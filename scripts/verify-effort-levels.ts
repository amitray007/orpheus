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
// This harness is DB-touching for section 7 only (a real in-memory
// bun:sqlite DB built fresh via engine.ts's sync(), never a file on disk) —
// every other section (buildSelectableModels, CLAUDE_BUILTIN_EFFORT_LEVELS,
// EFFORT_LADDER_ORDER, clampEffortToSupportedLevel, resolveEffortLevelsFor
// ModelId, computeRoutingEnv) is electron-free and DB-free by construction,
// same constraint every other verify-*.ts harness in this repo depends on.
//
// Covers (per effort-spec.md's work item 5, plus the team-lead's two
// follow-up blockers: the widened DB enum, and cross-model reconciliation):
//   1. EFFORT_LADDER_ORDER matches [minimal,low,medium,high,xhigh,max] exactly
//   2. a model with effortLevels: null yields no effort options at all
//   3. grok-4.5 -> exactly [low,medium,high]; gpt-5.5 -> no 'max'; opus-4.6
//      (mirrored here as claude-sonnet-4-6, the one CLAUDE_MODEL_OPTIONS
//      entry with the "no xhigh" shape) -> no 'xhigh'; gemini-3.1-flash-image
//      -> exactly [minimal,high]
//   4. the cross-model effort reconciliation (clampEffortToSupportedLevel)
//      resolves every worked example from the spec: xhigh->high on
//      [low,medium,high]; max->xhigh on [low,medium,high,xhigh]; any value
//      -> 'auto' on a null-levels model; 'auto' always stays 'auto';
//      minimal->low on [low,medium,high]; 'none' stays 'none' when
//      supported; 'none'->lowest-supported when unsupported (never a
//      distance computation); a supported value returns byte-identical; a
//      genuine tie resolves to the LOWER rung (our own explicit choice, not
//      an upstream mirror — CLIProxyAPI's own tie-break is dead code)
//   5. Claude routing stays a byte-for-byte no-op — no effort-levels work in
//      this unit may alter computeRoutingEnv's output for a Claude model
//   6. resolveEffortLevelsForModelId (the main-process reconciliation
//      choke point's resolver) handles explicit Claude ids, Claude ALIASES,
//      date-stamped variants, and routed cliproxy-cache ids correctly
//   7. every value in the widened EFFORT enum survives a real write+read
//      through the ACTUAL claude_global_settings table; an out-of-enum
//      value is still rejected by the CHECK constraint
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import { Database } from 'bun:sqlite'
import {
  EFFORT_LADDER_ORDER,
  CLAUDE_BUILTIN_EFFORT_LEVELS,
  CLAUDE_MODEL_OPTIONS,
  clampEffortToSupportedLevel
} from '../src/shared/types.ts'
import {
  buildSelectableModels,
  resolveEffortLevelsForModelId
} from '../src/main/models/selectable.ts'
import type {
  BuildSelectableModelsInput,
  ProviderDescriptorInput
} from '../src/main/models/selectable.ts'
import { computeRoutingEnv, isRoutedModel } from '../src/main/modelRouting.ts'
import { sync } from '../src/main/db/engine.ts'
import { schema, EFFORT } from '../src/main/db/schema.ts'

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
// 4. The cross-model effort reconciliation / stale-selection guard
//    (clampEffortToSupportedLevel) maps a now-unsupported level to the
//    NEAREST supported one on the new model's ladder — proving the UI/main-
//    process resolution always matches what the wire would otherwise have
//    silently clamped to, instead of letting a mismatch ride along invisibly.
//    Exact worked examples from the reconciliation spec (team-lead blocker).
// ---------------------------------------------------------------------------

{
  // opus-4.8 'xhigh' -> grok-4.5 ([low,medium,high]) resolves to 'high'.
  // xhigh=4, high=3 (dist 1), medium=2 (dist 2), low=1 (dist 3) -> 'high'.
  assert.equal(
    clampEffortToSupportedLevel('xhigh', ['low', 'medium', 'high']),
    'high',
    "opus-4.8 'xhigh' -> grok-4.5 [low,medium,high] must resolve to 'high'"
  )

  // opus-4.8 'max' -> gpt-5.5 ([low,medium,high,xhigh], no max) resolves to
  // 'xhigh'. max=5, xhigh=4 (dist 1) is nearest.
  assert.equal(
    clampEffortToSupportedLevel('max', ['low', 'medium', 'high', 'xhigh']),
    'xhigh',
    "opus-4.8 'max' -> gpt-5.5 [low,medium,high,xhigh] must resolve to 'xhigh'"
  )

  // any effort -> a null-levels model (e.g. an image model) resolves to 'auto'.
  for (const stored of ['low', 'medium', 'high', 'xhigh', 'max', 'minimal', 'none', 'auto']) {
    assert.equal(
      clampEffortToSupportedLevel(stored, null),
      'auto',
      `'${stored}' -> a model with effortLevels: null must resolve to 'auto'`
    )
  }

  // 'auto' -> any model stays 'auto' — never resolved to a concrete rung,
  // even when the model's ladder could accommodate one.
  for (const levels of [['low', 'medium', 'high'], ['minimal', 'high'], null]) {
    assert.equal(
      clampEffortToSupportedLevel('auto', levels),
      'auto',
      "'auto' must stay 'auto' regardless of the new model's levels"
    )
  }

  // 'minimal' -> grok-4.5 ([low,medium,high], no minimal) resolves to 'low'
  // (minimal=0, low=1 is nearest).
  assert.equal(
    clampEffortToSupportedLevel('minimal', ['low', 'medium', 'high']),
    'low',
    "'minimal' -> grok-4.5 [low,medium,high] must resolve to 'low'"
  )

  // 'none' -> grok-4.3 ([none,low,medium,high]) stays 'none' — already
  // supported, returned unchanged.
  assert.equal(
    clampEffortToSupportedLevel('none', ['none', 'low', 'medium', 'high']),
    'none',
    "'none' -> grok-4.3 [none,low,medium,high] must stay 'none' (already supported)"
  )

  // 'none' -> grok-4.5 (no 'none' in its levels) falls back to the LOWEST
  // supported level ('low'), NOT a distance computation — 'none' is
  // off-ladder and has no meaningful index of its own.
  assert.equal(
    clampEffortToSupportedLevel('none', ['low', 'medium', 'high']),
    'low',
    "'none' -> grok-4.5 [low,medium,high] (no 'none') must fall back to the lowest supported level"
  )

  // A supported value is returned BYTE-IDENTICAL — no needless rewrite.
  const unchanged = clampEffortToSupportedLevel('medium', ['low', 'medium', 'high'])
  assert.equal(unchanged, 'medium', 'an already-supported level must be returned unchanged')
  assert.ok(
    Object.is(unchanged, 'medium'),
    'the returned value must be the exact same string, never a rebuilt equal-but-different value'
  )

  // 'medium' -> [minimal, high] is NOT a tie: dist(medium,minimal)=2,
  // dist(medium,high)=1 -> clamps to 'high' (mirrors effort-spec.md's
  // explicit worked example for gemini-3.1-flash-image).
  assert.equal(
    clampEffortToSupportedLevel('medium', ['minimal', 'high']),
    'high',
    "'medium' must clamp to 'high' on a [minimal,high] model (dist 2 vs 1, not a tie)"
  )

  // A GENUINE tie (medium=2 is equidistant from low=1 and high=3, dist 1
  // each) resolves to the LOWER rung — our own deliberate choice (NOT a
  // mirror of CLIProxyAPI's own dead tie-break code, which never fires).
  assert.equal(
    clampEffortToSupportedLevel('medium', ['low', 'high']),
    'low',
    'a genuine tie must resolve to the LOWER rung — our own explicit choice, not an upstream mirror'
  )

  console.log(
    '✓ the cross-model effort reconciliation (clampEffortToSupportedLevel) resolves every worked ' +
      'example from the spec correctly: xhigh->high, max->xhigh, null->auto, auto stays auto, ' +
      "minimal->low, none stays 'none' when supported, none->lowest when unsupported, a supported " +
      'value returns unchanged, and a genuine tie resolves to the lower rung'
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

// ---------------------------------------------------------------------------
// 6. resolveEffortLevelsForModelId — the resolver the main-process
//    reconciliation choke point (src/main/ipc/claudeSettings.ts) uses to
//    learn the NEW model's real ladder. Must resolve explicit Claude ids,
//    Claude ALIASES (opus/sonnet/haiku/fable — bareClaudeIdFor deliberately
//    excludes these from its own resolution, so the direct-table-lookup-first
//    ordering is load-bearing here), date-stamped Claude variants, and
//    routed ids via the cliproxy cache — never fabricating levels for an id
//    known to neither source.
// ---------------------------------------------------------------------------

{
  assert.deepEqual(
    resolveEffortLevelsForModelId('claude-opus-4-8', []),
    CLAUDE_BUILTIN_EFFORT_LEVELS['claude-opus-4-8'],
    'an explicit Claude id must resolve via the builtin table'
  )

  // Aliases: bareClaudeIdFor deliberately does NOT resolve these (see its own
  // doc comment) — resolveEffortLevelsForModelId must still resolve them
  // correctly via the direct table lookup, not fall through to "unknown".
  for (const alias of ['opus', 'sonnet', 'haiku', 'fable'] as const) {
    assert.deepEqual(
      resolveEffortLevelsForModelId(alias, []),
      CLAUDE_BUILTIN_EFFORT_LEVELS[alias],
      `the '${alias}' alias must resolve via the builtin table, not fall through to null`
    )
  }

  // Date-stamped variant (a real id Claude actually launches with) resolves
  // to its bare id's levels via bareClaudeIdFor.
  assert.deepEqual(
    resolveEffortLevelsForModelId('claude-opus-4-8-20260416', []),
    CLAUDE_BUILTIN_EFFORT_LEVELS['claude-opus-4-8'],
    'a date-stamped Claude variant must resolve to its bare id’s levels'
  )

  // A routed id resolves from the cliproxy cache entries passed in.
  assert.deepEqual(
    resolveEffortLevelsForModelId('grok-4.5', [
      { modelId: 'grok-4.5', providerId: 'xai', context: 256_000, effortLevels: ['low', 'high'] }
    ]),
    ['low', 'high'],
    'a routed id must resolve from the cliproxy cache entries passed in'
  )

  // An id known to neither source resolves to null — never fabricated.
  assert.equal(
    resolveEffortLevelsForModelId('totally-unknown-model-id', []),
    null,
    'an id known to neither the builtin table nor the cliproxy cache must resolve to null'
  )

  console.log(
    '✓ resolveEffortLevelsForModelId resolves explicit Claude ids, Claude ALIASES (opus/sonnet/' +
      'haiku/fable — despite bareClaudeIdFor excluding them), date-stamped variants, and routed ' +
      'cliproxy-cache ids; an unknown id resolves to null, never fabricated'
  )
}

// ---------------------------------------------------------------------------
// 7. DB round-trip: every value in the widened EFFORT enum survives a real
//    write + read through the ACTUAL declared claude_global_settings table
//    (built fresh from schema.ts via engine.ts's sync(), not a synthetic
//    mini-table) — proving the CHECK constraint was genuinely widened to
//    match ClaudeEffort, not just the TypeScript union. Also proves an
//    out-of-ladder value is correctly REJECTED by the CHECK constraint,
//    confirming the widening didn't accidentally drop enforcement entirely.
// ---------------------------------------------------------------------------

{
  assert.deepEqual(
    [...EFFORT],
    ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    'schema.ts’s EFFORT enum must exactly match the widened ClaudeEffort union'
  )

  const db = new Database(':memory:')
  sync(db, schema, { dbPath: ':memory:', legacyVersion: 0 })

  // claude_global_settings is a singleton row (id = 1) with a NOT NULL model
  // column — seed it once, then round-trip every effort value through an
  // UPDATE (never re-INSERT, since id is PRIMARY KEY CHECK (id = 1)).
  db.prepare(
    "INSERT INTO claude_global_settings (id, model, updated_at) VALUES (1, 'sonnet', 0)"
  ).run()

  for (const value of EFFORT) {
    db.prepare('UPDATE claude_global_settings SET effort = ? WHERE id = 1').run(value)
    const row = db.prepare('SELECT effort FROM claude_global_settings WHERE id = 1').get() as {
      effort: string
    }
    assert.equal(row.effort, value, `effort value '${value}' must survive a real DB write + read`)
  }

  // An out-of-enum value must still be rejected by the CHECK constraint —
  // the widening must not have accidentally loosened enforcement entirely.
  assert.throws(
    () => db.prepare("UPDATE claude_global_settings SET effort = 'bogus' WHERE id = 1").run(),
    /CHECK constraint failed/,
    'an out-of-enum effort value must still be rejected by the CHECK constraint'
  )

  db.close()
  console.log(
    '✓ every value in the widened EFFORT enum survives a real write + read through the actual ' +
      'claude_global_settings table (built fresh via engine.ts’s sync()); an out-of-enum value ' +
      'is still rejected by the CHECK constraint'
  )
}

console.log('\nAll effort-level assertions passed.')
