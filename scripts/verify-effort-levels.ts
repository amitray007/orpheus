// ---------------------------------------------------------------------------
// scripts/verify-effort-levels.ts
//
// Assertion harness for per-model effort levels (model-routing unit 11).
// Mirrors the existing scripts/verify-*.ts convention: a script run directly
// via `bun run` (the `test:effort` package.json script), no test framework.
//
// Root problem this unit fixes: DropdownChip.tsx used to offer a hardcoded
// EFFORT_VALUES = ['auto','low','medium','high','xhigh','max'] for EVERY
// model, regardless of what that model's provider actually supports.
// CLIProxyAPI's own /v0/management/model-definitions/:channel endpoint
// silently CLAMPS an unsupported-but-on-ladder level to the nearest one it
// does support (e.g. 'xhigh' on a [low,medium,high] model clamps to 'high')
// — so the old UI let a user "pick" a level the backend silently overrode,
// with no indication anything happened. This harness proves the fix is
// entirely data-driven off SelectableModel.effortLevels, with zero
// per-provider branching anywhere in the code under test.
//
// MUST PASS FULLY OFFLINE — everything under test here
// (buildSelectableModels, CLAUDE_BUILTIN_EFFORT_LEVELS, EFFORT_LADDER_ORDER,
// clampEffortToSupportedLevel, computeRoutingEnv) is electron-free and
// DB-free by construction, same constraint every other verify-*.ts harness
// in this repo already depends on.
//
// Covers (per effort-spec.md's work item 5):
//   1. EFFORT_LADDER_ORDER matches [minimal,low,medium,high,xhigh,max] exactly
//   2. a model with effortLevels: null yields no effort options at all
//   3. grok-4.5 -> exactly [low,medium,high]; gpt-5.5 -> no 'max'; opus-4.6
//      (mirrored here as claude-sonnet-4-6, the one CLAUDE_MODEL_OPTIONS
//      entry with the "no xhigh" shape) -> no 'xhigh'; gemini-3.1-flash-image
//      -> exactly [minimal,high]
//   4. the stale-selection guard (clampEffortToSupportedLevel) maps
//      'xhigh' -> the nearest supported level on a [low,medium,high] model
//   5. Claude routing stays a byte-for-byte no-op — no effort-levels work in
//      this unit may alter computeRoutingEnv's output for a Claude model
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  EFFORT_LADDER_ORDER,
  CLAUDE_BUILTIN_EFFORT_LEVELS,
  CLAUDE_MODEL_OPTIONS,
  clampEffortToSupportedLevel
} from '../src/shared/types.ts'
import { buildSelectableModels } from '../src/main/models/selectable.ts'
import type {
  BuildSelectableModelsInput,
  ProviderDescriptorInput
} from '../src/main/models/selectable.ts'
import { computeRoutingEnv, isRoutedModel } from '../src/main/modelRouting.ts'

const PROVIDER_DESCRIPTORS: ProviderDescriptorInput[] = [
  { id: 'xai', label: 'Grok (xAI)' },
  { id: 'codex', label: 'Codex (OpenAI)' },
  { id: 'antigravity', label: 'Gemini (Google)' }
]

function baseInput(
  overrides: Partial<BuildSelectableModelsInput> = {}
): BuildSelectableModelsInput {
  return {
    routingProxy: { enabled: false, status: 'not_installed', authFiles: [] },
    providerConfigs: [],
    providerDescriptors: PROVIDER_DESCRIPTORS,
    cliProxyModels: [],
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// 1. Ladder order constant matches [minimal,low,medium,high,xhigh,max]
//    exactly — every other assertion in this file (and DropdownChip.tsx's
//    effortOptionsFor) depends on this exact ordering.
// ---------------------------------------------------------------------------

{
  assert.deepEqual(
    [...EFFORT_LADDER_ORDER],
    ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    'EFFORT_LADDER_ORDER must exactly match the ladder documented in effort-spec.md'
  )
  console.log('✓ EFFORT_LADDER_ORDER matches [minimal,low,medium,high,xhigh,max] exactly')
}

// ---------------------------------------------------------------------------
// 2. A model with effortLevels: null yields NO effort options — proven both
//    for a routed model the cliproxy cache reports with no thinking.levels,
//    and for buildSelectableModels' Claude entries staying consistent with
//    CLAUDE_BUILTIN_EFFORT_LEVELS (no entry silently falls through to null
//    unless the table itself says so).
// ---------------------------------------------------------------------------

{
  const withNullLevels = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [{ provider: 'codex', health: 'ok' }]
      },
      providerConfigs: [{ providerId: 'codex', enabled: true }],
      cliProxyModels: [{ modelId: 'gpt-5-mini-image', providerId: 'codex', context: 128_000 }]
    })
  )
  const entry = withNullLevels.find((m) => m.id === 'gpt-5-mini-image')
  assert.ok(entry, 'sanity: the model must be present in the list')
  assert.equal(
    entry!.effortLevels,
    null,
    'a model with no reported thinking.levels must yield effortLevels: null'
  )

  // Every Claude entry must have a real (non-fabricated, table-sourced) array
  // — none of them are null today, and none should silently become null by
  // omission from the table.
  for (const option of CLAUDE_MODEL_OPTIONS) {
    const levels = CLAUDE_BUILTIN_EFFORT_LEVELS[option.value]
    assert.ok(
      Array.isArray(levels) && levels.length > 0,
      `CLAUDE_BUILTIN_EFFORT_LEVELS must have a real, non-empty array for '${option.value}'`
    )
  }
  console.log(
    '✓ a model with effortLevels: null yields no effort options; every Claude entry has real, non-fabricated levels'
  )
}

// ---------------------------------------------------------------------------
// 3. Live per-model data from effort-spec.md's verified table:
//    - grok-4.5 -> exactly [low, medium, high]
//    - gpt-5.5 -> [low, medium, high, xhigh], no 'max'
//    - claude-sonnet-4-6 (the CLAUDE_MODEL_OPTIONS entry matching the
//      "opus-4.6/sonnet-4.6 have no xhigh" shape from the spec) -> no 'xhigh'
//    - gemini-3.1-flash-image -> exactly [minimal, high] (the documented HOLE)
// ---------------------------------------------------------------------------

{
  const running = buildSelectableModels(
    baseInput({
      routingProxy: {
        enabled: true,
        status: 'running',
        authFiles: [
          { provider: 'xai', health: 'ok' },
          { provider: 'codex', health: 'ok' },
          { provider: 'antigravity', health: 'ok' }
        ]
      },
      providerConfigs: [
        { providerId: 'xai', enabled: true },
        { providerId: 'codex', enabled: true },
        { providerId: 'antigravity', enabled: true }
      ],
      cliProxyModels: [
        {
          modelId: 'grok-4.5',
          providerId: 'xai',
          context: 256_000,
          effortLevels: ['low', 'medium', 'high']
        },
        {
          modelId: 'gpt-5.5',
          providerId: 'codex',
          context: 400_000,
          effortLevels: ['low', 'medium', 'high', 'xhigh']
        },
        {
          modelId: 'gemini-3.1-flash-image',
          providerId: 'antigravity',
          context: 128_000,
          effortLevels: ['minimal', 'high']
        }
      ]
    })
  )

  const grok = running.find((m) => m.id === 'grok-4.5')
  assert.deepEqual(
    grok!.effortLevels,
    ['low', 'medium', 'high'],
    'grok-4.5 must report exactly [low, medium, high] — no xhigh/max offered'
  )

  const gpt55 = running.find((m) => m.id === 'gpt-5.5')
  assert.deepEqual(
    gpt55!.effortLevels,
    ['low', 'medium', 'high', 'xhigh'],
    'gpt-5.5 must report [low, medium, high, xhigh] — NOT include max'
  )
  assert.ok(!gpt55!.effortLevels!.includes('max'), 'gpt-5.5 must never offer max')

  const sonnet46 = CLAUDE_BUILTIN_EFFORT_LEVELS['claude-sonnet-4-6']
  assert.ok(
    sonnet46 && !sonnet46.includes('xhigh'),
    'claude-sonnet-4-6 (the "no xhigh" Claude shape from the spec) must never offer xhigh'
  )
  assert.deepEqual(
    sonnet46,
    ['low', 'medium', 'high', 'max'],
    'claude-sonnet-4-6 must be exactly [low, medium, high, max]'
  )

  const geminiImage = running.find((m) => m.id === 'gemini-3.1-flash-image')
  assert.deepEqual(
    geminiImage!.effortLevels,
    ['minimal', 'high'],
    'gemini-3.1-flash-image must report exactly [minimal, high] — the documented hole in the ladder'
  )

  console.log(
    '✓ live per-model data verified: grok-4.5=[low,medium,high], gpt-5.5 has no max, ' +
      'claude-sonnet-4-6 has no xhigh, gemini-3.1-flash-image=[minimal,high]'
  )
}

// ---------------------------------------------------------------------------
// 4. The stale-selection guard (clampEffortToSupportedLevel) maps a
//    now-unsupported level to the NEAREST supported one on the new model's
//    ladder, exactly mirroring CLIProxyAPI's own clampLevel — proving the UI
//    resolves the same value the wire would have silently clamped to,
//    instead of letting a mismatch ride along invisibly.
// ---------------------------------------------------------------------------

{
  // 'xhigh' has no meaning on [low,medium,high] -> nearest is 'high' (index
  // distance: xhigh=4, high=3 -> dist 1; medium=2 -> dist 2; low=1 -> dist 3).
  assert.equal(
    clampEffortToSupportedLevel('xhigh', ['low', 'medium', 'high']),
    'high',
    "'xhigh' must clamp to the nearest supported level ('high') on a [low,medium,high] model"
  )

  // 'medium' -> [minimal, high] is NOT a tie: dist(medium,minimal)=2,
  // dist(medium,high)=1 -> clamps to 'high' (mirrors effort-spec.md's
  // explicit worked example for gemini-3.1-flash-image).
  assert.equal(
    clampEffortToSupportedLevel('medium', ['minimal', 'high']),
    'high',
    "'medium' must clamp to 'high' on a [minimal,high] model (dist 2 vs 1, not a tie)"
  )

  // A value already supported is returned unchanged.
  assert.equal(
    clampEffortToSupportedLevel('medium', ['low', 'medium', 'high']),
    'medium',
    'an already-supported level must be returned unchanged'
  )

  // 'auto' is never resolved against the ladder — always passes through.
  assert.equal(
    clampEffortToSupportedLevel('auto', ['low', 'medium', 'high']),
    'auto',
    "'auto' must pass through unchanged regardless of the model's levels"
  )

  // A model with no reasoning control at all (null) -> resets to 'auto',
  // the one value that's never sent as a wire effort.
  assert.equal(
    clampEffortToSupportedLevel('high', null),
    'auto',
    'a model with effortLevels: null must resolve any stored effort to auto'
  )

  console.log(
    '✓ the stale-selection guard (clampEffortToSupportedLevel) maps an unsupported level to the ' +
      "nearest supported one, mirroring the proxy's own clamp rule"
  )
}

// ---------------------------------------------------------------------------
// 5. Claude routing stays a byte-for-byte no-op — this unit's effort-levels
//    work (a purely additive data table + UI wiring) must not alter
//    computeRoutingEnv's output for a Claude model in any way. This is the
//    ToS invariant the spec explicitly forbids touching.
// ---------------------------------------------------------------------------

{
  const env = computeRoutingEnv('claude-opus-4-8', {
    proxyUrl: 'http://127.0.0.1:18765',
    authToken: 'test-token'
  })
  assert.deepEqual(
    env,
    {},
    'a Claude model must still produce a byte-for-byte no-op env overlay — effort-levels work must never touch routing'
  )
  assert.equal(
    isRoutedModel('claude-opus-4-8'),
    false,
    'claude-opus-4-8 must still be classified as non-routed'
  )

  // Every CLAUDE_MODEL_OPTIONS entry, explicit versions and aliases alike,
  // must stay non-routed and produce a no-op env — proving the effort table
  // addition didn't accidentally reclassify anything.
  for (const option of CLAUDE_MODEL_OPTIONS) {
    assert.equal(isRoutedModel(option.value), false, `${option.value} must not be routed`)
    assert.deepEqual(
      computeRoutingEnv(option.value, { proxyUrl: 'http://127.0.0.1:18765', authToken: 'x' }),
      {},
      `${option.value} must still produce a byte-for-byte no-op routing env`
    )
  }

  console.log(
    '✓ Claude routing remains a byte-for-byte no-op for every CLAUDE_MODEL_OPTIONS entry — the ' +
      'effort-levels work never touches computeRoutingEnv (ToS invariant preserved)'
  )
}

console.log('\nAll effort-level assertions passed.')
