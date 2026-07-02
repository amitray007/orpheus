import assert from 'node:assert'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

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
import { enumCheck, renderCreateTable } from '../src/main/db/render.ts'
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
