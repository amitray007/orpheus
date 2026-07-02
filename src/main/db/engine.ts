import type Database from 'better-sqlite3'
import type { ColumnDef, SchemaDef } from './types'
import type { LiveTable } from './introspect'
import type { PlanOp } from './diff'
import { introspectTable } from './introspect'
import { diffTable } from './diff'
import { renderCreateTable, renderIndex } from './render'
import { backupBefore } from './backup'
import { rebuildTable } from './rebuild'

// Mirrors render.ts's private renderColumn — kept local (not exported from
// render.ts) so engine.ts can emit a single ALTER TABLE ... ADD COLUMN
// fragment without depending on render.ts's internals.
function renderColumnFragment(colName: string, def: ColumnDef): string {
  if (typeof def === 'string') {
    return `${colName} ${def}`
  }
  let out = `${colName} ${def.type}`
  if (def.primaryKey) out += ' PRIMARY KEY'
  if (def.notNull) out += ' NOT NULL'
  if (def.default !== undefined) out += ` DEFAULT ${def.default}`
  if (def.check) out += ` ${def.check}`
  return out
}

// Compute the full reconciliation plan for `schema` against the live DB:
// diff every table (in schema key order), concatenate all ops, then
// globally bucket-reorder so that within the whole plan:
//   1. createTable + addColumn (original relative order)
//   2. rebuildTable
//   3. addIndex
//   4. dropIndex
//   5. dropColumn
// This trivially satisfies "dropIndex before dropColumn on the same table"
// since all dropIndex ops precede all dropColumn ops globally.
function planSync(db: Database.Database, schema: SchemaDef): PlanOp[] {
  const allOps: PlanOp[] = []
  for (const [name, def] of Object.entries(schema)) {
    const live: LiveTable | null = introspectTable(db, name)
    allOps.push(...diffTable(name, def, live))
  }

  const createOrAdd: PlanOp[] = []
  const rebuild: PlanOp[] = []
  const addIndex: PlanOp[] = []
  const dropIndex: PlanOp[] = []
  const dropColumn: PlanOp[] = []

  for (const op of allOps) {
    switch (op.kind) {
      case 'createTable':
      case 'addColumn':
        createOrAdd.push(op)
        break
      case 'rebuildTable':
        rebuild.push(op)
        break
      case 'addIndex':
        addIndex.push(op)
        break
      case 'dropIndex':
        dropIndex.push(op)
        break
      case 'dropColumn':
        dropColumn.push(op)
        break
    }
  }

  return [...createOrAdd, ...rebuild, ...addIndex, ...dropIndex, ...dropColumn]
}

// Execute the reconciliation plan against the live DB inside a single
// transaction. Logs each op (structurally only — {table, kind}, never the
// full op) before executing it. Takes a single pre-destructive-op backup
// (unless dbPath is ':memory:' or legacyVersion is 0).
function sync(
  db: Database.Database,
  schema: SchemaDef,
  opts: {
    dbPath: string
    legacyVersion: number
    log?: (op: { table: string; kind: PlanOp['kind'] }) => void
  }
): void {
  const plan = planSync(db, schema)

  const skipBackup = opts.dbPath === ':memory:' || opts.legacyVersion === 0
  let backedUp = false

  // rebuildTable() manages its own BEGIN/COMMIT/ROLLBACK transaction
  // internally (see rebuild.ts) — real SQLite forbids nesting a second BEGIN
  // inside an already-open transaction, so this plan cannot be wrapped in one
  // outer transaction when it contains a rebuildTable op. Non-rebuild ops
  // (createTable/addColumn/dropColumn/addIndex/dropIndex) are individually
  // atomic DDL statements in SQLite, so executing them outside an explicit
  // transaction is safe; only rebuildTable needs (and provides) its own
  // transactional boundary.
  let inTxn = false
  const beginIfNeeded = (): void => {
    if (!inTxn) {
      db.exec('BEGIN')
      inTxn = true
    }
  }
  const commitIfNeeded = (): void => {
    if (inTxn) {
      db.exec('COMMIT')
      inTxn = false
    }
  }

  // Tables rebuilt this run: rebuildTable() already recreates every index in
  // desired.indexes as its final step (its shadow-table swap drops the old
  // table, and with it any indexes attached to it), so any addIndex op the
  // up-front plan also emitted for one of desired.indexes on this table is
  // already satisfied — executing it again would fail with "index already
  // exists". dropIndex ops are unaffected: a rebuilt table can't retain an
  // index that isn't in desired.indexes (rebuild only recreates desired
  // ones), so a planned drop of a non-desired index still applies... except
  // there's nothing left to drop either, since the old table (and its
  // indexes) is gone. Skip dropIndex for rebuilt tables too, for the same
  // reason.
  const rebuiltTables = new Set(
    plan.filter((op) => op.kind === 'rebuildTable').map((op) => op.table)
  )

  try {
    for (const op of plan) {
      if (!backedUp && !skipBackup && (op.kind === 'rebuildTable' || op.kind === 'dropColumn')) {
        backupBefore(db, opts.dbPath, opts.legacyVersion)
        backedUp = true
      }

      if ((op.kind === 'addIndex' || op.kind === 'dropIndex') && rebuiltTables.has(op.table)) {
        // Already handled by rebuildTable's own index recreation — skip to
        // avoid "index already exists" / dropping an index that no longer
        // exists post-rebuild.
        continue
      }

      opts.log?.({ table: op.table, kind: op.kind })

      switch (op.kind) {
        case 'createTable': {
          beginIfNeeded()
          const def = schema[op.table]
          db.exec(renderCreateTable(op.table, def))
          for (const [indexName, indexDef] of Object.entries(def.indexes ?? {})) {
            db.exec(renderIndex(op.table, indexName, indexDef))
          }
          break
        }
        case 'addColumn': {
          beginIfNeeded()
          const colDef = schema[op.table].columns[op.column]
          const fragment = renderColumnFragment(op.column, colDef)
          db.exec(`ALTER TABLE "${op.table}" ADD COLUMN ${fragment}`)
          break
        }
        case 'dropColumn': {
          beginIfNeeded()
          db.exec(`ALTER TABLE "${op.table}" DROP COLUMN "${op.column}"`)
          break
        }
        case 'rebuildTable': {
          // Flush + close any open outer transaction first: rebuildTable
          // opens its own.
          commitIfNeeded()
          const freshLive = introspectTable(db, op.table)!
          rebuildTable(db, op.table, schema[op.table], freshLive)
          break
        }
        case 'addIndex': {
          beginIfNeeded()
          db.exec(renderIndex(op.table, op.index, schema[op.table].indexes![op.index]))
          break
        }
        case 'dropIndex': {
          beginIfNeeded()
          db.exec(`DROP INDEX IF EXISTS "${op.index}"`)
          break
        }
      }
    }

    commitIfNeeded()
  } catch (err) {
    if (inTxn) db.exec('ROLLBACK')
    throw err
  }
}

export { planSync, sync }
