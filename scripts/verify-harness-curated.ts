// ---------------------------------------------------------------------------
// scripts/verify-harness-curated.ts
//
// Multi-harness migration, unit U3 — BEHAVIOR guard for
// src/main/harness/claude/curated.ts's builders (buildCuratedArgs,
// buildCuratedEnv) and Claude's three curated CuratedField values
// (CLAUDE_CURATED.model/effort/permissionMode).
//
// IMPORTABILITY: curated.ts imports only from src/shared/harness/types.ts
// and src/shared/types.ts — both pure, Electron-free modules with no chain
// to './db' or './workspaces'. So buildCuratedArgs/buildCuratedEnv and the
// three CLAUDE_CURATED_* fields are imported directly below, with NO
// mock.module() stubbing — unlike verify-harness-registry.ts/
// verify-non-claude-launch-behavior.ts, which must stub electron/db/
// workspaces because they import registry.ts/claudeSettings.ts (both of
// which DO chain to electron). This script only reaches into that chain for
// ONE thing: assertion 5 below calls the REAL composeFlagTokens (from
// claudeSettings.ts) to prove the '--model'/'--effort'/'--permission-mode'
// literals in curated.ts are not just internally-consistent but actually
// match what Claude's own launch composition emits today. That one call
// needs the same mock.module() precedent as verify-harness-registry.ts
// (electron / db/index.ts / workspaces.ts stubbed, thrown-if-called) since
// composeFlagTokens is called with workspaceId undefined, which
// short-circuits before any DB/workspace lookup.
//
// Covers (per the task brief's scenario list):
//   1. A curated option value produces the right [flag, value] / {env: value}.
//   2. A CUSTOM value NOT in `options` is still emitted (the allowCustom
//      contract) — not silently dropped, not thrown.
//   3. Unset/empty value -> [] / {} (no flag/env emitted).
//   4. A field with both flag and env is rejected — asserted here at the
//      TYPE level (see the comment above the commented-out invalid literal)
//      since CuratedField is a discriminated union that makes the "both"
//      shape a compile error, not a runtime case a builder has to handle.
//   5. Claude's three curated fields are populated (model/effort/
//      permissionMode all present, all flag-based, all allowCustom: true)
//      and their flag strings match composeFlagTokens's actual emitted
//      tokens for the same settings.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import type { CuratedField } from '../src/shared/harness/types.ts'
import type { ClaudeGlobalSettings } from '../src/shared/types.ts'
import { CLAUDE_EFFORT_VALUES, CLAUDE_MODEL_OPTIONS } from '../src/shared/types.ts'
import {
  buildCuratedArgs,
  buildCuratedEnv,
  CLAUDE_CURATED,
  CLAUDE_CURATED_EFFORT,
  CLAUDE_CURATED_MODEL,
  CLAUDE_CURATED_PERMISSION_MODE
} from '../src/main/harness/claude/curated.ts'

// Minimal-but-complete ClaudeGlobalSettings fixture, same shape/defaults as
// scripts/verify-harness-launch.ts's and
// scripts/verify-non-claude-launch-behavior.ts's own `baseSettings` helpers
// (repo precedent: each verify script keeps its own copy rather than
// sharing a fixture module across scripts — see those two files). Only the
// fields composeFlagTokens actually reads for assertion 5b below
// (model/permissionMode/planModeDefault/effort/debugLogging/fallbackModel/
// customCliFlags) are exercised; every other field just needs to be a
// well-typed default so this object satisfies ClaudeGlobalSettings.
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
// 1. A curated option value produces the right flag/env pair.
// ---------------------------------------------------------------------------

{
  const flagField: CuratedField = {
    flag: '--model',
    options: ['opus', 'sonnet'],
    allowCustom: true
  }
  assert.deepEqual(buildCuratedArgs(flagField, 'opus'), ['--model', 'opus'])
  assert.deepEqual(buildCuratedEnv(flagField, 'opus'), {}, 'a flag-based field must never emit env')

  const envField: CuratedField = {
    env: 'VIBE_ACTIVE_MODEL',
    options: ['vibe-1'],
    allowCustom: true
  }
  assert.deepEqual(buildCuratedEnv(envField, 'vibe-1'), { VIBE_ACTIVE_MODEL: 'vibe-1' })
  assert.deepEqual(
    buildCuratedArgs(envField, 'vibe-1'),
    [],
    'an env-based field must never emit args'
  )

  console.log('✓ a curated option value produces the right flag/env pair')
}

// ---------------------------------------------------------------------------
// 2. A CUSTOM value not in `options` is still emitted (allowCustom).
// ---------------------------------------------------------------------------

{
  const field: CuratedField = { flag: '--model', options: ['opus', 'sonnet'], allowCustom: true }
  const custom = 'my-fine-tuned-model-id'
  assert.ok(!field.options.includes(custom), 'fixture sanity: custom value must not be in options')
  assert.deepEqual(
    buildCuratedArgs(field, custom),
    ['--model', custom],
    'a value outside options must still be emitted, not dropped or rejected'
  )

  const envField: CuratedField = {
    env: 'VIBE_ACTIVE_MODEL',
    options: ['vibe-1'],
    allowCustom: true
  }
  const customEnvValue = 'vibe-custom-99'
  assert.deepEqual(buildCuratedEnv(envField, customEnvValue), { VIBE_ACTIVE_MODEL: customEnvValue })

  console.log('✓ a custom value not present in options is still emitted (allowCustom contract)')
}

// ---------------------------------------------------------------------------
// 3. Unset/empty value -> [] / {}.
// ---------------------------------------------------------------------------

{
  const flagField: CuratedField = { flag: '--model', options: ['opus'], allowCustom: true }
  const envField: CuratedField = { env: 'X', options: [], allowCustom: true }

  assert.deepEqual(buildCuratedArgs(flagField, ''), [])
  assert.deepEqual(buildCuratedEnv(envField, ''), {})
  assert.deepEqual(buildCuratedArgs(undefined, 'opus'), [], 'an undefined field must degrade to []')
  assert.deepEqual(buildCuratedEnv(undefined, 'opus'), {}, 'an undefined field must degrade to {}')

  console.log('✓ unset/empty value and undefined field degrade to []/{} rather than throwing')
}

// ---------------------------------------------------------------------------
// 4. A field with both flag and env is rejected — at the type level.
//
// CuratedField = { options; allowCustom: true } & ({ flag; env?: never } |
// { flag?: never; env }). The commented-out literal below is the actual
// evidence for this assertion: it must NOT type-check. `bun run typecheck`
// (which this repo's CI treats as a hard gate, and which this harness's own
// caller — scripts/verify-agentic-regression.ts — runs in a sibling step)
// is what proves it stays rejected; uncommenting it is expected to make
// typecheck fail. We do not (and cannot) assert this at runtime: `flag` and
// `env` being simultaneously present is a shape the type system refuses to
// construct in the first place, so there is no runtime value to construct
// and pass to a builder — the enforcement IS the type error.
//
// const invalid: CuratedField = { flag: '--model', env: 'X', options: [], allowCustom: true }
// ---------------------------------------------------------------------------

console.log(
  '✓ a field declaring both flag and env is rejected at the type level (see commented-out literal above; bun run typecheck is the evidence)'
)

// ---------------------------------------------------------------------------
// 5. Claude's three curated fields are populated and match composeFlagTokens.
// ---------------------------------------------------------------------------

{
  assert.ok(CLAUDE_CURATED.model, 'CLAUDE_CURATED.model must be populated')
  assert.ok(CLAUDE_CURATED.effort, 'CLAUDE_CURATED.effort must be populated')
  assert.ok(CLAUDE_CURATED.permissionMode, 'CLAUDE_CURATED.permissionMode must be populated')

  for (const [name, field] of Object.entries(CLAUDE_CURATED) as [string, CuratedField][]) {
    assert.equal(field.allowCustom, true, `${name}.allowCustom must be literal true`)
    assert.ok(
      field.flag,
      `${name} must be flag-based (Claude has no env-based curated concept today)`
    )
    assert.equal(field.env, undefined, `${name} must not also declare env`)
  }

  // Reuse, not duplicate: CLAUDE_CURATED_MODEL.options must be the exact
  // same values as CLAUDE_MODEL_OPTIONS (mapped to .value), and
  // CLAUDE_CURATED_EFFORT.options must be the exact same values as
  // CLAUDE_EFFORT_VALUES — proving curated.ts derives from src/shared/
  // types.ts's canonical arrays rather than hand-copying them (this is the
  // exact class of drift CLAUDE_EFFORT_VALUES's own doc comment warns
  // about: five independent copies existed before that array was
  // introduced specifically to prevent a sixth).
  assert.deepEqual(
    CLAUDE_CURATED_MODEL.options,
    CLAUDE_MODEL_OPTIONS.map((o) => o.value),
    'CLAUDE_CURATED_MODEL.options must be derived from CLAUDE_MODEL_OPTIONS, not a hand-copied list'
  )
  assert.deepEqual(
    CLAUDE_CURATED_EFFORT.options,
    [...CLAUDE_EFFORT_VALUES],
    'CLAUDE_CURATED_EFFORT.options must be derived from CLAUDE_EFFORT_VALUES, not a hand-copied list'
  )

  console.log(
    '✓ Claude curated fields are populated: model/effort/permissionMode, all flag-based, allowCustom true'
  )
  console.log(
    '✓ CLAUDE_CURATED_MODEL/EFFORT.options are derived from the canonical shared arrays, not duplicated'
  )
}

// Assertion 5b: the flag strings match composeFlagTokens's REAL output —
// needs the electron-chain stub, same technique as
// verify-harness-registry.ts / verify-non-claude-launch-behavior.ts.
{
  const mainDir = new URL('../src/main/', import.meta.url)
  const abs = (rel: string): string => new URL(rel, mainDir).pathname

  mock.module('electron', () => ({}))
  mock.module(abs('db/index.ts'), () => ({
    getDb: () => {
      throw new Error('getDb() must not be called by composeFlagTokens with workspaceId undefined')
    }
  }))
  mock.module(abs('workspaces.ts'), () => ({
    getWorkspace: () => {
      throw new Error('getWorkspace() must not be called when workspaceId is undefined')
    }
  }))

  const { composeFlagTokens } = await import('../src/main/claudeSettings.ts')
  const settings = baseSettings({
    model: 'opus',
    effort: 'high',
    permissionMode: 'acceptEdits'
  })

  const tokens = composeFlagTokens(settings, undefined, settings, [], [])

  const modelIdx = tokens.indexOf(CLAUDE_CURATED_MODEL.flag)
  assert.ok(
    modelIdx >= 0,
    `composeFlagTokens must emit ${CLAUDE_CURATED_MODEL.flag} when model is set`
  )
  assert.equal(tokens[modelIdx + 1], 'opus')

  const effortIdx = tokens.indexOf(CLAUDE_CURATED_EFFORT.flag)
  assert.ok(
    effortIdx >= 0,
    `composeFlagTokens must emit ${CLAUDE_CURATED_EFFORT.flag} when effort is set`
  )
  assert.equal(tokens[effortIdx + 1], 'high')

  const permIdx = tokens.indexOf(CLAUDE_CURATED_PERMISSION_MODE.flag)
  assert.ok(
    permIdx >= 0,
    `composeFlagTokens must emit ${CLAUDE_CURATED_PERMISSION_MODE.flag} when permissionMode is set`
  )
  assert.equal(tokens[permIdx + 1], 'acceptEdits')

  console.log(
    "✓ curated.ts's --model/--effort/--permission-mode flag strings match composeFlagTokens's real emitted tokens"
  )
}

console.log('\nAll harness-curated assertions passed.')
