"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import {
  captureFocusReturn,
  RETURN_FOCUS_REGION_ATTRIBUTE,
  RETURN_FOCUS_TRIGGER_ATTRIBUTE,
  useReturnAttention,
  type FocusReturnAnchor,
  type useEditorFocusReturn,
} from "@/hooks/use-scroll-to-feedback"

/**
 * Return focus after a list row's direct write — Activate/Deactivate, Delete —
 * whose refresh unmounted or disabled the button that held it (#4116).
 *
 * It finds its targets by the markers of the list's own `useEditorFocusReturn`
 * (`triggerProps(key)` on the row's buttons, `regionProps` on the card), but
 * keeps its OWN anchor: a row write while the row editor is open must not
 * consume the editor's anchor, or that editor's later Cancel would leave focus
 * on the page. `capture(key)` from the action, naming the button to land on;
 * `close()` once the refresh has been applied. It falls back to the card, and
 * moves nothing if focus is no longer on the page.
 */
export function useRowActionFocusReturn(
  editorFocus: ReturnType<typeof useEditorFocusReturn>,
) {
  const anchorRef = useRef<FocusReturnAnchor | null>(null)
  const [returnKey, setReturnKey] = useState(0)
  useReturnAttention(anchorRef, returnKey)
  const { triggerProps, regionProps } = editorFocus
  const capture = useCallback(
    (key: string) => {
      anchorRef.current = captureFocusReturn({
        triggerId: triggerProps(key)[RETURN_FOCUS_TRIGGER_ATTRIBUTE],
        regionId: regionProps[RETURN_FOCUS_REGION_ATTRIBUTE],
      })
    },
    [regionProps, triggerProps],
  )
  const close = useCallback(() => setReturnKey((count) => count + 1), [])
  return useMemo(() => ({ capture, close }), [capture, close])
}
