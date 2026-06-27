// ---------------------------------------------------------------------------
// diagCore.ts — In-memory diagnostics event bus and ring buffer.
//
// Extracted from diagnostics.ts to break the mutual-import cycle between
// db.ts (imports logDiagMain) and diagnostics.ts (imports getDb).
//
// This module has NO dependency on db.ts. The DB flush/query path lives in
// diagnostics.ts, which imports both this module and db.ts.
// ---------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks'
import type { DiagEvent, DiagCategory, DiagProcess, DiagLevel } from '../shared/types'
import { Span, newTraceId, newSpanId } from '../shared/trace'
import type { TraceContext, TraceRecord } from '../shared/trace'

const RING_CAPACITY = 4000 // bounded; drop-oldest if the flusher falls behind

const ring: DiagEvent[] = []
let dropped = 0

/** Drain up to `n` events from the front of the ring (for the DB flush path). */
export function drainRing(n: number): DiagEvent[] {
  return ring.splice(0, n)
}

/** Current ring length (pre-check before drainRing). */
export function ringLength(): number {
  return ring.length
}

/** Total events dropped due to ring overflow. */
export function getDiagDropped(): number {
  return dropped
}

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

export const diagSubscribers = new Set<(e: DiagEvent) => void>()

export function subscribeDiag(fn: (e: DiagEvent) => void): () => void {
  diagSubscribers.add(fn)
  return () => diagSubscribers.delete(fn)
}

export function subscribeTrace(fn: (rec: TraceRecord) => void): () => void {
  return subscribeDiag((e) => {
    if (e.category === 'trace') {
      fn({
        ts: e.ts,
        kind: (e.kind as TraceRecord['kind']) ?? 'event',
        name: e.name ?? e.event,
        traceId: e.traceId ?? '',
        spanId: e.spanId ?? '',
        parentSpanId: e.parentSpanId ?? null,
        durationMs: e.durationMs ?? null,
        level: e.level,
        workspaceId: e.workspaceId ?? null,
        sessionId: e.sessionId ?? null,
        data: e.data ?? null
      })
    }
  })
}

export function fanOut(evt: DiagEvent): void {
  if (isCategoryEnabled(evt.category)) {
    pushRing(evt)
  }
  if (diagSubscribers.size > 0) {
    // Snapshot before iterating: a subscriber may (un)subscribe during fan-out.
    const subs = [...diagSubscribers]
    for (const fn of subs) {
      try {
        fn(evt)
      } catch {
        /* a bad subscriber must not break emit or other subscribers */
      }
    }
  }
}

export function logDiagMain(
  evt: Omit<DiagEvent, 'process' | 'ts'> & { process?: DiagProcess; ts?: number }
): void {
  try {
    if (!isCategoryEnabled(evt.category) && diagSubscribers.size === 0) return
    fanOut({
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
    if (!isCategoryEnabled(evt.category) && diagSubscribers.size === 0) return
    fanOut(evt)
  } catch {
    /* swallow */
  }
}

// ── Trace context (main owns it via AsyncLocalStorage) ──────────────────────
export const traceStore = new AsyncLocalStorage<TraceContext>()

function emitTrace(rec: TraceRecord): void {
  try {
    if (!isCategoryEnabled('trace') && diagSubscribers.size === 0) return
    fanOut({
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
// Singleton — allocated once at import, never per-call. Its internal `ended`
// latch is intentional and harmless here: emit is a no-op, so a "stuck" latch
// has no observable effect — don't "fix" it by re-creating the span per call.
const NOOP_SPAN = new Span(() => {}, { traceId: 't0', spanId: 's0' }, 'noop', null)

export const diag = {
  // async unit of work — child spans nest automatically via ALS.
  async trace<T>(
    name: string,
    attrs: Record<string, unknown> | undefined,
    fn: (s: Span) => Promise<T> | T
  ): Promise<T> {
    if (!isCategoryEnabled('trace') && diagSubscribers.size === 0)
      return fn(NOOP_SPAN) as Promise<T>
    const span = startSpan(name, attrs)
    try {
      return await traceStore.run(span.ctx, () => fn(span))
    } finally {
      span.end()
    }
  },
  // sync unit of work.
  span<T>(name: string, attrs: Record<string, unknown> | undefined, fn: (s: Span) => T): T {
    if (!isCategoryEnabled('trace') && diagSubscribers.size === 0) return fn(NOOP_SPAN)
    const span = startSpan(name, attrs)
    try {
      return traceStore.run(span.ctx, () => fn(span))
    } finally {
      span.end()
    }
  },
  // point event (no span).
  event(name: string, attrs?: Record<string, unknown>, level: DiagLevel = 'info'): void {
    if (!isCategoryEnabled('trace') && diagSubscribers.size === 0) return
    const parent = traceStore.getStore()
    emitTrace({
      ts: Date.now(),
      kind: 'event',
      name,
      traceId: parent?.traceId ?? newTraceId(),
      spanId: newSpanId(),
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
