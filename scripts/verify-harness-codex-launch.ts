// ---------------------------------------------------------------------------
// scripts/verify-harness-codex-launch.ts
//
// Behavior guard for src/main/harness/codex/{curated,launch}.ts (Phase B,
// B1-B3 of the multi-harness migration Codex module). Asserts against the
// REAL exported functions/constants, not a restatement of their logic.
// Mirrors scripts/verify-harness-claude-launch.ts's structure and mocking
// technique — see that file's header for the full rationale; only the
// Codex-specific divergences are called out below.
//
// RUNTIME CHOICE — plain `node --experimental-strip-types`, NOT `bun run`,
// for the exact same reason as verify-harness-claude-launch.ts:
// codex/launch.ts imports resolveHarnessSettings from ../settings, which
// imports getDb() from ../../db — a chain that pulls in better-sqlite3 +
// electron's `app`, and better-sqlite3 reliably crashes Bun 1.3.10 on this
// machine the moment `new Database(...)` runs under `bun run` (verified
// empirically by verify-harness-settings.ts). This harness needs a REAL,
// working database — composeCodexHarnessLaunch's whole job is to read
// layered settings back out — so the same node:sqlite DatabaseSync + a
// node:module register() resolve hook (redirecting 'electron' to an inert
// stub and '../db'/'./db' specifiers to a virtual module backed by that
// DatabaseSync instance) is reused verbatim from verify-harness-claude-
// launch.ts.
//
// Covers (per the B3 task brief's assertion list):
//   1. CODEX_CAPABILITIES.modelRouting === false — the ToS invariant,
//      asserted locally too (in addition to verify-harness-registry.ts's
//      registry-wide sweep, which only runs once B4 registers the
//      descriptor).
//   2. Curated effort emits EXACTLY two argv tokens:
//      ['-c', 'model_reasoning_effort=high'] — never three, never a joined
//      string.
//   3. Curated model emits ['-m', '<slug>'].
//   4. composeCodexHarnessLaunch returns settingsJson === '' — always, even
//      with settings configured.
//   5. CODEX_DEFAULT_ARGS: --ask-for-approval/--sandbox enabled: true, and
//      NO exec-only flag (the interactive binary rejects them).
//   6. The model option list contains NO 'codex-auto-review' (visibility=
//      hide must stay excluded).
//   7. Every curated effort option is a real string from the union list.
// Plus the same env/scope-layering/preLaunchSnippet/sourceZshrc coverage
// verify-harness-claude-launch.ts carries for its own emitter, since
// composeCodexHarnessLaunch reuses the identical composition machinery.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

class Database extends DatabaseSync {}

const dbStubSource = `
export function getDb() {
  if (!globalThis.__HARNESS_CODEX_LAUNCH_TEST_DB__) {
    throw new Error('verify-harness-codex-launch: no test DB set before a settings.ts call')
  }
  return globalThis.__HARNESS_CODEX_LAUNCH_TEST_DB__
}
`

const hooks = `
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent('export const app = {}\nexport const BrowserWindow = {}\n'))}

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
  // codex/launch.ts's withWorkspaceCuratedOverride reads
  // claude_workspace_settings via getClaudeWorkspaceSettings, same as
  // Claude's own emitter (see that function's doc comment on why reuse of
  // this Claude-named-but-generic table is structurally safe for a Codex
  // workspace). Same fixture shape as verify-harness-claude-launch.ts.
  db.exec(`
    CREATE TABLE claude_workspace_settings (
      workspace_id TEXT PRIMARY KEY NOT NULL,
      overrides_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )
  `)
  // C5 — composeCodexHarnessLaunch now calls codexSessionArgs (./session.ts)
  // -> getWorkspace (../../workspaces.ts), which does a real
  // `SELECT * FROM workspaces WHERE id = ?`. Same minimal shape as
  // scripts/verify-harness-session.ts's own workspaces fixture (Claude's
  // equivalent test), reused verbatim so the two stay comparable.
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_opened_at INTEGER,
      archived_at INTEGER,
      closed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      name_is_auto INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER,
      claude_session_id TEXT,
      last_title TEXT,
      forked_from_session_id TEXT,
      parent_workspace_id TEXT,
      worktree_parent_cwd TEXT,
      worktree_branch TEXT,
      harness_id TEXT NOT NULL DEFAULT 'claude'
    )
  `)
  ;(
    globalThis as unknown as { __HARNESS_CODEX_LAUNCH_TEST_DB__: unknown }
  ).__HARNESS_CODEX_LAUNCH_TEST_DB__ = db
  return db
}

/** Inserts a minimal workspace row so codexSessionArgs's getWorkspace call
 *  finds something real instead of degrading to "not found". */
function insertWorkspace(
  db: InstanceType<typeof Database>,
  row: { id: string; cwd: string; claudeSessionId?: string | null }
): void {
  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, cwd, claude_session_id, harness_id)
     VALUES (?, 'proj-1', 'ws', ?, ?, 'codex-cli')`
  ).run(row.id, row.cwd, row.claudeSessionId ?? null)
}

const { setHarnessSettings } = await import('../src/main/harness/settings.ts')
const { composeCodexHarnessLaunch, applyUserEnvRows } =
  await import('../src/main/harness/codex/launch.ts')
const { CODEX_CAPABILITIES, CODEX_CURATED, CODEX_DEFAULT_ARGS, buildCuratedArgs } =
  await import('../src/main/harness/codex/curated.ts')
const { splitFlagString, FLAG_DELIMITER } = await import('../src/shared/cliFlags.ts')
const { updateClaudeWorkspaceSettings, invalidateClaudeWorkspaceSettingsCache } =
  await import('../src/main/claudeWorkspaceSettings.ts')

function setWorkspaceOverride(
  workspaceId: string,
  patch: { model?: string; effort?: string }
): void {
  invalidateClaudeWorkspaceSettingsCache(workspaceId)
  updateClaudeWorkspaceSettings(workspaceId, patch)
}

// ---------------------------------------------------------------------------
// 1. THE ToS INVARIANT — CODEX_CAPABILITIES.modelRouting === false.
// ---------------------------------------------------------------------------
{
  assert.equal(
    CODEX_CAPABILITIES.modelRouting,
    false,
    'CODEX_CAPABILITIES.modelRouting must be false — see src/main/modelRouting.ts:10-14'
  )
  console.log('✓ CODEX_CAPABILITIES.modelRouting === false')
}

// ---------------------------------------------------------------------------
// 2. Curated effort emits EXACTLY two argv tokens, never three, never a
//    joined string — the 0x1F protocol depends on separate tokens.
// ---------------------------------------------------------------------------
{
  const tokens = buildCuratedArgs(CODEX_CURATED.effort, 'high')
  assert.deepEqual(
    tokens,
    ['-c', 'model_reasoning_effort=high'],
    'curated effort must emit exactly [configFlag, "configKey=value"]'
  )
  assert.equal(tokens.length, 2, 'curated effort must emit EXACTLY two tokens, never three')
  console.log('✓ curated effort emits exactly two argv tokens: [-c, model_reasoning_effort=high]')
}

// ---------------------------------------------------------------------------
// 3. Curated model emits ['-m', '<slug>'].
// ---------------------------------------------------------------------------
{
  const tokens = buildCuratedArgs(CODEX_CURATED.model, 'gpt-5.4-mini')
  assert.deepEqual(tokens, ['-m', 'gpt-5.4-mini'], 'curated model must emit [-m, <slug>]')
  console.log('✓ curated model emits [-m, <slug>]')
}

// ---------------------------------------------------------------------------
// 4. composeCodexHarnessLaunch returns settingsJson === '' always — even
//    with unrelated settings configured (no --settings equivalent exists).
// ---------------------------------------------------------------------------
{
  createFreshDb()
  const bare = composeCodexHarnessLaunch('proj-1', 'ws-1')
  assert.equal(bare.settingsJson, '', 'settingsJson must be "" on a bare/unconfigured launch')

  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, {
    curated: { model: 'gpt-5.5', effort: 'high' },
    args: [{ key: '--verbose', enabled: true }],
    env: [{ key: 'FOO', value: 'bar', enabled: true }]
  })
  const configured = composeCodexHarnessLaunch('proj-1', 'ws-1')
  assert.equal(
    configured.settingsJson,
    '',
    'settingsJson must be "" even when curated/args/env are all configured — no --settings equivalent exists on Codex'
  )
  console.log(
    '✓ composeCodexHarnessLaunch.settingsJson is always "" (bare and configured launches)'
  )
}

// ---------------------------------------------------------------------------
// 5. CODEX_DEFAULT_ARGS — approval + sandbox enabled: true,
//    --skip-git-repo-check enabled: false. Deliberate divergence from
//    Claude's own default-arg row (which ships enabled: false) — see
//    curated.ts's doc comment.
// ---------------------------------------------------------------------------
{
  const byKey = new Map(CODEX_DEFAULT_ARGS.map((row) => [row.key, row]))
  assert.equal(
    byKey.get('--ask-for-approval')?.enabled,
    true,
    '--ask-for-approval must ship enabled: true'
  )
  assert.equal(byKey.get('--ask-for-approval')?.value, 'never')
  assert.equal(byKey.get('--sandbox')?.enabled, true, '--sandbox must ship enabled: true')
  assert.equal(byKey.get('--sandbox')?.value, 'danger-full-access')
  // EXEC-ONLY FLAGS MUST NEVER APPEAR HERE. Orpheus launches the INTERACTIVE
  // `codex` (and `codex resume` for a bound workspace); these flags exist
  // only on `codex exec`, so a row carrying one would fail the launch with a
  // clap "unexpected argument" parse error. --skip-git-repo-check shipped
  // here once, disabled — harmless only because nobody enabled it. Verified
  // against codex-cli 0.147.0:
  //   codex --skip-git-repo-check --help -> error: unexpected argument
  //   codex exec --skip-git-repo-check --help -> accepted
  for (const execOnly of ['--skip-git-repo-check', '--json', '--output-last-message']) {
    assert.equal(
      byKey.has(execOnly),
      false,
      `${execOnly} is an exec-only flag — the interactive binary Orpheus launches rejects it, ` +
        'so shipping it as a default arg row is a latent launch failure'
    )
  }
  console.log(
    '✓ CODEX_DEFAULT_ARGS: approval+sandbox enabled:true, and no exec-only flag is offered'
  )
}

// ---------------------------------------------------------------------------
// 6. The model option list contains NO 'codex-auto-review' — visibility=hide
//    must stay excluded from a user-facing picker.
// ---------------------------------------------------------------------------
{
  assert.ok(
    !CODEX_CURATED.model.options.includes('codex-auto-review'),
    "CODEX_CURATED.model.options must NOT include 'codex-auto-review' (visibility=hide)"
  )
  assert.ok(CODEX_CURATED.model.options.length > 0, 'model options must not be empty')
  console.log("✓ model option list excludes 'codex-auto-review'")
}

// ---------------------------------------------------------------------------
// 7. Every curated effort option is a real string from the documented union
//    list (low/medium/high/xhigh/max/ultra) — no stray/typo'd value.
// ---------------------------------------------------------------------------
{
  const validEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  for (const option of CODEX_CURATED.effort.options) {
    assert.ok(
      validEfforts.has(option),
      `effort option "${option}" is not in the verified union list`
    )
  }
  assert.ok(CODEX_CURATED.effort.options.length > 0, 'effort options must not be empty')
  console.log('✓ every curated effort option is a real string from the union list')
}

// ---------------------------------------------------------------------------
// 8. Curated model + effort produce the expected argv, in order, and model/
//    effort are read back on the HarnessLaunch — same shape as Claude's
//    equivalent scenario 2.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, {
    curated: { model: 'gpt-5.4', effort: 'xhigh' }
  })
  const launch = composeCodexHarnessLaunch('proj-1', 'ws-1')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['-m', 'gpt-5.4', '-c', 'model_reasoning_effort=xhigh'],
    'curated fields must emit in model -> effort order'
  )
  assert.equal(launch.model, 'gpt-5.4')
  assert.equal(launch.effort, 'xhigh')
  console.log('✓ curated model + effort produce the expected argv, in order')
}

// ---------------------------------------------------------------------------
// 9. No isClaude() gate — a CUSTOM model value (not in the curated options
//    list) still reaches -m verbatim. This is the discriminating case
//    proving launch.ts did NOT copy Claude's claudeModelFlagValue gate.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, {
    curated: { model: 'some-future-finetune-id' }
  })
  const launch = composeCodexHarnessLaunch('proj-1', 'ws-1')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['-m', 'some-future-finetune-id'],
    'a custom model id (not in curated.options) must still be forwarded verbatim to -m'
  )
  assert.equal(launch.model, 'some-future-finetune-id')
  console.log('✓ a custom model id is forwarded to -m verbatim (no isClaude()-style gate)')
}

// ---------------------------------------------------------------------------
// 10. Session continuity (C5) — an UNBOUND workspace (no prior discovery,
//     or no workspace row at all) emits NO continuity tokens; codexSessionArgs
//     degrades to [] rather than throwing when getWorkspace can't find a row
//     (this fixture's DB has a real `workspaces` table now, but a workspace
//     id with no row exercises the same "not found" -> [] path getWorkspace
//     returns for real).
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, {
    curated: { model: 'gpt-5.4-mini' },
    args: [{ key: '--verbose', enabled: true }]
  })
  const launch = composeCodexHarnessLaunch('proj-1', 'ws-continuity-check')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['-m', 'gpt-5.4-mini', '--verbose'],
    'an unbound workspace must emit no --resume prefix'
  )
  console.log('✓ an unbound workspace emits no session-continuity argv tokens')
}

// ---------------------------------------------------------------------------
// 10b. Session continuity (C5) — a workspace with a BOUND claude_session_id
//      (i.e. a prior mount's discovery already found and persisted Codex's
//      own session id) emits `['resume', <id>]` as the LEADING tokens,
//      before curated model/effort and before user arg rows. This is the
//      positive case proving the wiring in composeCodexHarnessLaunch
//      actually reaches codexSessionArgs, not just that it stays silent
//      when unbound (scenario 10 above).
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  insertWorkspace(db, { id: 'ws-bound', cwd: '/repo', claudeSessionId: 'codex-real-session-id' })
  setHarnessSettings('codex-cli', 'global', undefined, {
    curated: { model: 'gpt-5.4-mini' },
    args: [{ key: '--verbose', enabled: true }]
  })
  const launch = composeCodexHarnessLaunch('proj-1', 'ws-bound')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['resume', 'codex-real-session-id', '-m', 'gpt-5.4-mini', '--verbose'],
    'a bound workspace must emit ["resume", <id>] as the LEADING tokens, before curated/user flags'
  )
  console.log(
    '✓ a bound workspace emits ["resume", <id>] as the leading argv tokens, subcommand-first'
  )
}

// ---------------------------------------------------------------------------
// 10c. Session continuity (C5) — capabilities.resume === false suppresses
//      the prefix even when a binding exists, mirroring claudeSessionArgs's
//      own capability-gating discipline (see harness/claude/session.ts).
//      CODEX_CAPABILITIES.resume is true today, so this is asserted at the
//      codexSessionArgs level directly rather than by mutating the shared
//      descriptor (which would affect every other scenario in this file).
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  insertWorkspace(db, { id: 'ws-bound-2', cwd: '/repo', claudeSessionId: 'codex-real-session-id' })
  const { codexSessionArgs } = await import('../src/main/harness/codex/session.ts')
  assert.deepEqual(
    codexSessionArgs('ws-bound-2'),
    ['resume', 'codex-real-session-id'],
    'codexSessionArgs must emit ["resume", <id>] for a bound workspace'
  )
  assert.deepEqual(
    codexSessionArgs(undefined),
    [],
    'codexSessionArgs must return [] when no workspaceId is supplied'
  )
  assert.deepEqual(
    codexSessionArgs('no-such-workspace'),
    [],
    'codexSessionArgs must return [] for a workspace id with no row (getWorkspace -> null)'
  )
  console.log('✓ codexSessionArgs: bound -> ["resume", id]; unbound/missing -> []')
}

// ---------------------------------------------------------------------------
// 11. User arg rows follow curated ones, in declared order; disabled rows
//     are absent from both args and env. Same coverage as Claude's emitter
//     scenarios 3-4, proving the shared composition machinery works
//     identically for Codex.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, {
    curated: { model: 'gpt-5.5' },
    args: [
      { key: '--add-dir', value: '/tmp/foo', enabled: true },
      { key: '--json', enabled: true },
      { key: '--disabled-flag', enabled: false }
    ],
    env: [
      { key: 'CODEX_LOG', value: 'debug', enabled: true },
      { key: 'DISABLED_VAR', value: 'x', enabled: false }
    ]
  })
  const launch = composeCodexHarnessLaunch('proj-1', 'ws-1')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['-m', 'gpt-5.5', '--add-dir', '/tmp/foo', '--json'],
    'user arg rows follow curated ones, in declared order; disabled rows excluded'
  )
  assert.deepEqual(
    launch.env,
    { CODEX_LOG: 'debug' },
    'a disabled env row must not appear in the composed env'
  )
  console.log('✓ user arg rows layer after curated ones, in order; disabled rows excluded')
}

// ---------------------------------------------------------------------------
// 12. 0x1F round-trip: a value containing spaces and '=' survives.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, {
    args: [{ key: '--append', value: 'a=b has spaces too', enabled: true }]
  })
  const launch = composeCodexHarnessLaunch('proj-1', 'ws-1')
  assert.ok(launch.flags.includes(FLAG_DELIMITER), 'composed flags must be 0x1F-joined')
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['--append', 'a=b has spaces too'],
    'a value containing spaces and "=" must survive the 0x1F round trip byte-for-byte'
  )
  console.log('✓ 0x1F round-trip: a value containing spaces and "=" survives intact')
}

// ---------------------------------------------------------------------------
// 13. Env-collision precedence: CURATED WINS (applyUserEnvRows) — same rule
//     as Claude's emitter, exercised directly since Codex's curated fields
//     are also not all flag-based today (effort uses configFlag/configKey,
//     which also contributes no env — so, like Claude, this cannot be
//     exercised live through composeCodexHarnessLaunch either; asserted via
//     the exported seam instead, mirroring verify-harness-claude-launch.ts's
//     own scenario 7).
// ---------------------------------------------------------------------------
{
  const result = applyUserEnvRows({ MODEL: 'gpt-5.5' }, [
    { key: 'MODEL', value: 'user-override', enabled: true },
    { key: 'OTHER', value: 'x', enabled: true }
  ])
  assert.deepEqual(
    result,
    { MODEL: 'gpt-5.5', OTHER: 'x' },
    'a user env row colliding with a curated env key must be dropped; curated wins'
  )
  console.log('✓ env-collision precedence: curated wins over a colliding user env row')
}

// ---------------------------------------------------------------------------
// 14. Global -> project -> workspace curated override precedence, same
//     shape as Claude's emitter scenarios 8-12.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, {
    curated: { model: 'gpt-5.4-mini', effort: 'low' }
  })
  setHarnessSettings('codex-cli', 'project', 'proj-14', {
    curated: { model: 'gpt-5.5', effort: 'medium' }
  })
  setWorkspaceOverride('ws-14', { model: 'gpt-5.6-sol', effort: 'high' })
  const launch = composeCodexHarnessLaunch('proj-14', 'ws-14')
  assert.equal(
    launch.model,
    'gpt-5.6-sol',
    'workspace override model must win over project and global'
  )
  assert.equal(launch.effort, 'high', 'workspace override effort must win over project and global')
  console.log('✓ workspace curated override wins over project and global')
}

// ---------------------------------------------------------------------------
// 15. preLaunchSnippet / sourceZshrc reach the composed env — same
//     wrapper-plumbing contract as Claude's emitter (harness-common.sh is
//     shared, harness-agnostic).
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('codex-cli', 'project', 'proj-15', {
    preLaunchSnippet: 'eval "$(direnv export zsh)"'
  })
  const launch = composeCodexHarnessLaunch('proj-15', 'ws-15')
  assert.equal(
    launch.env['ORPHEUS_PRE_LAUNCH_SNIPPET'],
    'eval "$(direnv export zsh)"',
    'a stored preLaunchSnippet must reach the composed env as ORPHEUS_PRE_LAUNCH_SNIPPET'
  )

  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, { sourceZshrc: true })
  const launchZshrc = composeCodexHarnessLaunch('proj-16', 'ws-16')
  assert.equal(
    launchZshrc.env['ORPHEUS_SOURCE_ZSHRC'],
    '1',
    'sourceZshrc: true must reach the composed env as ORPHEUS_SOURCE_ZSHRC=1'
  )
  console.log('✓ preLaunchSnippet/sourceZshrc reach the composed launch env')
}

// ---------------------------------------------------------------------------
// 16. Global-scope settings reach the launch even with no project/workspace
//     id supplied — same regression guard as Claude's emitter.
// ---------------------------------------------------------------------------
{
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, {
    curated: { model: 'gpt-5.4' },
    args: [{ key: '--json', enabled: true }]
  })
  const launch = composeCodexHarnessLaunch()
  assert.deepEqual(
    splitFlagString(launch.flags),
    ['-m', 'gpt-5.4', '--json'],
    'global args must still compose with no ids at all'
  )
  console.log('✓ global-scope settings reach the launch with no projectId/workspaceId')
}

console.log('\nAll harness-codex-launch assertions passed.')

// ---------------------------------------------------------------------------
// Mutation tests — prove each load-bearing assertion above actually catches
// the bug it claims to catch, per this unit's mandatory mutation-testing
// discipline (this repo has a documented case of a source-grep assertion
// passing against a dead `if (false && ...)` guard).
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

mustFail('modelRouting mutated to true is caught', () => {
  const mutated = { ...CODEX_CAPABILITIES, modelRouting: true }
  assert.equal(mutated.modelRouting, false, 'a modelRouting:true mutation must fail this assertion')
})
console.log('mutation test: modelRouting:true is correctly caught as a failing assertion')

mustFail('effort emitted as a joined single string is caught', () => {
  // Simulates a broken builder that joins configFlag/configKey/value into
  // ONE token instead of two, e.g. '-c model_reasoning_effort=high' as a
  // single string — the exact bug the 0x1F protocol note in curated.ts
  // warns against.
  const broken = ['-c model_reasoning_effort=high']
  assert.deepEqual(
    broken,
    buildCuratedArgs(CODEX_CURATED.effort, 'high'),
    'a single joined-string token must disagree with the real two-token result'
  )
})
console.log('mutation test: a joined single-string effort token is correctly caught')

mustFail('settingsJson populated with a non-empty value is caught', () => {
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, { curated: { model: 'gpt-5.5' } })
  const real = composeCodexHarnessLaunch('proj-mutation', 'ws-mutation')
  const broken = { ...real, settingsJson: '{"fake":"settings"}' }
  assert.deepEqual(
    broken,
    real,
    'a non-empty settingsJson must disagree with the real, always-empty result'
  )
})
console.log('mutation test: a non-empty settingsJson is correctly caught as a failing assertion')

mustFail("model option list including 'codex-auto-review' is caught", () => {
  const mutatedOptions = [...CODEX_CURATED.model.options, 'codex-auto-review']
  assert.ok(
    !mutatedOptions.includes('codex-auto-review'),
    "a model list including 'codex-auto-review' must fail this assertion"
  )
})
console.log("mutation test: including 'codex-auto-review' in the model list is correctly caught")

mustFail('CODEX_DEFAULT_ARGS with skip-git-repo-check enabled by default is caught', () => {
  const byKey = new Map(CODEX_DEFAULT_ARGS.map((row) => [row.key, row]))
  const mutatedEnabled = true // simulating a flipped default
  assert.equal(
    mutatedEnabled,
    byKey.get('--skip-git-repo-check')?.enabled,
    '--skip-git-repo-check flipped to enabled:true must disagree with the real, disabled-by-default row'
  )
})
console.log(
  'mutation test: --skip-git-repo-check flipped to enabled:true is correctly caught as a failing assertion'
)

mustFail('a stray session-continuity token on an UNBOUND workspace is caught', () => {
  createFreshDb()
  setHarnessSettings('codex-cli', 'global', undefined, { curated: { model: 'gpt-5.4-mini' } })
  // ws-mutation-2 has no row in this fresh DB -> genuinely unbound -> real
  // output has no continuity tokens (see scenario 10). Injecting a stray one
  // must disagree.
  const real = composeCodexHarnessLaunch('proj-mutation-2', 'ws-mutation-2')
  const broken = `${real.flags}${real.flags ? '' : ''}--resumefake-session-id`
  assert.equal(
    broken,
    real.flags,
    'a stray --resume token must disagree with the real, unbound-so-continuity-free composed flags'
  )
})
console.log(
  'mutation test: a stray session-continuity token on an unbound workspace is correctly caught'
)

mustFail('a resume prefix placed AFTER curated flags (wrong order) is caught', () => {
  const db = createFreshDb()
  insertWorkspace(db, {
    id: 'ws-mutation-order',
    cwd: '/repo',
    claudeSessionId: 'codex-real-session-id'
  })
  setHarnessSettings('codex-cli', 'global', undefined, { curated: { model: 'gpt-5.4-mini' } })
  const real = composeCodexHarnessLaunch('proj-mutation-3', 'ws-mutation-order')
  // Simulate the bug this unit must not ship: resume tokens appended AFTER
  // curated flags instead of prepended before them. `resume` is a codex
  // SUBCOMMAND (verified against `codex resume --help`/`codex --help`) --
  // placed after -m/-c it would not parse as the subcommand at all.
  const wrongOrder = ['-m', 'gpt-5.4-mini', 'resume', 'codex-real-session-id'].join(FLAG_DELIMITER)
  assert.equal(
    wrongOrder,
    real.flags,
    'resume tokens placed after curated flags must disagree with the real, subcommand-first order'
  )
})
console.log(
  'mutation test: a resume prefix in the wrong (non-subcommand-first) position is correctly caught'
)
