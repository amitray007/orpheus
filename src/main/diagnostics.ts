import type Database from 'better-sqlite3'
import { getDb } from './db'
import type { DiagEvent, DiagRow, DiagQuery } from '../shared/types'
import { ringLength, drainRing, getDiagDropped } from './diagCore'

// Re-export the full in-memory event bus API so all callers that currently
// import from './diagnostics' continue to work without any path changes.
export { setDiagCategoryFlags, logDiagMain, ingestDiagEvent, subscribeDiag, diag } from './diagCore'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const ROW_CAP = 50_000
const FLUSH_INTERVAL_MS = 2000
const FLUSH_BATCH_MAX = 1000

let timer: ReturnType<typeof setInterval> | null = null
let insertStmt: Database.Statement | null = null
let seqCounter = 0

function flush(): void {
  if (ringLength() === 0) return
  let db: Database.Database
  try {
    db = getDb()
  } catch {
    return // DB not ready; keep buffering (bounded)
  }
  const batch = drainRing(FLUSH_BATCH_MAX)
  try {
    if (!insertStmt) {
      insertStmt = db.prepare(
        `INSERT INTO diagnostics_events
           (ts, process, category, level, event, workspace_id, session_id, duration_ms, message, data, seq,
            trace_id, span_id, parent_span_id, name, kind)
         VALUES (@ts, @process, @category, @level, @event, @workspaceId, @sessionId, @durationMs, @message, @data, @seq,
            @traceId, @spanId, @parentSpanId, @name, @kind)`
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
          seq: seqCounter++,
          traceId: r.traceId ?? null,
          spanId: r.spanId ?? null,
          parentSpanId: r.parentSpanId ?? null,
          name: r.name ?? null,
          kind: r.kind ?? null
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
  if (q.traceId) {
    where.push('trace_id = @traceId')
    params.traceId = q.traceId
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
            duration_ms AS durationMs, message, data, seq,
            trace_id AS traceId, span_id AS spanId, parent_span_id AS parentSpanId, name, kind
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
    const parsed: unknown = JSON.parse(s)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function diagDroppedCount(): number {
  return getDiagDropped()
}
