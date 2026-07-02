import assert from 'node:assert'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// src/main/db/*.ts files use extensionless relative imports (required to
// typecheck under this repo's `moduleResolution: bundler` tsconfig — see
// tsconfig.node.json). Node's raw ESM loader, used here to run those .ts
// files directly without a bundler, requires an explicit extension on
// relative specifiers. Register a tiny resolve hook that retries with a
// `.ts` suffix when a bare relative specifier can't be found, so files like
// rebuild.ts (which does a real value-import of render.ts) can be run as-is.
const extensionFallbackHook = `
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return await nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`
register('data:text/javascript,' + encodeURIComponent(extensionFallbackHook), import.meta.url)
// better-sqlite3-compatible shim for the harness: DatabaseSync's prepare()/exec() already match;
// provide a Database-like constructor name so the rest of the harness is unchanged.
class Database extends DatabaseSync {}
import { enumCheck, renderCreateTable, renderIndex } from '../src/main/db/render.ts'
import { introspectTable } from '../src/main/db/introspect.ts'

// enumCheck renders a canonical IN(...) clause from a shared array
assert.equal(
  enumCheck('status', ['idle', 'archived'] as const),
  "CHECK (status IN ('idle', 'archived'))"
)

// renderCreateTable produces deterministic SQL from a structured def
const sql = renderCreateTable('workspaces', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    project_id: 'TEXT NOT NULL',
    status: {
      type: 'TEXT',
      notNull: true,
      default: "'idle'",
      check: enumCheck('status', ['idle', 'archived'])
    }
  },
  foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }]
})
assert.ok(sql.startsWith('CREATE TABLE workspaces ('), sql)
assert.ok(
  sql.includes("status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'archived'))"),
  sql
)
assert.ok(sql.includes('FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE'), sql)
console.log('✓ render')

// introspectTable reads live DB structural state via PRAGMA + sqlite_master
const db = new Database(':memory:')
db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)')
db.exec('CREATE INDEX t_n_idx ON t(n)')
const live = introspectTable(db, 't')!
assert.equal(live.columns.length, 2)
assert.equal(live.columns[0].name, 'id')
assert.equal(live.columns[0].pk, true)
assert.equal(live.columns[1].notNull, true)
assert.equal(live.columns[1].dflt, '0')
assert.ok(live.indexes.some((i) => i.name === 't_n_idx' && !i.auto))
assert.equal(introspectTable(db, 'missing'), null)
console.log('✓ introspect')

import { diffTable } from '../src/main/db/diff.ts'

{
  const desired = {
    columns: { id: 'TEXT PRIMARY KEY', n: 'INTEGER', extra: 'TEXT' }
  }
  // live is missing `extra` → addColumn
  const live = {
    name: 't',
    createSql: 'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)',
    columns: [
      { name: 'id', type: 'TEXT', notNull: false, dflt: null, pk: true },
      { name: 'n', type: 'INTEGER', notNull: false, dflt: null, pk: false }
    ],
    indexes: []
  }
  const ops = diffTable('t', desired, live)
  assert.deepEqual(ops, [{ kind: 'addColumn', table: 't', column: 'extra' }])

  // missing table → createTable
  assert.deepEqual(diffTable('t', desired, null), [{ kind: 'createTable', table: 't' }])

  // live has a stray column NOT in dropColumns → no op
  const desired2 = { columns: { id: 'TEXT PRIMARY KEY' } }
  const live2 = {
    ...live,
    columns: [
      live.columns[0],
      { name: 'gone', type: 'TEXT', notNull: false, dflt: null, pk: false }
    ]
  }
  assert.deepEqual(diffTable('t', desired2, live2), [])

  // same, but with dropColumns → dropColumn op
  const desired3 = { columns: { id: 'TEXT PRIMARY KEY' }, dropColumns: ['gone'] }
  assert.deepEqual(diffTable('t', desired3, live2), [
    { kind: 'dropColumn', table: 't', column: 'gone' }
  ])
  console.log('✓ diff')
}

const { rebuildTable } = await import('../src/main/db/rebuild.ts')

{
  const rdb = new Database(':memory:')
  rdb.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)')
  rdb.exec("INSERT INTO projects VALUES ('p1')")
  rdb.exec(`CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('in_progress','in_review','idle','archived')))`)
  rdb.exec("INSERT INTO workspaces VALUES ('w1','p1','in_review'), ('w2','p1','idle')")

  const rdesired = {
    columns: {
      id: 'TEXT PRIMARY KEY',
      project_id: 'TEXT NOT NULL',
      status: {
        type: 'TEXT',
        notNull: true,
        default: "'idle'",
        check: "CHECK (status IN ('in_progress','awaiting_input','attention','idle','archived'))"
      }
    },
    normalizeOnRebuild: {
      status:
        "CASE WHEN status IN ('in_progress','awaiting_input','attention','idle','archived') THEN status ELSE 'idle' END"
    }
  }
  const rlive = introspectTable(rdb, 'workspaces')!
  rebuildTable(rdb, 'workspaces', rdesired, rlive)

  const rows = rdb.prepare('SELECT id, status FROM workspaces ORDER BY id').all()
  assert.deepEqual(rows, [
    { id: 'w1', status: 'idle' },
    { id: 'w2', status: 'idle' }
  ])
  assert.equal((rdb.prepare('SELECT COUNT(*) c FROM workspaces').get() as any).c, 2)
  console.log('✓ rebuild')
}

const { backupBefore } = await import('../src/main/db/backup.ts')

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'))
  const dbPath = path.join(dir, 'orpheus.sqlite')
  const bdb = new Database(dbPath)
  bdb.exec('PRAGMA journal_mode = WAL')
  bdb.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('x')")
  const bak = backupBefore(bdb, dbPath, 63)
  assert.ok(fs.existsSync(bak), 'backup file exists')
  const readonlyDb = new DatabaseSync(bak, { readOnly: true })
  assert.equal((readonlyDb.prepare('SELECT COUNT(*) c FROM t').get() as any).c, 1)
  readonlyDb.close()
  bdb.close()
  console.log('✓ backup')
}

const { sync, planSync } = await import('../src/main/db/engine.ts')

{
  const edb = new Database(':memory:')
  const eschema = {
    projects: {
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL' },
      indexes: { projects_name_idx: ['name'] }
    }
  }
  sync(edb, eschema, { dbPath: ':memory:', legacyVersion: 0 })
  assert.ok(introspectTable(edb, 'projects'))
  assert.deepEqual(planSync(edb, eschema), [])
  console.log('✓ engine')
}

const { schema, WORKSPACE_STATUS } = await import('../src/main/db/schema.ts')

{
  const sdb = new Database(':memory:')
  sync(sdb, schema, { dbPath: ':memory:', legacyVersion: 0 })
  // every declared table exists
  for (const t of Object.keys(schema)) {
    assert.ok(introspectTable(sdb, t), `missing ${t}`)
  }
  // idempotent on a fresh build
  const secondPlan = planSync(sdb, schema)
  if (secondPlan.length !== 0) {
    console.log('schema-fresh: non-empty second plan', JSON.stringify(secondPlan, null, 2))
  }
  assert.deepEqual(secondPlan, [], 'fresh build must be idempotent')
  console.log('✓ schema-fresh')
}

// convergence: build synthetic legacy-shaped DBs BY HAND with raw SQL that
// mimics real historical shapes, then run the NEW engine's sync() on them and
// assert convergence to the same normalized shape as a fresh build, plus
// idempotency (a second planSync is empty). We deliberately do NOT import or
// call the OLD src/main/db.ts migrate() here: it is written against
// better-sqlite3-specific APIs and does not load under this harness's
// node:sqlite runtime (see Task 8 constraints in the plan).
{
  // normalizedShape: a stable structural fingerprint of every table in
  // `schema` — sorted PRAGMA table_info rows (name,type,notnull,dflt_value,pk)
  // plus sorted index sql from sqlite_master. Two DBs with equal
  // normalizedShape() are structurally converged regardless of how they got
  // there (fresh build vs. reconciled-from-legacy).
  function normalizedShape(cdb: InstanceType<typeof Database>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const table of Object.keys(schema)) {
      const cols = (cdb.prepare(`PRAGMA table_info("${table}")`).all() as any[])
        .map((r) => ({
          name: r.name,
          type: r.type,
          notnull: r.notnull,
          dflt_value: r.dflt_value,
          pk: r.pk
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      const indexSqls = (
        cdb
          .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=?")
          .all(table) as { sql: string | null }[]
      )
        .map((r) => r.sql)
        .filter((sql): sql is string => sql !== null)
        .sort()
      out[table] = { columns: cols, indexes: indexSqls }
    }
    return out
  }

  // Reference shape: fresh db, sync() from scratch.
  const ref = new Database(':memory:')
  sync(ref, schema, { dbPath: ':memory:', legacyVersion: 0 })
  const refShape = normalizedShape(ref)

  // --- Fixture (a): a "v21-ish" workspaces DB -----------------------------
  // Hand-built legacy shape: workspaces has the OLD CHECK that allows the
  // retired 'in_review' value. Other tables are created fresh-shaped (the
  // point of this fixture is exercising workspaces drift + normalizeOnRebuild,
  // not re-testing every table's history). projects is created first since
  // workspaces references it via FOREIGN KEY.
  {
    const ldb = new Database(':memory:')
    ldb.exec('PRAGMA foreign_keys = OFF')

    ldb.exec(renderCreateTable('projects', schema.projects))
    for (const [idxName, idxDef] of Object.entries(schema.projects.indexes ?? {})) {
      ldb.exec(renderIndex('projects', idxName, idxDef))
    }
    ldb.exec("INSERT INTO projects (id, path, name, added_at) VALUES ('p1', '/tmp/p1', 'p1', 0)")

    // Legacy-shaped workspaces: old CHECK still allowing 'in_review'.
    ldb.exec(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL,
      last_opened_at INTEGER,
      archived_at INTEGER,
      closed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('in_progress','in_review','idle','archived')),
      name_is_auto INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER,
      claude_session_id TEXT,
      last_title TEXT,
      forked_from_session_id TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`)
    ldb.exec(
      'INSERT INTO workspaces (id, project_id, name, cwd, created_at, status) VALUES ' +
        "('w1', 'p1', 'w1', '/tmp/w1', 0, 'in_review')," +
        "('w2', 'p1', 'w2', '/tmp/w2', 0, 'idle')"
    )

    // The remaining tables in schema get created fresh-shaped (no drift
    // being exercised for them in this fixture) so sync() has nothing else
    // to converge but workspaces.
    for (const [tableName, def] of Object.entries(schema)) {
      if (tableName === 'projects' || tableName === 'workspaces') continue
      ldb.exec(renderCreateTable(tableName, def))
      for (const [idxName, idxDef] of Object.entries(def.indexes ?? {})) {
        ldb.exec(renderIndex(tableName, idxName, idxDef))
      }
    }

    sync(ldb, schema, { dbPath: ':memory:', legacyVersion: 21 })

    // (i) workspaces (and everything else) converged to the new CHECK shape
    assert.deepEqual(normalizedShape(ldb), refShape, 'v21-ish fixture did not converge')

    // (ii) the 'in_review' row's status is now a VALID new value, coerced by
    // normalizeOnRebuild — row count preserved.
    const w1 = ldb.prepare("SELECT status FROM workspaces WHERE id = 'w1'").get() as {
      status: string
    }
    assert.ok(
      (WORKSPACE_STATUS as readonly string[]).includes(w1.status),
      `w1.status '${w1.status}' is not a valid WORKSPACE_STATUS value`
    )
    assert.equal(
      w1.status,
      'idle',
      `expected legacy 'in_review' to coerce to 'idle', got '${w1.status}'`
    )
    const count = ldb.prepare('SELECT COUNT(*) c FROM workspaces').get() as { c: number }
    assert.equal(count.c, 2, 'row count must be preserved across rebuild')

    // (iii) idempotent after converge.
    assert.deepEqual(planSync(ldb, schema), [], 'v21-ish fixture not idempotent after converge')
  }

  // --- Fixture (b): "fresh but pre-existing tables" -----------------------
  // Every table created fresh-shaped (via renderCreateTable, i.e. the exact
  // SQL the engine itself would emit for createTable), inserted in FK-safe
  // order, then sync() again. planSync must return [] — no phantom rebuilds
  // triggered against an already-correct DB.
  {
    const pdb = new Database(':memory:')
    pdb.exec('PRAGMA foreign_keys = OFF')
    for (const [tableName, def] of Object.entries(schema)) {
      pdb.exec(renderCreateTable(tableName, def))
      for (const [idxName, idxDef] of Object.entries(def.indexes ?? {})) {
        pdb.exec(renderIndex(tableName, idxName, idxDef))
      }
    }

    sync(pdb, schema, { dbPath: ':memory:', legacyVersion: 63 })

    assert.deepEqual(normalizedShape(pdb), refShape, 'pre-existing fresh-shaped fixture diverged')
    assert.deepEqual(
      planSync(pdb, schema),
      [],
      'sync() on an already-correct DB must not produce phantom rebuilds'
    )
  }

  console.log('✓ convergence')
}

const { dataSteps, ensureLedger, seedLedgerFromLegacy, runDataSteps } =
  await import('../src/main/db/data-steps.ts')

{
  const dsdb = new Database(':memory:')
  ensureLedger(dsdb)
  // a v45 DB already ran the v28 remap → seeded as applied, must NOT re-run
  seedLedgerFromLegacy(dsdb, 45)
  assert.ok(
    dsdb.prepare("SELECT 1 FROM applied_data_steps WHERE name='workspace-status-remap'").get()
  )

  // a v21 DB missed the v28 remap → not seeded → will run
  const dsdb2 = new Database(':memory:')
  ensureLedger(dsdb2)
  seedLedgerFromLegacy(dsdb2, 21)
  assert.ok(
    !dsdb2.prepare("SELECT 1 FROM applied_data_steps WHERE name='workspace-status-remap'").get()
  )

  // a fresh DB (legacyVersion 0): the 5 legacy transforms are pre-marked
  // applied (nothing legacy to fix on a brand-new schema), but the
  // alwaysRun 'keep-awake-seed' step is NOT pre-marked — it must still get
  // a real run so the default row gets inserted.
  const dsdb3 = new Database(':memory:')
  ensureLedger(dsdb3)
  seedLedgerFromLegacy(dsdb3, 0)
  const legacyStepNames = dataSteps.filter((s) => !s.alwaysRun).map((s) => s.name)
  assert.equal(legacyStepNames.length, 5, 'expected exactly 5 non-alwaysRun legacy transforms')
  for (const name of legacyStepNames) {
    assert.ok(
      dsdb3.prepare('SELECT 1 FROM applied_data_steps WHERE name = ?').get(name),
      `fresh install should pre-mark '${name}' as applied`
    )
  }
  assert.ok(
    !dsdb3.prepare("SELECT 1 FROM applied_data_steps WHERE name='keep-awake-seed'").get(),
    'alwaysRun step must NOT be pre-marked applied on a fresh install'
  )

  // Exercise the alwaysRun step on the fresh DB: it needs keep_awake_settings
  // to exist first (schema.ts owns structure; this data step only seeds the
  // default row).
  dsdb3.exec(`CREATE TABLE keep_awake_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('off', 'auto', 'on')),
    display_on INTEGER NOT NULL DEFAULT 0 CHECK (display_on IN (0, 1)),
    timer_minutes INTEGER NOT NULL DEFAULT 120
  )`)
  runDataSteps(dsdb3, { preRebuild: false })
  runDataSteps(dsdb3, { preRebuild: true })
  const seededRow = dsdb3
    .prepare('SELECT mode, display_on, timer_minutes FROM keep_awake_settings WHERE id = 1')
    .get() as {
    mode: string
    display_on: number
    timer_minutes: number
  }
  assert.deepEqual(seededRow, { mode: 'auto', display_on: 0, timer_minutes: 120 })
  assert.ok(
    dsdb3.prepare("SELECT 1 FROM applied_data_steps WHERE name='keep-awake-seed'").get(),
    'keep-awake-seed must be recorded in the ledger after running'
  )

  // Running again must be a no-op (ledger prevents re-run / duplicate INSERT
  // OR IGNORE would be harmless anyway, but confirm the ledger gate works).
  const rowCountBefore = (
    dsdb3.prepare('SELECT COUNT(*) c FROM keep_awake_settings').get() as { c: number }
  ).c
  runDataSteps(dsdb3, { preRebuild: false })
  const rowCountAfter = (
    dsdb3.prepare('SELECT COUNT(*) c FROM keep_awake_settings').get() as { c: number }
  ).c
  assert.equal(rowCountBefore, rowCountAfter)

  console.log('✓ data-steps')
}

const { runMigrations } = await import('../src/main/db/cutover.ts')

{
  // The pre-v28 in_review hazard, end-to-end: a real ~v21 DB has a
  // workspaces CHECK that still allows the retired 'in_review' status, and a
  // row sitting in that state. seedLedgerFromLegacy(db, 21) will NOT mark the
  // v28 remap step as already-applied (21 < 28), so it must run in the
  // preRebuild pass BEFORE sync() tightens the workspaces CHECK — otherwise
  // the rebuild's shadow-table copy would need to reject or coerce the
  // legacy value with nothing but normalizeOnRebuild as a backstop. This
  // proves the ordering in cutover.ts actually holds.
  const cdb = new Database(':memory:')
  cdb.exec('PRAGMA foreign_keys = OFF')

  cdb.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)')
  cdb.exec('INSERT INTO schema_version VALUES (21)')

  cdb.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    added_at INTEGER NOT NULL)`)
  cdb.exec("INSERT INTO projects (id, path, name, added_at) VALUES ('p1', '/tmp/p1', 'p1', 0)")

  cdb.exec(`CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('in_progress','in_review','idle','archived')))`)
  cdb.exec("INSERT INTO workspaces (id, project_id, status) VALUES ('w1', 'p1', 'in_review')")

  // Must complete without throwing — no 'CHECK constraint failed', proving
  // the preRebuild normalization ran before the workspaces CHECK tightened.
  runMigrations(cdb, { dbPath: ':memory:' })

  const w1 = cdb.prepare("SELECT status FROM workspaces WHERE id = 'w1'").get() as {
    status: string
  }
  assert.ok(
    (WORKSPACE_STATUS as readonly string[]).includes(w1.status),
    `cutover: w1.status '${w1.status}' is not a valid WORKSPACE_STATUS value`
  )

  const svCount = (
    cdb.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'schema_version'").get() as {
      c: number
    }
  ).c
  assert.equal(svCount, 0, 'cutover: schema_version table must be dropped')

  assert.deepEqual(planSync(cdb, schema), [], 'cutover: DB must be fully converged + idempotent')

  console.log('✓ cutover')
}
