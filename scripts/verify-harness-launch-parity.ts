// ---------------------------------------------------------------------------
// scripts/verify-harness-launch-parity.ts
//
// U7 of the multi-harness architecture plan — THE PARITY GATE. Everything
// else in the plan is preparation; this is the assertion that makes the U9
// cutover safe rather than hopeful.
//
// Two emitters exist side by side right now:
//   OLD (superseded, gate-only)  composeClaudeLaunch        src/main/claudeSettings.ts
//   NEW (live, authoritative)    composeClaudeHarnessLaunch src/main/harness/claude/launch.ts
// composeClaudeHarnessLaunch is wired in as descriptor.composeLaunch in
// src/main/harness/registry.ts, and every real launch call site (native
// mount via composeLaunchForMount, and tmux hosting via hostWorkspace, which
// used to call composeClaudeLaunch directly until that call-site bug was
// fixed) goes through the registry, so it is the one actually launching
// `claude` today. composeClaudeLaunch survives only as the OLD-storage
// reference implementation this gate compares against — it reads
// claude_global_settings, which the harness cutover (fcb579cc / 1d214b05)
// demoted from source of truth. Both return { flags, settingsJson, env, model }.
//
// WHAT PARITY MEANS HERE — read before adding a fixture. The two emitters
// read DIFFERENT STORAGE (claude_global_settings vs harness_settings) and are
// deliberately NOT feature-equivalent: the new one has no typed passthroughs
// at all (KTD2), so it will never emit CLAUDE_CODE_MAX_OUTPUT_TOKENS and the
// ~90 other wired settings. A naive "seed both, deep-equal everything" test
// would fail by construction and prove nothing.
//
// So parity is asserted over the OVERLAPPING SURFACE — the settings
// expressible in BOTH systems:
//   - curated model / effort
//   - session continuity (--resume, --session-id, --fork-session)
//   - user-supplied CLI flags and env vars
// For each fixture: seed the old storage, seed the EQUIVALENT new storage,
// assert the two outputs are byte-identical.
//
// Where the two cannot agree by design, the difference is asserted
// EXPLICITLY with its reason (see the typed-passthrough divergence case and
// the permission-mode divergence case at the bottom). A gate that quietly
// tolerates drift is worse than no gate.
//
// PERMISSION-MODE IS NO LONGER PART OF THE OVERLAPPING SURFACE. It was
// removed as a curated concept (see curated.ts's header and CuratedField's
// doc comment in shared/harness/types.ts: Codex/Copilot/Gemini each express
// the same intent as a different argv shape, not one field with different
// values). The OLD emitter (composeFlagTokens) still unconditionally emits
// `--permission-mode` from claude_global_settings.permission_mode /
// planModeDefault whenever it isn't 'default' — that column and that
// behavior were not removed from the old system, only the NEW system's
// typed concept for it was. So fixtures below no longer set permission_mode
// on the old side (keeping the two sides on the surface they still share),
// and the dedicated divergence case at the bottom pins the gap explicitly
// rather than the gate silently going quiet on it.
//
// ORDERING IS PART OF THE CONTRACT. Both emitters place tokens as
// curated/typed -> session -> user custom flags. The old one appends custom
// flags last on purpose so a user's override wins by last-flag-wins in
// claude's own parser (claudeSettings.ts's comment above mergeFlagScopes);
// the new one mirrors it. Several fixtures below assert exact token order,
// not just set membership, because a reordering would silently change which
// flag wins.
//
// RUNTIME — plain `node --experimental-strip-types`, NOT `bun run`.
// better-sqlite3 hard-crashes Bun 1.3.10 (NAPI fatal error, not catchable),
// and node:sqlite has no bun equivalent, so a harness needing a real DB has
// to run under node. Same constraint and same resolve-hook shape as
// verify-harness-settings.ts / verify-harness-claude-launch.ts /
// verify-harness-session.ts.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { FLAG_DELIMITER } from '../src/shared/cliFlags.ts'

class Database extends DatabaseSync {}

const dbStubSource = `
export function getDb() {
  if (!globalThis.__HARNESS_PARITY_TEST_DB__) {
    throw new Error('verify-harness-launch-parity: no test DB set')
  }
  return globalThis.__HARNESS_PARITY_TEST_DB__
}
`

const hooks = `
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent('export const app = {}\nexport const BrowserWindow = {}\n'))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStubUrl, shortCircuit: true }
  }
  // src/main/db is a DIRECTORY module (db/index.ts) and node's ESM resolver
  // rejects directory imports outright rather than falling back to index.ts
  // the way bundler resolution does. Intercept from ANY parent: this graph
  // reaches the db from claudeSettings.ts ('./db'), settings.ts ('../db')
  // and workspaces.ts ('./db') alike.
  if (specifier === './db' || specifier === '../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    // src/**/*.ts use extensionless relative imports (bundler resolution) —
    // retry with .ts, same fallback the sibling harnesses use.
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

// schema.ts imports './render' extensionlessly, so it must load AFTER the
// resolve hook is registered — hence a dynamic import here rather than a
// static one at the top of the file.
const { renderCreateTable } = await import('../src/main/db/render.ts')
const { schema } = await import('../src/main/db/schema.ts')
const { composeClaudeLaunch, invalidateClaudeGlobalSettingsCache } =
  await import('../src/main/claudeSettings.ts')
const { composeClaudeHarnessLaunch } = await import('../src/main/harness/claude/launch.ts')
const { setHarnessSettings } = await import('../src/main/harness/settings.ts')

const PROJECT_ID = 'proj-parity'
const WORKSPACE_ID = 'ws-parity'
const CWD = '/tmp/orpheus-parity-fixture'

/**
 * Build a fresh in-memory DB carrying the REAL schema for every table this
 * comparison touches. Derived from src/main/db/schema.ts via
 * renderCreateTable rather than hand-written DDL, so the fixture cannot
 * drift from production the way a copied CREATE TABLE silently would —
 * claude_global_settings alone is 121 columns.
 */
function createFreshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  for (const table of [
    // projects first: workspaces carries a FK to it, and SQLite resolves FK
    // targets at insert time even with enforcement off in some builds.
    'projects',
    'claude_global_settings',
    'claude_project_settings',
    'claude_workspace_settings',
    'workspaces',
    'harness_settings'
  ]) {
    db.exec(renderCreateTable(table, schema[table]))
  }
  db.exec(
    `CREATE UNIQUE INDEX idx_harness_settings_key ON harness_settings (harness_id, scope, scope_id)`
  )
  // The singleton settings row composeClaudeLaunch reads (id = 1).
  db.exec(`INSERT INTO claude_global_settings (id, updated_at) VALUES (1, 0)`)
  db.prepare(`INSERT INTO projects (id, path, name, added_at) VALUES (?, ?, ?, 0)`).run(
    PROJECT_ID,
    CWD,
    'parity'
  )
  ;(globalThis as unknown as { __HARNESS_PARITY_TEST_DB__: unknown }).__HARNESS_PARITY_TEST_DB__ =
    db
  invalidateClaudeGlobalSettingsCache()
  return db
}

function seedWorkspace(
  db: InstanceType<typeof Database>,
  overrides: { claudeSessionId?: string; forkedFromSessionId?: string } = {}
): void {
  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, cwd, created_at, status, name_is_auto, claude_session_id, forked_from_session_id, harness_id)
     VALUES (?, ?, ?, ?, ?, 'idle', 1, ?, ?, 'claude')`
  ).run(
    WORKSPACE_ID,
    PROJECT_ID,
    'parity',
    CWD,
    0,
    overrides.claudeSessionId ?? null,
    overrides.forkedFromSessionId ?? null
  )
}

/** Set one column on the singleton claude_global_settings row (OLD storage). */
function setGlobal(db: InstanceType<typeof Database>, column: string, value: unknown): void {
  db.prepare(`UPDATE claude_global_settings SET ${column} = ? WHERE id = 1`).run(value as never)
  // claudeSettings.ts memoizes the settings row in a module-level cache, so a
  // direct DB write is invisible to composeClaudeLaunch until it is dropped.
  // Without this every fixture below would silently compare against the first
  // fixture's stale settings and "pass" for the wrong reason.
  invalidateClaudeGlobalSettingsCache()
}

/**
 * Assert the two emitters agree field-for-field. Compares the whole
 * HarnessLaunch shape, not a chosen subset, so a divergence in any field
 * surfaces here rather than in production.
 */
function assertParity(label: string): void {
  const oldLaunch = composeClaudeLaunch(PROJECT_ID, WORKSPACE_ID)
  const newLaunch = composeClaudeHarnessLaunch(PROJECT_ID, WORKSPACE_ID)
  assert.deepEqual(
    {
      flags: newLaunch.flags,
      settingsJson: newLaunch.settingsJson,
      env: newLaunch.env,
      model: newLaunch.model
    },
    {
      flags: oldLaunch.flags,
      settingsJson: oldLaunch.settingsJson,
      env: oldLaunch.env,
      model: oldLaunch.model
    },
    `${label}: the new emitter must produce byte-identical output to composeClaudeLaunch`
  )
}

// ---------------------------------------------------------------------------
// 1. Defaults everywhere -> both emit nothing.
//    The floor case: an unconfigured workspace must launch bare `claude` on
//    both paths. If this diverges, every other fixture's result is suspect.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  seedWorkspace(db)

  // FINDING (U7) — the two DIVERGE on a fresh install, and the cause is a
  // schema default, not a bug in either emitter.
  //
  // claude_global_settings.model is `TEXT NOT NULL DEFAULT 'sonnet'`
  // (schema.ts:280), so the OLD emitter reads back a non-empty model for a
  // user who has never picked one and unconditionally emits `--model sonnet`
  // (claudeSettings.ts's comment at the emission site is explicit that this
  // is deliberate: it makes "Sonnet" distinguishable from "no override" and
  // stops an ambient ANTHROPIC_MODEL from winning).
  //
  // The NEW emitter has no such default — harness_settings starts empty, so
  // an unconfigured workspace emits nothing and claude picks its own default.
  //
  // These are different behaviors, both defensible. Pinning it here means the
  // cutover is a DECISION rather than a surprise: if Orpheus should keep
  // pinning the model explicitly, the Claude descriptor needs a default
  // curated value; if claude's own default is preferred, this is the intended
  // change and the assertion below documents it.
  const oldDefaults = composeClaudeLaunch(PROJECT_ID, WORKSPACE_ID)
  const newDefaults = composeClaudeHarnessLaunch(PROJECT_ID, WORKSPACE_ID)
  assert.equal(
    oldDefaults.model,
    'sonnet',
    "sanity: the old emitter pins 'sonnet' from the column default on a fresh install"
  )
  assert.equal(
    newDefaults.flags,
    '',
    'the new emitter emits nothing until the user configures something (no schema default)'
  )
  assert.equal(newDefaults.model, '', 'and reports an empty effective model, not a pinned one')
  console.log(
    '✓ fresh-install divergence pinned: old pins --model sonnet from a column default, new emits nothing'
  )

  // With the equivalent value configured in the new store, they agree — which
  // is what proves the divergence is only about the DEFAULT, not the wiring.
  setHarnessSettings('claude', 'global', undefined, { curated: { model: 'sonnet' } })
  assertParity('defaults, with model explicitly set on the new path')
  console.log('✓ once the model is set explicitly, both emitters agree exactly')
}

// ---------------------------------------------------------------------------
// 2. Curated model + effort.
//    The two concepts Orpheus still curates (KTD3 minus permission-mode —
//    see the file header). Asserts exact token ORDER, not just presence —
//    these lead the argv on both paths. permission_mode is deliberately left
//    at its 'default' fixture value on the OLD side here so this scenario
//    stays on the surface both emitters still share; the dedicated
//    divergence case at the bottom of this file covers what happens when
//    permission_mode is actually set on the old side.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  seedWorkspace(db)
  setGlobal(db, 'model', 'opus')
  setGlobal(db, 'effort', 'high')
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'opus', effort: 'high' }
  })
  assertParity('curated pair')
  console.log('✓ curated model/effort: identical flags and model field')
}

// ---------------------------------------------------------------------------
// 3. A CUSTOM model id — one absent from CLAUDE_MODEL_OPTIONS.
//    R4: curated lists are suggestion sets, never whitelists. Both emitters
//    must pass a user's own model id through untouched.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  seedWorkspace(db)
  setGlobal(db, 'model', 'my-fine-tuned-model-9')
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'my-fine-tuned-model-9' }
  })
  assertParity('custom model id')
  console.log('✓ a custom (non-curated) model id survives identically on both paths')
}

// ---------------------------------------------------------------------------
// 4. User-supplied CLI flags.
//    OLD stores free-text entries in custom_cli_flags; NEW stores structured
//    arg rows. Both must land in the same argv positions — AFTER the curated
//    flags, so the user's override still wins by last-flag-wins.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  seedWorkspace(db)
  setGlobal(db, 'model', 'sonnet')
  setGlobal(db, 'custom_cli_flags', JSON.stringify(['--add-dir /tmp/foo', '--verbose']))
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'sonnet' },
    args: [
      { key: '--add-dir', value: '/tmp/foo', enabled: true },
      { key: '--verbose', enabled: true }
    ]
  })
  assertParity('custom cli flags')
  console.log('✓ user CLI flags land in identical argv positions, after the curated flags')
}

// ---------------------------------------------------------------------------
// 5. User-supplied env vars.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  seedWorkspace(db)
  setGlobal(db, 'custom_env_vars', JSON.stringify({ MY_VAR: 'x', OTHER: 'y' }))
  // Pin the model on both sides so this fixture isolates env behavior rather
  // than re-reporting the fresh-install default divergence pinned in case 1.
  setGlobal(db, 'model', 'sonnet')
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'sonnet' },
    env: [
      { key: 'MY_VAR', value: 'x', enabled: true },
      { key: 'OTHER', value: 'y', enabled: true }
    ]
  })
  assertParity('custom env vars')
  console.log('✓ user env vars produce an identical env map')
}

// ---------------------------------------------------------------------------
// 6. Resume — a workspace whose transcript already exists on disk.
//    Session continuity is the least generalizable logic in the codebase
//    (U5), so parity here is the strongest signal that the move preserved
//    behavior.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  const sessionId = '11111111-2222-3333-4444-555555555555'
  seedWorkspace(db, { claudeSessionId: sessionId })
  // Pin the model on both sides so this fixture isolates session behavior.
  setGlobal(db, 'model', 'sonnet')
  setHarnessSettings('claude', 'global', undefined, { curated: { model: 'sonnet' } })
  assertParity('resume (no transcript on disk -> fresh --session-id)')
  const launch = composeClaudeHarnessLaunch(PROJECT_ID, WORKSPACE_ID)
  assert.ok(
    launch.flags.includes(sessionId),
    'the session id must appear in the composed flags on both paths'
  )
  console.log('✓ session continuity: identical tokens for a workspace with a session id')
}

// ---------------------------------------------------------------------------
// 7. Fork — the exact five-token branch, in order.
//    --session-id <new> --resume <parent> --fork-session. Order is the whole
//    contract here: a reordering still "contains the same tokens" but tells
//    claude to do something different.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  const ours = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const parent = '99999999-8888-7777-6666-555555555555'
  seedWorkspace(db, { claudeSessionId: ours, forkedFromSessionId: parent })
  setGlobal(db, 'model', 'sonnet')
  setHarnessSettings('claude', 'global', undefined, { curated: { model: 'sonnet' } })
  assertParity('fork')
  const launch = composeClaudeHarnessLaunch(PROJECT_ID, WORKSPACE_ID)
  const tokens = launch.flags.split(FLAG_DELIMITER)
  assert.deepEqual(
    tokens.slice(-5),
    ['--session-id', ours, '--resume', parent, '--fork-session'],
    'the fork branch must emit its five tokens in exactly this order on the new path'
  )
  console.log('✓ fork: identical five-token branch, exact order preserved')
}

// ---------------------------------------------------------------------------
// 8. THE DELIBERATE DIVERGENCE — asserted, not hidden.
//    A typed passthrough exists only in the OLD system. KTD2 removed those
//    from the new one on purpose: users supply such settings themselves as
//    env rows. This fixture pins that difference so it stays a known,
//    intentional gap rather than drifting into an accidental one — and so
//    that anyone who later "restores parity" by re-adding typed passthroughs
//    has to delete an assertion that says why not to.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  seedWorkspace(db)
  setGlobal(db, 'disable_telemetry', 1)

  const oldLaunch = composeClaudeLaunch(PROJECT_ID, WORKSPACE_ID)
  const newLaunch = composeClaudeHarnessLaunch(PROJECT_ID, WORKSPACE_ID)

  assert.equal(
    oldLaunch.env['DISABLE_TELEMETRY'],
    '1',
    'sanity: the old emitter still emits its typed passthrough'
  )
  assert.equal(
    newLaunch.env['DISABLE_TELEMETRY'],
    undefined,
    'BY DESIGN (KTD2): the new emitter has no typed passthroughs — a user who wants this sets it as an env row'
  )

  // ...and the user CAN express it, which is what makes the gap acceptable.
  setHarnessSettings('claude', 'global', undefined, {
    env: [{ key: 'DISABLE_TELEMETRY', value: '1', enabled: true }]
  })
  const withUserRow = composeClaudeHarnessLaunch(PROJECT_ID, WORKSPACE_ID)
  assert.equal(
    withUserRow.env['DISABLE_TELEMETRY'],
    '1',
    'a user env row must reproduce what the typed passthrough used to do'
  )
  console.log('✓ typed-passthrough divergence is by design, and user rows can express the same')
}

// ---------------------------------------------------------------------------
// 9. THE PERMISSION-MODE DIVERGENCE — asserted, not hidden.
//    permission-mode was REMOVED as a curated concept (see the file header
//    and curated.ts's own header: it is a Claude flag whose equivalent on
//    Codex/Copilot/Gemini is a structurally different argv shape, not one
//    field with different values). The OLD system's column
//    (claude_global_settings.permission_mode) and its unconditional emission
//    in composeFlagTokens were NOT touched by that change — only the NEW
//    system's typed concept for it was removed. So setting permission_mode
//    on the old side now makes the two emitters genuinely disagree: the old
//    one still emits `--permission-mode acceptEdits` from that column; the
//    new one emits it ONLY if an enabled `--permission-mode` arg row exists
//    in harness_settings (e.g. the user opts into the seeded
//    CLAUDE_DEFAULT_ARGS row) — nothing about permission_mode automatically
//    carries over from the old column any more.
//
//    This fixture pins that gap explicitly, the same pattern as the typed-
//    passthrough divergence above, so a future "restore parity" attempt has
//    to delete an assertion that explains why not to — and proves the gap
//    is bridgeable: an equivalent enabled arg row on the new side reproduces
//    the old flag exactly.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  seedWorkspace(db)
  setGlobal(db, 'model', 'sonnet')
  setGlobal(db, 'permission_mode', 'acceptEdits')
  setHarnessSettings('claude', 'global', undefined, { curated: { model: 'sonnet' } })

  const oldLaunch = composeClaudeLaunch(PROJECT_ID, WORKSPACE_ID)
  const newLaunch = composeClaudeHarnessLaunch(PROJECT_ID, WORKSPACE_ID)

  assert.ok(
    oldLaunch.flags.includes('--permission-mode'),
    'sanity: the old emitter still emits --permission-mode from claude_global_settings.permission_mode'
  )
  assert.ok(
    !newLaunch.flags.includes('--permission-mode'),
    'BY DESIGN (permission-mode is no longer curated): the new emitter emits nothing for permission_mode unless an arg row is enabled'
  )

  // ...and the user CAN express it — the seeded CLAUDE_DEFAULT_ARGS row
  // enabled reproduces the old flag exactly, which is what makes the gap
  // acceptable rather than a silent behavior loss.
  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'sonnet' },
    args: [{ key: '--permission-mode', value: 'acceptEdits', enabled: true }]
  })
  const withArgRow = composeClaudeHarnessLaunch(PROJECT_ID, WORKSPACE_ID)
  assert.ok(
    withArgRow.flags.includes('--permission-mode'),
    'an enabled --permission-mode arg row must reproduce what the old curated concept used to do'
  )
  console.log(
    '✓ permission-mode divergence is by design, and an enabled default-arg row can express the same'
  )
}

console.log('\nAll harness launch-parity assertions passed.')
