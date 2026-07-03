// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/WorkbenchPanel.tsx
//
// U2 (P1) — empty mount-point seam for the Workbench feature
// (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md). Renders nothing
// visible yet: this is intentionally just the empty container that future
// units build into —
//   U3 adds the three-section top bar
//   U4 adds the dormant/open/expanded state machine + frame geometry
//   U5 adds the Git · Terminal · Files · Panes tab strip
//
// Gated by AppUiState.workbenchEnabled (default false) at the call site in
// WorkspaceView.tsx — this component is only ever mounted when the flag is
// on, so it does not need to re-check the flag itself.
// ---------------------------------------------------------------------------

import type React from 'react'

export function WorkbenchPanel(): React.JSX.Element | null {
  // Empty shell — no tabs, no state machine, no visible content. Just the
  // mount seam. Returning null keeps this a true no-op even when mounted.
  return null
}
