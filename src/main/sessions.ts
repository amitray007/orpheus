import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { getDb } from './db'
import type { ProjectRecord, SessionRecord, SessionStatus } from '../shared/types'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type SessionRow = {
  id: string
  project_id: string
  jsonl_path: string
  title: string | null
  status: SessionStatus
  created_at: number
  updated_at: number
  archived_at: number | null
  model: string | null
  last_message_role: string | null
}

function rowToRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jsonlPath: row.jsonl_path,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    model: row.model,
    lastMessageRole: row.last_message_role
  }
}

// ---------------------------------------------------------------------------
// Title extraction
// ---------------------------------------------------------------------------

const MAX_BYTES = 200 * 1024 // 200 KB
const MAX_TITLE_LENGTH = 60

/**
 * Reads up to MAX_BYTES from the JSONL file, scans line-by-line for the first
 * user message, and extracts a title string from its content.
 * Returns null on any failure so the caller can use the session UUID prefix.
 */
function extractTitle(jsonlPath: string): string | null {
  try {
    const fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(MAX_BYTES)
    const bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES, 0)
    fs.closeSync(fd)

    const text = buf.slice(0, bytesRead).toString('utf-8')
    const lines = text.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        continue
      }

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        (parsed as Record<string, unknown>)['role'] !== 'user'
      ) {
        continue
      }

      const content = (parsed as Record<string, unknown>)['content']
      let raw: string | null = null

      if (typeof content === 'string') {
        raw = content
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (
            typeof part === 'object' &&
            part !== null &&
            (part as Record<string, unknown>)['type'] === 'text'
          ) {
            const t = (part as Record<string, unknown>)['text']
            if (typeof t === 'string') {
              raw = t
              break
            }
          }
        }
      }

      if (raw) {
        const trimmedRaw = raw.trim()
        return trimmedRaw.length > MAX_TITLE_LENGTH
          ? trimmedRaw.slice(0, MAX_TITLE_LENGTH) + '…'
          : trimmedRaw
      }
    }
  } catch {
    // Any IO / parse error → null, caller uses fallback
  }
  return null
}

// ---------------------------------------------------------------------------
// Model + last_message_role extraction
// ---------------------------------------------------------------------------

function extractModel(jsonlPath: string): string | null {
  try {
    const fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(MAX_BYTES)
    const bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES, 0)
    fs.closeSync(fd)

    const text = buf.slice(0, bytesRead).toString('utf-8')
    const lines = text.split('\n')

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        if (typeof parsed['model'] === 'string') return parsed['model']
      } catch {
        continue
      }
    }
  } catch {
    // ignore
  }
  return null
}

function extractLastMessageRole(jsonlPath: string): string | null {
  try {
    // Read last chunk for efficiency
    const stat = fs.statSync(jsonlPath)
    const fileSize = stat.size
    const readSize = Math.min(fileSize, MAX_BYTES)
    const offset = fileSize - readSize

    const fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(readSize)
    fs.readSync(fd, buf, 0, readSize, offset)
    fs.closeSync(fd)

    const text = buf.toString('utf-8')
    const lines = text.split('\n').reverse()

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        if (typeof parsed['role'] === 'string') return parsed['role']
      } catch {
        continue
      }
    }
  } catch {
    // ignore
  }
  return null
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Scans the Claude Code project directory for .jsonl session files and
 * inserts them into the sessions table (INSERT OR IGNORE — idempotent).
 * Wrapped in a transaction by the caller (addProject).
 */
export function importSessionsForProject(project: ProjectRecord): SessionRecord[] {
  if (!project.claudeEncodedName) return []

  const dir = nodePath.join(os.homedir(), '.claude', 'projects', project.claudeEncodedName)
  if (!fs.existsSync(dir)) return []

  const db = getDb()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO sessions
       (id, project_id, jsonl_path, title, status, created_at, updated_at, model, last_message_role)
     VALUES (?, ?, ?, ?, 'in_review', ?, ?, ?, ?)`
  )

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue

    const sessionId = entry.name.replace(/\.jsonl$/, '')
    const jsonlPath = nodePath.join(dir, entry.name)

    let mtime: number
    try {
      mtime = Math.floor(fs.statSync(jsonlPath).mtimeMs)
    } catch {
      mtime = Date.now()
    }

    const title = extractTitle(jsonlPath)
    const model = extractModel(jsonlPath)
    const lastMessageRole = extractLastMessageRole(jsonlPath)

    try {
      insert.run(sessionId, project.id, jsonlPath, title, mtime, mtime, model, lastMessageRole)
    } catch {
      // Ignore individual row failures (e.g. malformed UUID)
    }
  }

  return listSessionsForProject(project.id)
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function listSessionsForProject(
  projectId: string,
  options?: { includeArchived?: boolean }
): SessionRecord[] {
  const db = getDb()

  // Status ordering: in_progress → in_review → archived
  const statusOrder = `CASE status
    WHEN 'in_progress' THEN 0
    WHEN 'in_review' THEN 1
    WHEN 'archived' THEN 2
    ELSE 3
  END`

  const includeArchived = options?.includeArchived ?? false
  const archivedFilter = includeArchived ? '' : `AND status != 'archived'`

  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE project_id = ? ${archivedFilter}
       ORDER BY ${statusOrder}, updated_at DESC`
    )
    .all(projectId) as SessionRow[]

  return rows.map(rowToRecord)
}

export function listAllSessions(filter?: { status?: SessionStatus }): SessionRecord[] {
  const db = getDb()

  const statusOrder = `CASE s.status
    WHEN 'in_progress' THEN 0
    WHEN 'in_review' THEN 1
    WHEN 'archived' THEN 2
    ELSE 3
  END`

  let whereClause = 'WHERE p.archived_at IS NULL'
  const params: unknown[] = []

  if (filter?.status) {
    whereClause += ' AND s.status = ?'
    params.push(filter.status)
  }

  const rows = db
    .prepare(
      `SELECT s.* FROM sessions s
       JOIN projects p ON p.id = s.project_id
       ${whereClause}
       ORDER BY ${statusOrder}, s.updated_at DESC`
    )
    .all(...params) as SessionRow[]

  return rows.map(rowToRecord)
}

export function setSessionStatus(id: string, status: SessionStatus): void {
  const db = getDb()
  const now = Date.now()

  if (status === 'archived') {
    db.prepare(
      `UPDATE sessions SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?`
    ).run(status, now, now, id)
  } else {
    db.prepare(
      `UPDATE sessions SET status = ?, archived_at = NULL, updated_at = ? WHERE id = ?`
    ).run(status, now, id)
  }
}
