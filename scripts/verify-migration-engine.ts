import assert from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
// better-sqlite3-compatible shim for the harness: DatabaseSync's prepare()/exec() already match;
// provide a Database-like constructor name so the rest of the harness is unchanged.
class Database extends DatabaseSync {}
import { enumCheck, renderCreateTable } from '../src/main/db/render.ts'
import { introspectTable } from '../src/main/db/introspect.ts'

// enumCheck renders a canonical IN(...) clause from a shared array
assert.equal(
  enumCheck('status', ['idle', 'archived'] as const),
  "CHECK (status IN ('idle', 'archived'))",
)

// renderCreateTable produces deterministic SQL from a structured def
const sql = renderCreateTable('workspaces', {
  columns: {
    id: 'TEXT PRIMARY KEY',
    project_id: 'TEXT NOT NULL',
    status: { type: 'TEXT', notNull: true, default: "'idle'", check: enumCheck('status', ['idle', 'archived']) },
  },
  foreignKeys: [{ columns: ['project_id'], ref: 'projects(id)', onDelete: 'CASCADE' }],
})
assert.ok(sql.startsWith('CREATE TABLE workspaces ('), sql)
assert.ok(sql.includes("status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'archived'))"), sql)
assert.ok(sql.includes('FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE'), sql)
console.log('✓ render')

// introspectTable reads live DB structural state via PRAGMA + sqlite_master
const db = new Database(':memory:')
db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0)")
db.exec("CREATE INDEX t_n_idx ON t(n)")
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
    columns: { id: 'TEXT PRIMARY KEY', n: 'INTEGER', extra: 'TEXT' },
  }
  // live is missing `extra` → addColumn
  const live = {
    name: 't', createSql: 'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)',
    columns: [
      { name: 'id', type: 'TEXT', notNull: false, dflt: null, pk: true },
      { name: 'n', type: 'INTEGER', notNull: false, dflt: null, pk: false },
    ],
    indexes: [],
  }
  const ops = diffTable('t', desired, live)
  assert.deepEqual(ops, [{ kind: 'addColumn', table: 't', column: 'extra' }])

  // missing table → createTable
  assert.deepEqual(diffTable('t', desired, null), [{ kind: 'createTable', table: 't' }])

  // live has a stray column NOT in dropColumns → no op
  const desired2 = { columns: { id: 'TEXT PRIMARY KEY' } }
  const live2 = { ...live, columns: [live.columns[0], { name: 'gone', type: 'TEXT', notNull: false, dflt: null, pk: false }] }
  assert.deepEqual(diffTable('t', desired2, live2), [])

  // same, but with dropColumns → dropColumn op
  const desired3 = { columns: { id: 'TEXT PRIMARY KEY' }, dropColumns: ['gone'] }
  assert.deepEqual(diffTable('t', desired3, live2), [{ kind: 'dropColumn', table: 't', column: 'gone' }])
  console.log('✓ diff')
}
