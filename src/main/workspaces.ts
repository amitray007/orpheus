import { BrowserWindow } from 'electron'
import { getDb } from './db'
import type { WorkspaceRecord, WorkspaceStatus, PinnedItem, ProjectRecord } from '../shared/types'
import { invalidateClaudeWorkspaceSettingsCache } from './claudeWorkspaceSettings'
import { removeWorktree, withRepoLock } from './worktrees'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type WorkspaceRow = {
  id: string
  project_id: string
  name: string
  name_is_auto: number
  cwd: string
  pinned_at: number | null
  created_at: number
  last_opened_at: number | null
  archived_at: number | null
  closed_at: number | null
  status: WorkspaceStatus
  sort_order: number | null
  claude_session_id: string | null
  last_title: string | null
  // v43: fork session support (Plan A)
  forked_from_session_id: string | null
  // v64: parent workspace lineage
  parent_workspace_id: string | null
  // v64: worktree-native workspaces
  worktree_parent_cwd: string | null
  worktree_branch: string | null
}

type ProjectRow = {
  id: string
  path: string
  name: string
  claude_encoded_name: string | null
  added_at: number
  last_opened_at: number | null
  expanded_in_sidebar: number
  sort_order: number | null
  pinned_at: number | null
  // v37
  github_owner: string | null
  github_repo: string | null
  github_avatar_url: string | null
  github_checked_at: number | null
}

function rowToWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    nameIsAuto: row.name_is_auto === 1,
    cwd: row.cwd,
    pinnedAt: row.pinned_at,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
    archivedAt: row.archived_at,
    closedAt: row.closed_at,
    status: row.status ?? 'idle',
    sortOrder: row.sort_order ?? null,
    claudeSessionId: row.claude_session_id ?? null,
    forkedFromSessionId: row.forked_from_session_id ?? null,
    lastTitle: row.last_title ?? null,
    parentWorkspaceId: row.parent_workspace_id ?? null,
    worktreeParentCwd: row.worktree_parent_cwd ?? null,
    worktreeBranch: row.worktree_branch ?? null
  }
}

/**
 * Get the forked_from_session_id for a workspace (Plan A fork support).
 * Returns null when the column doesn't exist yet (pre-v43 DBs) or has no value.
 */
export function getWorkspaceForkedFromSessionId(id: string): string | null {
  const db = getDb()
  try {
    const row = db.prepare('SELECT forked_from_session_id FROM workspaces WHERE id = ?').get(id) as
      | { forked_from_session_id: string | null }
      | undefined
    return row?.forked_from_session_id ?? null
  } catch {
    return null
  }
}

function rowToProjectRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    claudeEncodedName: row.claude_encoded_name,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    expandedInSidebar: row.expanded_in_sidebar === 1,
    sortOrder: row.sort_order ?? null,
    pinnedAt: row.pinned_at ?? null,
    // v37
    githubOwner: row.github_owner ?? null,
    githubRepo: row.github_repo ?? null,
    githubAvatarUrl: row.github_avatar_url ?? null,
    githubCheckedAt: row.github_checked_at ?? null
  }
}

// ---------------------------------------------------------------------------
// Workspace name sanitization
// ---------------------------------------------------------------------------

/**
 * Max length (in characters) for a user-supplied workspace name. Names longer
 * than this are truncated with a trailing ellipsis ('…'). Chosen to keep
 * `ws ls` table rendering (and the sidebar) sane against a hostile/careless
 * caller passing a 300+ char name — 200 chars is comfortably longer than any
 * legitimate workspace name while still bounding worst-case column width.
 */
const WORKSPACE_NAME_MAX_LENGTH = 200

/**
 * Sanitize a user-supplied workspace name so it can never blow out table
 * rendering (`ws ls`) or the sidebar:
 *   - CRLF/LF/tab (and other control chars) are replaced with a space so a
 *     pasted multi-line string collapses to one line.
 *   - Runs of whitespace are collapsed to a single space.
 *   - Leading/trailing whitespace is trimmed.
 *   - The result is capped to WORKSPACE_NAME_MAX_LENGTH chars, truncated with
 *     a trailing '…' when longer.
 * Throws if the sanitized result is empty (name was blank/whitespace-only)
 * so callers get a clear error instead of silently storing an empty name.
 */
function sanitizeWorkspaceName(name: string): string {
  // C0 control chars (U+0000-U+001F) + DEL (U+007F), built via fromCharCode
  // rather than a literal \x00-\x1f regex escape to keep this ASCII-clean.
  const CONTROL_CHARS_RE = new RegExp(
    `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
    'g'
  )
  // Replace CR/LF/tab and other C0 control chars + DEL with a space so a
  // pasted multi-line / control-char-laden string collapses to plain text.
  const noControlChars = name.replace(CONTROL_CHARS_RE, ' ')
  // Collapse runs of whitespace (including the spaces just introduced) to one.
  const collapsed = noControlChars.replace(/\s+/g, ' ')
  const trimmed = collapsed.trim()
  if (trimmed === '') {
    throw new Error('name cannot be empty')
  }
  if (trimmed.length > WORKSPACE_NAME_MAX_LENGTH) {
    return trimmed.slice(0, WORKSPACE_NAME_MAX_LENGTH - 1) + '…'
  }
  return trimmed
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Broadcast helper — fan out a workspaces:created event to all renderer
// windows so they can merge the new record into state before any navigation
// fires. Called from createWorkspace() so every creation path (normal, fork,
// duplicate, session-resume) emits the event automatically.
// ---------------------------------------------------------------------------

function broadcastWorkspaceCreated(workspace: WorkspaceRecord): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('workspaces:created', { workspace })
    }
  }
}

function broadcastWorkspaceChanged(workspace: WorkspaceRecord): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('workspaces:changed', { workspace })
    }
  }
}

function broadcastWorkspaceArchived(workspaceId: string, projectId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('workspaces:archived', { workspaceId, projectId })
    }
  }
}

export function createWorkspace({
  projectId,
  name,
  cwd,
  forkedFromSessionId = null,
  parentWorkspaceId = null,
  worktreeParentCwd = null,
  worktreeBranch = null
}: {
  projectId: string
  name: string
  cwd: string
  /** When creating a forked workspace, pass the parent session ID so the
   *  record is written before broadcastWorkspaceCreated fires. Avoids a race
   *  where the renderer receives workspaces:created with a null field. */
  forkedFromSessionId?: string | null
  /** When creating a child workspace, pass the parent workspace ID to establish
   *  lineage for depth/children guardrails (v64). */
  parentWorkspaceId?: string | null
  /** Repo root this worktree branches from; null for a plain workspace (v64). */
  worktreeParentCwd?: string | null
  /** Branch checked out in this worktree; null for a plain workspace (v64). */
  worktreeBranch?: string | null
}): WorkspaceRecord {
  const db = getDb()
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  const sanitizedName = sanitizeWorkspaceName(name)

  // Pre-generate the claude session UUID at workspace creation so that the
  // very first launch can pass --session-id <uuid> to claude (deterministic).
  // Subsequent launches detect that ~/.claude/projects/<cwd>/<uuid>.jsonl
  // exists and switch to --resume <uuid>. This eliminates the prior race
  // where quitting Orpheus within ~2s of the first message orphaned the
  // session (the post-mount filesystem poll never completed and the row's
  // claudeSessionId stayed null, so the next launch started fresh).
  const claudeSessionId = crypto.randomUUID()

  // Assign sort_order so new workspaces appear at the top of the project's
  // list — even above existing drag-reordered ones. MIN(sort_order) - 1 keeps
  // the order open-ended downward; drag-reorder still works to move it later.
  const minRow = db
    .prepare('SELECT MIN(sort_order) AS minSort FROM workspaces WHERE project_id = ?')
    .get(projectId) as { minSort: number | null } | undefined
  const sortOrder = minRow?.minSort != null ? minRow.minSort - 1 : 0

  const row = db
    .prepare(
      `INSERT INTO workspaces (id, project_id, name, cwd, created_at, claude_session_id, sort_order, forked_from_session_id, parent_workspace_id, worktree_parent_cwd, worktree_branch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .get(
      id,
      projectId,
      sanitizedName,
      cwd,
      createdAt,
      claudeSessionId,
      sortOrder,
      forkedFromSessionId ?? null,
      parentWorkspaceId ?? null,
      worktreeParentCwd ?? null,
      worktreeBranch ?? null
    ) as WorkspaceRow | undefined
  if (!row) throw new Error(`createWorkspace: INSERT RETURNING returned nothing`)
  const workspace = rowToWorkspaceRecord(row)
  broadcastWorkspaceCreated(workspace)
  return workspace
}

export function listWorkspacesForProject(
  projectId: string,
  options?: { scope?: 'active' | 'archived' | 'all' }
): WorkspaceRecord[] {
  const db = getDb()
  const scope = options?.scope ?? 'active'
  const archiveFilter =
    scope === 'active'
      ? 'AND archived_at IS NULL'
      : scope === 'archived'
        ? 'AND archived_at IS NOT NULL'
        : ''

  const rows = db
    .prepare(
      `SELECT * FROM workspaces
       WHERE project_id = ? ${archiveFilter}
       ORDER BY sort_order ASC NULLS LAST, created_at DESC`
    )
    .all(projectId) as WorkspaceRow[]

  return rows.map(rowToWorkspaceRecord)
}

export function getWorkspace(id: string): WorkspaceRecord | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
    | WorkspaceRow
    | undefined
  return row ? rowToWorkspaceRecord(row) : null
}

export function openWorkspace(id: string): WorkspaceRecord {
  const db = getDb()
  const row = db
    .prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ? RETURNING *')
    .get(Date.now(), id) as WorkspaceRow | undefined
  if (!row) throw new Error(`workspace not found: ${id}`)
  return rowToWorkspaceRecord(row)
}

export function setWorkspacePinned(id: string, pinned: boolean): WorkspaceRecord {
  const db = getDb()
  const pinnedAt = pinned ? Date.now() : null
  const row = db
    .prepare('UPDATE workspaces SET pinned_at = ? WHERE id = ? RETURNING *')
    .get(pinnedAt, id) as WorkspaceRow | undefined
  if (!row) throw new Error(`workspace not found: ${id}`)
  return rowToWorkspaceRecord(row)
}

/**
 * "Archive" is a misnomer post-v34 — the archive concept is gone. Calling
 * this just deletes the workspace row entirely.
 *
 * Rationale: an Archived list of placeholder workspaces (no title, no
 * session) reads as duplication and is impossible to make trustworthy.
 * The underlying Claude transcripts on disk (~/.claude/projects/.../*.jsonl)
 * are never touched — those still surface in the Sessions panel and can be
 * resumed into a fresh workspace whenever the user wants to come back.
 *
 * Kept named archiveWorkspace because the IPC channel + UI action names
 * are still "Archive" from the user's vocabulary perspective. Internally
 * it's just deletion.
 *
 * For worktree-backed workspaces (`worktreeParentCwd != null`), the git
 * worktree is removed BEFORE the row is deleted. If the worktree is dirty
 * and `force` is false, the function returns early with `{ archived: false,
 * wasDirty: true }` and the row is NOT deleted — caller must re-invoke with
 * force:true after user confirmation. The branch is never deleted.
 *
 * Returns `{ archived: true, wasDirty: false }` on success, or
 * `{ archived: false, wasDirty: true }` when blocked by an unforced dirty
 * worktree.
 */
export async function archiveWorkspace(
  id: string,
  force: boolean = false
): Promise<{ archived: boolean; wasDirty: boolean }> {
  const db = getDb()
  // Fetch the full workspace record so we have worktreeParentCwd + cwd.
  const ws = db
    .prepare('SELECT id, project_id, cwd, worktree_parent_cwd FROM workspaces WHERE id = ?')
    .get(id) as
    | { id: string; project_id: string; cwd: string; worktree_parent_cwd: string | null }
    | undefined

  // Worktree teardown: must happen before the row DELETE.
  if (ws?.worktree_parent_cwd) {
    const r = await withRepoLock(ws.worktree_parent_cwd, () =>
      removeWorktree({ path: ws.cwd, force })
    )
    if (!r.removed && r.wasDirty && !force) {
      // Dirty worktree, no force — block the delete and let the caller escalate.
      return { archived: false, wasDirty: true }
    }
    // Either removed cleanly or forced (r.removed === true). Proceed to delete.
  }

  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  // Evict the settings cache entry so a stale value can't be served after the
  // row is gone.
  invalidateClaudeWorkspaceSettingsCache(id)
  // Broadcast after delete so the renderer can remove the row from state and
  // navigate away if the deleted workspace was currently selected.
  if (ws) {
    broadcastWorkspaceArchived(ws.id, ws.project_id)
  }
  return { archived: true, wasDirty: false }
}

export function closeWorkspace(id: string, lastTitle: string | null): WorkspaceRecord | undefined {
  const db = getDb()
  const row = db
    .prepare(
      'UPDATE workspaces SET closed_at = ?, last_title = COALESCE(?, last_title) WHERE id = ? RETURNING *'
    )
    .get(Date.now(), lastTitle, id) as WorkspaceRow | undefined
  if (!row) return undefined
  const record = rowToWorkspaceRecord(row)
  broadcastWorkspaceChanged(record)
  return record
}

export function reopenWorkspace(id: string): WorkspaceRecord | undefined {
  const db = getDb()
  const row = db
    .prepare('UPDATE workspaces SET closed_at = NULL WHERE id = ? RETURNING *')
    .get(id) as WorkspaceRow | undefined
  if (!row) return undefined
  const record = rowToWorkspaceRecord(row)
  broadcastWorkspaceChanged(record)
  return record
}

export function renameWorkspace(id: string, name: string): WorkspaceRecord {
  const db = getDb()
  // Sanitize BEFORE the existence check so a bad name (empty/whitespace-only)
  // is rejected with 'name cannot be empty' even for a nonexistent id — the
  // sanitize error is the more specific/actionable one for a malformed rename
  // payload, while a genuinely missing workspace still surfaces below.
  const sanitizedName = sanitizeWorkspaceName(name)
  const row = db
    .prepare('UPDATE workspaces SET name = ?, name_is_auto = 0 WHERE id = ? RETURNING *')
    .get(sanitizedName, id) as WorkspaceRow | undefined
  if (!row) throw new Error(`workspace not found: ${id}`)
  return rowToWorkspaceRecord(row)
}

export function reorderWorkspaces(projectId: string, orderedIds: string[]): void {
  const db = getDb()
  const tx = db.transaction((ids: string[]) => {
    const stmt = db.prepare('UPDATE workspaces SET sort_order = ? WHERE id = ? AND project_id = ?')
    ids.forEach((id, idx) => stmt.run(idx, id, projectId))
  })
  tx(orderedIds)
}

// ---------------------------------------------------------------------------
// Last terminal title — written each time libghostty dispatches an OSC title,
// read at app start to seed the in-memory workspaceTitles map so the sidebar
// shows the prior title instead of "New workspace" until Claude re-emits one.
// ---------------------------------------------------------------------------

export function setWorkspaceLastTitle(id: string, title: string | null): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET last_title = ? WHERE id = ?').run(title, id)
}

export function getAllWorkspaceLastTitles(): Array<{ id: string; title: string }> {
  const db = getDb()
  const rows = db
    .prepare(
      "SELECT id, last_title FROM workspaces WHERE last_title IS NOT NULL AND last_title != ''"
    )
    .all() as Array<{ id: string; last_title: string }>
  return rows.map((r) => ({ id: r.id, title: r.last_title }))
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const VALID_STATUSES: WorkspaceStatus[] = [
  'in_progress',
  'awaiting_input',
  'attention',
  'idle',
  'archived'
]

/**
 * On app launch no claude processes are running yet, so any non-archived
 * runtime status persisted from a prior session is stale by definition.
 * Demote everything except 'archived' to 'idle' so the Workspaces kanban lands
 * each row in "Waiting" until the user actually activates it and a SessionStart
 * hook dispatches a fresh status. Without this, workspaces shown as
 * in_progress / attention / awaiting_input from the prior session would
 * surface as forever-thinking, attention-needed, or ready-to-go before the
 * user has done anything.
 */
export function resetTransientStatusesOnStartup(): number {
  const db = getDb()
  const res = db.prepare("UPDATE workspaces SET status = 'idle' WHERE status != 'archived'").run()
  return res.changes
}

export function setWorkspaceStatus(id: string, status: WorkspaceStatus): WorkspaceRecord {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`)
  }
  const db = getDb()
  // Sync archived_at with status. Transitioning to 'archived' sets archived_at;
  // transitioning AWAY from 'archived' clears it.
  let row: WorkspaceRow | undefined
  if (status === 'archived') {
    row = db
      .prepare(
        'UPDATE workspaces SET status = ?, archived_at = COALESCE(archived_at, ?) WHERE id = ? RETURNING *'
      )
      .get(status, Date.now(), id) as WorkspaceRow | undefined
  } else {
    row = db
      .prepare('UPDATE workspaces SET status = ?, archived_at = NULL WHERE id = ? RETURNING *')
      .get(status, id) as WorkspaceRow | undefined
  }
  if (!row) throw new Error(`workspace not found: ${id}`)
  return rowToWorkspaceRecord(row)
}

// ---------------------------------------------------------------------------
// Worktree workspace queries (v64+)
// ---------------------------------------------------------------------------

/**
 * Count the number of worktree-backed workspaces for a project.
 * Used pre-delete to decide whether to show the "Also delete worktrees" checkbox.
 */
export function countWorktreeWorkspaces(projectId: string): number {
  const db = getDb()
  const row = db
    .prepare(
      'SELECT COUNT(*) AS cnt FROM workspaces WHERE project_id = ? AND worktree_parent_cwd IS NOT NULL'
    )
    .get(projectId) as { cnt: number } | undefined
  return row?.cnt ?? 0
}

/**
 * Return the cwd + worktreeParentCwd for all worktree-backed workspaces of a
 * project. Used by the project-delete IPC handler to enumerate worktrees that
 * need teardown before the cascade-delete.
 */
export function listWorktreeWorkspaces(
  projectId: string
): Array<{ id: string; cwd: string; worktreeParentCwd: string }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, cwd, worktree_parent_cwd FROM workspaces
       WHERE project_id = ? AND worktree_parent_cwd IS NOT NULL`
    )
    .all(projectId) as Array<{ id: string; cwd: string; worktree_parent_cwd: string }>
  return rows.map((r) => ({ id: r.id, cwd: r.cwd, worktreeParentCwd: r.worktree_parent_cwd }))
}

// ---------------------------------------------------------------------------
// Worktree cwd update (v64+)
// ---------------------------------------------------------------------------

/**
 * Update the cwd of a workspace row. Used by reconcileWorktree when the
 * recreated worktree lands at a suffixed path (e.g. `slug-2`) different from
 * the stored cwd.
 */
export function setWorkspaceCwd(id: string, cwd: string): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET cwd = ? WHERE id = ?').run(cwd, id)
}

/**
 * Convert a worktree-backed workspace into a plain local workspace.
 *
 * Sets cwd to the old worktreeParentCwd (the main repo root) and nulls out
 * both worktree fields. Does NOT delete the branch or the worktree directory —
 * that is left to the user. Broadcasts workspaces:changed so the renderer
 * picks up the mutation immediately.
 */
export function convertWorktreeToLocal(id: string): WorkspaceRecord {
  const db = getDb()
  // Read current row to get worktreeParentCwd before we overwrite it.
  const current = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
    | WorkspaceRow
    | undefined
  if (!current) throw new Error(`convertWorktreeToLocal: workspace not found: ${id}`)
  if (!current.worktree_parent_cwd) {
    throw new Error(`convertWorktreeToLocal: workspace ${id} is not a worktree workspace`)
  }
  const parentCwd = current.worktree_parent_cwd
  const row = db
    .prepare(
      'UPDATE workspaces SET cwd = ?, worktree_parent_cwd = NULL, worktree_branch = NULL WHERE id = ? RETURNING *'
    )
    .get(parentCwd, id) as WorkspaceRow | undefined
  if (!row) throw new Error(`convertWorktreeToLocal: UPDATE returned nothing for id: ${id}`)
  const record = rowToWorkspaceRecord(row)
  broadcastWorkspaceChanged(record)
  return record
}

// ---------------------------------------------------------------------------
// Claude session tracking (v26)
// ---------------------------------------------------------------------------

export function setWorkspaceClaudeSessionId(id: string, sessionId: string | null): void {
  const db = getDb()
  db.prepare('UPDATE workspaces SET claude_session_id = ? WHERE id = ?').run(sessionId, id)
}

// ---------------------------------------------------------------------------
// Pinned items
// ---------------------------------------------------------------------------

export function listAllPinned(): PinnedItem[] {
  const db = getDb()

  const rows = db
    .prepare(
      `SELECT w.*, p.id as p_id, p.path as p_path, p.name as p_name,
              p.claude_encoded_name as p_claude_encoded_name,
              p.added_at as p_added_at, p.last_opened_at as p_last_opened_at,
              p.expanded_in_sidebar as p_expanded_in_sidebar,
              p.sort_order as p_sort_order,
              p.pinned_at as p_pinned_at
       FROM workspaces w
       JOIN projects p ON p.id = w.project_id
       WHERE w.pinned_at IS NOT NULL
         AND w.archived_at IS NULL
       ORDER BY w.pinned_at DESC`
    )
    .all() as (WorkspaceRow & {
    p_id: string
    p_path: string
    p_name: string
    p_claude_encoded_name: string | null
    p_added_at: number
    p_last_opened_at: number | null
    p_expanded_in_sidebar: number
    p_sort_order: number | null
    p_pinned_at: number | null
  })[]

  return rows.map((row) => ({
    workspace: rowToWorkspaceRecord(row),
    project: rowToProjectRecord({
      id: row.p_id,
      path: row.p_path,
      name: row.p_name,
      claude_encoded_name: row.p_claude_encoded_name,
      added_at: row.p_added_at,
      last_opened_at: row.p_last_opened_at,
      expanded_in_sidebar: row.p_expanded_in_sidebar,
      sort_order: row.p_sort_order,
      pinned_at: row.p_pinned_at,
      github_owner: null,
      github_repo: null,
      github_avatar_url: null,
      github_checked_at: null
    })
  }))
}

// ---------------------------------------------------------------------------
// Workspace lineage (v64)
// ---------------------------------------------------------------------------

/**
 * List all direct children of the given workspace (workspaces whose
 * parent_workspace_id === parentId). Excludes archived workspaces.
 */
export function listChildWorkspaces(parentId: string): WorkspaceRecord[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM workspaces
       WHERE parent_workspace_id = ? AND archived_at IS NULL
       ORDER BY sort_order ASC NULLS LAST, created_at DESC`
    )
    .all(parentId) as WorkspaceRow[]
  return rows.map(rowToWorkspaceRecord)
}

/**
 * Return the root-to-node ancestry path for the given workspace by walking
 * parent_workspace_id upward. The returned array is ordered from the root
 * ancestor down to (and including) the workspace itself.
 *
 * A visited set guards against cycles in malformed data — if a cycle is
 * detected the walk stops and the partial path is returned.
 */
export function getWorkspaceLineage(id: string): WorkspaceRecord[] {
  const db = getDb()
  const visited = new Set<string>()
  const path: WorkspaceRecord[] = []

  let currentId: string | null = id
  while (currentId !== null) {
    if (visited.has(currentId)) {
      // Cycle detected — stop the walk
      break
    }
    visited.add(currentId)
    const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(currentId) as
      | WorkspaceRow
      | undefined
    if (!row) break
    path.unshift(rowToWorkspaceRecord(row))
    currentId = row.parent_workspace_id ?? null
  }

  return path
}
