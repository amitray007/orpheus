import { getDb } from './db'
import type { ProjectRecord } from '../shared/types'
import { importSessionsForProject } from './sessions'
import { createWorkspace } from './workspaces'
import { refreshGithubData } from './githubAvatar'
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
  expanded_in_sidebar: number
  sort_order: number | null
  // v37
  github_owner: string | null
  github_repo: string | null
  github_avatar_url: string | null
  github_checked_at: number | null
}

function rowToRecord(row: ProjectRow): ProjectRecord {
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

export function listProjects(): ProjectRecord[] {
  const db = getDb()
  // Stable ordering: explicit sort_order first (NULLS LAST), then added_at DESC.
  // last_opened_at is intentionally NOT a tiebreaker — using it reshuffles the
  // sidebar every time a project is opened, which makes positions feel random
  // across restarts. added_at never changes after insert.
  const rows = db
    .prepare(
      `SELECT * FROM projects
       ORDER BY sort_order ASC NULLS LAST, added_at DESC`
    )
    .all() as ProjectRow[]
  return rows.map(rowToRecord)
}

export function reorderProjects(orderedIds: string[]): void {
  const db = getDb()
  const tx = db.transaction((ids: string[]) => {
    const stmt = db.prepare('UPDATE projects SET sort_order = ? WHERE id = ?')
    ids.forEach((id, idx) => stmt.run(idx, id))
  })
  tx(orderedIds)
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

  const project = insertProjectAndSessions()

  // Fire-and-forget: fetch GitHub avatar in the background after insert.
  void refreshGithubData(project.id).catch((err) => {
    console.warn('[github] initial avatar fetch failed for', project.id, err)
  })

  return project
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

export function setProjectExpandedInSidebar(id: string, expanded: boolean): void {
  const db = getDb()
  db.prepare('UPDATE projects SET expanded_in_sidebar = ? WHERE id = ?').run(expanded ? 1 : 0, id)
}

