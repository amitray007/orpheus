import { getDb } from './db'
import type { WorkspaceRecord, PinnedItem, ProjectRecord } from '../shared/types'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type WorkspaceRow = {
  id: string
  project_id: string
  name: string
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
  archived_at: number | null
  pinned_at: number | null
}

function rowToWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
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
    archivedAt: row.archived_at,
    pinnedAt: row.pinned_at
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
  options?: { includeArchived?: boolean }
): WorkspaceRecord[] {
  const db = getDb()
  const includeArchived = options?.includeArchived ?? false
  const archivedFilter = includeArchived ? '' : 'AND archived_at IS NULL'

  const rows = db
    .prepare(
      `SELECT * FROM workspaces
       WHERE project_id = ? ${archivedFilter}
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
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, id)
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow
  return rowToWorkspaceRecord(row)
}

// ---------------------------------------------------------------------------
// Pinned items
// ---------------------------------------------------------------------------

export function listAllPinned(): PinnedItem[] {
  const db = getDb()

  const pinnedWorkspaceRows = db
    .prepare(
      `SELECT w.*, p.id as p_id, p.path as p_path, p.name as p_name,
              p.claude_encoded_name as p_claude_encoded_name,
              p.added_at as p_added_at, p.last_opened_at as p_last_opened_at,
              p.archived_at as p_archived_at, p.pinned_at as p_pinned_at
       FROM workspaces w
       JOIN projects p ON p.id = w.project_id
       WHERE w.pinned_at IS NOT NULL
         AND p.archived_at IS NULL
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
      p_archived_at: number | null
      p_pinned_at: number | null
    })[]

  const pinnedProjectRows = db
    .prepare(
      `SELECT * FROM projects
       WHERE pinned_at IS NOT NULL AND archived_at IS NULL
       ORDER BY pinned_at DESC`
    )
    .all() as ProjectRow[]

  const workspaceItems: PinnedItem[] = pinnedWorkspaceRows.map((row) => ({
    kind: 'workspace' as const,
    workspace: rowToWorkspaceRecord(row),
    project: rowToProjectRecord({
      id: row.p_id,
      path: row.p_path,
      name: row.p_name,
      claude_encoded_name: row.p_claude_encoded_name,
      added_at: row.p_added_at,
      last_opened_at: row.p_last_opened_at,
      archived_at: row.p_archived_at,
      pinned_at: row.p_pinned_at
    })
  }))

  const projectItems: PinnedItem[] = pinnedProjectRows.map((row) => ({
    kind: 'project' as const,
    project: rowToProjectRecord(row)
  }))

  // Combine and sort by pinned_at DESC
  const all: (PinnedItem & { _pinnedAt: number })[] = [
    ...workspaceItems.map((item) => ({
      ...item,
      _pinnedAt: (item as { kind: 'workspace'; workspace: WorkspaceRecord; project: ProjectRecord }).workspace.pinnedAt!
    })),
    ...projectItems.map((item) => ({
      ...item,
      _pinnedAt: (item as { kind: 'project'; project: ProjectRecord }).project.pinnedAt!
    }))
  ]

  all.sort((a, b) => b._pinnedAt - a._pinnedAt)

  return all.map(({ _pinnedAt: _, ...item }) => item as PinnedItem)
}
