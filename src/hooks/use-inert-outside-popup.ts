"use client";

import * as React from "react";

/** The marker the `aria-hidden` package (Radix's `hideOthers`) stamps on what it hides. */
const HIDDEN_BY_OPEN_POPUP = '[data-aria-hidden="true"]';

/**
 * Make what an open Radix popup hides `inert` as well as `aria-hidden` (#4466).
 *
 * Radix `Select` and modal `DropdownMenu` content call `hideOthers()` while open:
 * every node outside the popup gets `aria-hidden="true"`, the pointer is blocked
 * and focus is trapped inside. The hidden nodes stay FOCUSABLE, though, and
 * focusable content under `aria-hidden` is WCAG 4.1.2's failure (axe
 * `aria-hidden-focus`, serious): a screen-reader user who escapes the trap lands
 * on controls the accessibility tree says are not there. Radix exposes no option
 * to change it. `inert` is the attribute that says "not focusable, not
 * clickable, not in the tree", which is exactly what Radix already enforces by
 * other means while the popup is open, so mirroring its marks as `inert` changes
 * nothing a user could do and makes the hidden page consistent.
 *
 * Returns a callback ref for the popup's CONTENT element, which Radix mounts only
 * while the popup is open. Marks are applied in an effect (Radix applies its own
 * in an effect of the content, which runs first) and re-checked on the next
 * frame; they are released synchronously the moment the content detaches, so the
 * trigger is focusable again before Radix returns focus to it. Only nodes this
 * hook made inert are released.
 */
export function useInertOutsidePopup<T extends HTMLElement>(
  forwardedRef: React.ForwardedRef<T>,
): React.RefCallback<T> {
  const [content, setContent] = React.useState<T | null>(null);
  const madeInert = React.useRef<Element[]>([]);
  const latestForwardedRef = React.useRef(forwardedRef);
  React.useLayoutEffect(() => {
    latestForwardedRef.current = forwardedRef;
  });

  const release = React.useCallback(() => {
    for (const element of madeInert.current) element.removeAttribute("inert");
    madeInert.current = [];
  }, []);

  React.useEffect(() => {
    if (!content) return;
    const apply = () => {
      for (const element of document.querySelectorAll(HIDDEN_BY_OPEN_POPUP)) {
        if (element.hasAttribute("inert") || element.contains(content)) continue;
        element.setAttribute("inert", "");
        madeInert.current.push(element);
      }
    };
    apply();
    const frame = requestAnimationFrame(apply);
    return () => {
      cancelAnimationFrame(frame);
      release();
    };
  }, [content, release]);

  return React.useCallback(
    (element: T | null) => {
      if (element === null) release();
      setContent(element);
      const ref = latestForwardedRef.current;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [release],
  );
}
