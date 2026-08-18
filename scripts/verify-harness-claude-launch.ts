// ---------------------------------------------------------------------------
// scripts/verify-harness-claude-launch.ts
//
// Behavior guard for src/main/harness/claude/launch.ts (U4, multi-harness
// architecture plan) — composeClaudeHarnessLaunch, the KTD2 emitter that
// produces a HarnessLaunch from ONLY resolved harness_settings (U2) +
// curated fields (U3), with zero typed passthrough settings. Asserts
// against the REAL exported function, not a restatement of its logic.
//
// DESIGN NOTE (post-permission-mode-removal, post-workspace-scope-removal):
//   - permission-mode is no longer a curated concept (HarnessCuratedSettings
//     has only `model`/`effort`) — it now lives as a seeded, user-editable
//     default-arg row in CLAUDE_DEFAULT_ARGS
//     (src/main/harness/claude/curated.ts), disabled by default. That row is
//     NOT unconditionally injected into every launch — it only applies once
//     surfaced as an enabled harness_settings arg row, same as any other user
//     arg — so composeClaudeHarnessLaunch itself never emits
//     `--permission-mode` from curated settings any more. The fixture in
//     scenario 2 below therefore configures model+effort only, and asserts
//     the two REMAINING curated tokens still emit in the old relative order
//     (model -> effort — permission-mode was the middle token; removing it
//     does not change model's or effort's order relative to each other).
//   - harness_settings.scope is now `'global' | 'project'` only — the
//     in-memory fixture DB's CHECK constraint below matches schema.ts's
//     HARNESS_SETTINGS_SCOPE exactly, and there is no workspace-scope
//     scenario left to assert (resolveHarnessSettings has no workspaceId
//     parameter to layer through).
//
// RUNTIME CHOICE — plain `node --experimental-strip-types`, NOT `bun run`,
// mirroring scripts/verify-harness-settings.ts exactly. launch.ts imports
// resolveHarnessSettings from ../settings, which imports getDb() from
// ../../db — a chain that pulls in better-sqlite3 + electron's `app`.
// better-sqlite3 reliably crashes Bun 1.3.10 on this machine the moment
// `new Database(...)` runs under `bun run` (verified empirically by
// verify-harness-settings.ts). This harness ALSO needs a REAL, WORKING
// database — composeClaudeHarnessLaunch's whole job is to read layered
// settings back out, so a stub that merely throws (the pattern
// verify-harness-launch.ts/verify-harness-registry.ts use, where the DB
// path is provably unreached) won't do here. Reuses
// verify-harness-settings.ts's exact combination: node:sqlite's
// DatabaseSync (aliased to `Database`) for a real in-memory DB, plus a
// node:module `register()` resolve hook redirecting 'electron' to an inert
// stub and settings.ts's '../db' specifier to a virtual module backed by
// that DatabaseSync instance.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

class Database extends DatabaseSync {}

const dbStubSource = `
export function getDb() {
  if (!globalThis.__HARNESS_CLAUDE_LAUNCH_TEST_DB__) {
    throw new Error('verify-harness-claude-launch: no test DB set before a settings.ts call')
  }
  return globalThis.__HARNESS_CLAUDE_LAUNCH_TEST_DB__
}
`

const hooks = `
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent('export const app = {}\nexport const BrowserWindow = {}\n'))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    // Both app and BrowserWindow are needed: settings.ts reaches electron
    // via ./db (app), and session.ts reaches it via workspaces.ts
    // (BrowserWindow, for its change broadcasts). Neither is called on the
    // paths this harness exercises — they exist only to satisfy the linker.
    // (No backticks in this comment: the whole hook is a template literal.)
    return { url: electronStubUrl, shortCircuit: true }
  }
  // Redirect EVERY relative import of the db directory to the stub, from any
  // parent — not just settings.ts's own '../db'. src/main/db is a DIRECTORY
  // module (db/index.ts), and node's ESM resolver rejects a directory import
  // outright (ERR_UNSUPPORTED_DIR_IMPORT) rather than falling back to
  // index.ts the way bundler resolution does. So any module in this import
  // graph that reaches the DB has to be intercepted here, not only the one
  // this harness set out to test: session.ts pulls in workspaces.ts, which
  // sits in src/main/ and imports './db' — a different specifier AND a
  // different parent directory than settings.ts's '../db'. Matching on the
  // resolved basename instead of one literal specifier keeps this working as
  // the harness module's import graph grows.
  // (Plain string compare rather than a regex: this hook is serialized into a
  // data: URL, where a regex literal's slashes do not survive encoding.)
  if (specifier === './db' || specifier === '../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    // src/main/**/*.ts and src/shared/**/*.ts use extensionless relative
    // imports (bundler moduleResolution) — retry with .ts appended, same
    // fallback verify-migration-engine.ts / verify-harness-settings.ts use.
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
  // scope CHECK matches schema.ts's HARNESS_SETTINGS_SCOPE = ['global',
  // 'project'] exactly — workspace scope was removed.
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
  // session.ts (U5) reads the workspace row for claude_session_id / cwd /
  // forked_from_session_id, so the launch path now touches this table too.
  // Only the columns getWorkspace's row→record mapping actually selects are
  // needed — this is a launch-composition harness, not a workspaces one.
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      name_is_auto INTEGER NOT NULL DEFAULT 1,
      claude_session_id TEXT,
      forked_from_session_id TEXT,
      harness_id TEXT NOT NULL DEFAULT 'claude'
    )
  `)
  // A2 (support-multi-harness) — withWorkspaceCuratedOverride (launch.ts)
  // reads claude_workspace_settings via getClaudeWorkspaceSettings for the
  // per-workspace model/effort override layer. Same overrides_json shape as
  // schema.ts's real table (see overridesStore.ts's get/update).
  db.exec(`
    CREATE TABLE claude_workspace_settings (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )
  `)
  ;(
    globalThis as unknown as { __HARNESS_CLAUDE_LAUNCH_TEST_DB__: unknown }
  ).__HARNESS_CLAUDE_LAUNCH_TEST_DB__ = db
  return db
}

const { setHarnessSettings } = await import('../src/main/harness/settings.ts')
const { composeClaudeHarnessLaunch, applyUserEnvRows } =
  await import('../src/main/harness/claude/launch.ts')
const { splitFlagString, FLAG_DELIMITER } = await import('../src/shared/cliFlags.ts')
const { updateClaudeWorkspaceSettings, invalidateClaudeWorkspaceSettingsCache } =
  await import('../src/main/claudeWorkspaceSettings.ts')

// Writes a workspace's model/effort override directly, bypassing the cache
// (createFreshDb() swaps in a brand-new DB per scenario, but
// claudeWorkspaceSettings.ts's overridesStore cache is module-level and
// would otherwise leak a stale value across scenarios that reuse a
// workspace id — invalidate first so every write reads/writes the CURRENT
// fresh DB).
function setWorkspaceOverride(
  workspaceId: string,
  patch: { model?: string; effort?: string }
): void {
  invalidateClaudeWorkspaceSettingsCache(workspaceId)
  updateClaudeWorkspaceSettings(workspaceId, patch)
}

// ---------------------------------------------------------------------------
// 1. Empty settings -> bare invocation: no stray flags, flags === '', env
//    empty, settingsJson empty, model empty.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-1')
  assert.deepEqual(
    launch,
    { flags: '', settingsJson: '', env: {}, model: '', effort: '' },
    'nothing configured -> fully bare launch'
  )
  console.log('✓ empty settings -> bare invocation (flags === "", no stray flags)')
}

// ---------------------------------------------------------------------------
// 2. Curated model + effort produce the expected argv, IN ORDER, and model
//    is read back on the HarnessLaunch. permission-mode is NOT part of this
//    scenario any more — it is not a curated concept (see file header); it
//    only reaches a launch as an enabled defaultArgs/user arg row, which
//    scenario 3 already covers for user rows in general.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'opus', effort: 'high' }
  })
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-1')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['--model', 'opus', '--effort', 'high'],
    // Order matches composeClaudeHarnessLaunch's own emission order
    // (launch.ts: model then effort) — the same relative order
    // composeFlagTokens used before permission-mode sat between them; with
    // permission-mode gone from curated fields entirely, model -> effort is
    // simply the full curated sequence now. verify-harness-launch-parity
    // still asserts this against the old emitter's overlapping surface.
    'curated fields must emit in model -> effort order'
  )
  assert.equal(launch.model, 'opus', 'model field must equal the resolved curated model value')
  assert.equal(launch.effort, 'high', 'effort field must equal the resolved curated effort value')
  console.log('✓ curated model + effort produce the expected argv, in order')
}

// ---------------------------------------------------------------------------
// 3. User arg rows appear in declared order, AFTER curated ones. A bare
//    flag (no value) emits just its key. This is also where a
//    defaultArgs-style row (e.g. --permission-mode) would land once
//    enabled — it is just another user arg row from this emitter's point of
//    view; nothing about it is special-cased in launch.ts.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'sonnet' },
    args: [
      { key: '--permission-mode', value: 'acceptEdits', enabled: true },
      { key: '--add-dir', value: '/tmp/foo', enabled: true },
      { key: '--verbose', enabled: true }
    ]
  })
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-1')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['--model', 'sonnet', '--permission-mode', 'acceptEdits', '--add-dir', '/tmp/foo', '--verbose'],
    'user arg rows (including an enabled permission-mode default-arg row) must follow curated ones, in declared order; a valueless row emits just its key'
  )
  console.log(
    '✓ user arg rows appear after curated ones, in declared order; a bare flag emits only its key'
  )
}

// ---------------------------------------------------------------------------
// 4. Disabled rows are absent from both args and env.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    args: [
      { key: '--verbose', enabled: true },
      { key: '--debug', enabled: false }
    ],
    env: [
      { key: 'ANTHROPIC_LOG', value: 'debug', enabled: true },
      { key: 'DISABLED_VAR', value: 'x', enabled: false }
    ]
  })
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-1')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['--verbose'],
    'a disabled arg row must not appear in the composed flags'
  )
  assert.deepEqual(
    launch.env,
    { ANTHROPIC_LOG: 'debug' },
    'a disabled env row must not appear in the composed env'
  )
  console.log('✓ disabled rows are absent from both composed args and composed env')
}

// ---------------------------------------------------------------------------
// 5. 0x1F round-trip: a value containing spaces and '=' survives.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    args: [{ key: '--append-system-prompt', value: 'a=b has spaces too', enabled: true }]
  })
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-1')
  assert.ok(
    launch.flags.includes(FLAG_DELIMITER),
    'composed flags must be 0x1F-joined, not whitespace-joined'
  )
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['--append-system-prompt', 'a=b has spaces too'],
    'a value containing spaces and "=" must survive the 0x1F round trip byte-for-byte'
  )
  console.log('✓ 0x1F round-trip: a value containing spaces and "=" survives intact')
}

// ---------------------------------------------------------------------------
// 6. model field equals the curated model value, and is '' when unset —
//    even when other settings ARE configured.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    args: [{ key: '--verbose', enabled: true }],
    env: [{ key: 'FOO', value: 'bar', enabled: true }]
  })
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-1')
  assert.equal(launch.model, '', 'model must be "" when no curated model is configured')
  console.log('✓ model field is "" when curated.model is unset, independent of other settings')
}

// ---------------------------------------------------------------------------
// 6b. model must be the RESOLVED CURATED VALUE, not something re-derived by
// scanning the composed flag tokens. A user arg row that itself happens to
// contain a bare '--model' passthrough (a plausible, if unusual, escape
// hatch a user could type into the generic args editor) must NOT influence
// `launch.model` — only curated.model may. This is the discriminating case:
// an implementation that reads `curated.model` directly and one that greps
// flagTokens for '--model' agree on every other scenario in this file but
// diverge here.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'opus' },
    args: [{ key: '--model', value: 'user-typed-decoy', enabled: true }]
  })
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-1')
  assert.equal(
    launch.model,
    'opus',
    'model must be read from resolved curated.model, never re-derived by scanning composed flag tokens'
  )
  console.log(
    '✓ model field is read from curated.model, not parsed out of the composed flags (decoy user --model row ignored)'
  )
}

// ---------------------------------------------------------------------------
// 7. Env-collision precedence: CURATED WINS. A user env row using the same
//    key as a curated field's env key must be dropped, not override it.
//
// Claude's curated fields are all flag-based today (see curated.ts's
// header: "every CuratedField below uses `flag`, never `env`"), so
// composeClaudeHarnessLaunch itself can never exercise a live collision —
// there is no way to make curatedEnv non-empty through the public surface
// with today's descriptor. launch.ts exports applyUserEnvRows (the exact
// function composeClaudeHarnessLaunch calls internally to layer user rows
// on top of curated env) precisely so this rule can be asserted against
// REAL behavior rather than left as an untested comment ahead of the
// future harness (e.g. one with `curated.model = { env: 'MODEL', ... }`)
// that makes the collision reachable end-to-end.
// ---------------------------------------------------------------------------
{
  const result = applyUserEnvRows({ MODEL: 'opus' }, [
    { key: 'MODEL', value: 'user-override', enabled: true },
    { key: 'OTHER', value: 'x', enabled: true }
  ])
  assert.deepEqual(
    result,
    { MODEL: 'opus', OTHER: 'x' },
    'a user env row colliding with a curated env key must be dropped; curated wins'
  )
  console.log(
    '✓ env-collision precedence: curated wins over a colliding user env row (applyUserEnvRows)'
  )
}

// ---------------------------------------------------------------------------
// 7b. Reachable-today proxy: with Claude's curated fields all flag-based,
//     curatedEnv is always {} in practice, so the merge that actually
//     happens at the composeClaudeHarnessLaunch level is scope layering
//     among user rows — resolveHarnessSettings's own project-beats-global
//     precedence (asserted here to confirm curated-first layering doesn't
//     interfere with it).
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    env: [{ key: 'SHARED_KEY', value: 'global-value', enabled: true }]
  })
  setHarnessSettings('claude', 'project', 'proj-1', {
    env: [{ key: 'SHARED_KEY', value: 'project-value', enabled: true }]
  })
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-1')
  assert.deepEqual(
    launch.env,
    { SHARED_KEY: 'project-value' },
    'project-scope user row must win over global-scope user row beneath curated-first layering'
  )
  console.log('✓ curated-first layering does not interfere with scope precedence among user rows')
}

// ---------------------------------------------------------------------------
// REGRESSION GUARD: global-scope settings must reach the launch even when no
// project/workspace id is supplied.
//
// Both parameters are optional (composeClaudeLaunch has the same shape and
// real callers do pass undefined). An earlier revision guarded the whole
// resolve behind `projectId && workspaceId`, which silently dropped the
// global layer for those callers — the user's configured flags simply never
// reached `claude`, with no error and no log line. resolveHarnessSettings now
// owns per-layer skipping and always reads global, which has no id to miss.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'opus' },
    args: [{ key: '--verbose', enabled: true }],
    env: [{ key: 'GLOBAL_ONLY', value: 'yes', enabled: true }]
  })

  for (const [label, launch] of [
    ['no ids at all', composeClaudeHarnessLaunch()],
    ['projectId only', composeClaudeHarnessLaunch('proj-1')],
    ['workspaceId only', composeClaudeHarnessLaunch(undefined, 'ws-1')]
  ] as const) {
    assert.deepEqual(
      splitFlagString(launch.flags),
      ['--model', 'opus', '--verbose'],
      `global args must still compose with ${label}`
    )
    assert.equal(launch.model, 'opus', `global curated model must still resolve with ${label}`)
    assert.deepEqual(
      launch.env,
      { GLOBAL_ONLY: 'yes' },
      `global env must still compose with ${label}`
    )
  }
  console.log('✓ global-scope settings reach the launch with a missing projectId/workspaceId')
}

// ---------------------------------------------------------------------------
// A2 (support-multi-harness) — the read-side conversions in
// ipc/claudeSettings.ts, effortReconciliation.ts, controlPlane/
// settingsResourceService.ts, and sessions.ts now resolve model/effort via
// resolveHarness(...).composeLaunch(...).model/.effort instead of composing
// composeClaudeLaunch and grepping its `flags` for `--model`/`--effort`.
// composeClaudeHarnessLaunch (this file's subject, and what resolveHarness's
// Claude descriptor's composeLaunch IS) is the function every one of those
// call sites now runs through. These scenarios pin the exact resolution
// precedence those call sites depend on: global -> project curated ->
// workspace override, with 'auto'/'' as the workspace "no override"
// sentinel — see withWorkspaceCuratedOverride's doc comment in
// harness/claude/launch.ts.
// ---------------------------------------------------------------------------

// 8. Global curated only (no project/workspace layer at all) resolves model
//    and effort directly off HarnessLaunch's structured fields — the exact
//    shape workspace:getEffectiveModel/getEffectiveEffort now read.
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'opus', effort: 'high' }
  })
  const launch = composeClaudeHarnessLaunch('proj-1', 'ws-global-only')
  assert.equal(launch.model, 'opus', 'global curated model resolves with only a global layer set')
  assert.equal(launch.effort, 'high', 'global curated effort resolves with only a global layer set')
  console.log('✓ resolved model/effort come back correctly with only global curated set')
}

// 9. A project-scope curated value overrides global.
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'sonnet', effort: 'low' }
  })
  setHarnessSettings('claude', 'project', 'proj-9', {
    curated: { model: 'opus', effort: 'high' }
  })
  const launch = composeClaudeHarnessLaunch('proj-9', 'ws-project-override')
  assert.equal(launch.model, 'opus', 'project curated model must override global')
  assert.equal(launch.effort, 'high', 'project curated effort must override global')
  console.log('✓ a project-scope curated value overrides global')
}

// 10. A workspace override wins over both project and global (per
//     withWorkspaceCuratedOverride).
{
  createFreshDb()
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'sonnet', effort: 'low' }
  })
  setHarnessSettings('claude', 'project', 'proj-10', {
    curated: { model: 'opus', effort: 'medium' }
  })
  setWorkspaceOverride('ws-workspace-wins', { model: 'haiku', effort: 'high' })
  const launch = composeClaudeHarnessLaunch('proj-10', 'ws-workspace-wins')
  assert.equal(launch.model, 'haiku', 'workspace override model must win over project and global')
  assert.equal(launch.effort, 'high', 'workspace override effort must win over project and global')
  console.log('✓ a workspace override wins over both project and global')
}

// 11. A workspace effort of 'auto' must NOT override a project/global
//     effort — it is the legacy "no override" sentinel (see
//     withWorkspaceCuratedOverride's 'auto' SENTINEL note). A workspace
//     MODEL override set alongside it must still apply independently.
{
  createFreshDb()
  setHarnessSettings('claude', 'project', 'proj-11', {
    curated: { model: 'opus', effort: 'medium' }
  })
  setWorkspaceOverride('ws-auto-effort', { model: 'haiku', effort: 'auto' })
  const launch = composeClaudeHarnessLaunch('proj-11', 'ws-auto-effort')
  assert.equal(
    launch.effort,
    'medium',
    "a workspace effort of 'auto' must fall through to the project curated effort, not override it"
  )
  assert.equal(
    launch.model,
    'haiku',
    'a workspace model override alongside an auto effort must still apply independently'
  )
  console.log("✓ a workspace effort of 'auto' does not override a project/global effort")
}

// 12. Empty/unset resolves to '' (not 'auto', not undefined) — the exact
//     contract workspace:getEffectiveModel/getEffectiveEffort's handlers
//     return to the footer chips.
{
  createFreshDb()
  const launch = composeClaudeHarnessLaunch('proj-12', 'ws-nothing-set')
  assert.equal(launch.model, '', "unset model must resolve to '' (not undefined, not 'auto')")
  assert.equal(launch.effort, '', "unset effort must resolve to '' (not undefined, not 'auto')")
  console.log("✓ empty/unset resolves to '' for both model and effort")
}

console.log('\nAll harness-claude-launch assertions passed.')
