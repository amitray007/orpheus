import type { DbLike, SchemaDef } from './types'
import type { LiveTable } from './introspect'
import type { PlanOp } from './diff'
import { introspectTable, listTables } from './introspect'
import { diffTable } from './diff'
import { renderColumn, renderCreateTable, renderIndex } from './render'
import { backupBefore } from './backup'
import { rebuildTable } from './rebuild'

// A DB counts as a "fresh install" (safe to skip the pre-destructive-op
// backup) only when it has NO pre-existing user tables at all. This is
// deliberately NOT the same thing as `legacyVersion === 0`: after the first
// cutover drops the schema_version table, every subsequent boot of an
// already-converged DB also detects legacyVersion 0 — but that DB has real
// user tables (and potentially secrets), so a later schema evolution on it
// must still be backed up before any destructive op. `applied_data_steps` is
// the migration engine's own bookkeeping table (see data-steps.ts) — its
// presence alone doesn't count as "has user data", so it's excluded here too.
function isFreshInstall(db: DbLike): boolean {
  const tables = listTables(db).filter((t) => t !== 'applied_data_steps' && t !== 'schema_version')
  return tables.length === 0
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
function planSync(db: DbLike, schema: SchemaDef): PlanOp[] {
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
// (unless dbPath is ':memory:' or the DB is a fresh install with no
// pre-existing user tables — see isFreshInstall()).
function sync(
  db: DbLike,
  schema: SchemaDef,
  opts: {
    dbPath: string
    legacyVersion: number
    log?: (op: { table: string; kind: PlanOp['kind'] }) => void
  }
): void {
  const plan = planSync(db, schema)

  // Skip the backup only for an in-memory DB (nothing durable to protect) or
  // a genuinely fresh install (no pre-existing user tables — nothing to lose
  // yet). Do NOT key this off legacyVersion === 0: that's also true for any
  // already-cutover on-disk DB (schema_version is dropped post-cutover), so
  // using it here would skip backups for real user data on every later
  // schema evolution. See isFreshInstall() above.
  const skipBackup = opts.dbPath === ':memory:' || isFreshInstall(db)
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
        // VACUUM INTO (inside backupBefore) is forbidden while a transaction
        // is open. A prior addColumn/createTable op in this same loop may
        // have left `inTxn` true via beginIfNeeded(). Flush it first — this
        // is safe: VACUUM INTO is a read-only snapshot, and committing
        // pending DDL before snapshotting is the correct order anyway (the
        // backup should reflect the DB state right before the destructive
        // op, including any DDL that already landed this run).
        commitIfNeeded()
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
          const fragment = renderColumn(op.column, colDef)
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
