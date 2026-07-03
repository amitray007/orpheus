// ---------------------------------------------------------------------------
// src/main/ipc/worktrees.ts
//
// Worktrees IPC — moved verbatim out of index.ts (STR-1). Pure passthrough to
// ./projects and ./worktrees; closes over no index.ts state.
// ---------------------------------------------------------------------------

import { getProject } from '../projects'
import { resolveMainWorktree, branchExists } from '../worktrees'
import { handle } from './handle'

export function registerWorktreesIpc(): void {
  // Thin existence check used by NewWorkspaceMenu to flip the branch-field hint.
  handle('worktrees:branchExists', async (_e, { projectId, branch }) => {
    const project = getProject(projectId)
    if (!project) return false
    let repoRoot: string
    try {
      repoRoot = await resolveMainWorktree(project.path)
    } catch {
      return false
    }
    return branchExists(repoRoot, branch)
  })
}
