import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { getDb } from './db'
import { createWorkspace, getWorkspace, setWorkspaceClaudeSessionId } from './workspaces'
import type {
  ProjectRecord,
  SessionRecord,
  SessionStatus,
  SessionsPagedRequest,
  SessionsPagedResult,
  WorkspaceRecord
} from '../shared/types'

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
 *
 * Handles Claude Code transcript shape:
 *   { "type": "user", "message": { "role": "user", "content": "..." | [{type,text,...}] } }
 *
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
        (parsed as Record<string, unknown>)['type'] !== 'user'
      ) {
        continue
      }

      const message = (parsed as Record<string, unknown>)['message']
      if (typeof message !== 'object' || message === null) continue

      const content = (message as Record<string, unknown>)['content']
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
        // Claude Code shape: { "type": "assistant", "message": { "model": "claude-..." } }
        if (parsed['type'] !== 'assistant') continue
        const message = parsed['message']
        if (typeof message !== 'object' || message === null) continue
        const model = (message as Record<string, unknown>)['model']
        if (typeof model === 'string' && model.length > 0) return model
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
        // Claude Code shape: top-level "type" is "user" | "assistant"
        const type = parsed['type']
        if (type !== 'user' && type !== 'assistant') continue
        const message = parsed['message']
        if (typeof message !== 'object' || message === null) continue
        const role = (message as Record<string, unknown>)['role']
        if (typeof role === 'string') return role
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
 * Shared helper: scan a Claude project directory and INSERT any .jsonl files
 * not yet in the sessions table. Returns the list of inserted session IDs.
 */
function upsertSessionFilesForProject(
  projectId: string,
  dir: string
): void {
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
    return
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
      insert.run(sessionId, projectId, jsonlPath, title, mtime, mtime, model, lastMessageRole)
    } catch {
      // Ignore individual row failures (e.g. malformed UUID)
    }
  }
}

/**
 * Scans the Claude Code project directory for .jsonl session files and
 * inserts them into the sessions table (INSERT OR IGNORE — idempotent).
 * Wrapped in a transaction by the caller (addProject).
 */
export function importSessionsForProject(project: ProjectRecord): SessionRecord[] {
  if (!project.claudeEncodedName) return []

  const dir = nodePath.join(os.homedir(), '.claude', 'projects', project.claudeEncodedName)
  if (!fs.existsSync(dir)) return []

  upsertSessionFilesForProject(project.id, dir)

  return listSessionsForProject(project.id)
}

/**
 * For all sessions in a project where title / model / last_message_role is NULL,
 * re-runs the extractors and fills in the missing values.
 * Also scans for new .jsonl files not yet in the sessions table and inserts them.
 */
export function refreshSessionMetadata(projectId: string): void {
  const db = getDb()

  // Pull the claudeEncodedName for this project so we can scan for new files.
  const projectRow = db
    .prepare('SELECT claude_encoded_name FROM projects WHERE id = ?')
    .get(projectId) as { claude_encoded_name: string | null } | undefined

  if (projectRow?.claude_encoded_name) {
    const dir = nodePath.join(os.homedir(), '.claude', 'projects', projectRow.claude_encoded_name)
    if (fs.existsSync(dir)) {
      upsertSessionFilesForProject(projectId, dir)
    }
  }

  // Now backfill any NULL metadata columns.
  type NullMetaRow = { id: string; jsonl_path: string }
  const rows = db
    .prepare(
      `SELECT id, jsonl_path FROM sessions
       WHERE project_id = ?
         AND (title IS NULL OR model IS NULL OR last_message_role IS NULL)`
    )
    .all(projectId) as NullMetaRow[]

  const updateStmt = db.prepare(
    `UPDATE sessions
     SET title              = COALESCE(title,              ?),
         model              = COALESCE(model,              ?),
         last_message_role  = COALESCE(last_message_role,  ?)
     WHERE id = ?`
  )

  for (const row of rows) {
    const title = extractTitle(row.jsonl_path)
    const model = extractModel(row.jsonl_path)
    const lastMessageRole = extractLastMessageRole(row.jsonl_path)
    try {
      updateStmt.run(title, model, lastMessageRole, row.id)
    } catch {
      // Ignore individual row failures
    }
  }
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

// Whitelist for sortBy to prevent any SQL injection via column name interpolation.
const SORT_COLUMN_MAP: Record<string, string> = {
  updatedAt: 'updated_at',
  createdAt: 'created_at',
  title: 'title'
}

export function listSessionsForProjectPaged(req: SessionsPagedRequest): SessionsPagedResult {
  const db = getDb()

  const limit = req.limit ?? 25
  const offset = req.offset ?? 0
  const sortDir = req.sortDir === 'asc' ? 'ASC' : 'DESC'
  const sortCol = SORT_COLUMN_MAP[req.sortBy ?? 'updatedAt'] ?? 'updated_at'

  // Build WHERE clause incrementally — archived rows excluded by default.
  const conditions: string[] = ['project_id = ?', "status != 'archived'"]
  const params: unknown[] = [req.projectId]

  if (req.search) {
    conditions.push("LOWER(title) LIKE '%' || LOWER(?) || '%'")
    params.push(req.search)
  }
  if (req.dateFrom !== undefined) {
    conditions.push('updated_at >= ?')
    params.push(req.dateFrom)
  }
  if (req.dateTo !== undefined) {
    conditions.push('updated_at <= ?')
    params.push(req.dateTo)
  }

  const where = 'WHERE ' + conditions.join(' AND ')

  // COUNT first, then paginated SELECT — two statements for clarity.
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM sessions ${where}`)
    .get(...params) as { total: number }

  // NULLS LAST: for title sort we want nulls at the end regardless of direction.
  const nullsLast = sortCol === 'title' ? ' NULLS LAST' : ''
  const rows = db
    .prepare(
      `SELECT * FROM sessions ${where}
       ORDER BY ${sortCol} ${sortDir}${nullsLast}
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as SessionRow[]

  return { rows: rows.map(rowToRecord), total }
}

export function setSessionStatus(id: string, status: SessionStatus): void {
  const db = getDb()
  const now = Date.now()

  if (status === 'archived') {
    db.prepare(`UPDATE sessions SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?`).run(
      status,
      now,
      now,
      id
    )
  } else {
    db.prepare(
      `UPDATE sessions SET status = ?, archived_at = NULL, updated_at = ? WHERE id = ?`
    ).run(status, now, id)
  }
}

// ---------------------------------------------------------------------------
// Resume in new workspace
// ---------------------------------------------------------------------------

type ProjectPathRow = { id: string; path: string; name: string }

/**
 * Creates a fresh workspace pre-wired with `claude_session_id = sessionId` so
 * that the first terminal mount will launch claude with `--resume <sessionId>`.
 * No schema changes needed — claude_session_id already exists on workspaces (v26)
 * and composeClaudeLaunch already emits --resume when it is set.
 */
export function createWorkspaceResumingSession(
  projectId: string,
  sessionId: string
): WorkspaceRecord {
  const db = getDb()

  const project = db.prepare('SELECT id, path, name FROM projects WHERE id = ?').get(projectId) as
    | ProjectPathRow
    | undefined

  if (!project) {
    throw new Error(`Project not found: ${projectId}`)
  }

  // Derive a human-readable name from the session title when available.
  const sessionRow = db.prepare('SELECT title FROM sessions WHERE id = ?').get(sessionId) as
    | { title: string | null }
    | undefined

  const shortId = sessionId.slice(0, 8)
  const rawTitle = sessionRow?.title
  const workspaceName = rawTitle
    ? rawTitle.length > 40
      ? rawTitle.slice(0, 40) + '…'
      : rawTitle
    : `Resume ${shortId}`

  const ws = createWorkspace({ projectId, name: workspaceName, cwd: project.path })

  // Pre-seed the session ID so composeClaudeLaunch includes --resume on first mount.
  setWorkspaceClaudeSessionId(ws.id, sessionId)

  // Re-fetch via the public accessor to get the updated claudeSessionId.
  const refreshed = getWorkspace(ws.id)
  if (!refreshed) {
    throw new Error(`Workspace disappeared immediately after creation: ${ws.id}`)
  }
  return refreshed
}
