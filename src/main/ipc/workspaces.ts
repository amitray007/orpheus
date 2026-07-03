// ---------------------------------------------------------------------------
// src/main/ipc/workspaces.ts
//
// Workspaces + workspace IPC — moved verbatim out of index.ts (STR-1).
// Covers workspaces:listForProject/create/createWorktree/open/setPinned/
// archive/rename/convertToLocal/reorder and workspace:close/reopen/isDirty/
// getTitle.
//
// workspaces:archive and workspace:close need `performArchive` / `performClose`
// — these stay defined in index.ts because they close over the `terminalAddon`
// singleton directly AND are shared with other call sites (CommandServerDeps,
// the auto-close handler) that live outside any single ipc/ domain, so they
// aren't moved or duplicated here — just injected via deps. Everything else in
// this domain is a leaf passthrough (workspaces.ts, worktrees.ts,
// claudeSettings.ts's composeClaudeLaunch chain isn't touched here, and the
// workspaceResources.ts accessors isDirty/getTitle are leaf imports).
// ---------------------------------------------------------------------------

import {
  listWorkspacesForProject,
  createWorkspace,
  openWorkspace,
  setWorkspacePinned,
  reopenWorkspace,
  renameWorkspace,
  reorderWorkspaces,
  convertWorktreeToLocal
} from '../workspaces'
import {
  resolveMainWorktree,
  withRepoLock,
  createWorktree,
  removeWorktree,
  worktreeSlug,
  readWorktreeBaseRef,
  branchExists,
  NotAGitRepoError
} from '../worktrees'
import { resolveOfferedModes } from '../orpheusConfig'
import { getProject } from '../projects'
import { getWorkspaceActivity } from '../orpheusNotify'
import { isDirty, getTitle } from '../workspaceResources'
import type { WorkspaceRecord } from '../../shared/types'
import { handle } from './handle'

export interface WorkspacesIpcDeps {
  performArchive: (id: string, force?: boolean) => Promise<{ archived: boolean; wasDirty: boolean }>
  performClose: (id: string) => WorkspaceRecord | undefined
}

export function registerWorkspacesIpc(deps: WorkspacesIpcDeps): void {
  handle('workspaces:listForProject', (_e, { projectId, scope }) =>
    listWorkspacesForProject(projectId, { scope })
  )

  handle('workspaces:create', (_e, args) => createWorkspace(args))

  // Create a worktree-backed workspace. Async + git-first transaction order:
  // resolve repo root → authoritatively enforce the offered-modes config →
  // (under the per-repo mutex) decide new-vs-existing branch → create the git
  // worktree → insert the DB row, rolling the worktree back if the insert fails.
  // Nothing is persisted until the worktree exists, and a failed insert leaves no
  // orphaned worktree behind.
  handle('workspaces:createWorktree', async (_e, { projectId, params }) => {
    const project = getProject(projectId)
    if (!project) throw new Error(`workspaces:createWorktree: project not found: ${projectId}`)

    // Resolve the main worktree root. A non-git cwd throws NotAGitRepoError —
    // worktree workspaces are impossible there, so reject with a clear message.
    let repoRoot: string
    try {
      repoRoot = await resolveMainWorktree(project.path)
    } catch (err) {
      if (err instanceof NotAGitRepoError) {
        throw new Error(
          `Cannot create a worktree workspace: ${project.path} is not a git repository`
        )
      }
      throw err
    }

    // Authoritative enforcement (spec §7.2): re-read the offered modes in the
    // main process and reject if worktree creation is disabled by config. The
    // UI gate is advisory; this is the real gate.
    const modes = await resolveOfferedModes(project.path, true)
    if (!modes.worktree) {
      throw new Error('Worktree workspaces are disabled for this project by .orpheus/config.yml')
    }

    const slug = worktreeSlug(params.name)
    const branch = params.branch?.trim() || `worktree-${slug}`

    return withRepoLock(repoRoot, async () => {
      const mode = (await branchExists(repoRoot, branch)) ? 'existing' : 'new'
      const baseRef = await readWorktreeBaseRef()

      // If createWorktree throws, propagate — no DB row has been inserted yet.
      const { path: worktreePath, branch: finalBranch } = await createWorktree({
        repoRoot,
        slug,
        branch,
        mode,
        baseRef
      })

      try {
        // createWorkspace broadcasts workspaces:created internally (same as the
        // normal create path), so no separate broadcast is needed here.
        return createWorkspace({
          projectId,
          name: params.name,
          cwd: worktreePath,
          worktreeParentCwd: repoRoot,
          worktreeBranch: finalBranch
        })
      } catch (rowErr) {
        // Roll back the freshly created worktree so a failed insert can't leak a
        // dangling worktree. Force-remove since it's brand new (no user changes).
        try {
          await removeWorktree({ path: worktreePath, force: true })
        } catch {
          // Best-effort rollback; surface the original insert error regardless.
        }
        throw rowErr
      }
    })
  })

  handle('workspaces:open', (_e, { id }) => openWorkspace(id))

  handle('workspaces:setPinned', (_e, { id, pinned }) => setWorkspacePinned(id, pinned))

  handle('workspaces:archive', async (_e, { id, force = false }) => {
    return await deps.performArchive(id, force)
  })

  handle('workspace:close', (_e, { id }) => {
    const status = getWorkspaceActivity(id)
    if (status === 'in_progress') {
      return { ok: false as const, error: 'busy' as const }
    }
    const workspace = deps.performClose(id)
    return { ok: true as const, workspace: workspace ?? null }
  })

  handle('workspace:reopen', (_e, { id }) => {
    const workspace = reopenWorkspace(id)
    return { ok: true as const, workspace: workspace ?? null }
  })

  handle('workspaces:rename', (_e, { id, name }) => renameWorkspace(id, name))

  // Convert a worktree-backed workspace to a plain local workspace (non-destructive:
  // does NOT delete the branch or worktree directory). Sets cwd = worktreeParentCwd
  // and nulls the worktree fields, then broadcasts workspaces:changed.
  handle('workspaces:convertToLocal', (_e, { id }) => convertWorktreeToLocal(id))

  handle('workspaces:reorder', (_e, { projectId, orderedIds }) =>
    reorderWorkspaces(projectId, orderedIds)
  )

  handle('workspace:isDirty', (_e, { workspaceId }) => isDirty(workspaceId))

  handle('workspace:getTitle', (_e, { workspaceId }) => getTitle(workspaceId) ?? null)
}
