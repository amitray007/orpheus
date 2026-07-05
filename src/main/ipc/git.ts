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
// it already has from the workspace record / gitStore).
// ---------------------------------------------------------------------------

import { getGitStatus, listBranches, listCommits, countCommits, gitInit } from '../git'
import { getWorkingTreeDiff } from '../gitDiff'
import { getPrForBranch } from '../github'
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

  handle('git:init', (_e, { workspaceId }) => {
    const cwd = getWorkspaceCwd(workspaceId)
    return cwd ? gitInit(cwd) : Promise.resolve({ ok: false, error: 'Workspace not found' })
  })

  // ---------------------------------------------------------------------------
  // GitHub IPC — `gh` CLI passthrough; null on every failure mode.
  // ---------------------------------------------------------------------------

  handle('github:prForBranch', (_e, { cwd, branch }) => getPrForBranch(cwd, branch))
}
