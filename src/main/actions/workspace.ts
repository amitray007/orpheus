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
import { destroyAddonSurface } from './addonSurface'
import {
  resolveMainWorktree,
  createWorktree,
  removeWorktree,
  withRepoLock,
  worktreeSlug,
  readWorktreeBaseRef,
  branchExists,
  NotAGitRepoError
} from '../worktrees'

// ---------------------------------------------------------------------------
// workspace.fork
// ---------------------------------------------------------------------------

export async function handleFork(
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ workspaceId: string }>> {
  const { name, worktree: wantWorktree } = params as WorkspaceForkParams

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

  // Resolve the main repo root. This maps a worktree-workspace parent back to
  // the MAIN repo root so worktrees never nest and no two workspaces squat the
  // same worktree dir. For a plain (non-worktree) parent, resolveMainWorktree
  // returns the same cwd — behaviour is unchanged.
  let repoRoot: string | null = null
  try {
    repoRoot = await resolveMainWorktree(parent.cwd)
  } catch (err) {
    if (!(err instanceof NotAGitRepoError)) throw err
    // Non-git parent: repoRoot stays null (handled per path below)
  }

  if (wantWorktree === true) {
    // worktree:true on a non-git parent is impossible — reject clearly.
    if (repoRoot === null) {
      return {
        ok: false,
        code: 'invalid',
        error: `Cannot create a worktree fork: parent directory is not a git repository (${parent.cwd})`
      }
    }

    // Git-first + withRepoLock + rollback (mirrors workspaces:createWorktree).
    const slug = worktreeSlug(newName)
    const branch = `worktree-${slug}`

    return withRepoLock(repoRoot, async () => {
      const mode = (await branchExists(repoRoot, branch)) ? 'existing' : 'new'
      const baseRef = await readWorktreeBaseRef()

      // Create the worktree first. If this throws, no DB row has been inserted.
      const { path: worktreePath, branch: finalBranch } = await createWorktree({
        repoRoot: repoRoot,
        slug,
        branch,
        mode,
        baseRef
      })

      try {
        // Plan A: pass forkedFromSessionId atomically so the renderer sees the
        // correct forked_from_session_id immediately on the workspaces:created broadcast.
        const newWorkspace = createWorkspace({
          projectId: parent.projectId,
          name: newName,
          cwd: worktreePath,
          worktreeParentCwd: repoRoot,
          worktreeBranch: finalBranch,
          forkedFromSessionId: parent.claudeSessionId
        })
        return { ok: true, value: { workspaceId: newWorkspace.id } }
      } catch (rowErr) {
        // Roll back the freshly created worktree so a failed insert can't leak
        // a dangling worktree. Force-remove: it's brand new, no user changes.
        try {
          await removeWorktree({ path: worktreePath, force: true })
        } catch {
          // Best-effort rollback; surface the original insert error.
        }
        throw rowErr
      }
    })
  }

  // worktree:false (or absent) — plain fork.
  // Use repoRoot (main repo root) if git, else fall back to parent.cwd.
  // This prevents squatting the worktree dir when the parent IS a worktree.
  const targetCwd = repoRoot ?? parent.cwd

  // Plan A: pass forkedFromSessionId into createWorkspace so the INSERT and
  // the broadcastWorkspaceCreated happen atomically — renderer sees the correct
  // forked_from_session_id immediately without a second UPDATE race.
  const newWorkspace = createWorkspace({
    projectId: parent.projectId,
    name: newName,
    cwd: targetCwd,
    forkedFromSessionId: parent.claudeSessionId
  })

  return { ok: true, value: { workspaceId: newWorkspace.id } }
}

// ---------------------------------------------------------------------------
// workspace.archive
// ---------------------------------------------------------------------------

export async function handleArchive(
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<{ wasDirty: boolean }>> {
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return { ok: false, code: 'not_found', error: `Workspace not found: ${workspaceId}` }
  }
  const force = params['force'] === true
  // Run archiveWorkspace FIRST. For worktree-backed workspaces with a dirty
  // worktree and force=false it returns { archived: false, wasDirty: true }
  // without deleting the DB row — in that case we must NOT destroy the surface
  // so the workspace terminal stays alive for the user to see the dirty confirm.
  //
  // archiveWorkspace broadcasts workspaces:archived after the DELETE so
  // the renderer removes the row from state and navigates away if needed.
  // For worktree-backed workspaces it removes the git worktree first;
  // if dirty and !force it returns { archived: false, wasDirty: true }
  // without deleting the row — caller must re-invoke with force:true.
  const result = await archiveWorkspace(workspaceId, force)
  if (!result.archived) {
    return { ok: false, code: 'invalid', error: 'worktree_dirty' }
  }
  // Archive succeeded: destroy the surface now that the DB row is gone.
  // Silently no-ops when the terminal was never mounted.
  destroyAddonSurface(workspaceId)
  return { ok: true, value: { wasDirty: result.wasDirty } }
}

// ---------------------------------------------------------------------------
// workspace.rename
// ---------------------------------------------------------------------------

export function handleRename(
  params: Record<string, unknown>,
  workspaceId: string
): Promise<ActionResult<void>> {
  const name = params['name']
  if (typeof name !== 'string' || name.trim() === '') {
    return Promise.resolve({ ok: false, code: 'invalid', error: 'name must be a non-empty string' })
  }
  const ws = getWorkspace(workspaceId)
  if (!ws) {
    return Promise.resolve({
      ok: false,
      code: 'not_found',
      error: `Workspace not found: ${workspaceId}`
    })
  }
  renameWorkspace(workspaceId, name.trim())
  return Promise.resolve({ ok: true })
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

  // When the parent is a worktree workspace, target the main repo root for the
  // new plain workspace's cwd — never the worktree dir (squat prevention).
  // For a plain parent, resolveMainWorktree returns the same cwd — unchanged.
  // For a non-git parent, fall back to parent.cwd (current behaviour).
  let targetCwd = parent.cwd
  try {
    targetCwd = await resolveMainWorktree(parent.cwd)
  } catch (err) {
    if (!(err instanceof NotAGitRepoError)) throw err
    // Non-git parent: keep parent.cwd as the target (no change to existing behaviour)
  }

  // Fresh workspace — createWorkspace already assigns a new UUID session ID.
  // No forked_from_session_id needed.
  const newWorkspace = createWorkspace({
    projectId: parent.projectId,
    name,
    cwd: targetCwd
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
