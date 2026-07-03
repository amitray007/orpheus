// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/ComingSoon.tsx
//
// U4 (P1) — placeholder body for the Workbench frame
// (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md). U5 replaces this
// with the Git · Terminal · Files · Panes tab strip; each tab body will reuse
// this component as its own "coming soon" placeholder until its unit lands
// (P3-P6 per docs/brainstorms/2026-07-02-workbench-panes-requirements.md §9).
// ---------------------------------------------------------------------------

import type React from 'react'

export interface ComingSoonProps {
  /** Optional label for the specific tab/feature this placeholder stands in
   *  for (e.g. "Git", "Terminal"). Defaults to the generic Workbench label. */
  label?: string
}

export function ComingSoon({ label = 'Workbench' }: ComingSoonProps): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center min-h-0">
      <span className="text-xs text-text-muted select-none">{label} — coming soon</span>
    </div>
  )
}
