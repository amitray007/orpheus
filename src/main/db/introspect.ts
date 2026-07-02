import type Database from 'better-sqlite3'

interface LiveColumn {
  name: string
  type: string
  notNull: boolean
  dflt: string | null
  pk: boolean
}
interface LiveIndex {
  name: string
  sql: string | null
  auto: boolean
}
interface LiveTable {
  name: string
  columns: LiveColumn[]
  createSql: string
  indexes: LiveIndex[]
}

// Row shapes for the two PRAGMA queries used below. SQLite's PRAGMA output
// columns are stable across versions; see https://sqlite.org/pragma.html.
interface PragmaTableInfoRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}
interface PragmaIndexListRow {
  name: string
  origin: string
  partial: number
  unique: number
}

function introspectTable(db: Database.Database, name: string): LiveTable | null {
  const tableRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { sql: string } | undefined
  if (!tableRow) return null

  const columns = (db.prepare(`PRAGMA table_info("${name}")`).all() as PragmaTableInfoRow[]).map(
    (row): LiveColumn => ({
      name: row.name,
      type: row.type,
      notNull: !!row.notnull,
      dflt: row.dflt_value,
      pk: !!row.pk
    })
  )

  const indexList = db.prepare(`PRAGMA index_list("${name}")`).all() as PragmaIndexListRow[]
  const indexSqlStmt = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
  const indexes = indexList.map((row): LiveIndex => {
    const indexRow = indexSqlStmt.get(row.name) as { sql: string | null } | undefined
    const sql = indexRow?.sql ?? null
    return { name: row.name, sql, auto: sql === null }
  })

  return { name, columns, createSql: tableRow.sql, indexes }
}

function listTables(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[]
  return rows.map((row) => row.name)
}

export type { LiveColumn, LiveIndex, LiveTable }
export { introspectTable, listTables }
