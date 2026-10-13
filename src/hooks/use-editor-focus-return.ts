"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  captureFocusReturn,
  elementByMarker,
  focusAndKeepInView,
  isHTMLElement,
  RETURN_FOCUS_REGION_ATTRIBUTE,
  RETURN_FOCUS_TRIGGER_ATTRIBUTE,
  revealEditor,
  useReturnAttention,
  type FocusReturnAnchor,
} from "@/hooks/use-scroll-to-feedback";

/**
 * FOCUS INTO AND BACK OUT OF AN EDITOR A SURFACE OPENS ITSELF (#4087, #4115).
 *
 * The reveal and return halves of the attention rule, as one hook for a staged
 * section (`useSectionEditState` runs it) or a list whose per-row editor is its
 * own component. Every focus and scroll here goes through the primitives in
 * `use-scroll-to-feedback.ts`, the one home of that rule (#2934); this module
 * decides only WHICH element they act on.
 */

/**
 * What counts as a control the admin can edit, for the reveal into an opened
 * editor (#4115): the native form fields and the ARIA widgets the admin
 * primitives render in their place — a Radix checkbox, switch or select
 * trigger is a `button` carrying one of these roles. A plain button is not
 * one: Save, Cancel and Add row are actions, not the thing being edited.
 */
const EDITABLE_CONTROL_SELECTOR = [
  'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"])',
  "select",
  "textarea",
  '[contenteditable=""]',
  '[contenteditable="true"]',
  ...[
    "checkbox",
    "combobox",
    "radio",
    "slider",
    "spinbutton",
    "switch",
    "textbox",
  ].map((role) => `[role="${role}"]`),
].join(", ");

/**
 * Whether a keyboard user could Tab to `element` and change it. `tabIndex < 0`
 * drops what Tab skips: the hidden native input a Radix checkbox or select
 * keeps for form submission, and the unchecked radios of a roving group, whose
 * checked radio is the one Tab lands on.
 */
function isEditableControl(element: Element): element is HTMLElement {
  if (!isHTMLElement(element)) return false;
  if (element.matches(":disabled")) return false;
  if (element.tabIndex < 0) return false;
  if (
    element.getAttribute("aria-disabled") === "true" ||
    element.getAttribute("aria-readonly") === "true" ||
    (element as HTMLInputElement).readOnly === true
  ) {
    return false;
  }
  return !element.closest('[aria-hidden="true"], [inert], [hidden]');
}

function editableControlsIn(region: HTMLElement | null): HTMLElement[] {
  if (!region) return [];
  return Array.from(region.querySelectorAll(EDITABLE_CONTROL_SELECTOR)).filter(
    isEditableControl,
  );
}

/** What {@link captureEditorOpening} recorded as an editor was opened. */
export interface EditorOpening {
  /** The marker on the section the editor opens in. */
  regionId: string;
  /** The controls that were ALREADY editable before it opened. */
  editableBefore: ReadonlySet<Element>;
}

/**
 * Record which of the marked section's controls are already editable, from
 * the explicit action that opens its editor — before the render that opens it.
 * A scope select, a row's toggle or anything else the admin could already
 * change is then not mistaken for what the opening made editable.
 */
// test seam
export function captureEditorOpening(regionId: string): EditorOpening {
  const region =
    typeof document === "undefined"
      ? null
      : elementByMarker(RETURN_FOCUS_REGION_ATTRIBUTE, regionId);
  return { regionId, editableBefore: new Set(editableControlsIn(region)) };
}

/**
 * REVEAL, for a staged section or list editor (#4115). Focus the first control
 * the opening made editable — mounted by it, or enabled by it — in document
 * order; when it made none (an editor with no form fields, or one rendered
 * outside the section), focus the section itself, the region its title names.
 * The first candidate that actually TAKES focus wins.
 *
 * The scroll is `block: "nearest"`, unlike `revealEditor`'s `"start"`: the
 * admin pressed Edit (or Add, or a row's Edit) inside this section, so it is
 * already where they are looking, and the control moves only as far as it must
 * to be on screen. It moves focus whatever holds it — the pressed control is
 * usually gone, and a row's Edit that stays mounted is not where the admin is
 * going next.
 */
// test seam
export function revealOpenedEditor(opening: EditorOpening | null) {
  if (!opening || typeof document === "undefined") return;
  const region = elementByMarker(RETURN_FOCUS_REGION_ATTRIBUTE, opening.regionId);
  if (!region) return;
  for (const control of editableControlsIn(region)) {
    if (opening.editableBefore.has(control)) continue;
    if (focusAndKeepInView(control)) return;
  }
  focusAndKeepInView(region);
}

/**
 * Everything a surface needs to move focus into an editor it opens and back
 * out when it closes — `useSectionEditState` uses it for Edit, and a list
 * section whose per-row editor is its own component uses it directly.
 *
 *  - `capture(key)` from the action that opens the editor. It records where to
 *    return to and, once the editor has rendered, REVEALS it (#4115): focus
 *    goes to the first control the opening made editable, or to the section
 *    (`revealOpenedEditor`). `revealTarget` replaces that with a
 *    `revealEditor` of the given element; it exists for the three sections
 *    whose card reveal predates #4115, and a new section omits it;
 *  - `close()` from every user action that closes it (Cancel, a successful
 *    save, a save conflict that closes the stale editor) — never from a scope
 *    change or a background refresh, which are not the admin leaving it;
 *  - `triggerProps(key)` on an opening control that is NOT mounted while the
 *    editor is open (Edit, Add), so its replacement can be found; a control
 *    that stays mounted (a per-row Edit) is returned to directly;
 *  - `regionProps` on the section's card, the fallback when the trigger is
 *    gone or disabled. It makes the card a `region` named by `titleProps`,
 *    which goes on the card's visible title, so a keyboard user who lands on
 *    the card hears its name rather than "group" (#2934) — or, for a card with
 *    no visible title of its own, by `regionLabel`.
 */
export function useEditorFocusReturn({
  regionLabel,
  revealTarget,
}: { regionLabel?: string; revealTarget?: RefObject<HTMLElement | null> } = {}) {
  const id = useId();
  const titleId = `${id}title`;
  const anchorRef = useRef<FocusReturnAnchor | null>(null);
  const [closeKey, setCloseKey] = useState(0);
  useReturnAttention(anchorRef, closeKey);

  // The reveal: keyed on the count of opens ONLY, so a re-render with the
  // editor already open moves nothing — not even one that hands in a new
  // `revealTarget` — and each open consumes its own record. The target is
  // read from a latest-ref, refreshed by the effect declared first.
  const openingRef = useRef<EditorOpening | null>(null);
  const revealTargetRef = useRef(revealTarget);
  const [openKey, setOpenKey] = useState(0);
  useEffect(() => {
    revealTargetRef.current = revealTarget;
  });
  useEffect(() => {
    if (!openKey) return;
    const opening = openingRef.current;
    openingRef.current = null;
    const target = revealTargetRef.current;
    if (target) {
      revealEditor(target);
      return;
    }
    revealOpenedEditor(opening);
  }, [openKey]);

  const capture = useCallback(
    (key = "edit") => {
      anchorRef.current = captureFocusReturn({
        triggerId: `${id}${key}`,
        regionId: id,
      });
      openingRef.current = captureEditorOpening(id);
      setOpenKey((count) => count + 1);
    },
    [id],
  );
  const close = useCallback(() => setCloseKey((count) => count + 1), []);
  const triggerProps = useCallback(
    (key = "edit") => ({ [RETURN_FOCUS_TRIGGER_ATTRIBUTE]: `${id}${key}` }),
    [id],
  );
  const regionProps = useMemo(
    () => ({
      [RETURN_FOCUS_REGION_ATTRIBUTE]: id,
      role: "region" as const,
      ...(regionLabel
        ? { "aria-label": regionLabel }
        : { "aria-labelledby": titleId }),
    }),
    [id, regionLabel, titleId],
  );
  const titleProps = useMemo(() => ({ id: titleId }), [titleId]);
  return useMemo(
    () => ({ capture, close, triggerProps, regionProps, titleProps }),
    [capture, close, triggerProps, regionProps, titleProps],
  );
}
