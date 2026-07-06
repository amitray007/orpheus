// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/ChecksTab.tsx
//
// Git tab — Checks sub-tab (PHASE 3e TARGET, not yet built here). This file
// is a Phase-3-foundation stub: GitTab.tsx (see its module header) now fetches
// the rich `github:prDetail` payload and slots this component in for
// `subTab === 'checks'` instead of an inline "Coming soon" message, so a
// later pass can fill in real content here WITHOUT touching GitTab.tsx (or
// CommitsTab.tsx / DetailsTab.tsx, its siblings) — the three tabs are
// independent files by design so they can be built in parallel. Checks is a
// PR-only sub-tab (only reachable when `hasPr` is true — see GitTab's
// SubTabStrip), so `prDetail` is expected non-null in practice here, but the
// prop stays nullable to match the other two tabs' signature and to degrade
// gracefully if it's still loading/mid-refetch.
//
// What this will eventually render (from `prDetail.checks: GhCheck[]`,
// src/shared/types.ts): the un-reduced per-check list — name, workflowName,
// state (success/failure/pending/neutral), startedAt/completedAt, and a link
// to `check.url`. Distinct from the existing 3-state aggregate rollup used
// elsewhere (e.g. PrChip) — this tab shows every individual check, not just
// the aggregate badge.
// ---------------------------------------------------------------------------

import type React from 'react'
import type { GhPullRequestDetail } from '@shared/types'

export interface ChecksTabProps {
  /** The current branch's PR detail, or null when there's no PR for this
   *  branch (no `gh` / no remote / detached HEAD / not-yet-pushed) — this
   *  sub-tab is only reachable while a PR exists, but stays nullable to
   *  match CommitsTab/DetailsTab's shared signature. */
  prDetail: GhPullRequestDetail | null
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process, same as GitTab's own `workspaceId` prop. */
  workspaceId: string
  /** The current branch name (from GitTab's `git:statusChanged` push), or
   *  null before the first push arrives / on a detached HEAD. */
  branch: string | null
}

/** Phase 3e stub — placeholder body for the Checks sub-tab. Props are wired
 *  through in full (see ChecksTabProps) even though this placeholder only
 *  surfaces them as inert `data-*` attributes — the real 3e pass reads
 *  `prDetail`/`branch` for content and needs no signature change to GitTab. */
export function ChecksTab({ prDetail, workspaceId, branch }: ChecksTabProps): React.JSX.Element {
  return (
    <div
      className="flex-1 flex items-center justify-center min-h-0"
      data-workspace-id={workspaceId}
      data-branch={branch ?? undefined}
      data-has-pr-detail={prDetail !== null}
    >
      <span className="text-xs text-text-muted select-none">Coming soon — Checks</span>
    </div>
  )
}
