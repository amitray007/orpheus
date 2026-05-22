// ---------------------------------------------------------------------------
// actions/workspace.ts — Workspace operation actions for Quick Actions
//
// fork: clone the current workspace into a new one, using --fork-session so
//   claude creates an independent copy of the transcript branching from the
//   parent session. Plan A is used: we pre-assign a UUID to the new workspace
//   and pass --session-id <uuid> --resume <parent> --fork-session at mount.
//   Plan A was validated: claude respects the --session-id flag when combined
//   with --resume --fork-session.
//
// archive: hard-delete the workspace row (v34+ semantics).
// rename: update the workspace name.
// duplicate: fresh workspace at the same cwd/settings, no session fork.
// ---------------------------------------------------------------------------

import { shell, clipboard } from 'electron'
import type { ActionResult, WorkspaceForkParams } from '../../shared/types'
import { createWorkspace, getWorkspace, archiveWorkspace, renameWorkspace } from '../workspaces'
import { getWorkspaceActivity, computeDetail } from '../orpheusNotify'
import { destroyAddonSurface } from './index'

// ---------------------------------------------------------------------------
// workspace.fork
// ---------------------------------------------------------------------------

export async function handleFork(
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ workspaceId: string }>> {
  const { name } = params as WorkspaceForkParams

  const parent = getWorkspace(workspaceId)
  if (!parent) {
    return { ok: false, code: 'not_found', error: `Workspace not found: ${workspaceId}` }
  }

  // Fork semantics require a parent session to branch from. Without one there's
  // nothing to fork — fail loudly so the caller (footer chip / palette) can
  // suggest workspace.duplicate instead of silently starting a fresh session.
  if (!parent.claudeSessionId) {
    return {
      ok: false,
      code: 'invalid',
      error: 'Parent workspace has no session to fork from — use duplicate instead'
    }
  }

  const newName = name ?? (parent.name ? `${parent.name} (fork)` : 'Forked workspace')

  // Plan A: pass forkedFromSessionId into createWorkspace so the INSERT and
  // the broadcastWorkspaceCreated happen atomically — renderer sees the correct
  // forked_from_session_id immediately without a second UPDATE race.
  const newWorkspace = createWorkspace({
    projectId: parent.projectId,
    name: newName,
    cwd: parent.cwd,
    forkedFromSessionId: parent.claudeSessionId
  })

  return { ok: true, value: { workspaceId: newWorkspace.id } }
}

// ---------------------------------------------------------------------------
// workspace.archive
// ---------------------------------------------------------------------------

export async function handleArchive(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<void>> {
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return { ok: false, code: 'not_found', error: `Workspace not found: ${workspaceId}` }
  }
  // Destroy the libghostty surface first. Silently no-ops when the terminal
  // was never mounted (the addon ref may not even be loaded yet).
  destroyAddonSurface(workspaceId)
  // archiveWorkspace now broadcasts workspaces:archived after the DELETE so
  // the renderer removes the row from state and navigates away if needed.
  archiveWorkspace(workspaceId)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// workspace.rename
// ---------------------------------------------------------------------------

export async function handleRename(
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<void>> {
  const name = params['name']
  if (typeof name !== 'string' || name.trim() === '') {
    return { ok: false, code: 'invalid', error: 'name must be a non-empty string' }
  }
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return { ok: false, code: 'not_found', error: `Workspace not found: ${workspaceId}` }
  }
  renameWorkspace(workspaceId, name.trim())
  return { ok: true }
}

// ---------------------------------------------------------------------------
// workspace.duplicate — like fork but starts a completely fresh session
// ---------------------------------------------------------------------------

export async function handleDuplicate(
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ workspaceId: string }>> {
  const parent = getWorkspace(workspaceId)
  if (!parent) {
    return { ok: false, code: 'not_found', error: `Workspace not found: ${workspaceId}` }
  }

  // Accept both `name` (fully-qualified name) and `nameSuffix` (appended to
  // parent name) so the editor's { nameSuffix } draft and legacy { name } both work.
  let name: string
  if (typeof params['name'] === 'string') {
    name = params['name']
  } else if (typeof params['nameSuffix'] === 'string' && params['nameSuffix'].length > 0) {
    name = parent.name ? `${parent.name}${params['nameSuffix']}` : params['nameSuffix']
  } else {
    name = parent.name ? `${parent.name} (copy)` : 'Duplicate workspace'
  }

  // Fresh workspace — createWorkspace already assigns a new UUID session ID.
  // No forked_from_session_id needed.
  const newWorkspace = createWorkspace({
    projectId: parent.projectId,
    name,
    cwd: parent.cwd
  })

  return { ok: true, value: { workspaceId: newWorkspace.id } }
}

// ---------------------------------------------------------------------------
// workspace.getActivityStatus — query
// Returns the current WorkspaceActivityDetail string for the workspace.
// Delegates to the in-memory activityMap maintained by orpheusNotify and
// maps WorkspaceStatus → WorkspaceActivityDetail via computeDetail().
// LiveChip reads this value directly as a string for dot-color and label.
// ---------------------------------------------------------------------------

export async function handleGetActivityStatus(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<string>> {
  const status = getWorkspaceActivity(workspaceId)
  const detail = computeDetail(workspaceId, status)
  return { ok: true, value: detail }
}

// ---------------------------------------------------------------------------
// workspace.openInFinder — mutator
// Opens the workspace's cwd in macOS Finder.
// ---------------------------------------------------------------------------

export async function handleOpenInFinder(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<void>> {
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return { ok: false, code: 'not_found', error: `Workspace not found: ${workspaceId}` }
  }
  shell.showItemInFolder(ws.cwd)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// workspace.openInEditor — mutator
// Opens the workspace's cwd in the user's default editor/app for that path.
// ---------------------------------------------------------------------------

export async function handleOpenInEditor(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<void>> {
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return { ok: false, code: 'not_found', error: `Workspace not found: ${workspaceId}` }
  }
  const errMsg = await shell.openPath(ws.cwd)
  if (errMsg) {
    return { ok: false, code: 'failed', error: errMsg }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// workspace.copyPath — mutator
// Copies the workspace's cwd to the system clipboard.
// ---------------------------------------------------------------------------

export async function handleCopyPath(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ copied: string }>> {
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return { ok: false, code: 'not_found', error: `Workspace not found: ${workspaceId}` }
  }
  clipboard.writeText(ws.cwd)
  return { ok: true, value: { copied: ws.cwd } }
}
