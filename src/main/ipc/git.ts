// ---------------------------------------------------------------------------
// src/main/ipc/git.ts
//
// Git + GitHub IPC — moved verbatim out of index.ts (STR-1). Pure passthrough
// to ./git and ./github; closes over no index.ts state.
// ---------------------------------------------------------------------------

import { getGitStatus, listBranches, listCommits, countCommits } from '../git'
import { getPrForBranch } from '../github'
import { handle } from './handle'

export function registerGitIpc(): void {
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

  // ---------------------------------------------------------------------------
  // GitHub IPC — `gh` CLI passthrough; null on every failure mode.
  // ---------------------------------------------------------------------------

  handle('github:prForBranch', (_e, { cwd, branch }) => getPrForBranch(cwd, branch))
}
