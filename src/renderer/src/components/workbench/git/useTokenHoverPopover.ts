// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/useTokenHoverPopover.ts
//
// Pierre adoption Batch 3 — the token-hover controller hook, extracted into
// its own file (mirrors useReviewComposers.ts's split from CommentComposer.tsx)
// rather than co-located with TokenHoverPopover.tsx's component: this repo's
// `react-refresh/only-export-components` lint rule requires a component file
// export ONLY components, so a hook sharing a file with one breaks Fast
// Refresh for that file.
//
// See TokenHoverPopover.tsx's own header for the full design rationale
// (show-immediately/hide-with-grace-delay timing, ref-stability contract).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import type { TokenEventBase } from '@pierre/diffs'

/** How long the popover stays mounted after the pointer leaves the token,
 *  giving the user time to move onto the popover itself (e.g. to hit Copy)
 *  without it vanishing mid-move. */
const HIDE_DELAY_MS = 180

export interface TokenHoverState {
  tokenText: string
  rect: DOMRect
  /** 1-based line:col label — col is `lineCharStart + 1`. */
  line: number
  col: number
}

export interface UseTokenHoverPopoverResult {
  state: TokenHoverState | null
  /** Stable (empty-deps) — safe to spread directly into a memoized `options`
   *  object literal without destabilizing that memo's identity. */
  onTokenEnter: (props: TokenEventBase) => void
  onTokenLeave: () => void
  /** Cancels a pending hide (called by the popover's own onMouseEnter) so
   *  moving the pointer from the token onto the popover doesn't dismiss it. */
  cancelHide: () => void
  /** Re-schedules the hide (called by the popover's own onMouseLeave). */
  scheduleHide: () => void
}

/** Token-hover controller shared between GitTab's PatchDiff and FilesTab's
 *  File viewer. Exposes STABLE (empty-deps useCallback) onTokenEnter/
 *  onTokenLeave handlers so they can be spread into a memoized `options`
 *  object without destabilizing that memo — mirrors GitTab.tsx's
 *  DiffContentPaneImpl's own ref-based pattern for `onLineSelected` (see its
 *  doc comment). No `latestRef` is needed here (unlike that pattern) since
 *  these handlers only ever WRITE state via the setState updater form — they
 *  never need to read a stale render's closed-over value. */
export function useTokenHoverPopover(): UseTokenHoverPopoverResult {
  const [state, setState] = useState<TokenHoverState | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }, [])

  const scheduleHide = useCallback(() => {
    cancelHide()
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null
      setState(null)
    }, HIDE_DELAY_MS)
  }, [cancelHide])

  // A fresh token-enter always wins over any pending hide from the
  // previously-hovered token (mousemove fires onTokenEnter rapidly while
  // crossing many tokens — this is intentionally cheap: just a rect read +
  // setState, no per-move computation beyond what the popover needs).
  const onTokenEnter = useCallback(
    (props: TokenEventBase) => {
      cancelHide()
      setState({
        tokenText: props.tokenText,
        rect: props.tokenElement.getBoundingClientRect(),
        line: props.lineNumber,
        col: props.lineCharStart + 1
      })
    },
    [cancelHide]
  )

  const onTokenLeave = useCallback(() => {
    scheduleHide()
  }, [scheduleHide])

  // Belt-and-suspenders: clear any in-flight timer on unmount.
  useEffect(() => cancelHide, [cancelHide])

  return { state, onTokenEnter, onTokenLeave, cancelHide, scheduleHide }
}
