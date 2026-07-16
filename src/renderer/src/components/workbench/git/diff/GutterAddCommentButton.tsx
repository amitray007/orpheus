// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/GutterAddCommentButton.tsx
//
// GitTab's hover gutter "+" affordance (Phase 4b/4c) — extracted verbatim
// from GitTab.tsx (Wave 3 Phase A structural extraction). Its own file
// (component-only) per this repo's `react-refresh/only-export-components`
// lint convention — see renderReviewCommentAnnotation.tsx's own header for
// why it isn't co-located with that routing function.
// ---------------------------------------------------------------------------

import type React from 'react'
import { Plus } from '@phosphor-icons/react'

/** BUG FIX — Pierre's `@pierre/diffs` has TWO mutually exclusive
 *  gutter-utility APIs, and the previous code set both at once: `options.
 *  onGutterUtilityClick` (a built-in, non-custom-render click handler) AND
 *  the React `renderGutterUtility` prop (a custom-render React node,
 *  auto-detected by the library and translated into `options.
 *  renderGutterUtility` — see `useFileDiffInstance.mergeFileDiffOptions` in
 *  @pierre/diffs' own source). `InteractionManager` throws "Cannot use both
 *  'onGutterUtilityClick' and 'renderGutterUtility'" the instant BOTH end up
 *  non-null in its resolved options — which happened on every PR-diff-mode
 *  render, crashing the whole app to the error boundary. This was dormant
 *  since Phase 4b introduced it: PR-diff mode was unreachable until a later
 *  pass's `pr`-state fix made it reachable for the first time, so this
 *  latent crash never actually fired in practice until then.
 *
 *  FIX: since a custom React node IS wanted here (GutterAddCommentButton),
 *  only the `renderGutterUtility` prop is used — `onGutterUtilityClick`/
 *  `enableGutterUtility` are removed from buildDiffOptions entirely (see
 *  DiffContentPane.tsx). The click itself is now wired directly on the
 *  button's own onClick, reading the currently-hovered line via the
 *  `getHoveredLine` accessor Pierre passes into
 *  `renderGutterUtility(getHoveredLine)` (see renderDiffChildren.tsx) — the
 *  same line/side data `onGutterUtilityClick`'s `SelectedLineRange` argument
 *  used to carry, just sourced from the render-prop's own accessor instead
 *  of a second parallel callback. */
export function GutterAddCommentButton({
  getHoveredLine,
  onAdd
}: {
  getHoveredLine: () => { lineNumber: number; side: 'additions' | 'deletions' } | undefined
  onAdd: (lineNumber: number, side: 'additions' | 'deletions') => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="gcc-gutter-add"
      title="Add a comment on this line"
      tabIndex={-1}
      onClick={() => {
        const hovered = getHoveredLine()
        if (hovered) onAdd(hovered.lineNumber, hovered.side)
      }}
    >
      <Plus size={11} weight="bold" />
    </button>
  )
}
