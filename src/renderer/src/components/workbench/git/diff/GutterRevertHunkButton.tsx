// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/GutterRevertHunkButton.tsx
//
// Per-hunk "Revert" gutter affordance (setting-gated, AppUiState.
// hunkActionsEnabled — see docs/learnings/hunk-accept-reject.md). Mounted via
// the SAME `renderGutterUtility` slot GutterAddCommentButton already uses —
// Pierre only exposes one gutter-utility slot per hovered line (see that
// component's own doc comment on the onGutterUtilityClick/renderGutterUtility
// conflict), so DiffContentPane renders BOTH buttons side by side inside one
// wrapper when hunkActionsEnabled is on, rather than each registering its own
// competing slot.
//
// BUG FIX (button never appeared) — Pierre's `renderGutterUtility` render
// function is NOT re-invoked per hovered line: it renders ONCE into a single
// persistent container div (`InteractionManager.gutterUtilityContainer`,
// created once in `ensureGutterUtilityNode`) that Pierre itself re-parents
// (`showUtilityOnLine`'s `line.numberElement.appendChild(...)`) onto whichever
// line is currently hovered — confirmed against the installed 1.2.12's
// managers/InteractionManager.js + react/CodeView.js's `SlotPortals`
// (`useSyncExternalStore` keyed on the PORTAL TARGET LIST, not on hover state).
// `getHoveredLine` is a LIVE accessor meant to be called at INTERACTION time
// (a click), not read once at render time to decide what to show — DOM-testing
// confirmed `hunkIndexForLine`'s conditional-render approach (compute
// `showRevert` once inside the render prop) left the button permanently
// absent, since the render prop fires far less often than hover changes.
//
// FIX: mount unconditionally (whenever hunkActionsEnabled), then track "is the
// CURRENTLY hovered line inside a hunk" imperatively via a `pointermove`
// listener on `document` (cheap; Pierre's own hover tracking is pointer-event-
// based, not mousemove — see InteractionManager's `pointermove`/`pointerleave`
// listeners) that re-polls the live `getHoveredLine()` accessor and updates
// local state — this is the same "read the live accessor" pattern
// GutterAddCommentButton's onClick already uses, just polled continuously
// instead of once-per-click. Renders `null` (no DOM at all) when the hovered
// line isn't part of any hunk, so it never visually competes with the plain
// comment "+" on non-hunk lines.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type React from 'react'
import { ArrowCounterClockwise } from '@phosphor-icons/react'

export function GutterRevertHunkButton({
  getHoveredLine,
  isHunkLine,
  onRevert,
  title
}: {
  getHoveredLine: () => { lineNumber: number; side: 'additions' | 'deletions' } | undefined
  /** Pure, cheap check — no I/O — so it's safe to call on every pointermove. */
  isHunkLine: (lineNumber: number) => boolean
  onRevert: (lineNumber: number) => void
  title: string
}): React.JSX.Element | null {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const recompute = (): void => {
      const hovered = getHoveredLine()
      setVisible(hovered !== undefined && isHunkLine(hovered.lineNumber))
    }
    recompute()
    document.addEventListener('pointermove', recompute)
    document.addEventListener('pointerleave', recompute)
    return () => {
      document.removeEventListener('pointermove', recompute)
      document.removeEventListener('pointerleave', recompute)
    }
  }, [getHoveredLine, isHunkLine])

  if (!visible) return null
  return (
    <button
      type="button"
      className="gcc-gutter-revert"
      title={title}
      tabIndex={-1}
      onClick={() => {
        const hovered = getHoveredLine()
        if (hovered) onRevert(hovered.lineNumber)
      }}
    >
      <ArrowCounterClockwise size={11} weight="bold" />
    </button>
  )
}
