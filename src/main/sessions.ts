import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import { getDb } from './db'
import { getAppUiState } from './uiState'
import { createWorkspace, getWorkspace, setWorkspaceClaudeSessionId } from './workspaces'
import { getPricing } from './pricing'
import { composeClaudeLaunch, getClaudeGlobalSettings } from './claudeSettings'
import { listWorktreePaths, NotAGitRepoError, resolveMainWorktree } from './worktrees'
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
  // v33
  message_count: number | null
  jsonl_size_bytes: number | null
  // v34
  last_message_preview: string | null
  // v35
  last_user_message_preview: string | null
  // v50
  jsonl_mtime: number | null
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
    lastMessageRole: row.last_message_role,
    messageCount: row.message_count,
    jsonlSizeBytes: row.jsonl_size_bytes,
    lastMessagePreview: row.last_message_preview,
    lastUserMessagePreview: row.last_user_message_preview,
    jsonlMtime: row.jsonl_mtime
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
    let bytesRead: number
    const buf = Buffer.allocUnsafe(MAX_BYTES)
    try {
      bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES, 0)
    } finally {
      fs.closeSync(fd)
    }

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
    let bytesRead: number
    const buf = Buffer.allocUnsafe(MAX_BYTES)
    try {
      bytesRead = fs.readSync(fd, buf, 0, MAX_BYTES, 0)
    } finally {
      fs.closeSync(fd)
    }

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
    try {
      fs.readSync(fd, buf, 0, readSize, offset)
    } finally {
      fs.closeSync(fd)
    }

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
// Message count + file size extraction (v33)
// ---------------------------------------------------------------------------

function extractMessageCount(jsonlPath: string): number | null {
  // Bounded read — same MAX_BYTES cap as extractTitle / extractLastMessagePreview.
  // On very long sessions this undercounts, but avoids loading unbounded files.
  try {
    const stat = fs.statSync(jsonlPath)
    const fileSize = stat.size
    const readSize = Math.min(fileSize, MAX_BYTES)
    // Read from the start so we count from the beginning of the conversation.
    const fd = fs.openSync(jsonlPath, 'r')
    const buf = Buffer.allocUnsafe(readSize)
    try {
      fs.readSync(fd, buf, 0, readSize, 0)
    } finally {
      fs.closeSync(fd)
    }
    const text = buf.toString('utf-8')
    const lines = text.split('\n')
    let count = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>
        const type = parsed['type']
        if (type === 'user' || type === 'assistant') count++
      } catch {
        // Skip unparseable lines
      }
    }
    return count
  } catch {
    return null
  }
}

function extractFileSize(jsonlPath: string): number | null {
  try {
    return fs.statSync(jsonlPath).size
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Preview constants (v34 / v35)
// ---------------------------------------------------------------------------

const MAX_PREVIEW_LENGTH = 100

// ---------------------------------------------------------------------------
// Single-pass extraction helpers
//
// Instead of opening the fd 5 separate times per JSONL file, we do at most
// 2 reads: one head read (~200KB from offset 0) for title/model/messageCount,
// and one tail read (~200KB from the end) for lastMessageRole/previews.
// The stat call is shared between the two reads.
// ---------------------------------------------------------------------------

type HeadExtracted = {
  title: string | null
  model: string | null
  messageCount: number
}

type TailExtracted = {
  lastMessageRole: string | null
  lastMessagePreview: string | null
  lastUserMessagePreview: string | null
}

function extractFromHead(text: string): HeadExtracted {
  const lines = text.split('\n')
  let title: string | null = null
  let model: string | null = null
  let messageCount = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }

    const type = parsed['type']
    if (type !== 'user' && type !== 'assistant') continue
    messageCount++

    const message = parsed['message']
    if (typeof message !== 'object' || message === null) continue

    // Extract title from first user message
    if (title === null && type === 'user') {
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
        title =
          trimmedRaw.length > MAX_TITLE_LENGTH
            ? trimmedRaw.slice(0, MAX_TITLE_LENGTH) + '…'
            : trimmedRaw
      }
    }

    // Extract model from first assistant message
    if (model === null && type === 'assistant') {
      const m = (message as Record<string, unknown>)['model']
      if (typeof m === 'string' && m.length > 0) model = m
    }
  }

  return { title, model, messageCount }
}

function extractFromTail(text: string): TailExtracted {
  const lines = text.split('\n').reverse()
  let lastMessageRole: string | null = null
  let lastMessagePreview: string | null = null
  let fallbackUserText: string | null = null
  let lastUserMessagePreview: string | null = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }

    const type = parsed['type']
    if (type !== 'user' && type !== 'assistant') continue

    const message = parsed['message']
    if (typeof message !== 'object' || message === null) continue

    // Extract last_message_role from first qualifying line (reversed = last in file)
    if (lastMessageRole === null) {
      const role = (message as Record<string, unknown>)['role']
      if (typeof role === 'string') lastMessageRole = role
    }

    const content = (message as Record<string, unknown>)['content']
    let raw: string | null = null
    if (typeof content === 'string') {
      raw = content
    } else if (Array.isArray(content)) {
      const parts: string[] = []
      for (const part of content) {
        if (
          typeof part === 'object' &&
          part !== null &&
          (part as Record<string, unknown>)['type'] === 'text'
        ) {
          const t = (part as Record<string, unknown>)['text']
          if (typeof t === 'string' && t.trim()) parts.push(t)
        }
      }
      if (parts.length > 0) raw = parts.join(' ')
    }

    if (!raw) continue

    const cleaned = raw
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()

    if (!cleaned) continue

    const preview =
      cleaned.length > MAX_PREVIEW_LENGTH ? cleaned.slice(0, MAX_PREVIEW_LENGTH) + '…' : cleaned

    // last_message_preview: prefer assistant, fall back to user
    if (lastMessagePreview === null) {
      if (type === 'assistant') {
        lastMessagePreview = preview
      } else if (fallbackUserText === null) {
        fallbackUserText = preview
      }
    }

    // last_user_message_preview: first user line seen (reversed = last in file)
    if (lastUserMessagePreview === null && type === 'user') {
      lastUserMessagePreview = preview
    }

    // Stop once we have everything we need (all three fields populated).
    if (lastMessagePreview !== null && lastUserMessagePreview !== null && lastMessageRole !== null)
      break
  }

  if (lastMessagePreview === null) lastMessagePreview = fallbackUserText

  return { lastMessageRole, lastMessagePreview, lastUserMessagePreview }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

// Yield to the event loop so a long scan doesn't monopolize the main thread.
// Called between files (or small batches) inside async loops.
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Encode an absolute path to Claude Code's directory-name format.
 *
 * Claude replaces BOTH '/' and '.' with '-' — verified against on-disk layout
 * where e.g. '/Users/maverick/.claude/projects' encodes to
 * '-Users-maverick--claude-projects' (the dot in '.claude' becomes a dash).
 *
 * This mirrors the transform used in projects.ts for the project root path
 * (which works with '/'-only replace because normal project cwds lack dots
 * in path components — worktree paths through '.claude/worktrees/' do not).
 */
function encodePathToClaudeDir(absolutePath: string): string {
  return absolutePath.replace(/[/.]/g, '-')
}

/**
 * Return the list of Claude-encoded directory names for all linked worktrees
 * of the repo that owns `projectCwd`, excluding the main repo root itself
 * (which is already covered by the project's own claudeEncodedName).
 *
 * If `projectCwd` is not inside a git repo, returns [].
 */
export async function worktreeEncodedDirs(projectCwd: string): Promise<string[]> {
  let repoRoot: string
  try {
    repoRoot = await resolveMainWorktree(projectCwd)
  } catch (err) {
    if (err instanceof NotAGitRepoError) return []
    throw err
  }

  let allPaths: string[]
  try {
    allPaths = await listWorktreePaths(repoRoot)
  } catch {
    return []
  }

  const result: string[] = []
  for (const wPath of allPaths) {
    // Exclude the main repo root — it's already covered by project.claudeEncodedName.
    if (wPath === repoRoot) continue
    result.push(encodePathToClaudeDir(wPath))
  }
  return result
}

/**
 * Shared helper: scan a Claude project directory and INSERT any .jsonl files
 * not yet in the sessions table.
 *
 * Extraction is gated: we only open the file when the INSERT actually inserts
 * a new row (better-sqlite3 `.changes > 0`). Already-imported rows skip all
 * fd opens, paying only a readdirSync + stat per file. At most 2 reads per
 * file (head ~200KB + tail ~200KB) instead of 5 separate fd opens.
 *
 * Yields to the event loop every file so IPC/clicks interleave during large
 * project scans. The max contiguous main-thread block is bounded to O(1 file).
 */
async function upsertSessionFilesForProject(projectId: string, dir: string): Promise<void> {
  const db = getDb()

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  // Snapshot the set of already-known session IDs so we can decide during the
  // read loop whether each file is new (needs extraction) — without writing
  // anything to the DB yet. This lets us keep yields in the READ phase only
  // and commit all inserts+updates in one synchronous transaction at the end.
  const knownIds = new Set<string>(
    (
      db.prepare('SELECT id FROM sessions WHERE project_id = ?').all(projectId) as { id: string }[]
    ).map((r) => r.id)
  )

  // Collected pending writes — populated during the (async) read phase.
  type PendingInsert = {
    sessionId: string
    jsonlPath: string
    mtime: number
    createdAt: number
  }
  type PendingUpdate = {
    sessionId: string
    title: string | null
    model: string | null
    lastMessageRole: string | null
    messageCount: number | null
    fileSize: number
    lastMessagePreview: string | null
    lastUserMessagePreview: string | null
    mtime: number
  }
  const pendingInserts: PendingInsert[] = []
  const pendingUpdates: PendingUpdate[] = []

  for (let _i = 0; _i < entries.length; _i++) {
    const entry = entries[_i]
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue

    // Yield every 10 files so IPC and clicks interleave during large scans
    // without paying scheduling overhead on every file.
    if (_i % 10 === 0) await yieldToEventLoop()

    const sessionId = entry.name.replace(/\.jsonl$/, '')
    const jsonlPath = nodePath.join(dir, entry.name)

    let stat: fs.Stats
    try {
      stat = fs.statSync(jsonlPath)
    } catch {
      continue
    }
    const mtime = Math.floor(stat.mtimeMs)
    const fileSize = stat.size

    if (knownIds.has(sessionId)) {
      // Row already existed — skip extraction entirely.
      continue
    }

    // New file not yet in DB — queue an insert.
    // Pass null for jsonl_mtime at INSERT time; only the updateMeta path writes
    // the real mtime. If extraction throws, null mtime ensures the mtime guard
    // treats this row as "needs extraction" on the next scan.
    pendingInserts.push({ sessionId, jsonlPath, mtime, createdAt: mtime })

    // Run extraction (at most 2 reads).
    try {
      const readSize = Math.min(fileSize, MAX_BYTES)

      // Head read: title, model, messageCount
      const headBuf = Buffer.allocUnsafe(readSize)
      let headText: string
      {
        const fd = fs.openSync(jsonlPath, 'r')
        try {
          const bytesRead = fs.readSync(fd, headBuf, 0, readSize, 0)
          headText = headBuf.slice(0, bytesRead).toString('utf-8')
        } finally {
          fs.closeSync(fd)
        }
      }
      const { title, model, messageCount } = extractFromHead(headText)

      // Tail read: lastMessageRole, previews (skip if file fits in head read)
      let tailText: string
      if (fileSize <= MAX_BYTES) {
        tailText = headText
      } else {
        const tailOffset = fileSize - readSize
        const tailBuf = Buffer.allocUnsafe(readSize)
        const fd = fs.openSync(jsonlPath, 'r')
        try {
          fs.readSync(fd, tailBuf, 0, readSize, tailOffset)
          tailText = tailBuf.toString('utf-8')
        } finally {
          fs.closeSync(fd)
        }
      }
      const { lastMessageRole, lastMessagePreview, lastUserMessagePreview } =
        extractFromTail(tailText)

      pendingUpdates.push({
        sessionId,
        title,
        model,
        lastMessageRole,
        messageCount,
        fileSize,
        lastMessagePreview,
        lastUserMessagePreview,
        mtime
      })
    } catch {
      // Extraction failure is non-fatal — row stays with NULL metadata
    }
  }

  if (pendingInserts.length === 0) return

  // Commit all inserts and updates in one synchronous transaction — one fsync
  // instead of N. No await inside the transaction (better-sqlite3 requirement).
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO sessions
       (id, project_id, jsonl_path, status, created_at, updated_at, jsonl_mtime)
     VALUES (?, ?, ?, 'in_review', ?, ?, ?)`
  )
  const updateMetaStmt = db.prepare(
    `UPDATE sessions
     SET title = ?, model = ?, last_message_role = ?,
         message_count = ?, jsonl_size_bytes = ?,
         last_message_preview = ?, last_user_message_preview = ?,
         jsonl_mtime = ?
     WHERE id = ?`
  )

  db.transaction(() => {
    for (const ins of pendingInserts) {
      try {
        insertStmt.run(ins.sessionId, projectId, ins.jsonlPath, ins.createdAt, ins.createdAt, null)
      } catch {
        // Ignore individual row failures (e.g. malformed UUID)
      }
    }
    for (const upd of pendingUpdates) {
      try {
        updateMetaStmt.run(
          upd.title,
          upd.model,
          upd.lastMessageRole,
          upd.messageCount,
          upd.fileSize,
          upd.lastMessagePreview,
          upd.lastUserMessagePreview,
          upd.mtime,
          upd.sessionId
        )
      } catch {
        // Ignore individual row failures
      }
    }
  })()
}

/**
 * Scans the Claude Code project directory (and all linked worktree encoded
 * dirs) for .jsonl session files and inserts them into the sessions table
 * (INSERT OR IGNORE — idempotent). Wrapped in a transaction by the caller (addProject).
 */
export async function importSessionsForProject(project: ProjectRecord): Promise<SessionRecord[]> {
  if (!project.claudeEncodedName) return []

  const worktreeDirs = await worktreeEncodedDirs(project.path)
  const encodedDirs = [project.claudeEncodedName, ...worktreeDirs]

  for (const encodedDir of encodedDirs) {
    const dir = nodePath.join(os.homedir(), '.claude', 'projects', encodedDir)
    if (!fs.existsSync(dir)) continue
    await upsertSessionFilesForProject(project.id, dir)
  }

  return listSessionsForProject(project.id)
}

/**
 * For all sessions in a project where title / model / last_message_role is NULL,
 * re-runs the extractors and fills in the missing values.
 * Also scans for new .jsonl files not yet in the sessions table and inserts them.
 *
 * mtime guard: for non-archived sessions we skip re-extraction when the JSONL
 * file's mtime matches the stored jsonl_mtime — this avoids N×stat+read calls
 * on every project-tab open when sessions haven't changed.
 *
 * Yielding: file reads are interleaved with setImmediate yields so the event
 * loop can service IPC/clicks between files. The max contiguous main-thread
 * block is bounded to O(1 file) instead of O(N files).
 */
// Per-projectId in-flight dedup: if a refresh is already running for a given
// project (e.g. user reopens a tab while the first scan is still yielding),
// the second caller piggybacks on the first promise instead of starting a
// parallel scan that would double I/O and bypass the mtime guard.
const refreshInFlight = new Map<string, Promise<void>>()

export async function refreshSessionMetadata(projectId: string): Promise<void> {
  const existing = refreshInFlight.get(projectId)
  if (existing) return existing
  const work = _refreshSessionMetadata(projectId)
  refreshInFlight.set(projectId, work)
  try {
    return await work
  } finally {
    refreshInFlight.delete(projectId)
  }
}

async function _refreshSessionMetadata(projectId: string): Promise<void> {
  const db = getDb()

  // Pull the claudeEncodedName and path for this project so we can scan for
  // new files across the project dir and all linked worktree encoded dirs.
  const projectRow = db
    .prepare('SELECT claude_encoded_name, path FROM projects WHERE id = ?')
    .get(projectId) as { claude_encoded_name: string | null; path: string } | undefined

  if (projectRow?.claude_encoded_name) {
    const worktreeDirs = await worktreeEncodedDirs(projectRow.path)
    const encodedDirs = [projectRow.claude_encoded_name, ...worktreeDirs]

    for (const encodedDir of encodedDirs) {
      const dir = nodePath.join(os.homedir(), '.claude', 'projects', encodedDir)
      if (fs.existsSync(dir)) {
        await upsertSessionFilesForProject(projectId, dir)
      }
    }
  }

  // Backfill any NULL metadata columns (title, model, role, counts) for rows
  // that were inserted before the single-pass extractor was wired.
  type NullMetaRow = { id: string; jsonl_path: string }
  const nullRows = db
    .prepare(
      `SELECT id, jsonl_path FROM sessions
       WHERE project_id = ?
         AND (title IS NULL OR model IS NULL OR last_message_role IS NULL
              OR message_count IS NULL OR jsonl_size_bytes IS NULL)`
    )
    .all(projectId) as NullMetaRow[]

  const updateStmt = db.prepare(
    `UPDATE sessions
     SET title              = COALESCE(title,              ?),
         model              = COALESCE(model,              ?),
         last_message_role  = COALESCE(last_message_role,  ?),
         message_count      = COALESCE(message_count,      ?),
         jsonl_size_bytes   = COALESCE(jsonl_size_bytes,   ?)
     WHERE id = ?`
  )

  // Run extractions with per-file yields, then commit all UPDATEs in one
  // transaction. better-sqlite3 transactions are synchronous, so we can't
  // await inside them — instead we collect results first, then write in bulk.
  type NullMetaResult = {
    id: string
    title: string | null
    model: string | null
    lastMessageRole: string | null
    messageCount: number | null
    jsonlSizeBytes: number | null
  }
  const nullMetaResults: NullMetaResult[] = []
  for (let i = 0; i < nullRows.length; i++) {
    const row = nullRows[i]
    // Yield every 10 iterations so IPC/clicks can interleave without
    // paying pure scheduling overhead on every file.
    if (i % 10 === 0) await yieldToEventLoop()
    nullMetaResults.push({
      id: row.id,
      title: extractTitle(row.jsonl_path),
      model: extractModel(row.jsonl_path),
      lastMessageRole: extractLastMessageRole(row.jsonl_path),
      messageCount: extractMessageCount(row.jsonl_path),
      jsonlSizeBytes: extractFileSize(row.jsonl_path)
    })
  }

  // Commit all null-meta backfill rows in one transaction — one fsync.
  db.transaction((results: NullMetaResult[]) => {
    for (const r of results) {
      try {
        updateStmt.run(r.title, r.model, r.lastMessageRole, r.messageCount, r.jsonlSizeBytes, r.id)
      } catch {
        // Ignore individual row failures
      }
    }
  })(nullMetaResults)

  // Re-extract last_message_preview and last_user_message_preview for non-archived
  // sessions, but only when the JSONL file has changed since the last extraction
  // (mtime guard). This avoids re-reading every file on every project-tab open.
  type ActiveRow = { id: string; jsonl_path: string; jsonl_mtime: number | null }
  const activeRows = db
    .prepare(
      `SELECT id, jsonl_path, jsonl_mtime FROM sessions
       WHERE project_id = ? AND status != 'archived'`
    )
    .all(projectId) as ActiveRow[]

  const previewUpdateStmt = db.prepare(
    `UPDATE sessions
     SET last_message_preview = ?, last_user_message_preview = ?, jsonl_mtime = ?
     WHERE id = ?`
  )

  // Run file reads with per-file yields; collect results; commit in one transaction.
  type PreviewResult = {
    id: string
    lastMessagePreview: string | null
    lastUserMessagePreview: string | null
    currentMtime: number
  }
  const previewResults: PreviewResult[] = []
  for (let i = 0; i < activeRows.length; i++) {
    const row = activeRows[i]
    // Yield every 10 iterations so IPC/clicks can interleave without
    // paying pure scheduling overhead on unchanged-mtime scans.
    if (i % 10 === 0) await yieldToEventLoop()

    let currentMtime: number
    let fileSize: number
    try {
      const stat = fs.statSync(row.jsonl_path)
      currentMtime = Math.floor(stat.mtimeMs)
      fileSize = stat.size
    } catch {
      continue
    }

    // Skip re-extraction if the file hasn't changed since last time.
    if (row.jsonl_mtime !== null && row.jsonl_mtime === currentMtime) continue

    try {
      const readSize = Math.min(fileSize, MAX_BYTES)
      let tailText: string
      if (fileSize <= MAX_BYTES) {
        // Small file — one read covers both head and tail
        const buf = Buffer.allocUnsafe(readSize)
        const fd = fs.openSync(row.jsonl_path, 'r')
        try {
          const bytesRead = fs.readSync(fd, buf, 0, readSize, 0)
          tailText = buf.slice(0, bytesRead).toString('utf-8')
        } finally {
          fs.closeSync(fd)
        }
      } else {
        const tailOffset = fileSize - readSize
        const buf = Buffer.allocUnsafe(readSize)
        const fd = fs.openSync(row.jsonl_path, 'r')
        try {
          fs.readSync(fd, buf, 0, readSize, tailOffset)
          tailText = buf.toString('utf-8')
        } finally {
          fs.closeSync(fd)
        }
      }

      const { lastMessagePreview, lastUserMessagePreview } = extractFromTail(tailText)
      previewResults.push({ id: row.id, lastMessagePreview, lastUserMessagePreview, currentMtime })
    } catch {
      // Extraction failure is non-fatal
    }
  }

  // Commit all preview updates in one transaction.
  db.transaction((results: PreviewResult[]) => {
    for (const r of results) {
      previewUpdateStmt.run(r.lastMessagePreview, r.lastUserMessagePreview, r.currentMtime, r.id)
    }
  })(previewResults)

  // Auto-prune: drop oldest non-archived rows if a cap is configured.
  const uiState = getAppUiState()
  const max = uiState.maxLocalSessions
  if (typeof max === 'number' && max > 0) {
    pruneOldSessions(projectId, max)
  }
}

// ---------------------------------------------------------------------------
// Prune (v33)
// ---------------------------------------------------------------------------

/**
 * Deletes session rows beyond `max`, oldest-first by updated_at.
 * Only non-archived rows count against the cap; archived rows are excluded
 * because they're already intentionally user-removed from the active list.
 * IMPORTANT: only deletes DB rows — JSONL files on disk are never touched.
 * Returns the number of rows deleted.
 */
export function pruneOldSessions(projectId: string, max: number): number {
  const db = getDb()

  const { total } = db
    .prepare(
      `SELECT COUNT(*) AS total FROM sessions
       WHERE project_id = ? AND status != 'archived'`
    )
    .get(projectId) as { total: number }

  if (total <= max) return 0

  const excess = total - max

  // Identify the IDs to delete (oldest updated_at first, skipping the newest `max` rows).
  type IdRow = { id: string }
  const toDelete = db
    .prepare(
      `SELECT id FROM sessions
       WHERE project_id = ? AND status != 'archived'
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .all(projectId, excess) as IdRow[]

  if (toDelete.length === 0) return 0

  const placeholders = toDelete.map(() => '?').join(', ')
  const ids = toDelete.map((r) => r.id)

  db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids)

  return toDelete.length
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

  // Slim projection: the WorkspacesView renderer only reads id, title, and
  // lastUserMessagePreview; emit only the columns needed for rowToRecord to
  // produce those fields correctly. Non-projected columns default to null.
  const rows = db
    .prepare(
      `SELECT s.id, s.project_id, s.jsonl_path, s.title, s.status,
              s.created_at, s.updated_at, s.archived_at, s.model,
              s.last_message_role, s.last_user_message_preview
       FROM sessions s
       JOIN projects p ON p.id = s.project_id
       ${whereClause}
       AND s.status != 'archived'
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

// ---------------------------------------------------------------------------
// Hard delete a session — drops the DB row AND moves the JSONL transcript to
// the OS trash. trashItem (vs fs.unlink) means the user can still recover
// from Finder Trash if they hit delete by accident.
// ---------------------------------------------------------------------------

export async function deleteSession(id: string): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT jsonl_path FROM sessions WHERE id = ?').get(id) as
    | { jsonl_path: string | null }
    | undefined

  if (row?.jsonl_path) {
    try {
      // shell is imported lazily — keeping this module electron-free where it
      // doesn't need to be (it's imported by unit-test friendly paths too).
      const { shell } = await import('electron')
      await shell.trashItem(row.jsonl_path)
    } catch (err) {
      console.warn('[sessions] failed to trash JSONL', row.jsonl_path, err)
      // Fall through to DB delete anyway — we don't want the row stuck if
      // the file was already gone or path access failed.
    }
  }

  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

// ---------------------------------------------------------------------------
// Context budget resolution — used by the title-bar chip and future footers.
//
// Resolution order for the effective model ID:
//   1. Last assistant turn's `model` field in the JSONL (most authoritative —
//      reflects what claude actually ran with in the most recent response).
//   2. composeClaudeLaunch's merged model (workspace → project → global setting).
//   3. Fallback to 'sonnet' if neither produces a value.
//
// Then: getPricing(modelId).context gives the native context window.
// If disable1mContext is set, clamp to 200 000 tokens.
// ---------------------------------------------------------------------------

export type ContextBudgetResult = {
  /** Effective context window size in tokens after applying all settings. */
  contextBudget: number
  /** The model ID used to look up the budget. */
  modelId: string
}

/**
 * Resolve the context budget for a workspace.
 * Returns the budget in tokens and the model ID used to derive it.
 */
export function getContextBudget(workspaceId: string): ContextBudgetResult {
  const db = getDb()

  // Pull the workspace row so we can get projectId + claudeSessionId
  const ws = db
    .prepare('SELECT project_id, claude_session_id FROM workspaces WHERE id = ?')
    .get(workspaceId) as { project_id: string; claude_session_id: string | null } | undefined

  // 1. Try the session's cached model column first — avoids reading the JSONL.
  //    Fall back to extractModel() only when the DB column is NULL (not yet populated).
  let modelFromJSONL: string | null = null
  if (ws?.claude_session_id) {
    const sessionRow = db
      .prepare('SELECT model, jsonl_path FROM sessions WHERE id = ?')
      .get(ws.claude_session_id) as { model: string | null; jsonl_path: string | null } | undefined
    if (sessionRow?.model) {
      modelFromJSONL = sessionRow.model
    } else if (sessionRow?.jsonl_path) {
      // model column is NULL — fall back to JSONL extraction
      modelFromJSONL = extractModel(sessionRow.jsonl_path)
    }
  }

  // 2. Compose launch settings to get the merged model (workspace → project → global)
  let modelFromSettings: string | null = null
  if (ws) {
    try {
      const launch = composeClaudeLaunch(ws.project_id, workspaceId)
      // The flag is '--model <id>', so extract the value
      const match = launch.flags.match(/--model\s+(\S+)/)
      if (match?.[1]) modelFromSettings = match[1]
    } catch {
      // ignore — settings DB may not be ready
    }
  }

  // 3. Determine effective model ID
  const modelId = modelFromJSONL ?? modelFromSettings ?? 'sonnet'

  // 4. Resolve pricing → context window
  const pricing = getPricing(modelId)
  const nativeContext = pricing?.context ?? 200_000

  // 5. Apply disable1mContext clamp
  const globals = getClaudeGlobalSettings()
  const contextBudget = globals.disable1mContext ? Math.min(nativeContext, 200_000) : nativeContext

  return { contextBudget, modelId }
}
