// Pure, process-agnostic trace primitives. No I/O — the per-process sink is
// injected as `emit`. Importable by both main (Node) and renderer (Chromium).
import type { DiagLevel } from './types'

export type TraceContext = { traceId: string; spanId: string }
export type TraceKind = 'span' | 'event' | 'mark'

// One record produced by the trace layer. A per-process sink maps this onto a
// DiagEvent and persists it.
export type TraceRecord = {
  ts: number
  kind: TraceKind
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string | null
  durationMs?: number | null
  level: DiagLevel
  workspaceId?: string | null
  sessionId?: string | null
  data?: Record<string, unknown> | null
}

let counter = 0
function id(prefix: string): string {
  counter = (counter + 1) >>> 0
  // cheap + collision-resistant enough for local correlation; no crypto.
  const rnd = Math.floor(Math.random() * 0xffffff).toString(36)
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${rnd}`
}
export function newTraceId(): string {
  return id('t')
}
export function newSpanId(): string {
  return id('s')
}

// Compact wire form for crossing process boundaries (IPC payloads, native
// callback strings): "<traceId>.<spanId>".
export function serializeContext(ctx: TraceContext): string {
  return `${ctx.traceId}.${ctx.spanId}`
}
export function parseContext(s: string | null | undefined): TraceContext | null {
  if (!s || typeof s !== 'string') return null
  const dot = s.indexOf('.')
  if (dot <= 0 || dot >= s.length - 1) return null
  return { traceId: s.slice(0, dot), spanId: s.slice(dot + 1) }
}

// A live span. Constructed by the per-process tracer with an injected `emit`.
// `mark`/`attr` accumulate; `end` emits the completed span record.
export class Span {
  readonly ctx: TraceContext
  private readonly emit: (rec: TraceRecord) => void
  private readonly name: string
  private readonly startTs: number
  private readonly parentSpanId: string | null
  private readonly attrs: Record<string, unknown>
  private ended = false

  constructor(
    emit: (rec: TraceRecord) => void,
    ctx: TraceContext,
    name: string,
    parentSpanId: string | null,
    attrs?: Record<string, unknown>
  ) {
    this.emit = emit
    this.ctx = ctx
    this.name = name
    this.parentSpanId = parentSpanId
    this.attrs = { ...(attrs ?? {}) }
    this.startTs = Date.now()
  }

  attr(key: string, value: unknown): void {
    this.attrs[key] = value
  }

  mark(label: string, data?: Record<string, unknown>): void {
    this.emit({
      ts: Date.now(),
      kind: 'mark',
      name: `${this.name}:${label}`,
      traceId: this.ctx.traceId,
      spanId: this.ctx.spanId,
      parentSpanId: this.parentSpanId,
      level: 'info',
      workspaceId: pick(this.attrs, 'workspaceId'),
      sessionId: pick(this.attrs, 'sessionId'),
      data: data ?? null
    })
  }

  end(level: DiagLevel = 'info'): void {
    if (this.ended) return
    this.ended = true
    const endTs = Date.now()
    this.emit({
      ts: endTs,
      kind: 'span',
      name: this.name,
      traceId: this.ctx.traceId,
      spanId: this.ctx.spanId,
      parentSpanId: this.parentSpanId,
      durationMs: endTs - this.startTs,
      level,
      workspaceId: pick(this.attrs, 'workspaceId'),
      sessionId: pick(this.attrs, 'sessionId'),
      data: Object.keys(this.attrs).length ? this.attrs : null
    })
  }
}

function pick(o: Record<string, unknown>, k: string): string | null {
  const v = o[k]
  return typeof v === 'string' ? v : null
}
