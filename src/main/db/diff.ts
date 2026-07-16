import type { ColumnDef, TableDef } from './types'
import type { LiveTable } from './introspect'

type PlanOp =
  | { kind: 'createTable'; table: string }
  | { kind: 'addColumn'; table: string; column: string }
  | { kind: 'dropColumn'; table: string; column: string }
  | { kind: 'rebuildTable'; table: string; reason: string }
  | { kind: 'addIndex'; table: string; index: string }
  | { kind: 'dropIndex'; table: string; index: string }

interface ResolvedColumn {
  type: string
  notNull: boolean
  pk: boolean
  check: string | null
  default: string | null
}

// SQLite type-affinity classes: normalize case + common aliases so cosmetic
// spelling differences (INT vs INTEGER, VARCHAR vs TEXT, ...) don't false-trigger
// a rebuild. Not exhaustive of every SQLite alias — just the common ones, per spec.
const TYPE_AFFINITY_CLASSES: string[][] = [
  ['INTEGER', 'INT', 'BIGINT', 'SMALLINT', 'TINYINT'],
  ['TEXT', 'VARCHAR', 'CHAR', 'CLOB'],
  ['REAL', 'FLOAT', 'DOUBLE'],
  ['BLOB']
]

function normalizeTypeAffinity(rawType: string): string {
  const upper = rawType.trim().toUpperCase()
  // strip any parenthesized length/precision, e.g. VARCHAR(255) → VARCHAR
  const base = upper.replace(/\(.*\)/, '').trim()
  for (const cls of TYPE_AFFINITY_CLASSES) {
    if (cls.includes(base)) return cls[0]
  }
  return base
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// Normalize a DEFAULT value for comparison between our schema DSL's rendered
// text and SQLite's own canonical rendering (via PRAGMA table_info's
// dflt_value). SQLite re-renders literals in its own form (e.g. it may
// strip/normalize surrounding whitespace, and represents string literals
// with single quotes) — normalize both sides the same way so cosmetic
// differences don't false-trigger a rebuild:
//   - trim outer whitespace
//   - collapse internal whitespace
//   - strip one layer of enclosing parens some SQLite versions add around
//     non-literal expressions (e.g. "(0)")
function normalizeDefault(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  let s = normalizeWhitespace(raw)
  // Strip a single layer of enclosing parens, e.g. "(0)" -> "0", but leave
  // multi-token expressions like "(strftime('%s','now'))" whose outer parens
  // SQLite also normalizes away consistently in dflt_value — safe to strip
  // in both cases since both sides go through this same function.
  const parenMatch = s.match(/^\((.*)\)$/)
  if (parenMatch) s = normalizeWhitespace(parenMatch[1])
  return s
}

// Parse a bare-string ColumnDef (e.g. "TEXT PRIMARY KEY", "INTEGER") into its
// resolved shape. Pragmatic, regex-based — not a full SQL parser. Handles the
// fragments the schema DSL actually uses: leading type token, PRIMARY KEY,
// NOT NULL, DEFAULT ..., CHECK (...).
function parseStringColumnDef(def: string): ResolvedColumn {
  const trimmed = def.trim()
  const typeMatch = trimmed.match(/^([A-Za-z]+)/)
  const type = typeMatch ? typeMatch[1] : trimmed
  const pk = /\bPRIMARY\s+KEY\b/i.test(trimmed)
  const notNull = /\bNOT\s+NULL\b/i.test(trimmed)
  const checkMatch = trimmed.match(/\bCHECK\s*(\([\s\S]*\))/i)
  const check = checkMatch ? normalizeWhitespace(checkMatch[1]) : null
  // DEFAULT ... runs up to the next recognized keyword (NOT/CHECK/PRIMARY) or
  // end of string. Handles quoted-string, numeric, and parenthesized-
  // expression defaults.
  const defaultMatch = trimmed.match(
    /\bDEFAULT\s+('(?:[^']|'')*'|\((?:[^()]|\([^()]*\))*\)|[^\s,]+)/i
  )
  const defaultValue = defaultMatch ? normalizeDefault(defaultMatch[1]) : null
  return { type, notNull, pk, check, default: defaultValue }
}

function resolveColumnDef(def: ColumnDef): ResolvedColumn {
  if (typeof def === 'string') return parseStringColumnDef(def)
  // Structured `check` is stored with a leading CHECK keyword (render.ts's
  // renderColumn appends it verbatim, and enumCheck() returns it that way) —
  // strip it here so this matches parseStringColumnDef/extractLiveColumnCheck,
  // which both capture only the parenthesized body via the same CHECK regex.
  const check = def.check ? def.check.replace(/^\s*CHECK\s*/i, '') : null
  return {
    type: def.type,
    notNull: !!def.notNull,
    pk: !!def.primaryKey,
    check: check ? normalizeWhitespace(check) : null,
    default: normalizeDefault(def.default)
  }
}

// Extract a per-column inline CHECK clause from a raw CREATE TABLE statement
// for a given column name. Pragmatic regex extraction: finds the column's
// definition line/segment and pulls out a trailing CHECK (...) fragment.
function extractLiveColumnCheck(createSql: string, columnName: string): string | null {
  // Match "<columnName> <rest of column def up to comma-at-depth-0 or closing paren>"
  // We scan for the column name as a token, then capture up to the next top-level
  // comma or the end of the column list, tracking paren depth so CHECK(...) with
  // internal commas doesn't get truncated early.
  const escaped = columnName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nameRe = new RegExp(`(^|[(,\\s])${escaped}\\s+`, 'i')
  const match = nameRe.exec(createSql)
  if (!match) return null
  const start = match.index + match[0].length
  let depth = 0
  let end = createSql.length
  for (let i = start; i < createSql.length; i++) {
    const ch = createSql[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      if (depth === 0) {
        end = i
        break
      }
      depth--
    } else if (ch === ',' && depth === 0) {
      end = i
      break
    }
  }
  const segment = createSql.slice(start, end)
  const checkMatch = segment.match(/\bCHECK\s*(\([\s\S]*\))/i)
  if (!checkMatch) return null
  return normalizeWhitespace(balanceParens(checkMatch[1]))
}

// Guard against the paren-depth scan above cutting off a CHECK's closing paren
// when the CHECK itself was the reason we hit depth 0 (i.e. the segment already
// ends exactly at the CHECK's close). Ensures parens are balanced; if not, this
// is a best-effort fallback that trims to the last balanced point.
function balanceParens(s: string): string {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') {
      depth--
      if (depth === 0) return s.slice(0, i + 1)
    }
  }
  return s
}

// Extract table-level FOREIGN KEY (...) REFERENCES ... clauses from a raw
// CREATE TABLE statement, normalized for comparison.
function extractLiveForeignKeys(createSql: string): string[] {
  const results: string[] = []
  const re =
    /FOREIGN\s+KEY\s*\([^)]*\)\s*REFERENCES\s+[A-Za-z0-9_"'`]+\s*(?:\([^)]*\))?(?:\s+ON\s+DELETE\s+(?:SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|CASCADE|RESTRICT))?(?:\s+ON\s+UPDATE\s+(?:SET\s+NULL|SET\s+DEFAULT|NO\s+ACTION|CASCADE|RESTRICT))?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(createSql)) !== null) {
    results.push(normalizeWhitespace(m[0]))
  }
  return results
}

function renderDesiredForeignKeys(desired: TableDef): string[] {
  return (desired.foreignKeys ?? []).map((fk) =>
    normalizeWhitespace(
      `FOREIGN KEY (${fk.columns.join(', ')}) REFERENCES ${fk.ref}${fk.onDelete ? ' ON DELETE ' + fk.onDelete : ''}`
    )
  )
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((v, i) => v === sortedB[i])
}

// Columns present in `desired` but missing live → addColumn ops, in desired
// column order (matches the original single-pass loop exactly).
function computeAddColumnOps(
  name: string,
  desiredColumnNames: string[],
  liveColumnsByName: Map<string, LiveTable['columns'][number]>
): PlanOp[] {
  const ops: PlanOp[] = []
  for (const colName of desiredColumnNames) {
    if (!liveColumnsByName.has(colName)) {
      ops.push({ kind: 'addColumn', table: name, column: colName })
    }
  }
  return ops
}

// Live columns absent from `desired` → dropColumn ops, but ONLY when the
// column is explicitly listed in dropColumns; a stray live column not in
// dropColumns intentionally produces no op at all.
function computeDropColumnOps(
  name: string,
  desiredColumnNames: string[],
  liveColumns: LiveTable['columns'],
  dropColumns: Set<string>
): PlanOp[] {
  const ops: PlanOp[] = []
  for (const liveCol of liveColumns) {
    if (!desiredColumnNames.includes(liveCol.name)) {
      if (dropColumns.has(liveCol.name)) {
        ops.push({ kind: 'dropColumn', table: name, column: liveCol.name })
      }
      // else: stray live column not in dropColumns → no op at all
    }
  }
  return ops
}

// FOREIGN KEY set comparison → a rebuild reason string, or null if they match.
function diffForeignKeys(name: string, desired: TableDef, live: LiveTable): string | null {
  const desiredForeignKeys = renderDesiredForeignKeys(desired)
  const liveForeignKeys = extractLiveForeignKeys(live.createSql)
  if (!sameStringSet(desiredForeignKeys, liveForeignKeys)) {
    return `${name} FOREIGN KEY definitions differ`
  }
  return null
}

// Compare a single resolved desired column against its live counterpart and
// return the first-differing reason, in the exact original check order
// (notNull → type → pk → check → default), or null if all match.
function diffColumnDefinition(
  colName: string,
  resolved: ResolvedColumn,
  liveCol: LiveTable['columns'][number],
  createSql: string
): string | null {
  if (resolved.notNull !== liveCol.notNull) {
    return `${colName} NOT NULL differs`
  }
  if (normalizeTypeAffinity(resolved.type) !== normalizeTypeAffinity(liveCol.type)) {
    return `${colName} type differs`
  }
  if (resolved.pk !== liveCol.pk) {
    return `${colName} PRIMARY KEY differs`
  }

  const liveCheck = extractLiveColumnCheck(createSql, colName)
  const desiredCheck = resolved.check
  if ((desiredCheck ?? null) !== (liveCheck ?? null)) {
    return `${colName} CHECK differs`
  }

  const liveDefault = normalizeDefault(liveCol.dflt)
  if (resolved.default !== liveDefault) {
    return `${colName} DEFAULT differs`
  }

  return null
}

// Walk desired columns in order, stopping at the first column-level
// difference found (matches the original loop's `break` on first reason).
function findColumnRebuildReason(
  desiredColumnNames: string[],
  desired: TableDef,
  liveColumnsByName: Map<string, LiveTable['columns'][number]>,
  createSql: string
): string | null {
  for (const colName of desiredColumnNames) {
    const liveCol = liveColumnsByName.get(colName)
    if (!liveCol) continue // handled by addColumn above

    const resolved = resolveColumnDef(desired.columns[colName])
    const reason = diffColumnDefinition(colName, resolved, liveCol, createSql)
    if (reason !== null) return reason
  }
  return null
}

// Index adds: desired indexes missing from live, in desired order.
function computeAddIndexOps(
  name: string,
  desiredIndexNames: string[],
  liveIndexesByName: Map<string, LiveTable['indexes'][number]>
): PlanOp[] {
  const ops: PlanOp[] = []
  for (const indexName of desiredIndexNames) {
    if (!liveIndexesByName.has(indexName)) {
      ops.push({ kind: 'addIndex', table: name, index: indexName })
    }
  }
  return ops
}

// Index drops: live non-auto indexes absent from desired, in live order.
function computeDropIndexOps(
  name: string,
  desiredIndexNames: string[],
  liveIndexes: LiveTable['indexes']
): PlanOp[] {
  const ops: PlanOp[] = []
  for (const liveIndex of liveIndexes) {
    if (liveIndex.auto) continue
    if (!desiredIndexNames.includes(liveIndex.name)) {
      ops.push({ kind: 'dropIndex', table: name, index: liveIndex.name })
    }
  }
  return ops
}

function diffTable(name: string, desired: TableDef, live: LiveTable | null): PlanOp[] {
  if (live === null) {
    return [{ kind: 'createTable', table: name }]
  }

  const desiredColumnNames = Object.keys(desired.columns)
  const liveColumnsByName = new Map(live.columns.map((c) => [c.name, c]))
  const dropColumns = new Set(desired.dropColumns ?? [])

  const addColumnOps = computeAddColumnOps(name, desiredColumnNames, liveColumnsByName)
  const dropColumnOps = computeDropColumnOps(name, desiredColumnNames, live.columns, dropColumns)

  let rebuildReason: string | null = diffForeignKeys(name, desired, live)

  if (rebuildReason === null) {
    rebuildReason = findColumnRebuildReason(
      desiredColumnNames,
      desired,
      liveColumnsByName,
      live.createSql
    )
  }

  const ops: PlanOp[] = []
  if (rebuildReason !== null) {
    ops.push({ kind: 'rebuildTable', table: name, reason: rebuildReason })
  } else {
    ops.push(...addColumnOps, ...dropColumnOps)
  }

  const desiredIndexNames = Object.keys(desired.indexes ?? {})
  const liveIndexesByName = new Map(live.indexes.map((idx) => [idx.name, idx]))

  ops.push(...computeAddIndexOps(name, desiredIndexNames, liveIndexesByName))
  ops.push(...computeDropIndexOps(name, desiredIndexNames, live.indexes))

  return ops
}

export type { PlanOp }
export { diffTable }
