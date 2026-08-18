// ---------------------------------------------------------------------------
// scripts/verify-non-claude-launch-behavior.ts
//
// Phase 0 (multi-harness migration) BEHAVIOR guard for P0.3 + P0.4 —
// deliberately NOT a source-grep. It asserts, against the actual
// production functions (not restated copies), that for a workspace whose
// stored model is NOT a Claude model:
//
//   P0.3 — composeFlagTokens (src/main/claudeSettings.ts) omits --model
//          rather than passing the non-Claude id straight through to the
//          `claude` binary.
//   P0.4 — buildAuthEnvForRow / buildAnthropicEnv (src/main/claudeAuth.ts)
//          still produce a real Anthropic auth env for cloud_provider
//          'routed' (the branch that a non-Claude model implies today),
//          so the workspace can still launch authenticated against
//          api.anthropic.com now that launch-side routing is severed.
//
// Composed together, this proves the end state CLAUDE.md's task asked for:
// a non-Claude-model workspace's launch env contains NO localhost
// ANTHROPIC_BASE_URL (nothing routes it to a local proxy) AND DOES contain
// the Anthropic auth layer (it can still authenticate directly).
//
// Both composeFlagTokens and buildAuthEnvForRow/buildAnthropicEnv are pure
// (row/settings in, tokens/env out — no DB, no electron API call) in their
// OWN bodies for the call shapes exercised below (composeFlagTokens is
// called with workspaceId undefined, which short-circuits before
// getWorkspace()/getDb(); buildAuthEnvForRow/buildAnthropicEnv take a Row
// directly and never call getDb() themselves — only the outer
// getClaudeAuthEnv() does). But claudeSettings.ts and claudeAuth.ts both
// STATICALLY import './db' (which statically imports electron's `app`),
// and claudeSettings.ts also statically imports './workspaces' (which
// statically imports electron's `BrowserWindow`) — so merely loading these
// modules under plain `bun run` fails at link time outside Electron. This
// script follows scripts/verify-project-add.ts's precedent: mock.module()
// the handful of modules that reach electron before dynamically importing
// the modules under test, so the *functions* run for real while only the
// unreachable electron surface is stubbed. The full integration point
// (buildMountEnv in orpheusSurfaceAdapter.ts) imports electron + the native
// addon and cannot be called this way even with mocking — see
// verify-runtime-main-integration.ts's source-level guard for that seam.
// What remains genuinely uncovered by this script: buildMountEnv's own
// merge order (composeFlagTokens's tokens -> ORPHEUS_CLAUDE_FLAGS,
// buildAuthEnvForRow's env -> ...authEnv spread) is exercised only via
// source-text assertions elsewhere, not executed end-to-end here.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import type { ClaudeGlobalSettings } from '../src/shared/types.ts'
// Type-only import — erased at compile time, so it does NOT trigger the
// electron-chain module load the value imports below need mock.module()
// for. Safe to keep static.
import type { Row } from '../src/main/claudeAuth.ts'

// Module specifiers exactly as claudeSettings.ts/claudeAuth.ts import them,
// resolved to absolute paths so mock.module() doesn't depend on this
// script's own location relative to src/main (same technique as
// verify-project-add.ts).
const mainDir = new URL('../src/main/', import.meta.url)
const abs = (rel: string): string => new URL(rel, mainDir).pathname

// Static imports hoist, so mock.module() must run BEFORE the dynamic
// import()s below pull in claudeSettings.ts/claudeAuth.ts, or the real
// './db' (-> electron `app`) and './workspaces' (-> electron
// `BrowserWindow`) load first and this script dies at link time exactly as
// it did before this fix. Neither composeFlagTokens (workspaceId
// undefined) nor buildAuthEnvForRow/buildAnthropicEnv (Row in, env out)
// call getDb()/getWorkspace() on the paths this script exercises, so the
// stub bodies below are never invoked — they exist only to satisfy the
// module linker.
mock.module('electron', () => ({}))
mock.module(abs('db/index.ts'), () => ({
  getDb: () => {
    throw new Error('getDb() must not be called by composeFlagTokens/buildAuthEnvForRow')
  }
}))
mock.module(abs('workspaces.ts'), () => ({
  getWorkspace: () => {
    throw new Error('getWorkspace() must not be called when workspaceId is undefined')
  }
}))

const { composeFlagTokens } = await import('../src/main/claudeSettings.ts')
const { buildAuthEnvForRow, buildAnthropicEnv } = await import('../src/main/claudeAuth.ts')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A complete, inert ClaudeGlobalSettings — every field explicit so
// `bun run typecheck` catches drift if the shared type ever adds a
// required field this fixture doesn't know about.
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

function authRow(overrides: Partial<Row> = {}): Row {
  const defaults: Row = {
    cloud_provider: 'anthropic',
    auth_api_key: '',
    auth_token: '',
    auth_base_url: '',
    auth_aws_region: '',
    auth_vertex_project_id: '',
    auth_vertex_region: '',
    auth_foundry_api_key: '',
    auth_foundry_resource: '',
    auth_foundry_base_url: '',
    auth_bedrock_bearer_token: ''
  }
  return { ...defaults, ...overrides }
}

// ---------------------------------------------------------------------------
// P0.3 — composeFlagTokens omits --model for a non-Claude model, but still
// passes it for a Claude model (both explicit id and alias).
// ---------------------------------------------------------------------------

{
  const nonClaudeSettings = baseSettings({ model: 'gpt-5.1-codex' })
  // workspaceId undefined -> pushSessionContinuityFlags early-returns before
  // touching getWorkspace()/getDb(), keeping this call DB-free.
  const tokens = composeFlagTokens(nonClaudeSettings, undefined, nonClaudeSettings, [], [])
  assert.equal(
    tokens.includes('--model'),
    false,
    'a non-Claude model must NOT produce a --model flag (P0.3)'
  )
  console.log('✓ composeFlagTokens omits --model for a non-Claude model (gpt-5.1-codex)')

  for (const claudeModel of ['sonnet', 'claude-opus-4-8']) {
    const claudeSettings = baseSettings({ model: claudeModel })
    const claudeTokens = composeFlagTokens(claudeSettings, undefined, claudeSettings, [], [])
    const modelFlagIndex = claudeTokens.indexOf('--model')
    assert.ok(modelFlagIndex >= 0, `Claude model '${claudeModel}' must still get --model`)
    assert.equal(claudeTokens[modelFlagIndex + 1], claudeModel)
  }
  console.log('✓ composeFlagTokens still passes --model for Claude models (regression guard)')

  // Empty model ('' == claude's own default) must stay silent — no --model,
  // no warning path taken (isClaude has no empty-string guard, which is why
  // composeFlagTokens's own guard is written as `s.model && !isClaude(...)`).
  const emptyModelSettings = baseSettings({ model: '' })
  const emptyTokens = composeFlagTokens(emptyModelSettings, undefined, emptyModelSettings, [], [])
  assert.equal(emptyTokens.includes('--model'), false)
  console.log(
    '✓ composeFlagTokens omits --model for the empty-string default (unaffected by the guard)'
  )
}

// ---------------------------------------------------------------------------
// P0.4 — a 'routed' cloud_provider row still produces the SAME real
// Anthropic auth env as the plain 'anthropic' provider — not {} (the
// pre-P0.4 bug) and not a routing-proxy overlay (severed in Phase 0).
// ---------------------------------------------------------------------------

{
  const routedRow = authRow({
    cloud_provider: 'routed',
    auth_api_key: 'sk-ant-real-key',
    auth_base_url: 'https://api.anthropic.com'
  })
  const routedEnv = buildAuthEnvForRow(routedRow)

  assert.equal(
    routedEnv['ANTHROPIC_API_KEY'],
    'sk-ant-real-key',
    "cloud_provider 'routed' must still emit the user's real ANTHROPIC_API_KEY (P0.4)"
  )
  assert.deepEqual(
    routedEnv,
    buildAnthropicEnv(routedRow),
    "cloud_provider 'routed' must produce EXACTLY buildAnthropicEnv's output — no separate routed-only env shape"
  )
  console.log(
    "✓ buildAuthEnvForRow(cloud_provider: 'routed') falls through to real Anthropic auth (P0.4)"
  )

  // The composed behavior CLAUDE.md's task asked for: no localhost
  // ANTHROPIC_BASE_URL, and the Anthropic auth layer present. A localhost
  // base URL would only ever have been injected by the now-deleted routing
  // overlay (computeRoutingEnv -> getRoutingProxyUrl(), a 127.0.0.1 URL) —
  // buildAuthEnvForRow itself only ever forwards the user's OWN
  // auth_base_url, so this doubles as a guard against a stored
  // auth_base_url accidentally being a loopback address in this fixture.
  assert.equal(
    /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(routedEnv['ANTHROPIC_BASE_URL'] ?? ''),
    false,
    'a routed workspace auth env must not point at a localhost proxy URL'
  )
  assert.ok(
    'ANTHROPIC_API_KEY' in routedEnv || 'ANTHROPIC_AUTH_TOKEN' in routedEnv,
    'a routed workspace auth env must contain the Anthropic auth layer'
  )
  console.log(
    '✓ end state: routed-model launch env has NO localhost ANTHROPIC_BASE_URL and DOES have Anthropic auth'
  )

  // Regression guard for the exact bug P0.4 fixed: 'routed' must NOT
  // collapse to an auth-free {} the way it did before this fix (which would
  // launch `claude` completely unauthenticated).
  assert.notDeepEqual(routedEnv, {}, "cloud_provider 'routed' must never resolve to an empty env")
  console.log("✓ regression guard: cloud_provider 'routed' no longer resolves to {} (pre-P0.4 bug)")

  // Branch selection: 'routed' produces the SAME env as plain 'anthropic'
  // for an identical row (modulo cloud_provider itself) — proving the
  // fallthrough, not a coincidentally-similar parallel implementation.
  const anthropicRow = authRow({
    cloud_provider: 'anthropic',
    auth_api_key: 'sk-ant-real-key',
    auth_base_url: 'https://api.anthropic.com'
  })
  assert.deepEqual(buildAuthEnvForRow(routedRow), buildAuthEnvForRow(anthropicRow))
  console.log(
    "✓ 'routed' and 'anthropic' cloud_provider rows produce byte-for-byte identical auth env for identical auth fields"
  )
}

console.log('\nAll non-Claude launch behavior assertions passed.')
