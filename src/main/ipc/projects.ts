// ---------------------------------------------------------------------------
// src/main/ipc/projects.ts
//
// Projects IPC — moved verbatim out of index.ts (STR-1).
//
// projects:remove needs to destroy each removed workspace's native terminal
// surface and run the full cross-module teardown before the cascade-delete —
// both are genuine index.ts state (the `terminalAddon` singleton and
// `teardownWorkspaceResources`, which itself composes workspaceResources.ts
// accessors with loadingOverlay/osNotifications/activity/git-watch cleanup).
// Neither is a leaf, so both are injected via deps (mirrors the
// `destroySurface` + `teardownWorkspaceResources` shape already used by
// CommandServerDeps in index.ts).
// ---------------------------------------------------------------------------

import { dialog } from 'electron'
import {
  listProjects,
  addProject,
  openProject,
  deleteProject,
  renameProject,
  setProjectExpandedInSidebar,
  reorderProjects,
  reorderProjectsByActivity,
  setProjectPinned
} from '../projects'
import { withRepoLock, removeWorktree, isWorktreeDirty } from '../worktrees'
import { refreshGithubData } from '../githubAvatar'
import {
  listWorkspacesForProject,
  countWorktreeWorkspaces,
  listWorktreeWorkspaces
} from '../workspaces'
import { logDiagMain } from '../diagnostics'
import { DIAG_EVENTS } from '../../shared/diagEvents'
import { handle } from './handle'

export interface ProjectsIpcDeps {
  destroySurface: (workspaceId: string) => void
  teardownWorkspaceResources: (workspaceId: string, cwd: string | null) => void
}

export function registerProjectsIpc(deps: ProjectsIpcDeps): void {
  handle('projects:list', () => listProjects())

  handle('projects:add', (_e, { path }) => addProject(path))

  handle('projects:pickAndAdd', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const chosen = result.filePaths[0]
    console.log('[orpheus] project folder selected:', chosen)
    return addProject(chosen)
  })

  handle('projects:open', (_e, { id }) => openProject(id))

  handle('projects:remove', async (_e, { id, deleteWorktrees = false, force = false }) => {
    // Optional worktree teardown before cascade-delete.
    // Must happen before deleteProject() so we still have workspace rows to query.
    if (deleteWorktrees) {
      const worktreeWorkspaces = listWorktreeWorkspaces(id)

      // ── Phase 1 (pre-check, NO removal): count dirty worktrees ───────────
      // Check dirtiness WITHOUT removing anything. If any are dirty and the
      // caller hasn't set force, return early having removed NOTHING — so the
      // user can cancel the confirmation without losing clean worktrees.
      if (!force) {
        const results = await Promise.all(worktreeWorkspaces.map((ws) => isWorktreeDirty(ws.cwd)))
        const dirtyCount = results.filter(Boolean).length
        if (dirtyCount > 0) {
          return { deleted: false, dirtyWorktrees: dirtyCount }
        }
      }

      // ── Phase 2 (removal): only reached when dirtyCount===0 or force ─────
      // Remove each worktree best-effort; log non-fatal errors and continue so
      // a single failure does not leave the project permanently undeletable.
      for (const ws of worktreeWorkspaces) {
        try {
          await withRepoLock(ws.worktreeParentCwd, () =>
            removeWorktree({ path: ws.cwd, force, repoRoot: ws.worktreeParentCwd })
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logDiagMain({
            category: 'error',
            level: 'error',
            event: DIAG_EVENTS.WORKTREE_REMOVAL_FAILED,
            workspaceId: ws.id,
            message: `non-fatal error removing worktree at ${ws.cwd}: ${message}`,
            data: { cwd: ws.cwd }
          })
          console.warn(`[projects:remove] non-fatal error removing worktree at ${ws.cwd}:`, message)
          // Continue — best-effort removal; don't abort the whole delete.
        }
      }
    }

    // Enumerate workspaces before the cascade-delete removes the rows so we can
    // tear down each one's in-memory state and native surface. The renderer
    // pre-destroys surfaces via terminal:destroy, but projects:remove must be
    // self-sufficient even when called directly (double-cleanup is safe — all
    // teardown operations are idempotent).
    const workspacesToRemove = listWorkspacesForProject(id, { scope: 'all' })
    for (const ws of workspacesToRemove) {
      deps.destroySurface(ws.id)
      deps.teardownWorkspaceResources(ws.id, ws.cwd ?? null)
    }
    deleteProject(id)
    return { deleted: true, dirtyWorktrees: 0 }
  })

  handle('projects:worktreeSummary', (_e, { projectId }) => {
    return { count: countWorktreeWorkspaces(projectId) }
  })

  handle('projects:rename', (_e, { id, name }) => renameProject(id, name))

  handle('projects:setExpandedInSidebar', (_e, { id, expanded }) =>
    setProjectExpandedInSidebar(id, expanded)
  )

  handle('projects:reorder', (_e, { orderedIds }) => reorderProjects(orderedIds))

  handle('projects:reorderByActivity', () => reorderProjectsByActivity())

  handle('projects:setPinned', (_e, { id, pinned }) => setProjectPinned(id, pinned))

  handle('projects:refreshGithub', (_e, projectId) => refreshGithubData(projectId))
}
