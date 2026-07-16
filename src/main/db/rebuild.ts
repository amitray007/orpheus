import type { ColumnDef, DbLike, TableDef } from './types'
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

// Render a standalone column-definition fragment (name + type + NOT NULL +
// default) for a LIVE column, so it can be appended to the shadow __new
// table via ALTER TABLE ... ADD COLUMN. Used only for "carry-over" columns —
// live columns that are undeclared in `desired` and not in `dropColumns`,
// which diff.ts's contract says must be left alone (never silently dropped),
// even when the table happens to rebuild for an unrelated reason (e.g. a
// CHECK change on a sibling column). We don't have the column's original
// CHECK/PK text handy from LiveColumn (it only exposes type/notNull/dflt),
// so this reconstructs a best-effort def from live introspection — enough to
// preserve the column and its data, which is the load-bearing guarantee.
function renderCarryOverColumnFragment(col: {
  name: string
  type: string
  notNull: boolean
  dflt: string | null
}): string {
  let out = `"${col.name}" ${col.type}`
  if (col.notNull) out += ' NOT NULL'
  if (col.dflt !== null) out += ` DEFAULT ${col.dflt}`
  return out
}

// Perform SQLite's documented 12-step "rebuild" procedure to change a table's
// structure in place while preserving data: create a shadow table with the
// desired shape, copy rows across (applying any normalizeOnRebuild coercions
// for columns whose CHECK/constraints tightened), drop the old table, rename
// the shadow into place, and recreate indexes. Runs inside its own
// transaction with foreign_keys disabled for the duration, per SQLite's
// guidance for schema changes that touch FK-related tables.
function rebuildTable(db: DbLike, name: string, desired: TableDef, live: LiveTable): void {
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

    // Carry-over columns: live columns that are UNDECLARED in `desired` and
    // NOT in `desired.dropColumns`. diff.ts's contract for these is "no op
    // at all" (see diff.ts's dropColumns handling) — a stray live column is
    // left alone. But if the table rebuilds for any other reason, the
    // shadow-table swap would otherwise drop it (and its data) silently,
    // since it's absent from the desired CREATE. Preserve it by adding it to
    // the shadow table via ALTER TABLE before the INSERT, using its live
    // type/notNull/default as a best-effort reconstruction.
    const dropColumns = new Set(desired.dropColumns ?? [])
    const carryOverColumns = live.columns.filter(
      (c) => !desiredColumnNames.includes(c.name) && !dropColumns.has(c.name)
    )
    for (const col of carryOverColumns) {
      db.exec(`ALTER TABLE "${newTableName}" ADD COLUMN ${renderCarryOverColumnFragment(col)}`)
    }

    const allCopyColumns = [...shared, ...carryOverColumns.map((c) => c.name)]

    const insertColumns = allCopyColumns.map((col) => `"${col}"`).join(', ')
    // Carry-over columns have no normalizeOnRebuild entry (they're not part
    // of `desired` at all) — copy verbatim.
    const selectExprs = allCopyColumns
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
