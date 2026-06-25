/*
 * Diagnostics CLI — read-only query over diagnostics_events.
 *   bun run diag --since 1h --category error,anomaly
 *   bun run diag --workspace <id> --around <ms> [--window 30s]
 *   bun run diag --event terminal.mount --stats
 *   bun run diag --tail
 *   bun run diag --trace <traceId>
 *   bun run diag --trace <traceId> --tail
 *   bun run diag --export --since 7d > bug.json
 *
 * DB path: defaults to the Dev data dir. Override the app name with
 * ORPHEUS_DIAG_APP=Orpheus for the production install.
 */
import { Database } from 'bun:sqlite'
import * as os from 'node:os'
import * as path from 'node:path'

function dbPath(): string {
  const appName = process.env.ORPHEUS_DIAG_APP ?? 'Orpheus Dev'
  return path.join(os.homedir(), 'Library', 'Application Support', appName, 'orpheus.sqlite')
}

function parseDuration(s: string): number {
  const m = /^(\d+)(ms|s|m|h|d)?$/.exec(s.trim())
  if (!m) return Number(s) || 0
  const n = Number(m[1])
  switch (m[2]) {
    case 'ms':
      return n
    case 's':
      return n * 1000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 3_600_000
    case 'd':
      return n * 86_400_000
    default:
      return n
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function table(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '(no events)'
  return rows
    .map((r) => {
      const t = new Date(Number(r.ts)).toISOString().slice(11, 23)
      const dur = r.durationMs != null ? ` ${r.durationMs}ms` : ''
      const ws = r.workspaceId ? ` ws=${String(r.workspaceId).slice(0, 8)}` : ''
      return `${t} ${String(r.level).padEnd(5)} ${String(r.event).padEnd(28)}${dur}${ws}  ${r.message ?? ''}`
    })
    .join('\n')
}

const now = Date.now()
const since = arg('since') ? now - parseDuration(arg('since')!) : undefined
const around = arg('around') ? Number(arg('around')) : undefined
const win = arg('window') ? parseDuration(arg('window')!) : 30_000
const categories = arg('category')?.split(',')
const levels = arg('level')?.split(',')
const event = arg('event')
const workspaceId = arg('workspace')
const limit = arg('limit') ? Number(arg('limit')) : 2000
const asJson = has('json') || has('export')
const stats = has('stats')
const tail = has('tail')

let db: Database
try {
  db = new Database(dbPath(), { readonly: true })
} catch (err) {
  console.error(`[diag] cannot open db at ${dbPath()}: ${(err as Error).message}`)
  console.error(
    '[diag] (the app must have run at least once; set ORPHEUS_DIAG_APP=Orpheus for the prod install)'
  )
  process.exit(1)
}

// Clean message if the diagnostics table doesn't exist yet (app hasn't run the
// v55 migration on this data dir). Avoids a raw SQLiteError stack trace.
{
  const t = db
    .query("SELECT name FROM sqlite_master WHERE type='table' AND name='diagnostics_events'")
    .get()
  if (!t) {
    console.error(
      '[diag] no diagnostics_events table yet — launch the app once (it runs the migration), then retry.'
    )
    process.exit(0)
  }
}

function buildWhere(): { sql: string; params: Record<string, unknown> } {
  const where: string[] = []
  const params: Record<string, unknown> = {}
  let lo = since
  let hi: number | undefined
  if (around != null) {
    lo = around - win
    hi = around + win
  }
  if (lo != null) {
    where.push('ts >= $lo')
    params['$lo'] = lo
  }
  if (hi != null) {
    where.push('ts <= $hi')
    params['$hi'] = hi
  }
  if (event) {
    where.push('event = $event')
    params['$event'] = event
  }
  if (workspaceId) {
    where.push('workspace_id = $ws')
    params['$ws'] = workspaceId
  }
  if (categories?.length) {
    where.push(`category IN (${categories.map((_, i) => `$c${i}`).join(',')})`)
    categories.forEach((c, i) => (params[`$c${i}`] = c))
  }
  if (levels?.length) {
    where.push(`level IN (${levels.map((_, i) => `$l${i}`).join(',')})`)
    levels.forEach((l, i) => (params[`$l${i}`] = l))
  }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params }
}

function renderTrace(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '(no rows for that trace id)'
  // Index spans by span_id; group marks/events under their span_id.
  const spans = rows.filter((r) => r.kind === 'span')
  const childrenOf = new Map<string | null, Array<Record<string, unknown>>>()
  for (const s of spans) {
    const p = (s.parent_span_id as string | null) ?? null
    if (!childrenOf.has(p)) childrenOf.set(p, [])
    childrenOf.get(p)!.push(s)
  }
  const marksOf = new Map<string, Array<Record<string, unknown>>>()
  for (const r of rows) {
    if (r.kind === 'mark' || r.kind === 'event') {
      const sid = (r.span_id as string) ?? ''
      if (!marksOf.has(sid)) marksOf.set(sid, [])
      marksOf.get(sid)!.push(r)
    }
  }
  const out: string[] = []
  const t0 = Number(rows[0].ts)
  const walk = (parentSpanId: string | null, depth: number): void => {
    for (const s of childrenOf.get(parentSpanId) ?? []) {
      const pad = '  '.repeat(depth)
      const dur = s.duration_ms != null ? `${s.duration_ms}ms` : '—'
      out.push(`${pad}▸ ${s.name}  (${dur})  +${Number(s.ts) - t0}ms`)
      for (const m of marksOf.get(s.span_id as string) ?? []) {
        out.push(
          `${pad}  · ${String(m.name).split(':').slice(1).join(':') || m.name}  +${Number(m.ts) - t0}ms`
        )
      }
      walk(s.span_id as string, depth + 1)
    }
  }
  // roots = spans whose parent is null OR whose parent isn't in this trace
  const known = new Set(spans.map((s) => s.span_id as string))
  for (const s of spans) {
    const p = (s.parent_span_id as string | null) ?? null
    if (p === null || !known.has(p)) {
      out.push(`▸ ${s.name}  (${s.duration_ms != null ? s.duration_ms + 'ms' : '—'})`)
      for (const m of marksOf.get(s.span_id as string) ?? []) {
        out.push(
          `  · ${String(m.name).split(':').slice(1).join(':') || m.name}  +${Number(m.ts) - t0}ms`
        )
      }
      walk(s.span_id as string, 1)
    }
  }
  return out.join('\n')
}

if (stats) {
  const { sql, params } = buildWhere()
  const rows = db
    .query(
      `SELECT event, category, COUNT(*) AS count,
              CAST(AVG(duration_ms) AS INTEGER) AS avg_ms
         FROM diagnostics_events ${sql}
        GROUP BY event ORDER BY count DESC`
    )
    .all(params) as Array<Record<string, unknown>>
  console.log(
    asJson
      ? JSON.stringify(rows, null, 2)
      : rows
          .map(
            (r) =>
              `${String(r.count).padStart(6)}  ${r.event}${r.avg_ms != null ? `  avg ${r.avg_ms}ms` : ''}`
          )
          .join('\n') || '(no events)'
  )
  process.exit(0)
}

const traceId = arg('trace')
if (traceId) {
  const rows = db
    .query('SELECT * FROM diagnostics_events WHERE trace_id = ? ORDER BY ts ASC, seq ASC')
    .all(traceId) as Array<Record<string, unknown>>
  if (tail) {
    // follow: re-query every 1s, print new rows' trace tree (simple full re-render)
    console.log(renderTrace(rows))
    setInterval(() => {
      const r2 = db
        .query('SELECT * FROM diagnostics_events WHERE trace_id = ? ORDER BY ts ASC, seq ASC')
        .all(traceId) as Array<Record<string, unknown>>
      console.clear()
      console.log(renderTrace(r2))
    }, 1000)
  } else {
    console.log(renderTrace(rows))
    process.exit(0)
  }
}

const SELECT = `SELECT id, ts, process, category, level, event,
          workspace_id AS workspaceId, session_id AS sessionId,
          duration_ms AS durationMs, message, data
     FROM diagnostics_events`

if (tail) {
  // Poll every 1s, print new rows. Ctrl-C to stop.
  const { sql, params } = buildWhere()
  let lastId =
    (db.query('SELECT MAX(id) AS m FROM diagnostics_events').get() as { m: number | null } | null)
      ?.m ?? 0
  console.error('[diag] tailing (Ctrl-C to stop)…')
  const tick = (): void => {
    const rows = db
      .query(`${SELECT} ${sql ? sql + ' AND' : 'WHERE'} id > $lastId ORDER BY id ASC LIMIT 500`)
      .all({ ...params, $lastId: lastId }) as Array<Record<string, unknown>>
    if (rows.length) {
      lastId = Number(rows[rows.length - 1].id)
      console.log(table(rows))
    }
  }
  setInterval(tick, 1000)
} else {
  const { sql, params } = buildWhere()
  const rows = db
    .query(`${SELECT} ${sql} ORDER BY ts ASC, seq ASC LIMIT $limit`)
    .all({ ...params, $limit: limit }) as Array<Record<string, unknown>>
  console.log(asJson ? JSON.stringify(rows, null, 2) : table(rows))
}
