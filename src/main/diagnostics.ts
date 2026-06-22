import type Database from 'better-sqlite3'
import { getDb } from './db'
import type { DiagEvent, DiagRow, DiagQuery, DiagCategory, DiagProcess } from '../shared/types'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ROW_CAP = 50_000
const FLUSH_INTERVAL_MS = 2000
const RING_CAPACITY = 4000 // bounded; drop-oldest if the flusher falls behind
const FLUSH_BATCH_MAX = 1000

const ring: DiagEvent[] = []
let dropped = 0
let seqCounter = 0
let timer: ReturnType<typeof setInterval> | null = null
let insertStmt: Database.Statement | null = null

// Phase 1: only 'error' is enabled. Phase 2 swaps this for a uiState read.
export function isCategoryEnabled(c: DiagCategory): boolean {
  return c === 'error'
}

function pushRing(evt: DiagEvent): void {
  if (ring.length >= RING_CAPACITY) {
    ring.shift()
    dropped++
  }
  ring.push(evt)
}

export function logDiagMain(
  evt: Omit<DiagEvent, 'process' | 'ts'> & { process?: DiagProcess; ts?: number }
): void {
  try {
    if (!isCategoryEnabled(evt.category)) return
    pushRing({
      ts: evt.ts ?? Date.now(),
      process: evt.process ?? 'main',
      category: evt.category,
      level: evt.level,
      event: evt.event,
      workspaceId: evt.workspaceId ?? null,
      sessionId: evt.sessionId ?? null,
      durationMs: evt.durationMs ?? null,
      message: evt.message,
      data: evt.data ?? null
    })
  } catch {
    /* diagnostics must never throw into app code */
  }
}

export function ingestDiagEvent(evt: DiagEvent): void {
  try {
    if (!evt || typeof evt.event !== 'string') return
    if (!isCategoryEnabled(evt.category)) return
    pushRing(evt)
  } catch {
    /* swallow */
  }
}

function flush(): void {
  if (ring.length === 0) return
  let db: Database.Database
  try {
    db = getDb()
  } catch {
    return // DB not ready; keep buffering (bounded)
  }
  const batch = ring.splice(0, FLUSH_BATCH_MAX)
  try {
    if (!insertStmt) {
      insertStmt = db.prepare(
        `INSERT INTO diagnostics_events
           (ts, process, category, level, event, workspace_id, session_id, duration_ms, message, data, seq)
         VALUES (@ts, @process, @category, @level, @event, @workspaceId, @sessionId, @durationMs, @message, @data, @seq)`
      )
    }
    const stmt = insertStmt
    const tx = db.transaction((rows: DiagEvent[]) => {
      for (const r of rows) {
        stmt.run({
          ts: r.ts,
          process: r.process,
          category: r.category,
          level: r.level,
          event: r.event,
          workspaceId: r.workspaceId ?? null,
          sessionId: r.sessionId ?? null,
          durationMs: r.durationMs ?? null,
          message: r.message ?? null,
          data: r.data != null ? JSON.stringify(r.data) : null,
          seq: seqCounter++
        })
      }
    })
    tx(batch)
  } catch {
    // Drop this batch on failure; never propagate. (Rows lost, app unaffected.)
  }
}

function prune(): void {
  try {
    const db = getDb()
    db.prepare('DELETE FROM diagnostics_events WHERE ts < ?').run(Date.now() - RETENTION_MS)
    db.prepare(
      `DELETE FROM diagnostics_events
        WHERE id <= (SELECT MAX(id) - ? FROM diagnostics_events)`
    ).run(ROW_CAP)
  } catch {
    /* swallow */
  }
}

export function startDiagnostics(): void {
  prune()
  if (timer) return
  timer = setInterval(flush, FLUSH_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopDiagnostics(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  flush()
}

export function queryDiagnostics(q: DiagQuery): DiagRow[] {
  const db = getDb()
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (q.sinceMs != null) {
    where.push('ts >= @sinceMs')
    params.sinceMs = q.sinceMs
  }
  if (q.untilMs != null) {
    where.push('ts <= @untilMs')
    params.untilMs = q.untilMs
  }
  if (q.event) {
    where.push('event = @event')
    params.event = q.event
  }
  if (q.workspaceId) {
    where.push('workspace_id = @workspaceId')
    params.workspaceId = q.workspaceId
  }
  if (q.categories?.length) {
    where.push(`category IN (${q.categories.map((_, i) => `@cat${i}`).join(',')})`)
    q.categories.forEach((c, i) => (params[`cat${i}`] = c))
  }
  if (q.levels?.length) {
    where.push(`level IN (${q.levels.map((_, i) => `@lvl${i}`).join(',')})`)
    q.levels.forEach((l, i) => (params[`lvl${i}`] = l))
  }
  const sql = `SELECT id, ts, process, category, level, event,
            workspace_id AS workspaceId, session_id AS sessionId,
            duration_ms AS durationMs, message, data, seq
       FROM diagnostics_events
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ts ASC, seq ASC
      LIMIT @limit`
  params.limit = q.limit ?? 1000
  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    ...(r as unknown as DiagRow),
    data: r.data ? safeParse(r.data as string) : null
  }))
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function diagDroppedCount(): number {
  return dropped
}
