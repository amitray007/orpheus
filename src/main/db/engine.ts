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

  try {
    db.exec('BEGIN')

    for (const op of plan) {
      if (!backedUp && !skipBackup && (op.kind === 'rebuildTable' || op.kind === 'dropColumn')) {
        backupBefore(db, opts.dbPath, opts.legacyVersion)
        backedUp = true
      }

      opts.log?.({ table: op.table, kind: op.kind })

      switch (op.kind) {
        case 'createTable': {
          const def = schema[op.table]
          db.exec(renderCreateTable(op.table, def))
          for (const [indexName, indexDef] of Object.entries(def.indexes ?? {})) {
            db.exec(renderIndex(op.table, indexName, indexDef))
          }
          break
        }
        case 'addColumn': {
          const colDef = schema[op.table].columns[op.column]
          const fragment = renderColumnFragment(op.column, colDef)
          db.exec(`ALTER TABLE "${op.table}" ADD COLUMN ${fragment}`)
          break
        }
        case 'dropColumn': {
          db.exec(`ALTER TABLE "${op.table}" DROP COLUMN "${op.column}"`)
          break
        }
        case 'rebuildTable': {
          const freshLive = introspectTable(db, op.table)!
          rebuildTable(db, op.table, schema[op.table], freshLive)
          break
        }
        case 'addIndex': {
          db.exec(renderIndex(op.table, op.index, schema[op.table].indexes![op.index]))
          break
        }
        case 'dropIndex': {
          db.exec(`DROP INDEX IF EXISTS "${op.index}"`)
          break
        }
      }
    }

    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

export { planSync, sync }
