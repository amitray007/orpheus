import type { DiagEvent, DiagRow } from './types'

/**
 * Safely stringify a loosely-typed diagnostic field for display.
 * Avoids relying on values' own `toString()` (which may be `[object Object]`
 * for plain objects) and template-literal coercion of `unknown`/`object`.
 */
function str(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v == null) return ''
  try {
    return JSON.stringify(v) ?? Object.prototype.toString.call(v)
  } catch {
    return Object.prototype.toString.call(v)
  }
}

/** Normalize a row that may have snake_case (raw SQLite) or camelCase (DiagRow) fields. */
function normalize(r: Record<string, unknown>): Record<string, unknown> {
  return {
    ...r,
    span_id: r.span_id ?? r.spanId,
    parent_span_id: r.parent_span_id ?? r.parentSpanId,
    duration_ms: r.duration_ms ?? r.durationMs
  }
}

/** Format one mark/event row as its display label (strips the `kind:` prefix for marks). */
function formatMarkLabel(m: Record<string, unknown>): string {
  const mName = m.name != null ? str(m.name) : '(unnamed)'
  return m.kind === 'mark' ? mName.split(':').slice(1).join(':') || mName : mName
}

/** Push one mark/event line (`  · label  +Nms`) onto `out`, with an optional indent pad. */
function pushMarkLine(out: string[], m: Record<string, unknown>, t0: number, pad = ''): void {
  const label = formatMarkLabel(m)
  out.push(`${pad}  · ${label}  +${Number(m.ts) - t0}ms`)
}

/** Push one span line (`▸ name  (dur)  +Nms`) onto `out`, with an optional indent pad. */
function pushSpanLine(out: string[], s: Record<string, unknown>, t0: number, pad = ''): void {
  const dur = s.duration_ms != null ? `${str(s.duration_ms)}ms` : '—'
  const sName = s.name != null ? str(s.name) : '(unnamed)'
  out.push(`${pad}▸ ${sName}  (${dur})  +${Number(s.ts) - (Number(s.duration_ms) || 0) - t0}ms`)
}

/** Group spans by their parent_span_id (null key = roots). */
function groupChildrenBySpan(
  spans: Array<Record<string, unknown>>
): Map<string | null, Array<Record<string, unknown>>> {
  const childrenOf = new Map<string | null, Array<Record<string, unknown>>>()
  for (const s of spans) {
    const p = (s.parent_span_id as string | null) ?? null
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p)!.push(s)
  }
  return childrenOf
}

/** Group marks/events by their span_id ('' = ungrouped). */
function groupMarksBySpan(
  normRows: Array<Record<string, unknown>>
): Map<string, Array<Record<string, unknown>>> {
  const marksOf = new Map<string, Array<Record<string, unknown>>>()
  for (const r of normRows) {
    if (r.kind === 'mark' || r.kind === 'event') {
      const sid = (r.span_id as string) ?? ''
      if (!marksOf.has(sid)) marksOf.set(sid, [])
      marksOf.get(sid)!.push(r)
    }
  }
  return marksOf
}

/** Root spans (parent is null, or parent isn't part of this trace) + the trace's t0 (earliest root-span start). */
function computeRootsAndT0(
  spans: Array<Record<string, unknown>>,
  normRows: Array<Record<string, unknown>>
): { rootSpans: Array<Record<string, unknown>>; t0: number } {
  const known = new Set(spans.map((s) => s.span_id as string))
  const rootSpans = spans.filter((s) => {
    const p = (s.parent_span_id as string | null) ?? null
    return p === null || !known.has(p)
  })
  const t0 = rootSpans.length
    ? Math.min(...rootSpans.map((s) => Number(s.ts) - (Number(s.duration_ms) || 0)))
    : Number(normRows[0].ts)
  return { rootSpans, t0 }
}

/** Render the in-flight case (no spans closed yet) — a flat list of marks/events. */
function formatInFlightTrace(normRows: Array<Record<string, unknown>>, t0: number): string {
  const out: string[] = ['(trace in progress — no spans closed yet)']
  const markRows = normRows.filter((r) => r.kind === 'mark' || r.kind === 'event')
  for (const m of markRows) {
    pushMarkLine(out, m, t0)
  }
  return out.join('\n')
}

/** Recursively push a span and its descendants (+ their marks) onto `out`, depth-first. */
function walkSpanTree(
  out: string[],
  childrenOf: Map<string | null, Array<Record<string, unknown>>>,
  marksOf: Map<string, Array<Record<string, unknown>>>,
  t0: number,
  parentSpanId: string | null,
  depth: number
): void {
  for (const s of childrenOf.get(parentSpanId) ?? []) {
    const pad = '  '.repeat(depth)
    pushSpanLine(out, s, t0, pad)
    for (const m of marksOf.get(s.span_id as string) ?? []) {
      pushMarkLine(out, m, t0, pad)
    }
    walkSpanTree(out, childrenOf, marksOf, t0, s.span_id as string, depth + 1)
  }
}

/**
 * Render a correlated span/mark tree for a single trace.
 * Accepts rows from raw SQLite (snake_case) or DiagRow queries (camelCase).
 * Pure — no I/O.
 */
export function formatTraceTree(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '(no rows for that trace id)'
  const normRows = rows.map(normalize)
  // Index spans by span_id; group marks/events under their span_id.
  const spans = normRows.filter((r) => r.kind === 'span')
  const childrenOf = groupChildrenBySpan(spans)
  const marksOf = groupMarksBySpan(normRows)
  // Compute t0 from earliest root-span START (span.ts is the END timestamp;
  // subtract duration to get start). Fall back to first DB row if no spans yet.
  const { rootSpans, t0 } = computeRootsAndT0(spans, normRows)

  // Handle in-flight / all-marks case: no spans closed yet
  if (spans.length === 0) {
    return formatInFlightTrace(normRows, t0)
  }

  const out: string[] = []
  // roots = spans whose parent is null OR whose parent isn't in this trace
  for (const s of rootSpans) {
    pushSpanLine(out, s, t0)
    for (const m of marksOf.get(s.span_id as string) ?? []) {
      pushMarkLine(out, m, t0)
    }
    walkSpanTree(out, childrenOf, marksOf, t0, s.span_id as string, 1)
  }
  return out.join('\n')
}

/**
 * Format one diagnostic event as a single readable line.
 * Pure — no I/O.
 *
 * Output: HH:MM:SS.mmm  <process>  <category>/<level>  <name||event>  [ws=<8chars>]  [<durationMs>ms]  <message>
 */
export function formatEventLine(evt: DiagEvent | DiagRow | Record<string, unknown>): string {
  const ts = Number((evt as Record<string, unknown>).ts)
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  const timeStr = `${hh}:${mm}:${ss}.${ms}`

  const e = evt as Record<string, unknown>
  const proc = e.process != null ? str(e.process) : 'main'
  const catLevel = `${e.category != null ? str(e.category) : ''}/${e.level != null ? str(e.level) : ''}`
  const nameOrEvent = str(e.name ?? e.event ?? '')
  const workspaceId = e.workspaceId
  const durationMs = e.durationMs
  const message = e.message

  const parts: string[] = [timeStr, proc, catLevel, nameOrEvent]
  if (workspaceId != null && workspaceId !== '') {
    parts.push(`ws=${str(workspaceId).slice(0, 8)}`)
  }
  if (durationMs != null) {
    parts.push(`[${str(durationMs)}ms]`)
  }
  if (message != null && message !== '') {
    parts.push(str(message))
  }
  return parts.join('  ')
}
