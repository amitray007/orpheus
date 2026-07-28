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
import type { ActionResult } from '../../shared/types'
import { getWorkspace } from '../workspaces'
import { getWorkspaceActivity, computeDetail } from '../orpheusNotify'
import type { WorkspaceControlAdapter } from '../workspaceControlAdapter'

// ---------------------------------------------------------------------------
// workspace.fork
// ---------------------------------------------------------------------------

export async function handleFork(
  workspaceControl: WorkspaceControlAdapter,
  senderId: number,
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ workspaceId: string }>> {
  return workspaceControl.forkAction(senderId, params, workspaceId)
}

// ---------------------------------------------------------------------------
// workspace.archive
// ---------------------------------------------------------------------------

export async function handleArchive(
  workspaceControl: WorkspaceControlAdapter,
  senderId: number,
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ wasDirty: boolean }>> {
  return workspaceControl.archiveAction(senderId, workspaceId)
}

// ---------------------------------------------------------------------------
// workspace.rename
// ---------------------------------------------------------------------------

export function handleRename(
  workspaceControl: WorkspaceControlAdapter,
  senderId: number,
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<void>> {
  return workspaceControl.renameAction(senderId, params, workspaceId)
}

// ---------------------------------------------------------------------------
// workspace.duplicate — like fork but starts a completely fresh session
// ---------------------------------------------------------------------------

export async function handleDuplicate(
  workspaceControl: WorkspaceControlAdapter,
  senderId: number,
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ workspaceId: string }>> {
  return workspaceControl.duplicateAction(senderId, params, workspaceId)
}

// ---------------------------------------------------------------------------
// workspace.getActivityStatus — query
// Returns the current WorkspaceActivityDetail string for the workspace.
// Delegates to the in-memory activityMap maintained by orpheusNotify and
// maps WorkspaceStatus → WorkspaceActivityDetail via computeDetail().
// LiveChip reads this value directly as a string for dot-color and label.
// ---------------------------------------------------------------------------

export function handleGetActivityStatus(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<string>> {
  const status = getWorkspaceActivity(workspaceId)
  const detail = computeDetail(workspaceId, status)
  return Promise.resolve({ ok: true, value: detail })
}

// ---------------------------------------------------------------------------
// workspace.openInFinder — mutator
// Opens the workspace's cwd in macOS Finder.
// ---------------------------------------------------------------------------

export function handleOpenInFinder(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<void>> {
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return Promise.resolve({
      ok: false,
      code: 'not_found',
      error: `Workspace not found: ${workspaceId}`
    })
  }
  shell.showItemInFolder(ws.cwd)
  return Promise.resolve({ ok: true })
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

export function handleCopyPath(
  _params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ copied: string }>> {
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return Promise.resolve({
      ok: false,
      code: 'not_found',
      error: `Workspace not found: ${workspaceId}`
    })
  }
  clipboard.writeText(ws.cwd)
  return Promise.resolve({ ok: true, value: { copied: ws.cwd } })
}
