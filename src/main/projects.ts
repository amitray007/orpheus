import { getDb } from './db'
import type { ProjectRecord } from '../shared/types'
import { importSessionsForProject } from './sessions'
import { createWorkspace } from './workspaces'
import * as nodePath from 'node:path'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type ProjectRow = {
  id: string
  path: string
  name: string
  claude_encoded_name: string | null
  added_at: number
  last_opened_at: number | null
  pinned_at: number | null
}

function rowToRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    claudeEncodedName: row.claude_encoded_name,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    pinnedAt: row.pinned_at
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listProjects(): ProjectRecord[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT * FROM projects
       ORDER BY last_opened_at DESC NULLS LAST, added_at DESC`
    )
    .all() as ProjectRow[]
  return rows.map(rowToRecord)
}

export function addProject(path: string): ProjectRecord {
  const db = getDb()

  // Dedup: if a project with this path already exists, bump last_opened_at
  // and return it instead of inserting a duplicate.
  const existing = db
    .prepare('SELECT * FROM projects WHERE path = ?')
    .get(path) as ProjectRow | undefined

  if (existing) {
    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), existing.id)
    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(existing.id) as ProjectRow
    return rowToRecord(updated)
  }

  const id = crypto.randomUUID()
  const name = nodePath.basename(path)
  // Encode absolute path to Claude Code's directory-name format: replace / with -
  const claudeEncodedName = path.replace(/\//g, '-')
  const addedAt = Date.now()

  // Insert project + default workspace + import its sessions atomically.
  const insertProjectAndSessions = db.transaction(() => {
    db.prepare(
      `INSERT INTO projects (id, path, name, claude_encoded_name, added_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, path, name, claudeEncodedName, addedAt)

    const newProject = rowToRecord(
      db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow
    )

    // Auto-create the Default workspace (cwd = project root)
    createWorkspace({ projectId: id, name: 'Default', cwd: path })

    // importSessionsForProject writes inside the same transaction
    importSessionsForProject(newProject)

    return newProject
  })

  return insertProjectAndSessions()
}

export function openProject(id: string): ProjectRecord {
  const db = getDb()
  db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run(Date.now(), id)
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow
  return rowToRecord(row)
}

export function deleteProject(id: string): void {
  const db = getDb()
  // ON DELETE CASCADE in the schema removes associated workspaces and sessions.
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)
}

export function renameProject(id: string, name: string): void {
  const db = getDb()
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
}

export function setProjectPinned(id: string, pinned: boolean): ProjectRecord {
  const db = getDb()
  const pinnedAt = pinned ? Date.now() : null
  db.prepare('UPDATE projects SET pinned_at = ? WHERE id = ?').run(pinnedAt, id)
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow
  return rowToRecord(row)
}
