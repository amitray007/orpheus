// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/CommitsTab.tsx
//
// Git tab — Commits sub-tab (PHASE 3c TARGET, not yet built here). This file
// is a Phase-3-foundation stub: GitTab.tsx (see its module header) now fetches
// the rich `github:prDetail` payload and slots this component in for
// `subTab === 'commits'` instead of an inline "Coming soon" message, so a
// later pass can fill in real content here WITHOUT touching GitTab.tsx (or
// DetailsTab.tsx / ChecksTab.tsx, its siblings) — the three tabs are
// independent files by design so they can be built in parallel.
//
// What this will eventually render (from `prDetail.commits: GhCommit[]`,
// src/shared/types.ts): the PR's commit list — oid, messageHeadline/Body,
// author, authoredDate, a link to `commit.url`. When there's no PR
// (`prDetail === null`), this should fall back to the current branch's local
// commit list (ahead-of-base) rather than an empty state — see the
// requirements doc's "ahead of base, no PR" case; that likely needs a new
// IPC (not yet built) since `GhPullRequestDetail` is PR-only data.
// ---------------------------------------------------------------------------

import type React from 'react'
import type { GhPullRequestDetail } from '@shared/types'

export interface CommitsTabProps {
  /** The current branch's PR detail, or null when there's no PR for this
   *  branch (no `gh` / no remote / detached HEAD / not-yet-pushed). */
  prDetail: GhPullRequestDetail | null
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process, same as GitTab's own `workspaceId` prop. */
  workspaceId: string
  /** The current branch name (from GitTab's `git:statusChanged` push), or
   *  null before the first push arrives / on a detached HEAD. Needed for the
   *  no-PR "local commits ahead of base" fallback described above. */
  branch: string | null
}

/** Phase 3c stub — placeholder body for the Commits sub-tab. Props are wired
 *  through in full (see CommitsTabProps) even though this placeholder only
 *  surfaces them as inert `data-*` attributes — the real 3c pass reads
 *  `prDetail`/`branch` for content and needs no signature change to GitTab. */
export function CommitsTab({ prDetail, workspaceId, branch }: CommitsTabProps): React.JSX.Element {
  return (
    <div
      className="flex-1 flex items-center justify-center min-h-0"
      data-workspace-id={workspaceId}
      data-branch={branch ?? undefined}
      data-has-pr-detail={prDetail !== null}
    >
      <span className="text-xs text-text-muted select-none">Coming soon — Commits</span>
    </div>
  )
}
