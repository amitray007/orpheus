import assert from 'node:assert'
import { register } from 'node:module'
import { randomUUID } from 'node:crypto'
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
  assert.equal((rdb.prepare('SELECT COUNT(*) c FROM workspaces').get() as { c: number }).c, 2)
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
  assert.equal((readonlyDb.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c, 1)
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
  interface PragmaTableInfoRow {
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }

  function normalizedShape(cdb: InstanceType<typeof Database>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const table of Object.keys(schema)) {
      const cols = (cdb.prepare(`PRAGMA table_info("${table}")`).all() as PragmaTableInfoRow[])
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

  // --- Fixture (c): a real "v66-shaped" staging DB -------------------------
  // Staging's imperative db.ts advanced to CURRENT_VERSION=66, adding 10
  // columns this branch's schema.ts was missing (workspaces.{parent_workspace_id,
  // worktree_parent_cwd,worktree_branch} + claude_global_settings.{
  // max_workspace_depth,max_workspace_children,tool_call_timeout_ms,
  // max_tool_output_length,disable_mouse_clicks,rewind_on_error_enabled,
  // low_power_mode}). Build workspaces + claude_global_settings BY HAND with
  // those columns already present (mimicking a real user's on-disk v66 DB,
  // schema_version=66), run sync() with legacyVersion 66, and assert the
  // engine sees a fully-converged, idempotent DB — no spurious rebuild /
  // addColumn — proving a staging-based DB converges cleanly onto this
  // engine's declared schema.
  {
    const vdb = new Database(':memory:')
    vdb.exec('PRAGMA foreign_keys = OFF')

    vdb.exec(renderCreateTable('projects', schema.projects))
    for (const [idxName, idxDef] of Object.entries(schema.projects.indexes ?? {})) {
      vdb.exec(renderIndex('projects', idxName, idxDef))
    }
    vdb.exec("INSERT INTO projects (id, path, name, added_at) VALUES ('p1', '/tmp/p1', 'p1', 0)")

    // v66-shaped workspaces: exact staging fresh-install CREATE TABLE shape,
    // including the 3 new lineage/worktree columns.
    vdb.exec(`CREATE TABLE workspaces (
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
        CHECK (status IN ('in_progress', 'awaiting_input', 'attention', 'idle', 'archived')),
      name_is_auto INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER,
      claude_session_id TEXT,
      last_title TEXT,
      forked_from_session_id TEXT,
      parent_workspace_id TEXT,
      worktree_parent_cwd TEXT,
      worktree_branch TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )`)
    for (const [idxName, idxDef] of Object.entries(schema.workspaces.indexes ?? {})) {
      vdb.exec(renderIndex('workspaces', idxName, idxDef))
    }
    vdb.exec(
      'INSERT INTO workspaces (id, project_id, name, cwd, created_at, status, parent_workspace_id, worktree_parent_cwd, worktree_branch) VALUES ' +
        "('w1', 'p1', 'w1', '/tmp/w1', 0, 'idle', NULL, NULL, NULL)," +
        "('w2', 'p1', 'w2', '/tmp/w2', 0, 'idle', 'w1', '/tmp/w1', 'feature/worktree-branch')"
    )

    // v66-shaped claude_global_settings: fresh-install CREATE TABLE shape via
    // renderCreateTable (identical to what the engine itself renders — this
    // fixture is specifically about proving the 7 NEW columns being already
    // present doesn't trigger a phantom rebuild), then INSERT a row exercising
    // the new columns' data.
    vdb.exec(renderCreateTable('claude_global_settings', schema.claude_global_settings))
    for (const [idxName, idxDef] of Object.entries(schema.claude_global_settings.indexes ?? {})) {
      vdb.exec(renderIndex('claude_global_settings', idxName, idxDef))
    }
    vdb.exec(
      `INSERT INTO claude_global_settings (
        id, max_workspace_depth, max_workspace_children, tool_call_timeout_ms,
        max_tool_output_length, disable_mouse_clicks, rewind_on_error_enabled,
        low_power_mode, updated_at
      ) VALUES (1, 5, 20, 30000, 100000, 1, 1, 1, 0)`
    )

    // The remaining tables get created fresh-shaped — this fixture is only
    // exercising workspaces + claude_global_settings convergence.
    for (const [tableName, def] of Object.entries(schema)) {
      if (
        tableName === 'projects' ||
        tableName === 'workspaces' ||
        tableName === 'claude_global_settings'
      )
        continue
      vdb.exec(renderCreateTable(tableName, def))
      for (const [idxName, idxDef] of Object.entries(def.indexes ?? {})) {
        vdb.exec(renderIndex(tableName, idxName, idxDef))
      }
    }

    sync(vdb, schema, { dbPath: ':memory:', legacyVersion: 66 })

    // (i) fully converged to the same normalized shape as a fresh build — the
    // engine recognizes the 10 columns as already present, no phantom
    // rebuild/addColumn against a DB that's already schema-correct.
    assert.deepEqual(normalizedShape(vdb), refShape, 'v66-shaped fixture did not converge')

    // (ii) idempotent — a second planSync is empty.
    assert.deepEqual(planSync(vdb, schema), [], 'v66-shaped fixture not idempotent after sync')

    // (iii) data preserved across convergence — both workspaces rows and the
    // new columns' values on claude_global_settings survive.
    const wcount = vdb.prepare('SELECT COUNT(*) c FROM workspaces').get() as { c: number }
    assert.equal(wcount.c, 2, 'workspaces row count must be preserved across v66 convergence')
    const w2 = vdb
      .prepare(
        'SELECT parent_workspace_id, worktree_parent_cwd, worktree_branch FROM workspaces WHERE id = ?'
      )
      .get('w2') as {
      parent_workspace_id: string | null
      worktree_parent_cwd: string | null
      worktree_branch: string | null
    }
    assert.equal(w2.parent_workspace_id, 'w1')
    assert.equal(w2.worktree_parent_cwd, '/tmp/w1')
    assert.equal(w2.worktree_branch, 'feature/worktree-branch')

    const settings = vdb
      .prepare(
        `SELECT max_workspace_depth, max_workspace_children, tool_call_timeout_ms,
                max_tool_output_length, disable_mouse_clicks, rewind_on_error_enabled,
                low_power_mode
         FROM claude_global_settings WHERE id = 1`
      )
      .get() as {
      max_workspace_depth: number
      max_workspace_children: number
      tool_call_timeout_ms: number | null
      max_tool_output_length: number | null
      disable_mouse_clicks: number
      rewind_on_error_enabled: number
      low_power_mode: number
    }
    assert.equal(settings.max_workspace_depth, 5)
    assert.equal(settings.max_workspace_children, 20)
    assert.equal(settings.tool_call_timeout_ms, 30000)
    assert.equal(settings.max_tool_output_length, 100000)
    assert.equal(settings.disable_mouse_clicks, 1)
    assert.equal(settings.rewind_on_error_enabled, 1)
    assert.equal(settings.low_power_mode, 1)
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

  // a fresh DB (legacyVersion 0): the 7 legacy transforms are pre-marked
  // applied (nothing legacy to fix on a brand-new schema), but the
  // alwaysRun 'keep-awake-seed' step is NOT pre-marked — it must still get
  // a real run so the default row gets inserted.
  const dsdb3 = new Database(':memory:')
  ensureLedger(dsdb3)
  seedLedgerFromLegacy(dsdb3, 0)
  const legacyStepNames = dataSteps.filter((s) => !s.alwaysRun).map((s) => s.name)
  assert.equal(legacyStepNames.length, 7, 'expected exactly 7 non-alwaysRun legacy transforms')
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

  // v67/v68 footer steps: a pre-v67 DB (legacyVersion 66) must NOT be
  // pre-marked applied for either step, so they run for real on such a DB.
  const dsdb4 = new Database(':memory:')
  ensureLedger(dsdb4)
  seedLedgerFromLegacy(dsdb4, 66)
  assert.ok(
    !dsdb4
      .prepare("SELECT 1 FROM applied_data_steps WHERE name='footer-model-select-rewrite'")
      .get(),
    'a v66 DB must not pre-mark footer-model-select-rewrite (legacyThroughVersion 67) as applied'
  )
  assert.ok(
    !dsdb4.prepare("SELECT 1 FROM applied_data_steps WHERE name='footer-effort-select-seed'").get(),
    'a v66 DB must not pre-mark footer-effort-select-seed (legacyThroughVersion 68) as applied'
  )

  // Exercise both steps for real against a v66-shaped footer_actions_global:
  // a legacy '/model' chip must rewrite to the modelSelect dropdown, and the
  // Effort chip must get seeded since it's absent.
  dsdb4.exec(`CREATE TABLE footer_actions_global (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    icon TEXT,
    action_id TEXT NOT NULL,
    params_json TEXT NOT NULL,
    visible_when TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prompts_json TEXT
  )`)
  dsdb4
    .prepare(
      `INSERT INTO footer_actions_global
         (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      '/model',
      'Robot',
      'terminal.sendInput',
      JSON.stringify({ text: '/model', submit: true }),
      'always',
      0,
      0,
      0,
      null
    )
  // runDataSteps sweeps ALL unapplied non-preRebuild steps, including the
  // alwaysRun 'keep-awake-seed' step, which needs its table to exist first
  // (same requirement as the dsdb3 fixture above).
  dsdb4.exec(`CREATE TABLE keep_awake_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('off', 'auto', 'on')),
    display_on INTEGER NOT NULL DEFAULT 0 CHECK (display_on IN (0, 1)),
    timer_minutes INTEGER NOT NULL DEFAULT 120
  )`)
  runDataSteps(dsdb4, { preRebuild: false })
  runDataSteps(dsdb4, { preRebuild: true })

  const modelRow = dsdb4
    .prepare(
      `SELECT label, action_id, params_json FROM footer_actions_global WHERE label = 'Model'`
    )
    .get() as { label: string; action_id: string; params_json: string } | undefined
  assert.ok(modelRow, 'footer-model-select-rewrite must rewrite the /model chip to the Model chip')
  assert.equal(modelRow!.action_id, 'footer.modelSelect')
  assert.equal(modelRow!.params_json, '{}')

  const effortRow = dsdb4
    .prepare(
      `SELECT action_id, position FROM footer_actions_global WHERE action_id = 'footer.effortSelect'`
    )
    .get() as { action_id: string; position: number } | undefined
  assert.ok(effortRow, 'footer-effort-select-seed must seed the Effort chip when absent')

  assert.ok(
    dsdb4
      .prepare("SELECT 1 FROM applied_data_steps WHERE name='footer-model-select-rewrite'")
      .get(),
    'footer-model-select-rewrite must be recorded in the ledger after running'
  )
  assert.ok(
    dsdb4.prepare("SELECT 1 FROM applied_data_steps WHERE name='footer-effort-select-seed'").get(),
    'footer-effort-select-seed must be recorded in the ledger after running'
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

// ---------------------------------------------------------------------------
// backup-path: exercises the real on-disk backup path, which every OTHER
// harness section above skips (they all use ':memory:' or a fresh-install
// DB, so `skipBackup` was always true and VACUUM INTO / backupBefore never
// actually ran). This is the root cause the reviewed bugs hid behind: FIX 1
// (VACUUM-in-open-transaction), FIX 2 (stale .bak crash-loop), FIX 4
// (legacyVersion===0 wrongly skipping backups on already-cutover on-disk
// DBs) are all only reachable via a REAL dbPath + a NON-fresh DB.
// ---------------------------------------------------------------------------
{
  // --- (1) mixed addColumn + rebuildTable on a real, non-fresh on-disk DB -
  // Exercises FIX 1 (commitIfNeeded() before VACUUM INTO — addColumn runs
  // first and leaves inTxn=true, then rebuildTable's backup check must flush
  // it before VACUUM) and FIX 4 (backup must NOT be skipped just because
  // legacyVersion is 0 — this DB has pre-existing tables, i.e. it's not a
  // fresh install, even though we pass legacyVersion: 0 to mimic an
  // already-cutover on-disk DB on a later boot).
  const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-backup-path-1-'))
  const dbPath1 = path.join(dir1, 'orpheus.sqlite')
  const bpdb1 = new Database(dbPath1)
  bpdb1.exec('PRAGMA journal_mode = WAL')

  // Pre-existing user table (proves this is NOT a fresh install) with an
  // 'in_review' row that will force a rebuild of `bp_workspaces` (CHECK
  // change) alongside an addColumn on a sibling table (`bp_projects`).
  bpdb1.exec(`CREATE TABLE bp_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)
  bpdb1.exec("INSERT INTO bp_projects (id, name) VALUES ('p1', 'proj')")
  bpdb1.exec(`CREATE TABLE bp_workspaces (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('in_progress','in_review','idle','archived')))`)
  bpdb1.exec("INSERT INTO bp_workspaces (id, status) VALUES ('w1', 'idle')")

  const bpSchema1 = {
    bp_projects: {
      // `added_at` is new → addColumn op, planned+executed BEFORE the
      // rebuildTable op below (engine.ts buckets createTable/addColumn first).
      columns: { id: 'TEXT PRIMARY KEY', name: 'TEXT NOT NULL', added_at: 'INTEGER' }
    },
    bp_workspaces: {
      // CHECK narrows (drops 'in_review') → forces rebuildTable.
      columns: {
        id: 'TEXT PRIMARY KEY',
        status: {
          type: 'TEXT',
          notNull: true,
          default: "'idle'",
          check: "CHECK (status IN ('in_progress','idle','archived'))"
        }
      },
      normalizeOnRebuild: {
        status: "CASE WHEN status IN ('in_progress','idle','archived') THEN status ELSE 'idle' END"
      }
    }
  }

  const plan1 = planSync(bpdb1, bpSchema1)
  assert.ok(
    plan1.some((op) => op.kind === 'addColumn' && op.table === 'bp_projects'),
    'backup-path fixture (1): expected an addColumn op'
  )
  assert.ok(
    plan1.some((op) => op.kind === 'rebuildTable' && op.table === 'bp_workspaces'),
    'backup-path fixture (1): expected a rebuildTable op'
  )

  // Must NOT throw "cannot VACUUM from within a transaction" (FIX 1).
  assert.doesNotThrow(() => {
    sync(bpdb1, bpSchema1, { dbPath: dbPath1, legacyVersion: 0 })
  }, 'sync() must not throw when a prior addColumn leaves a transaction open before a rebuildTable backup')

  // Backup must have been taken (FIX 4 — non-fresh on-disk DB, even at
  // legacyVersion 0, must still be backed up before the destructive rebuild).
  const bakPath1 = `${dbPath1}.bak-0`
  assert.ok(
    fs.existsSync(bakPath1),
    'backup-path: expected a .bak file, backup must not be skipped'
  )

  bpdb1.close()
  fs.rmSync(dir1, { recursive: true, force: true })

  // --- (2) crash-loop simulation: a stale .bak already exists at the target
  // path (from a prior failed migration attempt) — must NOT throw "output
  // file already exists" (FIX 2).
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-backup-path-2-'))
  const dbPath2 = path.join(dir2, 'orpheus.sqlite')
  const bpdb2 = new Database(dbPath2)
  bpdb2.exec('PRAGMA journal_mode = WAL')
  bpdb2.exec(`CREATE TABLE bp2_t (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('a','b')))`)
  bpdb2.exec("INSERT INTO bp2_t (id, status) VALUES ('x', 'a')")

  const bpSchema2 = {
    bp2_t: {
      columns: {
        id: 'TEXT PRIMARY KEY',
        status: { type: 'TEXT', notNull: true, default: "'idle'", check: "CHECK (status IN ('a'))" }
      },
      normalizeOnRebuild: { status: "CASE WHEN status IN ('a') THEN status ELSE 'a' END" }
    }
  }

  // Pre-create a stale .bak at the exact path sync() will compute (dbPath2,
  // legacyVersion 7) — simulates a crash after a prior run's backup but
  // before convergence completed.
  const staleBakPath = `${dbPath2}.bak-7`
  fs.writeFileSync(staleBakPath, 'stale-leftover-from-a-crashed-migration')
  assert.ok(fs.existsSync(staleBakPath))

  assert.doesNotThrow(() => {
    sync(bpdb2, bpSchema2, { dbPath: dbPath2, legacyVersion: 7 })
  }, 'sync() must not throw "output file already exists" when a stale .bak pre-exists at the target path')

  // The stale placeholder must have been replaced by a real VACUUM INTO
  // snapshot (a real sqlite file, not the literal placeholder text written
  // above).
  const bakContents = fs.readFileSync(staleBakPath)
  assert.ok(
    bakContents.toString('utf8', 0, 16) !== 'stale-leftover-f',
    'stale .bak must have been overwritten with a real backup'
  )

  bpdb2.close()
  fs.rmSync(dir2, { recursive: true, force: true })

  // --- (3) undeclared live column survives a rebuild triggered by a sibling
  // CHECK change (FIX 3) ---------------------------------------------------
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-backup-path-3-'))
  const dbPath3 = path.join(dir3, 'orpheus.sqlite')
  const bpdb3 = new Database(dbPath3)
  bpdb3.exec('PRAGMA journal_mode = WAL')
  // `legacy_note` is NOT declared in the desired schema below, and NOT in
  // dropColumns — diff.ts's contract says it must be left alone (no op) even
  // though the table rebuilds for an unrelated reason (status CHECK change).
  bpdb3.exec(`CREATE TABLE bp3_t (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','in_review','archived')),
    legacy_note TEXT)`)
  bpdb3.exec(
    "INSERT INTO bp3_t (id, status, legacy_note) VALUES ('r1', 'in_review', 'important-legacy-data')"
  )

  const bpSchema3 = {
    bp3_t: {
      columns: {
        id: 'TEXT PRIMARY KEY',
        status: {
          type: 'TEXT',
          notNull: true,
          default: "'idle'",
          check: "CHECK (status IN ('idle','archived'))"
        }
        // legacy_note intentionally absent, and no dropColumns entry for it.
      },
      normalizeOnRebuild: {
        status: "CASE WHEN status IN ('idle','archived') THEN status ELSE 'idle' END"
      }
    }
  }

  const plan3 = planSync(bpdb3, bpSchema3)
  assert.ok(
    plan3.some((op) => op.kind === 'rebuildTable' && op.table === 'bp3_t'),
    'backup-path fixture (3): expected a rebuildTable op'
  )

  sync(bpdb3, bpSchema3, { dbPath: dbPath3, legacyVersion: 0 })

  const survivorRow = bpdb3
    .prepare('SELECT status, legacy_note FROM bp3_t WHERE id = ?')
    .get('r1') as {
    status: string
    legacy_note: string | null
  }
  assert.equal(survivorRow.status, 'idle', 'backup-path (3): status must have been normalized')
  assert.equal(
    survivorRow.legacy_note,
    'important-legacy-data',
    'backup-path (3): undeclared live column data must survive the rebuild (FIX 3)'
  )

  bpdb3.close()
  fs.rmSync(dir3, { recursive: true, force: true })

  // --- (4) DEFAULT-only drift triggers a rebuild (FIX 5) ------------------
  const dpdb = new Database(':memory:')
  dpdb.exec(`CREATE TABLE bp4_t (id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'off')`)
  const bpSchema4 = {
    bp4_t: {
      columns: {
        id: 'TEXT PRIMARY KEY',
        // Same type/notNull/pk/check as live — ONLY the default differs.
        mode: { type: 'TEXT', notNull: true, default: "'on'" }
      }
    }
  }
  const plan4 = planSync(dpdb, bpSchema4)
  assert.deepEqual(
    plan4,
    [{ kind: 'rebuildTable', table: 'bp4_t', reason: 'mode DEFAULT differs' }],
    'backup-path (4): a DEFAULT-only drift must plan a rebuildTable'
  )
  dpdb.close()

  console.log('✓ backup-path')
}

// ---------------------------------------------------------------------------
// backup-atomic: exercises FIX A directly — backupBefore() must write to a
// temp path and only rename over the target on success, so a stale-but-good
// `.bak-*` from a prior crashed migration is never destroyed by a new backup
// attempt that itself fails partway (disk full / EIO / permissions). Two
// cases: (1) VACUUM INTO fails (forced via an unwritable directory) → the
// pre-existing stale .bak must survive UNCHANGED and no .tmp-* leftover must
// remain; (2) the success path — a stale .bak is atomically replaced with
// fresh content and no .tmp-* leftover remains (already partly covered by
// backup-path case (2), re-asserted here directly against backupBefore()).
// ---------------------------------------------------------------------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-backup-atomic-'))
  const dbPath = path.join(dir, 'orpheus.sqlite')
  const abdb = new Database(dbPath)
  abdb.exec('PRAGMA journal_mode = WAL')
  abdb.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('x')")

  // Pre-existing stale backup — the only recovery point from a prior crashed
  // migration attempt.
  const staleBakPath = `${dbPath}.bak-9`
  const staleContent = 'stale-but-good-recovery-point'
  fs.writeFileSync(staleBakPath, staleContent)

  // Force VACUUM INTO to fail by making the directory unwritable, so the tmp
  // file backupBefore() tries to create there cannot be written.
  fs.chmodSync(dir, 0o555)
  let threw = false
  try {
    backupBefore(abdb, dbPath, 9)
  } catch {
    threw = true
  } finally {
    // Restore write permission so we can clean up / inspect the directory.
    fs.chmodSync(dir, 0o755)
  }
  assert.ok(
    threw,
    'backup-atomic: backupBefore must throw when VACUUM INTO cannot write its tmp target'
  )

  // The stale recovery point must be completely untouched.
  assert.ok(
    fs.existsSync(staleBakPath),
    'backup-atomic: the stale .bak must still exist after a failed backup attempt'
  )
  assert.equal(
    fs.readFileSync(staleBakPath, 'utf8'),
    staleContent,
    'backup-atomic: the stale .bak content must be unchanged after a failed backup attempt'
  )

  // No tmp leftover from the failed attempt.
  const leftoverTmp = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(
    leftoverTmp,
    [],
    'backup-atomic: no .tmp-* leftover after a failed backup attempt'
  )

  abdb.close()
  fs.rmSync(dir, { recursive: true, force: true })

  // --- success path: stale .bak correctly replaced via tmp+rename ----------
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-backup-atomic-ok-'))
  const dbPath2 = path.join(dir2, 'orpheus.sqlite')
  const abdb2 = new Database(dbPath2)
  abdb2.exec('PRAGMA journal_mode = WAL')
  abdb2.exec("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('y')")

  const staleBakPath2 = `${dbPath2}.bak-9`
  fs.writeFileSync(staleBakPath2, 'stale-leftover-from-a-crashed-migration')

  const bak = backupBefore(abdb2, dbPath2, 9)
  assert.equal(bak, staleBakPath2)
  assert.ok(fs.existsSync(bak), 'backup-atomic: new backup must exist at the target path')

  const newContent = fs.readFileSync(bak)
  assert.ok(
    newContent.toString('utf8', 0, 16) !== 'stale-leftover-f',
    'backup-atomic: stale .bak must be replaced by a real VACUUM snapshot'
  )
  const readonlyDb2 = new DatabaseSync(bak, { readOnly: true })
  assert.equal((readonlyDb2.prepare('SELECT COUNT(*) c FROM t').get() as { c: number }).c, 1)
  readonlyDb2.close()

  const leftoverTmp2 = fs.readdirSync(dir2).filter((f) => f.includes('.tmp-'))
  assert.deepEqual(leftoverTmp2, [], 'backup-atomic: no .tmp-* leftover after a successful backup')

  abdb2.close()
  fs.rmSync(dir2, { recursive: true, force: true })

  console.log('✓ backup-atomic')
}
