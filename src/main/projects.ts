import { getDb } from './db'
import type { ProjectRecord } from '../shared/types'
import { importSessionsForProject } from './sessions'
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
  archived_at: number | null
}

function rowToRecord(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    claudeEncodedName: row.claude_encoded_name,
    addedAt: row.added_at,
    lastOpenedAt: row.last_opened_at,
    archivedAt: row.archived_at
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
       WHERE archived_at IS NULL
       ORDER BY last_opened_at DESC NULLS LAST, added_at DESC`
    )
    .all() as ProjectRow[]
  return rows.map(rowToRecord)
}

export function addProject(path: string): ProjectRecord {
  const db = getDb()

  // Dedup: if an active (non-archived) project with this path exists, bump
  // last_opened_at and return it instead of inserting a duplicate.
  const existing = db
    .prepare('SELECT * FROM projects WHERE path = ? AND archived_at IS NULL')
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

  // Insert project + import its sessions atomically.
  const insertProjectAndSessions = db.transaction(() => {
    db.prepare(
      `INSERT INTO projects (id, path, name, claude_encoded_name, added_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, path, name, claudeEncodedName, addedAt)

    const newProject = rowToRecord(
      db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow
    )
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

export function archiveProject(id: string): void {
  const db = getDb()
  db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(Date.now(), id)
}

export function renameProject(id: string, name: string): void {
  const db = getDb()
  db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(name, id)
}
