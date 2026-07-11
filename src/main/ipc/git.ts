// ---------------------------------------------------------------------------
// src/main/ipc/git.ts
//
// Git + GitHub IPC — moved verbatim out of index.ts (STR-1). Pure passthrough
// to ./git and ./github; closes over no index.ts state.
//
// git:diff (Workbench Git tab, Phase 1) is the one exception — like
// files.ts's channels, it resolves `workspaceId` -> cwd itself via an
// injected `getWorkspaceCwd`, rather than taking `{ cwd }` directly the way
// the other git:* channels do (those are called by the renderer with a cwd
// it already has from the workspace record / gitStore). git:logForWorkspace
// (Phase 3c) is the same shape, added for CommitsTab.tsx's no-PR fallback,
// which — like the rest of the Workbench Git tab — only ever has a
// `workspaceId`, never a raw cwd.
// ---------------------------------------------------------------------------

import {
  getGitStatus,
  listBranches,
  listCommits,
  countCommits,
  gitInit,
  getConflictedPaths,
  getFileAtHead
} from '../git'
import { getWorkingTreeDiff, getPrDiff } from '../gitDiff'
import {
  getPrForBranch,
  getPrForWorkspace,
  getPrDetail,
  getPrReviewComments,
  postReviewComment,
  replyToReviewComment,
  postGeneralComment,
  getMyOpenPrs,
  getMyIssues,
  getCachedMyOpenPrs,
  getCachedMyIssues,
  getGithubUsername
} from '../github'
import { updateAppUiState } from '../uiState'
import { handle } from './handle'

export type GitIpcDeps = {
  /** Resolve a workspace's cwd from its id; null when the workspace is gone. */
  getWorkspaceCwd: (workspaceId: string) => string | null
}

export function registerGitIpc(deps: GitIpcDeps): void {
  const { getWorkspaceCwd } = deps

  // ---------------------------------------------------------------------------
  // Git IPC
  // ---------------------------------------------------------------------------

  handle('git:status', (_e, { cwd }) => getGitStatus(cwd))

  handle('git:branches', async (_e, { cwd }) => {
    const result = await listBranches(cwd)
    return result
  })

  handle('git:log', (_e, args) => listCommits(args.cwd, args))

  handle('git:count', async (_e, args) => {
    const result = await countCommits(args.cwd, args)
    return result
  })

  // PERF FIX (main-side diff no-op detection) — workspaceId is threaded
  // through as the cache key for getWorkingTreeDiff's own last-signature
  // cache (see gitDiff.ts's own doc comment): a match returns the additive
  // `{ unchanged: true }` sentinel instead of re-serializing `files[]`. A
  // workspace switch always misses (different key), so the first fetch after
  // a switch is guaranteed to return the full result, never a stale sentinel.
  //
  // BUG FIX (stuck-loading) — `forceFresh` passes straight through to
  // getWorkingTreeDiff (see its own doc comment): the renderer's Git tab
  // fully unmounts/remounts on tab switch (not a sticky surface), so the
  // cache above can outlive the renderer instance that's asking. GitTab.tsx
  // sets this on the first fetch after every state reset (mount, mode
  // switch) so a stale cache entry from a PREVIOUS mount can never return
  // `{ unchanged: true }` to a renderer that has no data to fall back on.
  handle('git:diff', (_e, { workspaceId, forceFresh }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd
      ? getWorkingTreeDiff(cwd, workspaceId, forceFresh)
      : Promise.resolve({ repo: false, files: [] })
  })

  // Workbench Git tab, Phase 4-pre — the [Working tree | PR diff] toggle's
  // PR-diff data source. Resolves workspaceId -> cwd like git:diff, then
  // defers to gitDiff.ts's getPrDiff (gh pr diff <n> -> the SAME
  // splitPatchByFile/fileFromChunk parsers git:diff uses).
  handle('git:prDiff', (_e, { workspaceId }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? getPrDiff(cwd) : Promise.resolve({ repo: false, files: [] })
  })

  handle('git:init', (_e, { workspaceId }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? gitInit(cwd) : Promise.resolve({ ok: false, error: 'Workspace not found' })
  })

  // Workbench Git tab, Phase 3c — Commits sub-tab's no-PR fallback (local
  // commits on a branch with no PR yet). Resolves workspaceId -> cwd like
  // git:diff/git:init above, then defers to the existing listCommits.
  handle('git:logForWorkspace', (_e, { workspaceId, limit }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return Promise.resolve(cwd ? listCommits(cwd, { limit }) : [])
  })

  // Pierre adoption batch 4 (safe/read-only slice) — merge-conflict
  // DETECTION only. Resolves workspaceId -> cwd like git:diff/git:init above,
  // then defers to git.ts's getConflictedPaths (a read-only `git status
  // --porcelain=v1` scan for unmerged XY codes). No git mutation of any kind
  // — resolution/write-back is explicitly deferred, see git.ts's doc comment.
  handle('git:conflicts', (_e, { workspaceId }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? getConflictedPaths(cwd) : Promise.resolve([])
  })

  // Per-hunk "Revert" feature (setting-gated, hunkActionsEnabled) — READ-ONLY
  // `git show HEAD:<path>`, the pre-image `processFile` needs to compute a
  // hunk-reverted file's full text (see docs/learnings/hunk-accept-reject.md).
  // Resolves workspaceId -> cwd like git:diff/git:init above. Total (never
  // rejects) — null for an untracked/new file, non-repo, or any git failure.
  handle('git:showHead', (_e, { workspaceId, path }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? getFileAtHead(cwd, path) : Promise.resolve(null)
  })

  // ---------------------------------------------------------------------------
  // GitHub IPC — `gh` CLI passthrough; null on every failure mode.
  // ---------------------------------------------------------------------------

  handle('github:prForBranch', (_e, { cwd, branch }) => getPrForBranch(cwd, branch))

  // Fetch-on-mount fallback for GitTab's `pr` state (see the bug this fixes
  // in src/main/git.ts's startGitWatch header + src/shared/ipc.ts's own
  // comment on this channel). Resolves workspaceId -> cwd like the other
  // workspaceId-keyed handlers below, then defers to github.ts's
  // getPrForWorkspace (cwd -> current branch -> PR, sharing getPrForBranch's
  // cache/inflight-dedup).
  handle('github:prForWorkspace', (_e, { workspaceId }) =>
    getPrForWorkspace(getWorkspaceCwd(workspaceId))
  )

  // Phase 3b — rich PR detail (Details/Commits/Checks tabs). Resolves
  // workspaceId -> cwd like git:diff/git:init above.
  handle('github:prDetail', (_e, { workspaceId }) => getPrDetail(getWorkspaceCwd(workspaceId)))

  // Phase 4a — line-anchored PR review comments (inline annotations on the
  // PR diff). Resolves workspaceId -> cwd like git:diff/git:init/prDetail
  // above; own gh call + cache, separate from prDetail (see github.ts).
  handle('github:prReviewComments', (_e, { workspaceId }) =>
    getPrReviewComments(getWorkspaceCwd(workspaceId))
  )

  // Phase 4c — the FIRST write operations to GitHub. Each resolves
  // workspaceId -> cwd the same way the read handlers above do, then defers
  // to github.ts's total (never-throws) write functions — see that module's
  // "PR write operations" section header for the full safety rationale
  // (execFile-args body passing, error extraction, cache invalidation).

  handle('github:postReviewComment', (_e, { workspaceId, path, line, side, body, commitId }) =>
    postReviewComment({
      workspaceId,
      cwd: getWorkspaceCwd(workspaceId),
      path,
      line,
      side,
      body,
      commitId
    })
  )

  handle('github:replyToReviewComment', (_e, { workspaceId, commentId, body }) =>
    replyToReviewComment({ cwd: getWorkspaceCwd(workspaceId), commentId, body })
  )

  handle('github:postGeneralComment', (_e, { workspaceId, body }) =>
    postGeneralComment({ cwd: getWorkspaceCwd(workspaceId), body })
  )

  // Dashboard Phase 2 (U5) — account-wide search, no workspaceId/cwd
  // resolution needed (unlike every handler above). See github.ts::
  // getMyOpenPrs/getMyIssues.
  handle('github:myOpenPrs', () => getMyOpenPrs())
  handle('github:myIssues', () => getMyIssues())
  // Dashboard D2 (stale-while-revalidate) — instant, disk-backed reads that
  // never touch the network. See github.ts::getCachedMyOpenPrs/Issues.
  handle('github:myOpenPrs:cached', () => getCachedMyOpenPrs())
  handle('github:myIssues:cached', () => getCachedMyIssues())

  // Dashboard D4 — named greeting. Fired once per app open (DashboardTopBar's
  // background refresh); resolves via getGithubUsername, persists the
  // resolved display name to app_ui_state, and returns it so the renderer
  // can update its local uiState snapshot without waiting on a push (this
  // handler has no mainWindow ref to broadcast uiState:changed with — see
  // registerUiStateIpc for that pattern). On failure, leaves the stored
  // value untouched and returns null.
  handle('github:refreshUsername', async () => {
    const result = await getGithubUsername()
    if (!result) return null
    const resolved = result.name || result.login
    updateAppUiState({ githubUsername: resolved })
    return resolved
  })
}
