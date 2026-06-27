import type { DiagEvent, DiagRow } from './types'

/** Normalize a row that may have snake_case (raw SQLite) or camelCase (DiagRow) fields. */
function normalize(r: Record<string, unknown>): Record<string, unknown> {
  return {
    ...r,
    span_id: r.span_id ?? r.spanId,
    parent_span_id: r.parent_span_id ?? r.parentSpanId,
    duration_ms: r.duration_ms ?? r.durationMs
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
  const childrenOf = new Map<string | null, Array<Record<string, unknown>>>()
  for (const s of spans) {
    const p = (s.parent_span_id as string | null) ?? null
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p)!.push(s)
  }
  const marksOf = new Map<string, Array<Record<string, unknown>>>()
  for (const r of normRows) {
    if (r.kind === 'mark' || r.kind === 'event') {
      const sid = (r.span_id as string) ?? ''
      if (!marksOf.has(sid)) marksOf.set(sid, [])
      marksOf.get(sid)!.push(r)
    }
  }
  const out: string[] = []
  // Compute t0 from earliest root-span START (span.ts is the END timestamp;
  // subtract duration to get start). Fall back to first DB row if no spans yet.
  const known = new Set(spans.map((s) => s.span_id as string))
  const rootSpans = spans.filter((s) => {
    const p = (s.parent_span_id as string | null) ?? null
    return p === null || !known.has(p)
  })
  const t0 = rootSpans.length
    ? Math.min(...rootSpans.map((s) => Number(s.ts) - (Number(s.duration_ms) || 0)))
    : Number(normRows[0].ts)

  // Handle in-flight / all-marks case: no spans closed yet
  if (spans.length === 0) {
    out.push('(trace in progress — no spans closed yet)')
    const markRows = normRows.filter((r) => r.kind === 'mark' || r.kind === 'event')
    for (const m of markRows) {
      const label =
        m.kind === 'mark'
          ? String(m.name ?? '(unnamed)')
              .split(':')
              .slice(1)
              .join(':') || String(m.name ?? '(unnamed)')
          : String(m.name ?? '(unnamed)')
      out.push(`  · ${label}  +${Number(m.ts) - t0}ms`)
    }
    return out.join('\n')
  }

  const walk = (parentSpanId: string | null, depth: number): void => {
    for (const s of childrenOf.get(parentSpanId) ?? []) {
      const pad = '  '.repeat(depth)
      const dur = s.duration_ms != null ? `${s.duration_ms}ms` : '—'
      out.push(
        `${pad}▸ ${String(s.name ?? '(unnamed)')}  (${dur})  +${Number(s.ts) - (Number(s.duration_ms) || 0) - t0}ms`
      )
      for (const m of marksOf.get(s.span_id as string) ?? []) {
        const label =
          m.kind === 'mark'
            ? String(m.name ?? '(unnamed)')
                .split(':')
                .slice(1)
                .join(':') || String(m.name ?? '(unnamed)')
            : String(m.name ?? '(unnamed)')
        out.push(`${pad}  · ${label}  +${Number(m.ts) - t0}ms`)
      }
      walk(s.span_id as string, depth + 1)
    }
  }
  // roots = spans whose parent is null OR whose parent isn't in this trace
  for (const s of rootSpans) {
    const dur = s.duration_ms != null ? `${s.duration_ms}ms` : '—'
    out.push(
      `▸ ${String(s.name ?? '(unnamed)')}  (${dur})  +${Number(s.ts) - (Number(s.duration_ms) || 0) - t0}ms`
    )
    for (const m of marksOf.get(s.span_id as string) ?? []) {
      const label =
        m.kind === 'mark'
          ? String(m.name ?? '(unnamed)')
              .split(':')
              .slice(1)
              .join(':') || String(m.name ?? '(unnamed)')
          : String(m.name ?? '(unnamed)')
      out.push(`  · ${label}  +${Number(m.ts) - t0}ms`)
    }
    walk(s.span_id as string, 1)
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
  const proc = String(e.process ?? 'main')
  const catLevel = `${String(e.category ?? '')}/${String(e.level ?? '')}`
  const nameOrEvent = String(e.name ?? e.event ?? '')
  const workspaceId = e.workspaceId
  const durationMs = e.durationMs
  const message = e.message

  const parts: string[] = [timeStr, proc, catLevel, nameOrEvent]
  if (workspaceId != null && workspaceId !== '') {
    parts.push(`ws=${String(workspaceId).slice(0, 8)}`)
  }
  if (durationMs != null) {
    parts.push(`[${durationMs}ms]`)
  }
  if (message != null && message !== '') {
    parts.push(String(message))
  }
  return parts.join('  ')
}
