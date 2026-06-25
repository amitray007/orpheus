import type Database from 'better-sqlite3'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getDb } from './db'
import type { DiagEvent, DiagRow, DiagQuery, DiagCategory, DiagProcess } from '../shared/types'
import type { DiagLevel } from '../shared/types'
import { Span, newTraceId, newSpanId } from '../shared/trace'
import type { TraceContext, TraceRecord } from '../shared/trace'

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

let categoryFlags = { error: true, lifecycle: false, perf: false, anomaly: false, trace: false }

export function setDiagCategoryFlags(flags: {
  error: boolean
  lifecycle: boolean
  perf: boolean
  anomaly: boolean
  trace: boolean
}): void {
  categoryFlags = flags
}

export function isCategoryEnabled(c: DiagCategory): boolean {
  return categoryFlags[c] === true
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
      data: evt.data ?? null,
      traceId: evt.traceId ?? null,
      spanId: evt.spanId ?? null,
      parentSpanId: evt.parentSpanId ?? null,
      name: evt.name ?? null,
      kind: evt.kind ?? null
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

// ── Trace context (main owns it via AsyncLocalStorage) ──────────────────────
const traceStore = new AsyncLocalStorage<TraceContext>()
const traceSubscribers = new Set<(rec: TraceRecord) => void>()

// Live-stream seam: the Live Observability spec attaches here. No-op by default.
export function subscribeTrace(fn: (rec: TraceRecord) => void): () => void {
  traceSubscribers.add(fn)
  return () => traceSubscribers.delete(fn)
}

function emitTrace(rec: TraceRecord): void {
  try {
    if (!isCategoryEnabled('trace')) return
    pushRing({
      ts: rec.ts,
      process: 'main',
      category: 'trace',
      level: rec.level,
      event: rec.name,
      workspaceId: rec.workspaceId ?? null,
      sessionId: rec.sessionId ?? null,
      durationMs: rec.durationMs ?? null,
      message: undefined,
      data: rec.data ?? null,
      traceId: rec.traceId,
      spanId: rec.spanId,
      parentSpanId: rec.parentSpanId ?? null,
      name: rec.name,
      kind: rec.kind
    })
    for (const s of traceSubscribers) {
      try {
        s(rec)
      } catch {
        /* a bad subscriber must not break tracing */
      }
    }
  } catch {
    /* never throw */
  }
}

function startSpan(name: string, attrs?: Record<string, unknown>): Span {
  const parent = traceStore.getStore()
  const ctx: TraceContext = {
    traceId: parent?.traceId ?? newTraceId(),
    spanId: newSpanId()
  }
  return new Span(emitTrace, ctx, name, parent?.spanId ?? null, attrs)
}

// When the trace category is off, hand callers a Span that emits nothing.
function noopSpan(): Span {
  return new Span(() => {}, { traceId: 't0', spanId: 's0' }, 'noop', null, undefined)
}

export const diag = {
  // async unit of work — child spans nest automatically via ALS.
  async trace<T>(
    name: string,
    attrs: Record<string, unknown> | undefined,
    fn: (s: Span) => Promise<T> | T
  ): Promise<T> {
    if (!isCategoryEnabled('trace')) return await fn(noopSpan())
    const span = startSpan(name, attrs)
    try {
      return await traceStore.run(span.ctx, () => fn(span))
    } finally {
      span.end()
    }
  },
  // sync unit of work.
  span<T>(name: string, attrs: Record<string, unknown> | undefined, fn: (s: Span) => T): T {
    if (!isCategoryEnabled('trace')) return fn(noopSpan())
    const span = startSpan(name, attrs)
    try {
      return traceStore.run(span.ctx, () => fn(span))
    } finally {
      span.end()
    }
  },
  // point event (no span).
  event(name: string, attrs?: Record<string, unknown>, level: DiagLevel = 'info'): void {
    const parent = traceStore.getStore()
    emitTrace({
      ts: Date.now(),
      kind: 'event',
      name,
      traceId: parent?.traceId ?? newTraceId(),
      spanId: parent?.spanId ?? newSpanId(),
      parentSpanId: parent?.spanId ?? null,
      level,
      workspaceId: typeof attrs?.workspaceId === 'string' ? attrs.workspaceId : null,
      sessionId: typeof attrs?.sessionId === 'string' ? attrs.sessionId : null,
      data: attrs ?? null
    })
  },
  currentContext(): TraceContext | undefined {
    return traceStore.getStore()
  },
  // resume a trace under an explicit context (e.g. after parsing an IPC payload).
  withContext<T>(ctx: TraceContext, fn: () => T): T {
    return traceStore.run(ctx, fn)
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
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function diagDroppedCount(): number {
  return dropped
}
