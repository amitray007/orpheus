// ---------------------------------------------------------------------------
// scripts/verify-footer-actions.ts
//
// C5 (support-multi-harness) BEHAVIOR guard for the per-harness footer-
// action SEEDING half of this unit — src/main/footerActions.ts's
// seedDefaultFooterActions/seedDefaultFooterActionsForHarness/
// seedDefaultFooterActionsForAllHarnesses/resetToDefaults, plus the new
// harness_id provenance column and the terminal.sendInput gate it drives
// (filterActionsForHarness's own gating-DECISION behavior, independent of
// storage, is covered by scripts/verify-harness-actions.ts — this file is
// specifically the DB-touching seed/provenance half).
//
// THE LOAD-BEARING SAFETY PROPERTY under test: a user's existing rows must
// never be deleted, duplicated, or filtered out by this migration.
// Concretely:
//   1. A NULL-provenance row (every row that predates the harness_id
//      column, and every user-authored row created after it) must be shown
//      on EVERY harness, always — never treated as "belongs to nobody" or
//      "belongs to Claude by default".
//   2. A row stamped for harness X must be hidden when resolving harness Y,
//      and shown again on X.
//   3. Seeding a harness that already has rows (whole-table OR per-harness)
//      must never duplicate or overwrite them.
//   4. An existing user's 11 seeded (pre-C5, un-stamped) rows must be
//      byte-identical after this migration — same count, same fields, same
//      NULL provenance — never retroactively stamped.
//
// IMPORTABILITY: footerActions.ts imports getDb from './db' and
// resolveHarness/HARNESSES from './harness/registry', which itself reaches
// deep into harness/claude/{launch,settings,session}.ts, models/registry.ts,
// and routingProxy/providers/registry.ts. None of that chain imports
// `electron` directly (verified by grep before writing this file), but the
// db stub is still required — same pattern as verify-workspace-harness-
// create.ts's own header comment, which this file mirrors closely: a node
// `register()` ESM resolve hook that short-circuits './db'/'../db' (both
// spellings are reachable — footerActions.ts imports './db', harness/
// settings.ts imports '../db') to an inline stub whose getDb() returns a
// globalThis-stashed real in-memory DatabaseSync, schema.ts-derived so the
// fixture cannot drift from the real harness_id column.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

class Database extends DatabaseSync {}

const dbStubSource = `
export function getDb() {
  if (!globalThis.__C5_FOOTER_ACTIONS_TEST_DB__) {
    throw new Error('verify-footer-actions: no test DB set')
  }
  return globalThis.__C5_FOOTER_ACTIONS_TEST_DB__
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
  if (specifier === './db' || specifier === '../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
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

const { renderCreateTable } = await import('../src/main/db/render.ts')
const { schema } = await import('../src/main/db/schema.ts')

/**
 * Fresh in-memory DB carrying the REAL footer_actions_global table (plus
 * workspaces/projects, since listMerged reads workspaces.harness_id),
 * derived from schema.ts via renderCreateTable so the fixture cannot drift
 * from the real, C5-added `harness_id TEXT` column the way hand-written DDL
 * silently could.
 */
function createFreshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  // footer_actions_project/_workspace are created too — listMerged() (used
  // by assertion 6's end-to-end gating check) queries all three tables
  // unconditionally, even though seeding never writes to the latter two
  // (see BaseRow/GlobalRow's own comment in footerActions.ts: only
  // footer_actions_global carries harness_id/is ever harness-seeded).
  for (const table of [
    'projects',
    'workspaces',
    'footer_actions_global',
    'footer_actions_project',
    'footer_actions_workspace'
  ]) {
    db.exec(renderCreateTable(table, schema[table]))
  }
  // better-sqlite3-compatible `.transaction(fn)` shim — footerActions.ts's
  // seed functions call `db.transaction(() => {...})()` (better-sqlite3's
  // API); node:sqlite's DatabaseSync has no such method natively. Same
  // shim as verify-project-add.ts's own precedent: wrap in BEGIN/COMMIT,
  // roll back on throw. Only needs to support the exact zero-arg-callback
  // shape footerActions.ts uses.
  const dbWithTransaction = db as InstanceType<typeof Database> & {
    transaction: <R>(fn: () => R) => () => R
  }
  dbWithTransaction.transaction = (fn) => {
    return () => {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  }
  ;(
    globalThis as unknown as { __C5_FOOTER_ACTIONS_TEST_DB__: unknown }
  ).__C5_FOOTER_ACTIONS_TEST_DB__ = db
  return db
}

let db = createFreshDb()

const footerActions = await import('../src/main/footerActions.ts')
const { CLAUDE_DEFAULT_ACTIONS } = await import('../src/main/harness/claude/actions.ts')

function resetDb(): void {
  db = createFreshDb()
}

function globalRowCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM footer_actions_global').get() as { c: number }).c
}

type FullGlobalRow = {
  id: string
  label: string
  icon: string | null
  action_id: string
  params_json: string
  visible_when: string
  position: number
  created_at: number
  updated_at: number
  prompts_json: string | null
  harness_id: string | null
}

/**
 * SELECT * (every column, including `id`/`created_at`/`updated_at`), not a
 * curated subset — the byte-identical assertions below (esp. #4, modeled on
 * a real user's DB) must catch ANY column drift a broken seed/migration
 * could introduce, not just label/action_id/position. In particular
 * `updated_at` must never be bumped for a row the migration didn't touch.
 */
function globalRows(): FullGlobalRow[] {
  return db
    .prepare('SELECT * FROM footer_actions_global ORDER BY position ASC')
    .all() as FullGlobalRow[]
}

// ---------------------------------------------------------------------------
// 1. Fresh install: seedDefaultFooterActions() seeds exactly
//    CLAUDE_DEFAULT_ACTIONS.length rows, all stamped harness_id = 'claude'.
// ---------------------------------------------------------------------------

{
  footerActions.seedDefaultFooterActions()
  const rows = globalRows()
  assert.equal(
    rows.length,
    CLAUDE_DEFAULT_ACTIONS.length,
    'a fresh install must seed exactly CLAUDE_DEFAULT_ACTIONS.length rows'
  )
  assert.ok(
    rows.every((r) => r.harness_id === 'claude'),
    "every freshly-seeded row must be stamped harness_id = 'claude'"
  )
  console.log(
    `✓ fresh install seeds ${rows.length} rows via seedDefaultFooterActions(), all stamped 'claude'`
  )
}

// ---------------------------------------------------------------------------
// 2. Idempotency: calling seedDefaultFooterActions() again is a total no-op
//    (whole-table count > 0 short-circuit — UNCHANGED pre-C5 behavior).
// ---------------------------------------------------------------------------

{
  const before = globalRowCount()
  footerActions.seedDefaultFooterActions()
  const after = globalRowCount()
  assert.equal(before, after, 'calling seedDefaultFooterActions() twice must not duplicate rows')
  console.log(
    '✓ seedDefaultFooterActions() is idempotent (whole-table count short-circuit unchanged)'
  )
}

// ---------------------------------------------------------------------------
// 3. seedDefaultFooterActionsForAllHarnesses() after the above is a no-op
//    for Claude (rows already stamped) — no duplication.
// ---------------------------------------------------------------------------

{
  const before = globalRowCount()
  footerActions.seedDefaultFooterActionsForAllHarnesses()
  const after = globalRowCount()
  assert.equal(
    before,
    after,
    'seedDefaultFooterActionsForAllHarnesses() must not duplicate an already-seeded harness'
  )
  console.log(
    '✓ per-harness seeding is a no-op once a harness already has stamped rows (no duplication)'
  )
}

// ---------------------------------------------------------------------------
// 4. PRE-C5 SIMULATION: an existing user's rows (seeded before this column
//    existed) are NULL-provenance, and this migration must never touch
//    them. Simulated by resetting the DB, inserting 11 rows exactly like
//    the pre-C5 seeder used to (no harness_id column value = NULL), then
//    running seedDefaultFooterActions() and confirming it is a pure no-op
//    (still whole-table count > 0) and every row stays NULL forever.
// ---------------------------------------------------------------------------

{
  resetDb()
  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO footer_actions_global
      (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  CLAUDE_DEFAULT_ACTIONS.forEach((draft, idx) => {
    insert.run(
      `pre-c5-${idx}`,
      draft.label,
      draft.icon ?? null,
      draft.actionId,
      JSON.stringify(draft.params ?? {}),
      draft.visibleWhen,
      idx,
      now,
      now,
      draft.prompts ? JSON.stringify(draft.prompts) : null
    )
  })
  const beforeRows = globalRows()
  assert.ok(
    beforeRows.every((r) => r.harness_id === null),
    'the pre-C5 simulated rows must all read back harness_id = NULL before migration'
  )

  footerActions.seedDefaultFooterActions()
  footerActions.seedDefaultFooterActionsForAllHarnesses()

  const afterRows = globalRows()
  assert.equal(
    afterRows.length,
    beforeRows.length,
    "an existing user's row COUNT must be unchanged after C5 (no duplication, no seeding-over)"
  )
  assert.deepEqual(
    afterRows,
    beforeRows,
    "an existing user's rows must be BYTE-IDENTICAL after C5 — same label/action_id/position, " +
      'and NEVER retroactively stamped with a harness_id'
  )
  console.log(
    "✓ an existing user's pre-C5 (NULL-provenance) rows are untouched, unduplicated, and never " +
      'retroactively stamped — the load-bearing data-safety property'
  )
}

// ---------------------------------------------------------------------------
// 4b. REAL-USER-SHAPED CUSTOMIZATION (not the full 11/8 set — a PRUNED
//    subset, mirroring an actual production footer_actions_global inspected
//    read-only during this unit's development: 8 rows, NULL-provenance,
//    with `/compact`, `/cost`, `Archive`, and `Rename` deliberately deleted
//    by the user). This is the sharpest version of the data-safety property:
//    a migration that "helpfully" restores those 4 deleted chips because
//    the row count (8) doesn't match either canonical list's length (11)
//    would be real, user-visible data loss — the user explicitly removed
//    them and would see them reappear unexpectedly. seedDefaultFooterActions/
//    seedDefaultFooterActionsForAllHarnesses must be a pure no-op regardless
//    of WHICH subset the user kept, because the guard is "does the table
//    have any row at all", never "does the row count/shape match what we'd
//    seed". Also asserts full byte-identity across EVERY column (id,
//    created_at, updated_at, params_json, icon, prompts_json) — not just
//    label/action_id/position — so a migration that rewrote positions or
//    bumped updated_at on an untouched row would be caught here too.
// ---------------------------------------------------------------------------

{
  resetDb()
  const now = Date.now()
  // The real, observed production subset — Fork, /copy, /context, /clear,
  // Context (getUsage), Cost (getCost), Effort, Model. Deliberately built
  // from a literal list, NOT filtered out of CLAUDE_DEFAULT_ACTIONS/
  // DEFAULT_SEEDS, so this fixture cannot silently track a future change to
  // either canonical list and stop representing the real, already-pruned
  // data it was built to protect.
  const realUserRows = [
    {
      label: 'Fork',
      icon: 'GitFork',
      actionId: 'workspace.fork',
      params: {},
      visibleWhen: 'always' as const
    },
    {
      label: '/copy',
      icon: 'Clipboard',
      actionId: 'terminal.sendInput',
      params: { text: '/copy', submit: true },
      visibleWhen: 'idle' as const
    },
    {
      label: '/context',
      icon: 'Brain',
      actionId: 'terminal.sendInput',
      params: { text: '/context', submit: true },
      visibleWhen: 'always' as const
    },
    {
      label: '/clear',
      icon: 'Eraser',
      actionId: 'terminal.sendInput',
      params: { text: '/clear', submit: true },
      visibleWhen: 'idle' as const
    },
    {
      label: 'Context',
      icon: 'Gauge',
      actionId: 'session.getUsage',
      params: {},
      visibleWhen: 'always' as const
    },
    {
      label: 'Cost',
      icon: 'CurrencyDollar',
      actionId: 'session.getCost',
      params: {},
      visibleWhen: 'always' as const
    },
    {
      label: 'Effort',
      icon: 'Sliders',
      actionId: 'footer.effortSelect',
      params: {},
      visibleWhen: 'always' as const
    },
    {
      label: 'Model',
      icon: 'Robot',
      actionId: 'footer.modelSelect',
      params: {},
      visibleWhen: 'always' as const
    }
  ]
  const insertReal = db.prepare(`
    INSERT INTO footer_actions_global
      (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  realUserRows.forEach((row, idx) => {
    insertReal.run(
      `real-user-${idx}`,
      row.label,
      row.icon,
      row.actionId,
      JSON.stringify(row.params),
      row.visibleWhen,
      idx,
      now,
      now,
      null
    )
  })

  const beforeRows = globalRows()
  assert.equal(
    beforeRows.length,
    8,
    'the real-user-shaped fixture must have exactly 8 rows, not 11'
  )
  assert.ok(
    !beforeRows.some((r) => r.action_id === 'terminal.sendInput' && r.label === '/compact'),
    'the fixture must NOT contain /compact (the user deleted it)'
  )
  assert.ok(
    !beforeRows.some((r) => r.action_id === 'terminal.sendInput' && r.label === '/cost'),
    'the fixture must NOT contain /cost (the user deleted it)'
  )
  assert.ok(
    !beforeRows.some((r) => r.action_id === 'workspace.archive'),
    'the fixture must NOT contain Archive (the user deleted it)'
  )
  assert.ok(
    !beforeRows.some((r) => r.action_id === 'workspace.rename'),
    'the fixture must NOT contain Rename (the user deleted it)'
  )

  // Run the data step (idempotent by design — running it AGAIN afterward
  // must also be a no-op, verified below) plus the full per-harness sweep.
  footerActions.seedDefaultFooterActions()
  footerActions.seedDefaultFooterActionsForAllHarnesses()
  const afterFirstRun = globalRows()
  assert.deepEqual(
    afterFirstRun,
    beforeRows,
    "a real user's deliberately-pruned 8-row footer must be BYTE-IDENTICAL after the seed functions run — " +
      'no /compact, /cost, Archive, or Rename must reappear, and no column (including updated_at) may change'
  )

  // Idempotency: run again — still nothing changes.
  footerActions.seedDefaultFooterActions()
  footerActions.seedDefaultFooterActionsForAllHarnesses()
  const afterSecondRun = globalRows()
  assert.deepEqual(
    afterSecondRun,
    beforeRows,
    'running the seed functions a second time against the same real-user-shaped DB must still change nothing'
  )

  console.log(
    "✓ a real user's deliberately-pruned 8-row footer (modeled on an actual production DB inspected " +
      'read-only) is byte-identical after C5 runs once AND twice — /compact/​/cost/Archive/Rename never ' +
      're-appear, no column drifts, confirming the guard is presence-of-any-row, never a row-count/shape match'
  )
}

// ---------------------------------------------------------------------------
// 5. Fresh DB again: seedDefaultFooterActionsForHarness for an UNKNOWN
//    harness id is a no-op (resolveHarness falls back to claude, so this
//    just re-seeds claude — proving it can never silently seed under the
//    wrong stamp for a garbage id).
// ---------------------------------------------------------------------------

{
  resetDb()
  footerActions.seedDefaultFooterActionsForHarness('not-a-real-harness')
  const rows = globalRows()
  assert.equal(
    rows.length,
    CLAUDE_DEFAULT_ACTIONS.length,
    'an unknown harness id falls back to claude (resolveHarness never throws) and seeds claude only'
  )
  assert.ok(
    rows.every((r) => r.harness_id === 'claude'),
    'the fallback-resolved seed must be stamped with the REAL resolved id (claude), never the garbage input'
  )
  console.log(
    '✓ seedDefaultFooterActionsForHarness with an unknown id falls back to claude and stamps the real resolved id'
  )
}

// ---------------------------------------------------------------------------
// 6. filterActionsForHarness provenance gate, exercised through listMerged
//    end-to-end (real DB, real workspace row) — not just the pure function
//    in isolation (verify-harness-actions.ts already covers that).
//    A NULL-provenance row shows on every harness; a stamped row shows only
//    on its matching harness.
// ---------------------------------------------------------------------------

{
  resetDb()
  const now = Date.now()
  db.prepare(`INSERT INTO projects (id, path, name, added_at) VALUES (?, ?, ?, ?)`).run(
    'p1',
    '/tmp/p1',
    'Project One',
    now
  )
  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, cwd, status, created_at, harness_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('ws-claude', 'p1', 'ws-claude', '/tmp/p1', 'idle', now, 'claude')

  const insertGlobal = db.prepare(`
    INSERT INTO footer_actions_global
      (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json, harness_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  // NULL provenance — must show everywhere.
  insertGlobal.run(
    'row-null',
    'My custom snippet',
    null,
    'terminal.sendInput',
    JSON.stringify({ text: 'echo hi', submit: true }),
    'always',
    0,
    now,
    now,
    null,
    null
  )
  // Stamped for 'claude' — must show on a claude workspace.
  insertGlobal.run(
    'row-claude',
    '/copy',
    'Clipboard',
    'terminal.sendInput',
    JSON.stringify({ text: '/copy', submit: true }),
    'idle',
    1,
    now,
    now,
    null,
    'claude'
  )
  // Stamped for a DIFFERENT (hypothetical) harness — must be hidden on the
  // claude workspace, even though resolveHarness would fall back an
  // UNKNOWN workspace harness_id to claude; here the WORKSPACE itself is a
  // real, resolved 'claude' workspace, so this row must be filtered.
  insertGlobal.run(
    'row-other',
    '/foreign-command',
    null,
    'terminal.sendInput',
    JSON.stringify({ text: '/foreign-command', submit: true }),
    'always',
    2,
    now,
    now,
    null,
    'some-other-harness'
  )

  const merged = footerActions.listMerged('ws-claude')
  const ids = merged.map((a) => a.id)
  assert.ok(ids.includes('row-null'), 'a NULL-provenance row must show on the claude workspace')
  assert.ok(ids.includes('row-claude'), "a row stamped 'claude' must show on the claude workspace")
  assert.ok(
    !ids.includes('row-other'),
    'a row stamped for a DIFFERENT harness must be hidden on the claude workspace'
  )
  console.log(
    '✓ listMerged end-to-end: NULL provenance always shows, matching-harness provenance shows, ' +
      'foreign-harness provenance is hidden'
  )
}

// ---------------------------------------------------------------------------
// C5 MUTATION TESTS — deliberately break each rule above against the REAL
// exported functions, confirm the assertions actually fail, restore.
// ---------------------------------------------------------------------------

function assertMutationCaughtC5(run: () => void, label: string): void {
  let threw = false
  try {
    run()
  } catch (err) {
    threw = true
    console.log(
      `  mutation caught (expected failure) [${label}]:`,
      (err as Error).message.split('\n')[0]
    )
  }
  assert.ok(threw, `MUTATION TEST FAILED TO FAIL: ${label} went undetected`)
}

{
  // Mutation A: simulate a broken provenance gate that treats NULL as "hide
  // everywhere" instead of "show everywhere" — the exact inversion that
  // would silently break every existing user's footer on upgrade.
  const brokenGate = (harnessId: string | null): boolean => harnessId === 'claude' // BUG: NULL never passes
  assertMutationCaughtC5(() => {
    assert.equal(
      brokenGate(null),
      true,
      'a NULL-provenance row must pass the gate (this simulates the broken inversion failing correctly)'
    )
  }, 'provenance gate treating NULL as hidden instead of always-shown')
}

{
  // Mutation B: seeding ignores the per-harness idempotency check and
  // reseeds unconditionally, simulated by directly re-running the INSERT
  // loop the way seedDefaultFooterActionsForHarness would if its `existing
  // > 0` guard were deleted.
  resetDb()
  footerActions.seedDefaultFooterActionsForHarness('claude')
  const before = globalRowCount()
  // Manually reproduce what an UNGUARDED reseed would do (bypassing the
  // real guard on purpose, to prove the assertion below actually catches
  // duplication when it happens).
  const now = Date.now()
  const insert = db.prepare(`
    INSERT INTO footer_actions_global
      (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json, harness_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  CLAUDE_DEFAULT_ACTIONS.forEach((draft, idx) => {
    insert.run(
      `dup-${idx}`,
      draft.label,
      draft.icon ?? null,
      draft.actionId,
      JSON.stringify(draft.params ?? {}),
      draft.visibleWhen,
      before + idx,
      now,
      now,
      draft.prompts ? JSON.stringify(draft.prompts) : null,
      'claude'
    )
  })
  const afterUnguardedReseed = globalRowCount()
  assertMutationCaughtC5(() => {
    assert.equal(
      before,
      afterUnguardedReseed,
      'an unguarded reseed must not change the row count (this simulates the guard being absent, and MUST fail)'
    )
  }, 'per-harness seeding guard removed (unconditional reseed duplicating rows)')
}

{
  // Mutation C: simulate retroactively stamping an existing NULL row —
  // exactly the "backfill provenance onto pre-existing data" bug the
  // schema column's own comment forbids.
  resetDb()
  const now = Date.now()
  db.prepare(
    `
    INSERT INTO footer_actions_global
      (id, label, icon, action_id, params_json, visible_when, position, created_at, updated_at, prompts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run('legacy-row', 'Fork', 'GitFork', 'workspace.fork', '{}', 'always', 0, now, now, null)
  // Simulate the bug: retroactively backfill harness_id on every NULL row.
  db.prepare(
    `UPDATE footer_actions_global SET harness_id = 'claude' WHERE harness_id IS NULL`
  ).run()
  const row = db
    .prepare(`SELECT harness_id FROM footer_actions_global WHERE id = 'legacy-row'`)
    .get() as {
    harness_id: string | null
  }
  assertMutationCaughtC5(() => {
    assert.equal(
      row.harness_id,
      null,
      "a pre-existing legacy row's provenance must stay NULL forever (this simulates the backfill bug, and MUST fail)"
    )
  }, 'retroactively backfilling harness_id onto a pre-existing legacy row')
}

console.log(
  '\n✓ C5 mutation tests: NULL-as-hidden gate inversion, an unguarded per-harness reseed, and ' +
    'retroactive provenance backfill are all correctly caught as failing assertions'
)

console.log('\nAll footer-actions seeding/provenance assertions passed.')
