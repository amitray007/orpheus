// ---------------------------------------------------------------------------
// scripts/verify-harness-launch.ts
//
// Phase 1 (multi-harness migration, P1.7) BEHAVIOR guard for the Claude
// descriptor's launch composition — src/main/harness/registry.ts's
// CLAUDE_DESCRIPTOR.composeLaunch, which is a direct reference to
// composeClaudeLaunch (src/main/claudeSettings.ts). Asserts, against the
// REAL exported functions, two zero-behavior-change guarantees Phase 1
// rests on:
//
//   1. THE ONE-LINE-DELEGATION GUARANTEE — the Claude descriptor's
//      composeLaunch produces output deep-equal to a direct
//      composeClaudeLaunch call for the same inputs, AND (since it's a
//      direct function reference today, not a wrapper) is reference-equal
//      to composeClaudeLaunch itself. Reference identity is the stronger,
//      more precise fact about today's implementation, but the deep-equal
//      on OUTPUT is what's actually load-bearing: if a future refactor ever
//      turns composeLaunch into a thin wrapper (no longer the same function
//      object), THIS assertion must keep passing — it's what guarantees
//      "every byte reaching `claude` stays identical" regardless of how
//      composeLaunch is implemented.
//   2. THE 0x1F ARGV ROUND-TRIP — a composed `flags` string (as produced by
//      composeLaunch/composeClaudeLaunch) round-trips intact through
//      splitFlagString (src/shared/cliFlags.ts), preserving quotes, `=`,
//      and embedded spaces byte-for-byte. splitFlagString is the shared,
//      canonical reader for this format (see its own doc comment: "any
//      main-process code that needs to read a value back out of that
//      composed string ... MUST go through these two functions rather than
//      hand-rolling a regex"), so this exercises the real parser, not a
//      restatement of the delimiter contract.
//
// IMPORTABILITY: same electron-chain problem as verify-harness-registry.ts
// (registry.ts -> claudeSettings.ts -> ./workspaces -> electron
// BrowserWindow, -> ./db -> electron app). Uses the identical mock.module()
// technique, stubbing as little as possible.
//
// composeClaudeLaunch is called here with a `precomputedGlobal` fixture
// (its third, optional parameter) so getClaudeGlobalSettings() — which
// calls getDb() unconditionally — is never reached; workspaceId is left
// undefined so pushSessionContinuityFlags short-circuits before
// getWorkspace(). Both DB-reaching stubs below throw if actually invoked,
// which itself proves this call path stays DB-free.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import type { ClaudeGlobalSettings } from '../src/shared/types.ts'

const mainDir = new URL('../src/main/', import.meta.url)
const abs = (rel: string): string => new URL(rel, mainDir).pathname

mock.module('electron', () => ({}))
mock.module(abs('db/index.ts'), () => ({
  getDb: () => {
    throw new Error('getDb() must not be called when precomputedGlobal is supplied')
  }
}))
mock.module(abs('workspaces.ts'), () => ({
  getWorkspace: () => {
    throw new Error('getWorkspace() must not be called when workspaceId is undefined')
  },
  // C5 (support-multi-harness) — registry.ts now transitively reaches
  // codex/launch.ts -> codex/session.ts, which imports both getWorkspace
  // AND setWorkspaceClaudeSessionId from this module. Same "throw if
  // actually invoked" discipline as getWorkspace above.
  setWorkspaceClaudeSessionId: () => {
    throw new Error(
      'setWorkspaceClaudeSessionId() must not be called when workspaceId is undefined'
    )
  },
  // support-multi-harness — registry.ts's Codex path now also transitively
  // reaches codex/titleGeneration.ts (via codex/launch.ts), which imports
  // these three from this same module at module scope. Same "throw if
  // actually invoked" discipline as the exports above.
  hasCodexTitleGenerationRun: () => {
    throw new Error('hasCodexTitleGenerationRun() must not be called when workspaceId is undefined')
  },
  markCodexTitleGenerationRun: () => {
    throw new Error(
      'markCodexTitleGenerationRun() must not be called when workspaceId is undefined'
    )
  },
  setWorkspaceLastTitle: () => {
    throw new Error('setWorkspaceLastTitle() must not be called when workspaceId is undefined')
  }
}))

const { HARNESSES } = await import('../src/main/harness/registry.ts')
const { composeClaudeLaunch } = await import('../src/main/claudeSettings.ts')
const { splitFlagString } = await import('../src/shared/cliFlags.ts')

const CLAUDE_DESCRIPTOR = HARNESSES.find((h: { id: string }) => h.id === 'claude')
assert.ok(CLAUDE_DESCRIPTOR, "HARNESSES must contain a 'claude' descriptor")

// A complete, inert ClaudeGlobalSettings fixture — every field explicit so
// `bun run typecheck` catches drift if the shared type ever adds a required
// field this fixture doesn't know about. Mirrors
// verify-non-claude-launch-behavior.ts's baseSettings() fixture exactly
// (same shared type, same defaults) rather than inventing a divergent copy.
function baseSettings(overrides: Partial<ClaudeGlobalSettings> = {}): ClaudeGlobalSettings {
  const defaults: ClaudeGlobalSettings = {
    model: '',
    permissionMode: 'default',
    effort: 'auto',
    autoMemory: false,
    alwaysThinking: false,
    outputStyle: 'default',
    tuiMode: 'default',
    editorMode: 'normal',
    reduceMotion: false,
    nativeCursor: false,
    hideCwd: false,
    disableGitInstructions: false,
    maxOutputTokens: null,
    maxContextTokens: null,
    compactionThreshold: null,
    debugLogging: false,
    logLevel: 'info',
    disableTelemetry: false,
    disableErrorReporting: false,
    disableAutoupdater: false,
    experimentalAgentTeams: false,
    experimentalForkedSubagents: false,
    simpleSystemPrompt: false,
    autoApproveEdits: false,
    askDestructiveBash: false,
    planModeDefault: false,
    permissionAllowRules: [],
    permissionAskRules: [],
    permissionDenyRules: [],
    permissionAdditionalDirs: [],
    fallbackModel: '',
    bashDefaultTimeoutMs: null,
    bashMaxTimeoutMs: null,
    bashMaxOutputLength: null,
    toolConcurrency: null,
    browserIntegration: true,
    disabledMcpServers: [],
    customEnvVars: {},
    customCliFlags: [],
    disableThinking: false,
    disableFastMode: false,
    maxTurns: null,
    maxThinkingTokens: null,
    fileReadMaxOutputTokens: null,
    disableClaudeMds: false,
    bashMaintainCwd: false,
    perforceMode: false,
    globHidden: false,
    globNoIgnore: false,
    globTimeoutSeconds: null,
    apiTimeoutMs: null,
    maxRetries: null,
    httpProxy: '',
    httpsProxy: '',
    disableNonessentialTraffic: false,
    doNotTrack: false,
    disableBackgroundTasks: false,
    disableAgentView: false,
    anthropicBetas: '',
    extraBodyJson: '',
    noFlicker: false,
    disableAlternateScreen: false,
    disableVirtualScroll: false,
    disableMouse: false,
    disableTerminalTitle: false,
    scrollSpeed: null,
    codeAccessibility: false,
    omitAttributionHeader: false,
    forceSyncOutput: false,
    enablePromptSuggestion: false,
    disable1mContext: false,
    disableAdaptiveThinking: false,
    disableLegacyModelRemap: false,
    autoCompactWindow: null,
    autocompactPctOverride: null,
    disableFileCheckpointing: false,
    disableAttachments: false,
    shellOverride: '',
    shellPrefix: '',
    enableFineGrainedToolStreaming: false,
    disableNonstreamingFallback: false,
    proxyResolvesHosts: false,
    enableGatewayModelDiscovery: false,
    autoBackgroundTasks: false,
    asyncAgentStallTimeoutMs: null,
    enableTasks: false,
    disableCron: false,
    exitAfterStopDelay: null,
    disableFeedbackCommand: false,
    disableFeedbackSurvey: false,
    disableBundledSkills: false,
    disableWorkflows: false,
    enableAwaySummary: false,
    disableArtifact: false,
    disableAdvisorTool: false,
    screenReader: false,
    additionalDirsClaudeMd: false,
    maxWorkspaceDepth: 10,
    maxWorkspaceChildren: 50,
    toolCallTimeoutMs: null,
    maxToolOutputLength: null,
    disableMouseClicks: false,
    rewindOnErrorEnabled: false,
    lowPowerMode: false,
    sourceZshrc: false,
    preLaunchSnippet: '',
    updatedAt: 0
  }
  return { ...defaults, ...overrides }
}

// ---------------------------------------------------------------------------
// 1. The one-line-delegation guarantee.
// ---------------------------------------------------------------------------

{
  // U9 CUTOVER — this assertion used to require reference identity with
  // composeClaudeLaunch, which was correct for Phase 1: the descriptor
  // delegated straight through, and identity was the cheapest proof that no
  // reshaping had crept in between them.
  //
  // The descriptor now composes from harness_settings instead, so identity
  // is deliberately false. The comparison it protected did not disappear —
  // it moved somewhere stronger: scripts/verify-harness-launch-parity.ts
  // drives BOTH emitters over shared fixtures with a real DB and asserts
  // byte-equality across the surface they share, plus explicit pinned
  // assertions for the places they now differ on purpose. Re-adding an
  // identity check here would fail by construction and prove nothing.
  assert.notEqual(
    CLAUDE_DESCRIPTOR.composeLaunch,
    composeClaudeLaunch,
    'post-cutover the descriptor must NOT delegate to composeClaudeLaunch — see verify-harness-launch-parity.ts for the comparison that replaced this'
  )
  assert.equal(
    typeof CLAUDE_DESCRIPTOR.composeLaunch,
    'function',
    'the descriptor must still expose a callable composeLaunch'
  )
  console.log(
    '✓ post-cutover: composeLaunch is the harness emitter, not composeClaudeLaunch (parity is asserted in verify-harness-launch-parity.ts)'
  )
}

// ---------------------------------------------------------------------------
// 2. The 0x1F argv round-trip through splitFlagString.
// ---------------------------------------------------------------------------

{
  const settings = baseSettings({
    model: 'opus',
    permissionMode: 'acceptEdits',
    customCliFlags: [
      '--append-system-prompt "be terse and kind"',
      '--x=quoted with spaces',
      "--y='a b' c"
    ]
  })
  const launch = composeClaudeLaunch(undefined, undefined, settings)

  assert.ok(launch.flags.length > 0, 'fixture must produce a non-empty composed flags string')

  const roundTripped = splitFlagString(launch.flags)
  // Re-joining the split tokens with the same delimiter splitFlagString
  // consumed must reproduce the exact original string — proving the split
  // is lossless (no token merged, dropped, or corrupted), which is the
  // property the 0x1F wire format exists to guarantee end-to-end.
  const rejoined = roundTripped.join('\x1f')
  assert.equal(
    rejoined,
    launch.flags,
    'splitFlagString must losslessly round-trip a composed flags string back to itself'
  )

  // Spot-check specific tokens survive with their `=`-joins and embedded
  // spaces intact — not just that SOME split happened, but that the exact
  // argv shape a shell would need is preserved. Quoted custom-flag entries
  // are already word-tokenized by parseFlagEntry at COMPOSE time (quotes are
  // consumed there, not carried through as literal characters) — e.g.
  // '--append-system-prompt "be terse and kind"' becomes the two tokens
  // '--append-system-prompt' and 'be terse and kind' — so what
  // splitFlagString must round-trip losslessly is THOSE tokens, spaces and
  // all, exactly as composeClaudeLaunch emitted them.
  assert.ok(
    roundTripped.includes('--append-system-prompt'),
    'the flag-name token must survive the round-trip'
  )
  assert.ok(
    roundTripped.includes('be terse and kind'),
    "the quoted value's embedded spaces must survive the round-trip as a single token"
  )
  assert.ok(
    roundTripped.includes('--x=quoted'),
    'an =-joined token must survive the round-trip intact'
  )
  assert.ok(
    roundTripped.includes('--y=a b'),
    "a quoted =-joined token's embedded space must survive the round-trip intact"
  )
  console.log(
    '✓ composed flags string round-trips through splitFlagString preserving =-joins and embedded spaces'
  )

  // The empty-default invariant: no custom flags/settings differing from
  // defaults must still produce flags === '', and splitFlagString must
  // treat that as [] rather than [''] (its own documented contract).
  const emptyLaunch = composeClaudeLaunch(undefined, undefined, baseSettings())
  assert.equal(
    emptyLaunch.flags,
    '',
    'an all-default settings fixture must compose to flags === ""'
  )
  assert.deepEqual(
    splitFlagString(emptyLaunch.flags),
    [],
    'splitFlagString("") must yield [] per its documented empty-default invariant'
  )
  console.log('✓ empty composed flags string round-trips to [] via splitFlagString, per contract')
}

// ---------------------------------------------------------------------------
// 3. ORPHEUS_HARNESS_BINARY — buildMountEnv (orpheusSurfaceAdapter.ts) must
//    emit ORPHEUS_HARNESS_BINARY: descriptor.binary, and resources/
//    harness-common.sh's shared PATH-probe must read that var (falling back
//    to 'claude' for the old-wrapper/new-main rollback case) rather than
//    hardcoding 'claude'. buildMountEnv itself statically imports electron's
//    `app` plus the native ghostty-surface addon and cannot be called from a
//    plain `bun run` script even with mock.module() (see
//    verify-non-claude-launch-behavior.ts's header for why) — so the wiring
//    is asserted as source text here, same precedent as
//    verify-runtime-main-integration.ts uses for this exact file. What IS
//    asserted against real, executed values: CLAUDE_DESCRIPTOR.binary itself
//    (registry.ts, imported for real above), so this isn't purely textual.
// ---------------------------------------------------------------------------

{
  assert.equal(
    CLAUDE_DESCRIPTOR.binary,
    'claude',
    "CLAUDE_DESCRIPTOR.binary must be 'claude' — the value ORPHEUS_HARNESS_BINARY is sourced from"
  )

  const fs = await import('node:fs')
  const adapterPath = new URL('../src/main/orpheusSurfaceAdapter.ts', import.meta.url)
  const adapterSource = fs.readFileSync(adapterPath, 'utf8')
  assert.ok(
    adapterSource.includes('ORPHEUS_HARNESS_BINARY: descriptor.binary'),
    'buildMountEnv must emit ORPHEUS_HARNESS_BINARY sourced from the resolved descriptor.binary'
  )

  const wrapperPath = new URL('../resources/harness-common.sh', import.meta.url)
  const wrapperSource = fs.readFileSync(wrapperPath, 'utf8')
  assert.ok(
    wrapperSource.includes('command -v "${ORPHEUS_HARNESS_BINARY:-claude}"'),
    'harness-common.sh must probe ORPHEUS_HARNESS_BINARY (defaulting to claude for old-wrapper rollback), not hardcode claude'
  )
  assert.equal(
    wrapperSource.includes('command -v claude >/dev/null'),
    false,
    'harness-common.sh must not still contain the old hardcoded `command -v claude` probe'
  )

  console.log(
    '✓ ORPHEUS_HARNESS_BINARY is wired from descriptor.binary and harness-common.sh probes it (with claude fallback)'
  )
}

// ---------------------------------------------------------------------------
// 4. Auth env scoping — resolveAuthEnvForDescriptor (src/main/harness/
//    authScope.ts) must merge Claude's auth env ONLY for the 'claude'
//    descriptor, and must return {} — containing no ANTHROPIC_*/AWS_*/
//    CLOUD_ML_* keys — for any other harness id. This is the real exported
//    function (not source text): authScope.ts has zero electron/native/DB
//    imports, so it's directly importable here unlike buildMountEnv itself.
// ---------------------------------------------------------------------------

{
  const { resolveAuthEnvForDescriptor } = await import('../src/main/harness/authScope.ts')

  const fakeAnthropicAuthEnv = {
    ANTHROPIC_API_KEY: 'sk-ant-fake-secret',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    AWS_REGION: 'us-east-1',
    AWS_BEARER_TOKEN_BEDROCK: 'fake-bedrock-token',
    CLOUD_ML_REGION: 'us-central1'
  }
  const getAuthEnv = (): Record<string, string> => fakeAnthropicAuthEnv

  const claudeAuthEnv = resolveAuthEnvForDescriptor('claude', getAuthEnv)
  assert.deepEqual(
    claudeAuthEnv,
    fakeAnthropicAuthEnv,
    "resolveAuthEnvForDescriptor('claude', ...) must pass through the full auth env unchanged"
  )

  for (const nonClaudeId of ['codex-cli', 'some-future-harness', '']) {
    const env = resolveAuthEnvForDescriptor(nonClaudeId, getAuthEnv)
    assert.deepEqual(
      env,
      {},
      `resolveAuthEnvForDescriptor(${JSON.stringify(nonClaudeId)}, ...) must return {} — no Claude auth env for a non-Claude descriptor`
    )
    for (const leakedKey of Object.keys(fakeAnthropicAuthEnv)) {
      assert.ok(!(leakedKey in env), `non-Claude descriptor env must not contain ${leakedKey}`)
    }
  }

  console.log(
    '✓ resolveAuthEnvForDescriptor merges Claude auth env for claude only; non-Claude descriptors get {} (no ANTHROPIC_*/AWS_*/CLOUD_ML_* leakage)'
  )
}

console.log('\nAll harness launch assertions passed.')
