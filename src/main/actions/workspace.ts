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

import type { ActionResult, WorkspaceStatus, WorkspaceForkParams } from '../../shared/types'
import { createWorkspace, getWorkspace, archiveWorkspace, renameWorkspace } from '../workspaces'
import { getDb } from '../db'
import { getWorkspaceActivity } from '../orpheusNotify'

// ---------------------------------------------------------------------------
// Internal: set the forked_from_session_id column after creation.
// The column is added by the v43 migration in db.ts.
// ---------------------------------------------------------------------------

function setForkedFromSessionId(workspaceId: string, parentSessionId: string): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET forked_from_session_id = ? WHERE id = ?').run(
    parentSessionId,
    workspaceId
  )
}

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

  const newName = name ?? (parent.name ? `${parent.name} (fork)` : 'Forked workspace')

  // createWorkspace pre-assigns a new claudeSessionId (Plan A step 1)
  const newWorkspace = createWorkspace({
    projectId: parent.projectId,
    name: newName,
    cwd: parent.cwd
  })

  // Plan A: store the parent session ID so composeClaudeLaunch can emit
  // --session-id <newId> --resume <parent> --fork-session
  if (parent.claudeSessionId) {
    try {
      setForkedFromSessionId(newWorkspace.id, parent.claudeSessionId)
    } catch (err) {
      // Column may not exist on fresh install before v43 migration runs —
      // log but don't fail the fork; the workspace will just start fresh.
      console.warn('[actions:workspace.fork] setForkedFromSessionId failed:', err)
    }
  }

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

  const name =
    (params['name'] as string | undefined) ??
    (parent.name ? `${parent.name} (copy)` : 'Duplicate workspace')

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
// Returns the current live activity status for the workspace.
// Delegates to the in-memory activityMap maintained by orpheusNotify.
// ---------------------------------------------------------------------------

export async function handleGetActivityStatus(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ status: WorkspaceStatus }>> {
  const status = getWorkspaceActivity(workspaceId)
  return { ok: true, value: { status } }
}
