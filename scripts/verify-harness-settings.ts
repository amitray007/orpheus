// ---------------------------------------------------------------------------
// scripts/verify-harness-settings.ts
//
// Behavior guard for src/main/harness/settings.ts (U2, multi-harness
// architecture plan) — the generic read/write + scope-layering module over
// the harness_settings table added by U1 (src/main/db/schema.ts). Asserts
// against the REAL exported functions (getHarnessSettings,
// setHarnessSettings, resolveHarnessSettings), not a restatement of their
// logic.
//
// DESIGN NOTE (post-workspace-scope-removal): HarnessSettingsScope is now
// `'global' | 'project'` — workspace scope was removed. resolveHarnessSettings
// takes only (harnessId, projectId?); there is no workspaceId parameter at
// all (not even an ignored one — see settings.ts's own doc comment: "a
// parameter that silently does nothing is worse than one that does not
// exist"). This file therefore asserts two-tier (global -> project)
// precedence only. The scope_id `''` sentinel round-trip and the upsert
// row-count assertions are UNCHANGED from before the scope change — they
// guard real storage bugs unrelated to how many scopes exist — so they are
// kept verbatim.
//
// RUNTIME CHOICE — plain `node --experimental-strip-types`, NOT `bun run`.
// settings.ts imports getDb() from ../db, which statically imports
// better-sqlite3 + electron's `app`. Two constraints rule out the
// mock.module()-under-bun approach used by verify-project-add.ts /
// verify-harness-registry.ts:
//   1. better-sqlite3 reliably crashes Bun 1.3.10 on this machine with a
//      NAPI FATAL ERROR the moment `new Database(...)` runs under `bun run`
//      (verified empirically, not assumed) — so a real, working SQLite
//      instance cannot come from better-sqlite3 under bun here.
//   2. This harness needs a REAL, WORKING database (unlike
//      verify-harness-registry.ts/verify-harness-launch.ts, whose stubs
//      only need to throw if touched) — getHarnessSettings/
//      setHarnessSettings/resolveHarnessSettings must round-trip real rows.
// scripts/verify-migration-engine.ts already solves both problems for this
// exact table: run under plain `node --experimental-strip-types`, and use
// node:sqlite's DatabaseSync (aliased to a class named `Database` so its
// prepare()/exec()/run() surface matches better-sqlite3 closely enough for
// settings.ts's own prepare().get()/prepare().run() calls). This script
// reuses that combination, and adds a node:module `register()` resolve+load
// hook (Node has no bun:test-style mock.module(); this is the plain-ESM
// equivalent) that redirects the 'electron' specifier and settings.ts's own
// '../db' specifier to virtual in-memory modules — 'electron' to an inert
// stub (never called: settings.ts only reaches getDb(), never app.* itself),
// '../db' to a tiny module whose getDb() returns whichever DatabaseSync
// instance globalThis.__HARNESS_SETTINGS_TEST_DB__ currently points at, so
// each test scenario below can swap in a fresh, empty database by calling
// createFreshDb() before calling into settings.ts.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

class Database extends DatabaseSync {}

// better-sqlite3-compatible enough shim, matching verify-migration-engine.ts's
// own comment: DatabaseSync's prepare()/exec() already match the calls
// settings.ts makes (prepare(sql).get(...args) / prepare(sql).run(...args)).
// The db stub module (below) reads the live instance off
// globalThis.__HARNESS_SETTINGS_TEST_DB__ rather than a module-level
// variable here, since the stub is a SEPARATE module (loaded via a
// data:-URL through the resolve hook) and can't close over this file's
// scope — globalThis is the only channel between the two.
const dbStubSource = `
export function getDb() {
  if (!globalThis.__HARNESS_SETTINGS_TEST_DB__) {
    throw new Error('verify-harness-settings: no test DB set before a settings.ts call')
  }
  return globalThis.__HARNESS_SETTINGS_TEST_DB__
}
`

const hooks = `
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: 'data:text/javascript,export const app = {}', shortCircuit: true }
  }
  // Match settings.ts's own relative specifier ('../db') exactly, resolved
  // against ITS parent URL — a plain string-equality check on the raw
  // specifier is enough since settings.ts is the only importer under test.
  if (specifier === '../db' && context.parentURL && context.parentURL.includes('/src/main/harness/')) {
    return { url: dbStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    // src/main/**/*.ts use extensionless relative imports (bundler
    // moduleResolution) — retry with .ts appended, same fallback
    // verify-migration-engine.ts uses.
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return await nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url)

function createFreshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  // Minimal real table, matching schema.ts's harness_settings TableDef
  // exactly (columns, defaults, CHECK, unique index) rather than a
  // hand-simplified stand-in, so this harness exercises the same SQL shape
  // settings.ts runs against in production. CHECK now allows only
  // ('global', 'project') — 'workspace' was removed from
  // HARNESS_SETTINGS_SCOPE in schema.ts.
  db.exec(`
    CREATE TABLE harness_settings (
      id TEXT PRIMARY KEY NOT NULL,
      harness_id TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('global', 'project')),
      scope_id TEXT NOT NULL DEFAULT '',
      settings_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )
  `)
  db.exec(
    `CREATE UNIQUE INDEX idx_harness_settings_key ON harness_settings (harness_id, scope, scope_id)`
  )
  ;(
    globalThis as unknown as { __HARNESS_SETTINGS_TEST_DB__: unknown }
  ).__HARNESS_SETTINGS_TEST_DB__ = db
  return db
}

const settingsMod = await import('../src/main/harness/settings.ts')
const { getHarnessSettings, setHarnessSettings, resolveHarnessSettings } = settingsMod
type HarnessSettings = Awaited<ReturnType<typeof getHarnessSettings>>

function rowCount(db: InstanceType<typeof Database>): number {
  return (db.prepare('SELECT COUNT(*) as n FROM harness_settings').get() as { n: number }).n
}

// ---------------------------------------------------------------------------
// 1. Missing rows at every scope -> {}, never a throw.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  assert.deepEqual(getHarnessSettings('claude', 'global'), {}, 'missing global row -> {}')
  assert.deepEqual(
    getHarnessSettings('claude', 'project', 'proj-1'),
    {},
    'missing project row -> {}'
  )
  assert.deepEqual(
    resolveHarnessSettings('claude', 'proj-1'),
    {},
    'resolveHarnessSettings with nothing configured anywhere -> {}'
  )
  console.log('✓ missing rows at every scope resolve to {} without throwing')
}

// ---------------------------------------------------------------------------
// 2. scope_id normalization: writing global with undefined scopeId then
//    reading it back returns the same row (the '' sentinel round-trips).
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  setHarnessSettings('claude', 'global', undefined, { curated: { model: 'opus' } })
  const readBack = getHarnessSettings('claude', 'global')
  assert.deepEqual(readBack, { curated: { model: 'opus' } }, 'global write/read round-trips')

  const raw = db
    .prepare(
      `SELECT scope_id FROM harness_settings WHERE harness_id = 'claude' AND scope = 'global'`
    )
    .get() as { scope_id: string }
  assert.equal(
    raw.scope_id,
    '',
    "global row's scope_id must be stored as the '' sentinel, not NULL"
  )
  assert.equal(rowCount(db), 1, 'exactly one global row must exist')
  console.log("✓ scope_id normalization: undefined scopeId round-trips via the '' sentinel")
}

// ---------------------------------------------------------------------------
// 3. Upsert: writing the same (harness, scope, scopeId) twice UPDATES
//    rather than inserting a duplicate row.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  setHarnessSettings('claude', 'project', 'proj-1', { curated: { model: 'opus' } })
  setHarnessSettings('claude', 'project', 'proj-1', { curated: { model: 'sonnet' } })
  assert.equal(
    rowCount(db),
    1,
    'a second write to the same key must UPDATE, not insert a duplicate'
  )
  assert.deepEqual(
    getHarnessSettings('claude', 'project', 'proj-1'),
    { curated: { model: 'sonnet' } },
    'the second write must win'
  )
  console.log('✓ upsert: same (harness, scope, scopeId) key updates in place (row count stays 1)')
}

// ---------------------------------------------------------------------------
// 4. Layering: global only -> global wins.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'opus', effort: 'high' },
    args: [{ key: 'verbose', enabled: true }],
    env: [{ key: 'ANTHROPIC_LOG', value: 'debug', enabled: true }]
  })
  const resolved = resolveHarnessSettings('claude', 'proj-1')
  assert.deepEqual(
    resolved,
    {
      curated: { model: 'opus', effort: 'high' },
      args: [{ key: 'verbose', enabled: true }],
      env: [{ key: 'ANTHROPIC_LOG', value: 'debug', enabled: true }]
    },
    'global-only settings must resolve unchanged'
  )
  console.log('✓ global only -> global wins')
}

// ---------------------------------------------------------------------------
// 5. Layering: project overrides ONE key -> project wins for it, other
//    global keys survive. Project scope is now the FINAL/highest-precedence
//    layer (workspace scope was removed).
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'opus', effort: 'high' }
  })
  setHarnessSettings('claude', 'project', 'proj-1', {
    curated: { model: 'sonnet' }
  })
  const resolved = resolveHarnessSettings('claude', 'proj-1')
  assert.deepEqual(
    resolved.curated,
    { model: 'sonnet', effort: 'high' },
    'project must override model but leave the global effort untouched'
  )
  // A different project must NOT see the override.
  const otherProject = resolveHarnessSettings('claude', 'proj-2')
  assert.deepEqual(
    otherProject.curated,
    { model: 'opus', effort: 'high' },
    'a project with no override of its own must see only the global curated settings'
  )
  console.log(
    '✓ project overrides one curated key; other global keys and other projects are unaffected'
  )
}

// ---------------------------------------------------------------------------
// 6. A disabled row is excluded from resolved output but preserved in
//    storage.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    args: [
      { key: 'verbose', enabled: true },
      { key: 'debug', enabled: false }
    ]
  })
  const resolved = resolveHarnessSettings('claude', 'proj-1')
  assert.deepEqual(
    resolved.args,
    [{ key: 'verbose', enabled: true }],
    'the disabled debug row must be excluded from the resolved output'
  )
  // Preserved in storage: a raw getHarnessSettings read (not resolved) still
  // has both rows.
  const stored = getHarnessSettings('claude', 'global') as HarnessSettings
  assert.deepEqual(
    stored.args,
    [
      { key: 'verbose', enabled: true },
      { key: 'debug', enabled: false }
    ],
    'the disabled row must still be present in raw storage'
  )
  // And it round-trips via the raw DB row too, not just via getHarnessSettings.
  const raw = db
    .prepare(`SELECT settings_json FROM harness_settings WHERE scope = 'global'`)
    .get() as { settings_json: string }
  assert.ok(JSON.parse(raw.settings_json).args.some((r: { key: string }) => r.key === 'debug'))
  console.log('✓ disabled rows are excluded from resolved output but preserved in storage')
}

// ---------------------------------------------------------------------------
// 7. args/env array layering semantics: merge-by-key, not whole-array
//    replacement. A project-scope row with a NEW key is appended after the
//    global rows (order preserved); a project-scope row with an EXISTING
//    key replaces that entry in place (including its position); a
//    project-scope `enabled: false` override of a global `enabled: true`
//    row suppresses it from the resolved output without deleting either
//    scope's stored copy.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    args: [
      { key: 'verbose', enabled: true },
      { key: 'add-dir', value: '/global/dir', enabled: true }
    ]
  })
  setHarnessSettings('claude', 'project', 'proj-1', {
    // Overrides the existing 'add-dir' key's value, introduces a new
    // 'strict' key, AND suppresses the global 'verbose' flag for this one
    // project without deleting it from global storage.
    args: [
      { key: 'add-dir', value: '/project/dir', enabled: true },
      { key: 'strict', enabled: true },
      { key: 'verbose', enabled: false }
    ]
  })

  const resolved = resolveHarnessSettings('claude', 'proj-1')
  assert.deepEqual(
    resolved.args,
    [
      { key: 'add-dir', value: '/project/dir', enabled: true },
      { key: 'strict', enabled: true }
    ],
    'merge-by-key: verbose suppressed by project, add-dir value replaced (position preserved), strict appended'
  )

  // A sibling project (no override of its own) must still see 'verbose' from
  // global, proving the suppression is project-scoped, not a global
  // mutation.
  const sibling = resolveHarnessSettings('claude', 'proj-2')
  assert.deepEqual(
    sibling.args,
    [
      { key: 'verbose', enabled: true },
      { key: 'add-dir', value: '/global/dir', enabled: true }
    ],
    'a sibling project with no override of its own must still see the global verbose flag'
  )

  // Global storage itself must still list 'verbose'/'add-dir' as before —
  // the project override must not have mutated the global row.
  const globalStored = getHarnessSettings('claude', 'global') as HarnessSettings
  assert.deepEqual(
    globalStored.args,
    [
      { key: 'verbose', enabled: true },
      { key: 'add-dir', value: '/global/dir', enabled: true }
    ],
    "the project-scope suppression of 'verbose' must not mutate the stored global row"
  )
  console.log(
    '✓ args/env layering is merge-by-key (order preserved, project wins per key, storage untouched)'
  )
}

// ---------------------------------------------------------------------------
// 8. curatedOptions round-trip: a stored {add,hide,order} overlay survives
//    a plain get/set cycle untouched.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curatedOptions: {
      model: { add: ['my-finetune'], hide: ['claude-3-5-haiku'], order: ['opus', 'sonnet'] }
    }
  })
  const readBack = getHarnessSettings('claude', 'global')
  assert.deepEqual(
    readBack,
    {
      curatedOptions: {
        model: { add: ['my-finetune'], hide: ['claude-3-5-haiku'], order: ['opus', 'sonnet'] }
      }
    },
    'a stored curatedOptions overlay must round-trip byte-for-byte'
  )
  console.log('✓ curatedOptions: stored overlay round-trips through get/set unchanged')
}

// ---------------------------------------------------------------------------
// 9. curatedOptions LAYERING: field-level whole-value replacement, NOT
//    merge-by-key like args/env. A project-scope overlay for a field
//    REPLACES the global overlay for that SAME field entirely (its add/hide
//    /order arrays are never combined with the global scope's), while a
//    field the project scope has NO opinion about still falls back to the
//    global overlay untouched.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curatedOptions: {
      model: { order: ['opus', 'sonnet'] },
      effort: { hide: ['low'] }
    }
  })
  setHarnessSettings('claude', 'project', 'proj-1', {
    // Project expresses an opinion about `model` only — a DIFFERENT,
    // non-overlapping overlay (order reversed) — and says nothing about
    // `effort` at all.
    curatedOptions: {
      model: { order: ['sonnet', 'opus'] }
    }
  })
  const resolved = resolveHarnessSettings('claude', 'proj-1')
  assert.deepEqual(
    resolved.curatedOptions,
    {
      model: { order: ['sonnet', 'opus'] },
      effort: { hide: ['low'] }
    },
    'project model overlay must REPLACE the global one wholesale (not merge order arrays); untouched effort falls back to global'
  )
  // A sibling project with no override of its own sees only the global
  // overlays, proving the replacement was project-scoped.
  const sibling = resolveHarnessSettings('claude', 'proj-2')
  assert.deepEqual(
    sibling.curatedOptions,
    {
      model: { order: ['opus', 'sonnet'] },
      effort: { hide: ['low'] }
    },
    'a sibling project with no override of its own must still see the global curatedOptions'
  )
  console.log(
    '✓ curatedOptions layering: project REPLACES a field wholesale (not merged across scopes); untouched fields fall back to global'
  )
}

// ---------------------------------------------------------------------------
// 10. curatedOptions survives a partial write: setting args alone at a scope
//     that already has a curatedOptions overlay must not drop it (mirrors
//     assertion 6's "disabled row preserved in storage" discipline, applied
//     to a sibling top-level key via the same whole-object HarnessSettings
//     upsert setHarnessSettings performs).
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curatedOptions: { model: { hide: ['claude-3-5-haiku'] } }
  })
  // Read-modify-write, the same pattern the Settings UI's save() follows
  // (spread existing settings, only replace the fields being edited) —
  // NOT a fresh { args: [...] } object, which would be a real regression
  // this assertion is specifically here to catch.
  const existing = getHarnessSettings('claude', 'global')
  setHarnessSettings('claude', 'global', undefined, {
    ...existing,
    args: [{ key: 'verbose', enabled: true }]
  })
  const readBack = getHarnessSettings('claude', 'global')
  assert.deepEqual(
    readBack,
    {
      curatedOptions: { model: { hide: ['claude-3-5-haiku'] } },
      args: [{ key: 'verbose', enabled: true }]
    },
    "writing args at a scope must not drop that scope's existing curatedOptions overlay"
  )
  console.log('✓ curatedOptions survives a partial write (args added) at the same scope')
}

// ---------------------------------------------------------------------------
// 11. setArgRowValue (H1, support-multi-harness) — the project Settings
//     drawer's Permission-mode write path. Merge-writes ONE keyed row,
//     preserving curated/env/curatedOptions and every OTHER args row at
//     that scope, mirroring setCuratedModelEffort's row-granularity merge
//     one level down. See settings.ts's own doc comment on the function.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'project', 'proj-1', {
    curated: { model: 'opus' },
    args: [{ key: '--verbose', enabled: true }],
    env: [{ key: 'FOO', value: 'bar', enabled: true }]
  })
  const { setArgRowValue } = settingsMod
  setArgRowValue('claude', 'project', 'proj-1', '--permission-mode', 'acceptEdits')
  const afterSet = getHarnessSettings('claude', 'project', 'proj-1')
  assert.deepEqual(
    afterSet,
    {
      curated: { model: 'opus' },
      args: [
        { key: '--verbose', enabled: true },
        { key: '--permission-mode', value: 'acceptEdits', enabled: true }
      ],
      env: [{ key: 'FOO', value: 'bar', enabled: true }]
    },
    'setArgRowValue appends the new row, preserving curated/env/other args untouched'
  )

  setArgRowValue('claude', 'project', 'proj-1', '--permission-mode', undefined)
  const afterClear = getHarnessSettings('claude', 'project', 'proj-1')
  assert.deepEqual(
    afterClear,
    {
      curated: { model: 'opus' },
      args: [{ key: '--verbose', enabled: true }],
      env: [{ key: 'FOO', value: 'bar', enabled: true }]
    },
    'clearing (undefined) removes the row entirely, leaving every other field untouched'
  )
  console.log('✓ setArgRowValue merge-writes/clears one args row without touching curated/env')
}

// ---------------------------------------------------------------------------
// 12. preLaunchSnippet (H1, support-multi-harness) — layers global -> project
//     like curated.model/curated.effort (mergeScalar: last-defined-wins, not
//     merged; a scope with no opinion leaves an earlier scope's value alone).
//     The composed-launch END of this (does it reach ORPHEUS_PRE_LAUNCH_SNIPPET)
//     is covered by scripts/verify-harness-claude-launch.ts — this is the
//     storage/resolution half.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  assert.equal(
    resolveHarnessSettings('claude', 'proj-12').preLaunchSnippet,
    undefined,
    'nothing configured -> unset'
  )

  setHarnessSettings('claude', 'global', undefined, {
    preLaunchSnippet: 'eval "$(nvm use)"'
  })
  assert.equal(
    resolveHarnessSettings('claude', 'proj-12').preLaunchSnippet,
    'eval "$(nvm use)"',
    'global value applies when the project has no override'
  )

  setHarnessSettings('claude', 'project', 'proj-12', {
    preLaunchSnippet: 'eval "$(direnv export zsh)"'
  })
  assert.equal(
    resolveHarnessSettings('claude', 'proj-12').preLaunchSnippet,
    'eval "$(direnv export zsh)"',
    'a project-scope value wins over global'
  )
  assert.equal(
    resolveHarnessSettings('claude', 'proj-13-different').preLaunchSnippet,
    'eval "$(nvm use)"',
    'a SIBLING project with no override of its own still sees the global value'
  )
  console.log(
    '✓ preLaunchSnippet layers global -> project (last-defined-wins), same as curated fields'
  )
}

// ---------------------------------------------------------------------------
// 13. sourceZshrc (H1 follow-up, support-multi-harness) — same mergeScalar
//     layering as preLaunchSnippet, but a boolean payload — confirms
//     mergeScalar's generic-over-T rewrite still works for a non-string type,
//     not just preLaunchSnippet's string case.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  assert.equal(
    resolveHarnessSettings('claude', 'proj-13').sourceZshrc,
    undefined,
    'nothing configured -> unset'
  )
  setHarnessSettings('claude', 'global', undefined, { sourceZshrc: true })
  assert.equal(
    resolveHarnessSettings('claude', 'proj-13').sourceZshrc,
    true,
    'global true applies when the project has no override'
  )
  setHarnessSettings('claude', 'project', 'proj-13', { sourceZshrc: false })
  assert.equal(
    resolveHarnessSettings('claude', 'proj-13').sourceZshrc,
    false,
    'an explicit project-scope false wins over a global true (not treated as "unset")'
  )
  console.log(
    '✓ sourceZshrc layers global -> project via the same generic mergeScalar as preLaunchSnippet'
  )
}

// ---------------------------------------------------------------------------
// 14. setShellInit (H1 follow-up, support-multi-harness) — the global
//     Settings page's write path for preLaunchSnippet/sourceZshrc. Merge-
//     writes either field, tri-state (omit/null/value), without touching
//     curated/args/env at the same scope.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'opus' },
    args: [{ key: '--verbose', enabled: true }]
  })
  const { setShellInit } = settingsMod
  setShellInit('claude', 'global', undefined, { preLaunchSnippet: 'eval "$(nvm use)"' })
  assert.deepEqual(
    getHarnessSettings('claude', 'global'),
    {
      curated: { model: 'opus' },
      args: [{ key: '--verbose', enabled: true }],
      preLaunchSnippet: 'eval "$(nvm use)"'
    },
    'setShellInit sets preLaunchSnippet, leaves curated/args untouched'
  )

  setShellInit('claude', 'global', undefined, { sourceZshrc: true })
  assert.deepEqual(
    getHarnessSettings('claude', 'global'),
    {
      curated: { model: 'opus' },
      args: [{ key: '--verbose', enabled: true }],
      preLaunchSnippet: 'eval "$(nvm use)"',
      sourceZshrc: true
    },
    'a second setShellInit call for sourceZshrc leaves the first field (preLaunchSnippet) alone'
  )

  setShellInit('claude', 'global', undefined, { preLaunchSnippet: null })
  const afterClear = getHarnessSettings('claude', 'global')
  assert.equal(afterClear.sourceZshrc, true, 'sourceZshrc survives a preLaunchSnippet clear')
  assert.equal(
    'preLaunchSnippet' in afterClear,
    false,
    'clearing (null) DELETES the key rather than storing undefined'
  )

  // THE GAP — symmetric coverage for sourceZshrc's OWN clear path, not just
  // preLaunchSnippet's. This matters MORE for sourceZshrc than for the
  // snippet: false and "unset, falls through to a less specific scope" are
  // genuinely different values once resolveHarnessSettings layers scopes
  // (mergeScalar — see settings.ts). A clear that stored `false` instead of
  // deleting the key would silently pin this scope to OFF rather than
  // letting a broader scope's value apply, which the preLaunchSnippet-only
  // assertion above could never have caught (a string field's "empty"
  // value has no equivalent false/true ambiguity).
  setShellInit('claude', 'global', undefined, { sourceZshrc: null })
  const afterSourceZshrcClear = getHarnessSettings('claude', 'global')
  assert.equal(
    afterSourceZshrcClear.preLaunchSnippet,
    undefined,
    'preLaunchSnippet stays cleared from the earlier step (unrelated field)'
  )
  assert.equal(
    'sourceZshrc' in afterSourceZshrcClear,
    false,
    'clearing sourceZshrc (null) DELETES the key rather than storing false'
  )
  console.log('✓ setShellInit merge-writes/clears preLaunchSnippet and sourceZshrc independently')
}

console.log('\nAll harness-settings assertions passed.')

// ---------------------------------------------------------------------------
// Mutation test — mergeScalar's "absence must not clobber" rule.
// ---------------------------------------------------------------------------

function mustFail(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.log(`  mutation caught (expected failure) [${label}]:`, (err as Error).message)
    return
  }
  throw new Error(`MUTATION TEST FAILED TO CATCH A BUG: ${label} did not throw`)
}

mustFail('mergeScalar letting an undefined project value wipe the global value', () => {
  // Simulates a broken merge that assigns the LAST layer unconditionally
  // instead of skipping undefined layers — a project with no preLaunchSnippet
  // opinion would then silently erase the global value for every workspace
  // in that project, instead of falling through to it.
  function brokenMergeScalar(layers: Array<string | undefined>): string | undefined {
    let merged: string | undefined
    for (const layer of layers) merged = layer // BUG: no `if (layer !== undefined)` guard
    return merged
  }
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, { preLaunchSnippet: 'eval "$(nvm use)"' })
  const real = resolveHarnessSettings('claude', 'proj-mutation').preLaunchSnippet
  const broken = brokenMergeScalar([
    getHarnessSettings('claude', 'global').preLaunchSnippet,
    getHarnessSettings('claude', 'project', 'proj-mutation').preLaunchSnippet
  ])
  assert.equal(broken, real, 'the unguarded merge must disagree with the real fall-through result')
})

mustFail('setShellInit clearing sourceZshrc by writing false instead of deleting', () => {
  // Simulates a broken clear that stores `false` for a `null` patch value
  // instead of deleting the key — false and "unset" are NOT the same thing
  // once resolveHarnessSettings layers scopes: an explicit project-scope
  // `false` would override a global `true`, but a DELETED key falls through
  // to the global value instead. Confusing the two silently changes
  // behavior for anyone clearing a project-scope override.
  function brokenSetShellInit(
    existing: HarnessSettings,
    patch: { sourceZshrc?: boolean | null }
  ): HarnessSettings {
    const next = { ...existing }
    if (patch.sourceZshrc !== undefined) {
      // BUG: stores `false` for a null (clear) patch instead of deleting.
      next.sourceZshrc = patch.sourceZshrc === null ? false : patch.sourceZshrc
    }
    return next
  }
  createFreshDb()
  setHarnessSettings('claude', 'project', 'proj-mutation-2', { sourceZshrc: true })
  const existing = getHarnessSettings('claude', 'project', 'proj-mutation-2')
  const { setShellInit } = settingsMod
  setShellInit('claude', 'project', 'proj-mutation-2', { sourceZshrc: null })
  const real = getHarnessSettings('claude', 'project', 'proj-mutation-2')
  const broken = brokenSetShellInit(existing, { sourceZshrc: null })
  assert.deepEqual(
    broken,
    real,
    'storing false-for-clear must disagree with the real delete-the-key result'
  )
})
