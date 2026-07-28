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
  setWorkspacePinned,
  reorderWorkspaces,
  convertWorktreeToLocal
} from '../workspaces'
import { getWorkspaceActivity } from '../orpheusNotify'
import { isDirty, getTitle } from '../workspaceResources'
import {
  archiveWorkspaceForRenderer,
  closeWorkspaceForRenderer,
  reopenWorkspaceForRenderer,
  type WorkspaceControlAdapter
} from '../workspaceControlAdapter'
import { handle } from './handle'

export interface WorkspacesIpcDeps {
  workspaceControl: WorkspaceControlAdapter
  performForcedArchive: (id: string) => Promise<{ archived: boolean; wasDirty: boolean }>
}

export function registerWorkspacesIpc(deps: WorkspacesIpcDeps): void {
  handle('workspaces:listForProject', (_e, { projectId, scope }) =>
    listWorkspacesForProject(projectId, { scope })
  )

  handle('workspaces:create', (e, args) => deps.workspaceControl.createLocal(e.sender.id, args))

  handle('workspaces:createWorktree', (e, { projectId, params }) =>
    deps.workspaceControl.createWorktree(e.sender.id, projectId, params)
  )

  // Internal acknowledgement: shares the canonical project mutation lease but
  // issues no renderer presentation request, so it cannot recurse.
  handle('workspaces:open', (_e, { id }) => deps.workspaceControl.acknowledgeRendererOpen(id))

  handle('workspaces:setPinned', (_e, { id, pinned }) => setWorkspacePinned(id, pinned))

  handle('workspaces:archive', async (e, { id, force = false }) => {
    // The injected force branch is the narrow legacy second leg after renderer
    // confirmation. Force is intentionally absent from the control schema.
    return archiveWorkspaceForRenderer(
      deps.workspaceControl,
      deps.performForcedArchive,
      e.sender.id,
      id,
      force
    )
  })

  handle('workspace:close', async (e, { id }) => {
    return closeWorkspaceForRenderer(
      deps.workspaceControl,
      e.sender.id,
      id,
      getWorkspaceActivity(id)
    )
  })

  handle('workspace:reopen', (e, { id }) =>
    reopenWorkspaceForRenderer(deps.workspaceControl, e.sender.id, id)
  )

  handle('workspaces:rename', (e, { id, name }) =>
    deps.workspaceControl.rename(e.sender.id, id, name)
  )

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
