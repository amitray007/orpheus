import type Database from 'better-sqlite3'
import type { ColumnDef, TableDef } from './types'
import type { LiveTable } from './introspect'
import { renderCreateTable, renderIndex } from './render'

// Minimal, self-contained parsing of NOT NULL / default from a ColumnDef —
// mirrors the pragmatic string-vs-structured handling in diff.ts without
// depending on it (diff.ts's resolveColumnDef returns a shape without
// `default`, which is the one thing we need here).
function columnHasNotNull(def: ColumnDef): boolean {
  if (typeof def === 'string') return /\bNOT\s+NULL\b/i.test(def)
  return !!def.notNull
}

function columnHasDefault(def: ColumnDef): boolean {
  if (typeof def === 'string') return /\bDEFAULT\b/i.test(def)
  return def.default !== undefined
}

// Perform SQLite's documented 12-step "rebuild" procedure to change a table's
// structure in place while preserving data: create a shadow table with the
// desired shape, copy rows across (applying any normalizeOnRebuild coercions
// for columns whose CHECK/constraints tightened), drop the old table, rename
// the shadow into place, and recreate indexes. Runs inside its own
// transaction with foreign_keys disabled for the duration, per SQLite's
// guidance for schema changes that touch FK-related tables.
function rebuildTable(
  db: Database.Database,
  name: string,
  desired: TableDef,
  live: LiveTable
): void {
  // NOT-NULL guard: fail fast, before touching any SQL, if a newly-required
  // column has no way to be populated for existing rows.
  const liveColumnNames = new Set(live.columns.map((c) => c.name))
  for (const [colName, colDef] of Object.entries(desired.columns)) {
    if (!columnHasNotNull(colDef)) continue
    if (liveColumnNames.has(colName)) continue
    if (columnHasDefault(colDef)) continue
    if (desired.normalizeOnRebuild?.[colName] !== undefined) continue
    throw new Error(
      `${name}.${colName} is NOT NULL, absent from live table, and has no default or normalizeOnRebuild entry`
    )
  }

  const before = db.prepare(`SELECT COUNT(*) as c FROM "${name}"`).get() as { c: number }

  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')

    const newTableName = `${name}__new`
    const createSql = renderCreateTable(name, desired)
    const newTableSql = createSql.replace(
      `CREATE TABLE ${name} (`,
      `CREATE TABLE ${newTableName} (`
    )
    db.exec(newTableSql)

    const desiredColumnNames = Object.keys(desired.columns)
    const shared = desiredColumnNames.filter((col) => liveColumnNames.has(col))

    const insertColumns = shared.map((col) => `"${col}"`).join(', ')
    const selectExprs = shared
      .map((col) => desired.normalizeOnRebuild?.[col] ?? `"${col}"`)
      .join(', ')
    const insertSql = `INSERT INTO "${newTableName}" (${insertColumns}) SELECT ${selectExprs} FROM "${name}"`
    db.exec(insertSql)

    const after = db.prepare(`SELECT COUNT(*) as c FROM "${newTableName}"`).get() as { c: number }
    if (after.c !== before.c) {
      throw new Error(
        `${name}: row count mismatch after rebuild copy (before=${before.c}, after=${after.c})`
      )
    }

    db.exec(`DROP TABLE "${name}"`)
    db.exec(`ALTER TABLE "${newTableName}" RENAME TO "${name}"`)

    for (const [indexName, indexDef] of Object.entries(desired.indexes ?? {})) {
      db.exec(renderIndex(name, indexName, indexDef))
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

export { rebuildTable }
