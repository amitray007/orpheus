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
import { DIAG_EVENTS } from '../shared/diagEvents'
import { redactLogRecord, redactLogString, redactLogValue } from './logRedaction'

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

function isCategoryEnabled(c: DiagCategory): boolean {
  return categoryFlags[c] === true
}

const DIAG_CATEGORIES = new Set<DiagCategory>(['error', 'lifecycle', 'perf', 'anomaly', 'trace'])
const DIAG_LEVELS = new Set<DiagLevel>(['debug', 'info', 'warn', 'error', 'fatal'])
const DIAG_KINDS = new Set<NonNullable<DiagEvent['kind']>>(['span', 'event', 'mark'])
const CURATED_EVENTS = new Set<string>(Object.values(DIAG_EVENTS))
const CURATED_TRACE_NAMES = new Set([
  'terminal.mount',
  'terminal.mount:surface-created',
  'terminal.mount:surface-reattached',
  'launch.compose'
])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TRACE_ID = /^t[0-9a-z]+$/
const SPAN_ID = /^s[0-9a-z]+$/
const MAX_EVENT_LENGTH = 160

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalPattern(value: unknown, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null
  const redacted = redactLogString(value)
  return redacted === value && pattern.test(redacted) ? redacted : null
}

function canonicalUuid(value: unknown): string | null {
  return canonicalPattern(value, UUID)
}

function canonicalTraceId(value: unknown): string | null {
  return canonicalPattern(value, TRACE_ID)
}

function canonicalSpanId(value: unknown): string | null {
  return canonicalPattern(value, SPAN_ID)
}

/**
 * Reconstruct a diagnostic event from an explicit allowlist. Both renderer
 * and main events pass through this path so neither caller-controlled process
 * identity/timestamp nor malformed identifiers reach subscribers/storage.
 */
function canonicalizeDiagEvent(
  input: unknown,
  processIdentity: 'main' | 'renderer',
  receivedAt = Date.now()
): DiagEvent | null {
  try {
    const normalized = redactLogValue(input)
    if (!isRecord(normalized)) return null
    const category = normalized['category']
    const level = normalized['level']
    const event = normalized['event']
    if (
      typeof category !== 'string' ||
      !DIAG_CATEGORIES.has(category as DiagCategory) ||
      typeof level !== 'string' ||
      !DIAG_LEVELS.has(level as DiagLevel) ||
      typeof event !== 'string' ||
      event.length < 1 ||
      event.length > MAX_EVENT_LENGTH
    ) {
      return null
    }
    const traceName = normalized['name']
    if (
      category === 'trace'
        ? !CURATED_TRACE_NAMES.has(event) || traceName !== event
        : !CURATED_EVENTS.has(event)
    ) {
      return null
    }

    const duration =
      typeof normalized['durationMs'] === 'number' &&
      Number.isFinite(normalized['durationMs']) &&
      normalized['durationMs'] >= 0 &&
      normalized['durationMs'] <= 24 * 60 * 60 * 1_000
        ? Math.round(normalized['durationMs'])
        : null
    const kind = normalized['kind']
    const canonicalKind =
      typeof kind === 'string' && DIAG_KINDS.has(kind as NonNullable<DiagEvent['kind']>)
        ? (kind as NonNullable<DiagEvent['kind']>)
        : null
    const data = isRecord(normalized['data']) ? redactLogRecord(normalized['data']) : null

    const traceId = canonicalTraceId(normalized['traceId'])
    const spanId = canonicalSpanId(normalized['spanId'])
    if (category === 'trace' && (traceId == null || spanId == null)) return null

    return {
      ts: Number.isFinite(receivedAt) ? Math.max(0, Math.round(receivedAt)) : Date.now(),
      process: processIdentity,
      category: category as DiagCategory,
      level: level as DiagLevel,
      event,
      workspaceId: canonicalUuid(normalized['workspaceId']),
      sessionId: canonicalUuid(normalized['sessionId']),
      durationMs: duration,
      message:
        typeof normalized['message'] === 'string'
          ? redactLogString(normalized['message'])
          : undefined,
      data,
      traceId,
      spanId,
      parentSpanId: canonicalSpanId(normalized['parentSpanId']),
      name: category === 'trace' ? event : null,
      kind: canonicalKind
    }
  } catch {
    return null
  }
}

export function canonicalizeRendererDiagEvent(
  input: unknown,
  receivedAt = Date.now()
): DiagEvent | null {
  return canonicalizeDiagEvent(input, 'renderer', receivedAt)
}

export function canonicalizeMainDiagEvent(
  input: unknown,
  receivedAt = Date.now()
): DiagEvent | null {
  return canonicalizeDiagEvent(input, 'main', receivedAt)
}

function pushRing(evt: DiagEvent): void {
  if (ring.length >= RING_CAPACITY) {
    ring.shift()
    dropped++
  }
  ring.push(evt)
}

const diagSubscribers = new Set<(e: DiagEvent) => void>()

export function subscribeDiag(fn: (e: DiagEvent) => void): () => void {
  diagSubscribers.add(fn)
  return () => diagSubscribers.delete(fn)
}

function fanOut(evt: DiagEvent): void {
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
    const canonical = canonicalizeMainDiagEvent(evt)
    if (canonical != null) fanOut(canonical)
  } catch {
    /* diagnostics must never throw into app code */
  }
}

export function ingestDiagEvent(input: unknown): void {
  try {
    const evt = canonicalizeRendererDiagEvent(input)
    if (evt == null) return
    if (!evt || typeof evt.event !== 'string') return
    if (!isCategoryEnabled(evt.category) && diagSubscribers.size === 0) return
    fanOut(evt)
  } catch {
    /* swallow */
  }
}

// ── Trace context (main owns it via AsyncLocalStorage) ──────────────────────
const traceStore = new AsyncLocalStorage<TraceContext>()

function emitTrace(rec: TraceRecord): void {
  try {
    if (!isCategoryEnabled('trace') && diagSubscribers.size === 0) return
    const canonical = canonicalizeMainDiagEvent({
      category: 'trace',
      level: rec.level,
      event: rec.name,
      workspaceId: rec.workspaceId ?? null,
      sessionId: rec.sessionId ?? null,
      durationMs: rec.durationMs ?? null,
      message: undefined,
      data: redactLogRecord(rec.data),
      traceId: rec.traceId,
      spanId: rec.spanId,
      parentSpanId: rec.parentSpanId ?? null,
      name: rec.name,
      kind: rec.kind
    })
    if (canonical != null) fanOut(canonical)
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
    if (!isCategoryEnabled('trace') && diagSubscribers.size === 0) return fn(NOOP_SPAN)
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
