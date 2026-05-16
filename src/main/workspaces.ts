import { getDb } from './db'
import type { WorkspaceRecord, WorkspaceStatus, PinnedItem, ProjectRecord } from '../shared/types'

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
  status: WorkspaceStatus
  sort_order: number | null
  claude_session_id: string | null
  last_title: string | null
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
    status: row.status ?? 'idle',
    sortOrder: row.sort_order ?? null,
    claudeSessionId: row.claude_session_id ?? null
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
    // v37
    githubOwner: row.github_owner ?? null,
    githubRepo: row.github_repo ?? null,
    githubAvatarUrl: row.github_avatar_url ?? null,
    githubCheckedAt: row.github_checked_at ?? null
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function createWorkspace({
  projectId,
  name,
  cwd
}: {
  projectId: string
  name: string
  cwd: string
}): WorkspaceRecord {
  const db = getDb()
  const id = crypto.randomUUID()
  const createdAt = Date.now()

  // Pre-generate the claude session UUID at workspace creation so that the
  // very first launch can pass --session-id <uuid> to claude (deterministic).
  // Subsequent launches detect that ~/.claude/projects/<cwd>/<uuid>.jsonl
  // exists and switch to --resume <uuid>. This eliminates the prior race
  // where quitting Orpheus within ~2s of the first message orphaned the
  // session (the post-mount filesystem poll never completed and the row's
  // claudeSessionId stayed null, so the next launch started fresh).
  const claudeSessionId = crypto.randomUUID()

  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, cwd, created_at, claude_session_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, name, cwd, createdAt, claudeSessionId)

  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
  return rowToWorkspaceRecord(row)
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
  db.prepare('UPDATE workspaces SET last_opened_at = ? WHERE id = ?').run(Date.now(), id)
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
  return rowToWorkspaceRecord(row)
}

export function setWorkspacePinned(id: string, pinned: boolean): WorkspaceRecord {
  const db = getDb()
  const pinnedAt = pinned ? Date.now() : null
  db.prepare('UPDATE workspaces SET pinned_at = ? WHERE id = ?').run(pinnedAt, id)
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
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
 */
export function archiveWorkspace(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
}

export function renameWorkspace(id: string, name: string): WorkspaceRecord {
  const db = getDb()
  db.prepare('UPDATE workspaces SET name = ?, name_is_auto = 0 WHERE id = ?').run(name, id)
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
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
 * On app launch no claude processes are running yet, so any workspace still
 * persisted as 'in_progress' or 'attention' is left over from a prior session
 * (e.g. crash, hard quit). Reset them to 'idle' so the UI doesn't show a
 * forever-spinning "thinking" indicator. Archived workspaces are untouched.
 */
export function resetTransientStatusesOnStartup(): number {
  const db = getDb()
  const res = db
    .prepare("UPDATE workspaces SET status = 'idle' WHERE status IN ('in_progress', 'attention')")
    .run()
  return res.changes
}

export function setWorkspaceStatus(id: string, status: WorkspaceStatus): WorkspaceRecord {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: ${status}`)
  }
  const db = getDb()
  // Sync archived_at with status. Transitioning to 'archived' sets archived_at;
  // transitioning AWAY from 'archived' clears it.
  if (status === 'archived') {
    db.prepare(
      'UPDATE workspaces SET status = ?, archived_at = COALESCE(archived_at, ?) WHERE id = ?'
    ).run(status, Date.now(), id)
  } else {
    db.prepare('UPDATE workspaces SET status = ?, archived_at = NULL WHERE id = ?').run(status, id)
  }
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
  return rowToWorkspaceRecord(row)
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
              p.sort_order as p_sort_order
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
      github_owner: null,
      github_repo: null,
      github_avatar_url: null,
      github_checked_at: null
    })
  }))
}
