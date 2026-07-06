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

import { getGitStatus, listBranches, listCommits, countCommits, gitInit } from '../git'
import { getWorkingTreeDiff, getPrDiff } from '../gitDiff'
import {
  getPrForBranch,
  getPrDetail,
  getPrReviewComments,
  postReviewComment,
  replyToReviewComment,
  postGeneralComment
} from '../github'
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

  handle('git:diff', (_e, { workspaceId }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? getWorkingTreeDiff(cwd) : Promise.resolve({ repo: false, files: [] })
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

  // ---------------------------------------------------------------------------
  // GitHub IPC — `gh` CLI passthrough; null on every failure mode.
  // ---------------------------------------------------------------------------

  handle('github:prForBranch', (_e, { cwd, branch }) => getPrForBranch(cwd, branch))

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
}
