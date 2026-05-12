import { getDb } from './db'
import type { WorkspaceRecord, PinnedItem, ProjectRecord } from '../shared/types'

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
}

type ProjectRow = {
  id: string
  path: string
  name: string
  claude_encoded_name: string | null
  added_at: number
  last_opened_at: number | null
  expanded_in_sidebar: number
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
    archivedAt: row.archived_at
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
    expandedInSidebar: row.expanded_in_sidebar === 1
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

  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, cwd, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, projectId, name, cwd, createdAt)

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
       ORDER BY created_at ASC`
    )
    .all(projectId) as WorkspaceRow[]

  return rows.map(rowToWorkspaceRecord)
}

export function getWorkspace(id: string): WorkspaceRecord | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
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

export function archiveWorkspace(id: string): WorkspaceRecord {
  const db = getDb()

  // Don't allow archiving the last non-archived workspace in the project
  const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
  if (!workspace) throw new Error(`Workspace ${id} not found`)

  const activeCount = (
    db
      .prepare(
        'SELECT COUNT(*) as count FROM workspaces WHERE project_id = ? AND archived_at IS NULL'
      )
      .get(workspace.project_id) as { count: number }
  ).count

  if (activeCount <= 1) {
    throw new Error('Cannot archive the last active workspace in a project')
  }

  db.prepare('UPDATE workspaces SET archived_at = ? WHERE id = ?').run(Date.now(), id)
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
  return rowToWorkspaceRecord(row)
}

export function renameWorkspace(id: string, name: string): WorkspaceRecord {
  const db = getDb()
  db.prepare('UPDATE workspaces SET name = ?, name_is_auto = 0 WHERE id = ?').run(name, id)
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
  return rowToWorkspaceRecord(row)
}

export function unarchiveWorkspace(id: string): WorkspaceRecord {
  const db = getDb()
  db.prepare('UPDATE workspaces SET archived_at = NULL WHERE id = ?').run(id)
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
  return rowToWorkspaceRecord(row)
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
              p.expanded_in_sidebar as p_expanded_in_sidebar
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
      expanded_in_sidebar: row.p_expanded_in_sidebar
    })
  }))
}
