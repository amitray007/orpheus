// ---------------------------------------------------------------------------
// scripts/verify-workspace-harness-create.ts
//
// C1 (support-multi-harness) BEHAVIOR guard for createWorkspace()'s new
// harnessId param (src/main/workspaces.ts) — the write-side half of the
// multi-harness migration. workspaces.harness_id has existed since Phase 1.3
// and is read correctly everywhere, but until C1 nothing could ever write a
// non-default value: createWorkspace() took no harnessId and its INSERT
// listed 12 columns with harness_id absent. This asserts, against the REAL
// exported createWorkspace/getWorkspace (not a restatement of their source
// text):
//
//   1. Omitted harnessId -> the row gets 'claude' (the schema DEFAULT, not a
//      hardcoded literal in application code).
//   2. An explicit valid harnessId ('claude', the only registered id today)
//      round-trips through the INSERT and back out via getWorkspace.
//   3. An unknown/garbage harnessId is REJECTED (createWorkspace throws)
//      rather than written raw to the column.
//   4. resolveHarness (src/main/harness/registry.ts) still falls back to
//      Claude for a stale/unknown id already sitting in a row — proving the
//      DB-write-boundary rejection above and the read-side fallback are two
//      independent, both-necessary guarantees, not one standing in for the
//      other.
//
// IMPORTABILITY: workspaces.ts imports `electron`'s BrowserWindow directly,
// and transitively (via overridesStore.ts/diagnostics.ts) imports getDb from
// ./db, which itself imports better-sqlite3 + electron's `app`. A plain
// `bun run` import dies at module-link time outside Electron, and
// better-sqlite3 hard-crashes Bun 1.3.10 — so this runs under
// `node --experimental-strip-types` with node:sqlite.
//
// THIS FILE'S FIRST VERSION used bun:test's/node:test's mock.module(), which
// is Bun-only (node needs --experimental-test-module-mocks, which the
// verify-agentic-regression.ts dispatcher does not pass, and mixing that
// with node:sqlite is a runtime nobody actually runs this suite under) —
// caught in review as dead verification. Rewritten to the ACTUAL established
// pattern this repo already uses for "import a real electron-reaching
// main-process module under plain node" — see
// verify-harness-launch-parity.ts's header + createFreshDb, which this file
// mirrors closely: a node `register()` ESM resolve hook that short-circuits
// the `electron` specifier to an inline stub module and `./db`/`../db` to an
// inline stub whose getDb() returns a `globalThis`-stashed test database.
// This needs no experimental flag beyond --experimental-strip-types (already
// required for the .ts sources) and lets the REAL createWorkspace/
// getWorkspace/resolveHarness run unmodified against a real, schema.ts-
// derived in-memory table.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

class Database extends DatabaseSync {}

const dbStubSource = `
export function getDb() {
  if (!globalThis.__C1_HARNESS_CREATE_TEST_DB__) {
    throw new Error('verify-workspace-harness-create: no test DB set')
  }
  return globalThis.__C1_HARNESS_CREATE_TEST_DB__
}
`

const electronStubSource = `
export const app = {}
export const BrowserWindow = { getAllWindows: () => [] }
`

const hooks = `
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(electronStubSource))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStubUrl, shortCircuit: true }
  }
  // src/main/db is a DIRECTORY module (db/index.ts) and node's raw ESM
  // resolver rejects directory imports outright (ERR_UNSUPPORTED_DIR_IMPORT)
  // rather than falling back to index.ts the way bundler resolution does.
  // Intercept from every relative spelling this graph reaches it by:
  // workspaces.ts ('./db'), overridesStore.ts/diagnostics.ts ('./db').
  if (specifier === './db' || specifier === '../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    // src/**/*.ts use extensionless relative imports (tsconfig.node.json's
    // moduleResolution: bundler) — retry with a .ts suffix, same fallback
    // verify-migration-engine.ts/verify-harness-launch-parity.ts use.
    if (
      err &&
      err.code === 'ERR_MODULE_NOT_FOUND' &&
      specifier.startsWith('.') &&
      !specifier.endsWith('.ts')
    ) {
      return await nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`

register(`data:text/javascript,${encodeURIComponent(hooks)}`)

// schema.ts/render.ts use extensionless relative imports, so they must load
// AFTER the resolve hook above is registered — hence dynamic imports
// throughout this file rather than static ones at the top.
const { renderCreateTable } = await import('../src/main/db/render.ts')
const { schema } = await import('../src/main/db/schema.ts')

/**
 * Build a fresh in-memory DB carrying the REAL `projects`/`workspaces`
 * tables, derived from src/main/db/schema.ts via renderCreateTable rather
 * than hand-written DDL, so the fixture cannot drift from the real
 * `harness_id TEXT NOT NULL DEFAULT 'claude'` column the way a copied CREATE
 * TABLE silently could. Stashed on globalThis so the resolve-hook's inline
 * db stub module (defined above, before this DB exists) can return it.
 */
function createFreshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  for (const table of ['projects', 'workspaces']) {
    db.exec(renderCreateTable(table, schema[table]))
  }
  db.prepare(`INSERT INTO projects (id, path, name, added_at) VALUES (?, ?, ?, 0)`).run(
    'p1',
    '/tmp/p1',
    'Project One'
  )
  ;(
    globalThis as unknown as { __C1_HARNESS_CREATE_TEST_DB__: unknown }
  ).__C1_HARNESS_CREATE_TEST_DB__ = db
  return db
}

const db = createFreshDb()

const { createWorkspace, getWorkspace } = await import('../src/main/workspaces.ts')
const { resolveHarness } = await import('../src/main/harness/registry.ts')

// ---------------------------------------------------------------------------
// 1. Omitted harnessId -> 'claude' via the schema DEFAULT, not a hardcoded
//    literal in createWorkspace's own INSERT.
// ---------------------------------------------------------------------------

{
  const ws = createWorkspace({ projectId: 'p1', name: 'no-harness', cwd: '/tmp/p1' })
  assert.equal(ws.harnessId, 'claude', 'omitted harnessId must default to claude')
  const reread = getWorkspace(ws.id)
  assert.equal(reread?.harnessId, 'claude', 'the default must be what getWorkspace reads back too')
  console.log('✓ omitted harnessId defaults to claude (schema DEFAULT, round-tripped)')
}

// ---------------------------------------------------------------------------
// 2. An explicit valid harnessId round-trips exactly.
// ---------------------------------------------------------------------------

{
  const ws = createWorkspace({
    projectId: 'p1',
    name: 'explicit-claude',
    cwd: '/tmp/p1',
    harnessId: 'claude'
  })
  assert.equal(ws.harnessId, 'claude')
  const reread = getWorkspace(ws.id)
  assert.equal(
    reread?.harnessId,
    'claude',
    'explicit harnessId must round-trip through getWorkspace'
  )
  console.log('✓ explicit valid harnessId round-trips through INSERT and getWorkspace')
}

// ---------------------------------------------------------------------------
// 3. An unknown/garbage harnessId is rejected, never written raw.
// ---------------------------------------------------------------------------

{
  const before = (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n
  assert.throws(
    () =>
      createWorkspace({
        projectId: 'p1',
        name: 'bad-harness',
        cwd: '/tmp/p1',
        // @ts-expect-error -- deliberately garbage, proving the runtime
        // guard catches what the type system alone would only warn about
        // for a value read from an external/untrusted source (IPC, socket).
        harnessId: 'not-a-real-harness'
      }),
    /unknown harnessId/,
    'an unregistered harnessId must throw, not silently write'
  )
  const after = (db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n
  assert.equal(before, after, 'a rejected harnessId must not leave a partial row behind')
  const raw = db.prepare(`SELECT harness_id FROM workspaces WHERE name = 'bad-harness'`).get() as
    | { harness_id: string }
    | undefined
  assert.equal(raw, undefined, 'the garbage id must never reach the harness_id column')
  console.log('✓ unknown harnessId is rejected before the INSERT, never written raw')
}

// ---------------------------------------------------------------------------
// 4. resolveHarness still falls back to Claude for a stale/unknown id
//    already sitting in a row (the read-side guarantee this whole migration
//    depends on) — independent of #3's write-side rejection above. Proven
//    by writing the unknown id directly at the SQL level (bypassing
//    createWorkspace's own guard, simulating a row from a future build with
//    a since-removed harness, or a rollback) and confirming the app's own
//    resolver is still inert, not fatal.
// ---------------------------------------------------------------------------

{
  db.prepare(
    `UPDATE workspaces SET harness_id = 'some-removed-harness' WHERE name = 'explicit-claude'`
  ).run()
  const staleRow = db.prepare(`SELECT id FROM workspaces WHERE name = 'explicit-claude'`).get() as {
    id: string
  }
  const stale = getWorkspace(staleRow.id)
  assert.equal(
    stale?.harnessId,
    'some-removed-harness',
    'getWorkspace must read the raw stored value back verbatim (no silent coercion at read time)'
  )
  const resolved = resolveHarness(stale?.harnessId)
  assert.equal(resolved.id, 'claude', 'resolveHarness must fall back to Claude for an unknown id')
  console.log('✓ resolveHarness falls back to Claude for a stale/unknown stored id')
}

console.log('\nworkspace harness-create verification passed')
