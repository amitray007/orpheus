type ColumnDef =
  | string
  | { type: string; notNull?: boolean; default?: string; check?: string; primaryKey?: boolean }
type IndexDef = string[] | { columns: string[]; where?: string; unique?: boolean }
interface TableDef {
  columns: Record<string, ColumnDef>
  foreignKeys?: Array<{ columns: string[]; ref: string; onDelete?: string }>
  indexes?: Record<string, IndexDef>
  dropColumns?: string[]
  normalizeOnRebuild?: Record<string, string>
}
type SchemaDef = Record<string, TableDef>

// Minimal, structural, synchronous DB surface shared by both real-runtime
// better-sqlite3's Database and the node:sqlite harness's DatabaseSync. The
// migration engine modules only ever need prepare()/exec() (plus
// get/all/run on the prepared statement) — never anything driver-specific —
// so typing against this instead of `import type Database from
// 'better-sqlite3'` lets the exact same module run under both drivers
// without a cast. better-sqlite3's Database is a structural superset of this
// (it has more methods, and its exec()/run() return values are more
// specific), so it satisfies DbLike wherever DbLike is required.
interface DbLike {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
}

export type { ColumnDef, IndexDef, TableDef, SchemaDef, DbLike }
