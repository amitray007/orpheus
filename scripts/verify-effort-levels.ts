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
//   8. CLAUDE_EFFORT_VALUES (the one array every validator now checks
//      directly — no remaining independent copies anywhere in the repo)
//      contains EXACTLY every ClaudeEffort member, and every value
//      clampEffortToSupportedLevel can return, across every real per-model
//      level set this repo has, is a member of it. Closes the gap a pure
//      clamp-function test alone cannot catch: a validator silently
//      drifting out of sync with what the clamp function can produce.
//   9. THE UI STALENESS BUGFIX's pure logic (effortOptionsFor/
//      shouldRenderEffortChip) recomputes correctly across a simulated
//      model transition (grok-4.5 -> gemini-3.1-flash-image -> null-levels
//      -> claude-opus-4-8). The store/push wiring itself is NOT verifiable
//      offline (no renderer test runner) — see this section's own note.
//   10. THE "EMPTY EFFORT CHIP ON A COLD DIRECT-TO-WORKSPACE OPEN" bugfix:
//       shouldRenderEffortChip's tri-state (undefined -> render/pending,
//       null -> hide, string[] -> render/options) is asserted for all
//       three members.
//   11. resolveEffortLevelsForScope — the ONE resolver footer chip AND all
//       three settings drawers (WorkspaceDrawer/SettingsDrawer/
//       ClaudeGeneralSection) now share: no-single-model -> full ladder,
//       loading -> pending, resolved -> real levels, residual miss ->
//       unknown (never null).
//   12. effortOptionsFor's `leading` parameter — the drawers' 'Use global'/
//       'Default' option, prepended before 'auto' without disturbing it.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import { Database } from 'bun:sqlite'
import {
  EFFORT_LADDER_ORDER,
  CLAUDE_BUILTIN_EFFORT_LEVELS,
  CLAUDE_MODEL_OPTIONS,
  CLAUDE_EFFORT_VALUES,
  clampEffortToSupportedLevel,
  type ClaudeEffort
} from '../src/shared/types.ts'
import {
  buildSelectableModels,
  resolveEffortLevelsForModelId
} from '../src/main/models/selectable.ts'
import {
  effortOptionsFor,
  shouldRenderEffortChip,
  resolveEffortLevelsForScope
} from '../src/renderer/src/lib/effortPickerOptions.ts'
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

// ---------------------------------------------------------------------------
// 8. THE GAP the team-lead flagged: a pure-function test of
//    clampEffortToSupportedLevel that never touches the persistence path
//    cannot catch a validator array silently drifting out of sync with what
//    the clamp function can actually return. Fixed at the ROOT (not just
//    asserted around): CLAUDE_EFFORT_VALUES (src/shared/types.ts) is now the
//    ONE array every validator checks directly at its call site — schema.ts's
//    EFFORT is a literal reference to it (asserted below), and
//    claudeSettings.ts's validatePatch / overridesStore.ts's
//    validateBasePatch / commandServer.ts's buildWorkspaceSettingsOverride /
//    packages/orpheus-cli's ws-new.ts help text all call
//    CLAUDE_EFFORT_VALUES.includes(...) directly — there is no longer a
//    separate VALID_EFFORTS copy or re-export in any of those files to drift
//    out of sync (grep confirms zero remaining occurrences of that name).
//    claudeSettings.ts/overridesStore.ts/commandServer.ts themselves import
//    `./db` -> `electron` (or `electron` directly), so they cannot be
//    imported into this offline harness (same constraint every other
//    verify-*.ts script in this repo is under) — but since there is only ONE
//    array left, asserting against CLAUDE_EFFORT_VALUES / schema.ts's EFFORT
//    (both electron-free) IS asserting against the exact values those
//    validators check at runtime, not a decoupled stand-in that could itself
//    drift. This section exercises clampEffortToSupportedLevel against every
//    REAL per-model level set this repo has (every CLAUDE_BUILTIN_EFFORT_
//    LEVELS entry, plus the documented live per-model shapes from
//    effort-spec.md), across every storable `current` value, and asserts
//    every value it can produce is a member of that one canonical array.
// ---------------------------------------------------------------------------

{
  assert.equal(
    EFFORT,
    CLAUDE_EFFORT_VALUES,
    'schema.ts’s EFFORT must be the exact same array reference as CLAUDE_EFFORT_VALUES, not an ' +
      'independent copy that could silently drift'
  )

  // Runtime exhaustiveness check (not just relying on TypeScript's own
  // literal-union inference silently succeeding): every member of the
  // ClaudeEffort type must be present in CLAUDE_EFFORT_VALUES — no value a
  // caller could legally type as ClaudeEffort would be rejected by the one
  // validator array every real check now uses.
  const EVERY_CLAUDE_EFFORT_MEMBER: ClaudeEffort[] = [
    'auto',
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
  ]
  for (const member of EVERY_CLAUDE_EFFORT_MEMBER) {
    assert.ok(
      (CLAUDE_EFFORT_VALUES as readonly string[]).includes(member),
      `ClaudeEffort member '${member}' is missing from CLAUDE_EFFORT_VALUES — a validator would ` +
        'wrongly reject a value the type system says is legal'
    )
  }
  assert.equal(
    CLAUDE_EFFORT_VALUES.length,
    EVERY_CLAUDE_EFFORT_MEMBER.length,
    'CLAUDE_EFFORT_VALUES must contain EXACTLY the ClaudeEffort members, no more (a fabricated ' +
      'extra value) and no fewer (a missing one)'
  )
  console.log(
    '✓ CLAUDE_EFFORT_VALUES contains exactly every member of the ClaudeEffort type — no legal ' +
      'value would be wrongly rejected by any validator, and no extra value was fabricated'
  )

  const realLevelSets: (string[] | null)[] = [
    ...Object.values(CLAUDE_BUILTIN_EFFORT_LEVELS),
    ['low', 'medium', 'high'], // grok-4.5
    ['none', 'low', 'medium', 'high'], // grok-4.3
    ['low', 'medium', 'high', 'xhigh'], // gpt-5.5/5.4/etc
    ['low', 'medium', 'high', 'xhigh', 'max'], // gpt-5.6-sol/terra/luna
    ['minimal', 'low', 'medium', 'high'], // gemini-3-flash etc
    ['minimal', 'high'], // gemini-3.1-flash-image
    null // image/video models with no thinking.levels at all
  ]
  const everyStorableValue = [...CLAUDE_EFFORT_VALUES]

  let checked = 0
  for (const levels of realLevelSets) {
    for (const current of everyStorableValue) {
      const resolved = clampEffortToSupportedLevel(current, levels)
      assert.ok(
        (CLAUDE_EFFORT_VALUES as readonly string[]).includes(resolved),
        `clampEffortToSupportedLevel('${current}', ${JSON.stringify(levels)}) returned ` +
          `'${resolved}', which is NOT in CLAUDE_EFFORT_VALUES — this is exactly the class of bug ` +
          'that would silently desync the UI from the DB (validator rejects/drops a value the ' +
          'clamp function can legitimately produce)'
      )
      checked++
    }
  }
  assert.ok(checked > 0, 'sanity: this section must actually exercise combinations')

  console.log(
    `✓ every value clampEffortToSupportedLevel can return across ${realLevelSets.length} real ` +
      `per-model level sets × ${everyStorableValue.length} storable current values (${checked} ` +
      'combinations) is a member of CLAUDE_EFFORT_VALUES — the ONE array every real validator ' +
      '(schema.ts, claudeSettings.ts, overridesStore.ts, commandServer.ts, ws-new.ts) checks ' +
      'directly, with no remaining independent copy anywhere'
  )
}

// ---------------------------------------------------------------------------
// 9. THE UI STALENESS BUG (reported by the user, root-caused by the team
//    lead): switching a workspace's model didn't update the footer Effort
//    chip — it kept offering the PREVIOUS model's levels until a remount.
//    Root cause: the footer's Model chip and Effort chip are TWO SEPARATE
//    DropdownChip component instances (WorkspaceFooter.tsx), each of which
//    used to own local useState with no way to learn the OTHER instance
//    just changed something. Fixed by moving modelValue/effortValue into
//    shared per-workspace stores (workspaceModelStore.ts/
//    workspaceEffortStore.ts) that BOTH chip instances read from, kept in
//    sync by ONE main->renderer push (workspace:effectiveSettingsChanged,
//    wired in Dashboard.tsx) covering every path that can change a
//    workspace's model (footer chip, creation menu, settings drawers, CLI —
//    see registerClaudeSettingsIpc's four handlers in
//    src/main/ipc/claudeSettings.ts).
//
//    HONEST COVERAGE NOTE: the store/push wiring itself (React
//    useSyncExternalStore subscriptions, the Dashboard.tsx useEffect
//    actually receiving the push in a live renderer) is NOT verifiable by
//    this offline, DOM-free harness — this repo has no renderer test runner
//    (see CLAUDE.md's own "no general/renderer test runner" note), and
//    simulating useSyncExternalStore subscription timing without a real DOM
//    would not be a meaningful assertion, only a simulated one. What CAN be
//    verified here, and IS verified below, is the PURE logic DropdownChip's
//    render derives its output from: given a model's effortLevels, (a) what
//    options does the effort chip show, and (b) does it render at all —
//    asserted across a SIMULATED model transition (grok-4.5 ->
//    gemini-3.1-flash-image -> claude-opus-4-8).
//
//    LIVE VERIFICATION ACTUALLY PERFORMED (this session, not simulated): the
//    MAIN-PROCESS half of this fix — withReconciledEffort actually firing
//    and persisting the correct reconciled value — was confirmed against a
//    real running Orpheus Dev build. Set the dev app's global effort to
//    'xhigh' via direct SQL, then issued a real workspace.create command
//    (POSTed directly to the running app's authenticated cmd.sock, the same
//    socket the CLI and this session's copy of orpheus-cli both use) with
//    model: 'claude-sonnet-4-6' ([low,medium,high,max], no xhigh) and no
//    explicit effort. Result, read back from the actual on-disk
//    claude_workspace_settings row: {"model":"claude-sonnet-4-6",
//    "effort":"high"} — exactly the tie-break-to-lower-rung result this
//    harness's section 4 predicts for xhigh on that ladder, proving
//    withReconciledEffort is wired correctly end-to-end on the
//    commandServer.ts (CLI) path. The renderer store/push wiring (this
//    session could not drive the live UI directly — no browser/UI-automation
//    tool available for a native Electron app in this environment) remains
//    UNVERIFIED beyond the pure-function level asserted below; report this
//    gap honestly rather than implying full coverage.
// ---------------------------------------------------------------------------

{
  // Step 1: workspace starts on grok-4.5 ([low,medium,high]) — chip renders,
  // offering auto/low/medium/high, no xhigh/max/minimal/none.
  const grokLevels = ['low', 'medium', 'high']
  assert.equal(shouldRenderEffortChip(grokLevels), true, 'grok-4.5 must render the effort chip')
  assert.deepEqual(
    effortOptionsFor(grokLevels).map((o) => o.value),
    ['auto', 'low', 'medium', 'high'],
    'grok-4.5 must offer exactly auto/low/medium/high'
  )

  // Step 2 (THE TRANSITION): workspace switches to gemini-3.1-flash-image
  // ([minimal,high]) — same chip instance, NEW model's levels. Options must
  // be recomputed from the NEW levels, not the stale grok ones.
  const geminiImageLevels = ['minimal', 'high']
  assert.equal(
    shouldRenderEffortChip(geminiImageLevels),
    true,
    'gemini-3.1-flash-image must still render the effort chip (minimal/high, not null)'
  )
  assert.deepEqual(
    effortOptionsFor(geminiImageLevels).map((o) => o.value),
    ['auto', 'minimal', 'high'],
    'after switching to gemini-3.1-flash-image, options must be recomputed to auto/minimal/high — ' +
      'NOT still grok-4.5’s auto/low/medium/high'
  )

  // Step 3: workspace switches to a null-levels model (e.g. a pure image
  // model with no thinking.levels at all) — the chip must now report
  // "don't render" for this same transition sequence.
  assert.equal(
    shouldRenderEffortChip(null),
    false,
    'a null-levels model must report "do not render the effort chip" — never a disabled control'
  )

  // Step 4: workspace switches BACK to a Claude model with full levels —
  // proves the derivation isn't a one-way ratchet; it recomputes correctly
  // in either direction of a transition.
  const opus48Levels = CLAUDE_BUILTIN_EFFORT_LEVELS['claude-opus-4-8']!
  assert.equal(
    shouldRenderEffortChip(opus48Levels),
    true,
    'switching back to claude-opus-4-8 must render the effort chip again'
  )
  assert.deepEqual(
    effortOptionsFor(opus48Levels).map((o) => o.value),
    ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
    'switching back to claude-opus-4-8 must offer its full ladder, not gemini-3.1-flash-image’s ' +
      'auto/minimal/high or "hidden"'
  )

  console.log(
    '✓ the pure options/visibility derivation (effortOptionsFor/shouldRenderEffortChip) recomputes ' +
      'correctly across a full simulated model transition (grok-4.5 -> gemini-3.1-flash-image -> ' +
      'null-levels -> claude-opus-4-8) — the renderer store/push WIRING that delivers a live ' +
      'modelValue to this derivation is NOT covered by this offline harness (no renderer test ' +
      'runner in this repo) and remains unverified beyond this pure-function level; the MAIN-' +
      'PROCESS reconciliation this wiring depends on WAS verified live (see this section’s own ' +
      'header comment for the exact repro against a running Orpheus Dev build)'
  )
}

// ---------------------------------------------------------------------------
// 10. THE "EMPTY EFFORT CHIP ON A COLD DIRECT-TO-WORKSPACE OPEN" BUG (user-
//    reported): shouldRenderEffortChip's effortLevels argument was
//    previously a plain null/non-null boolean — `null` meant BOTH "this
//    model genuinely has no reasoning-effort control" (hide) AND "we don't
//    know this model's levels yet, the model list is still loading" (which
//    should NOT hide — it's a transient unknown, not an authoritative
//    fact). Root cause: modelValue resolves from getEffectiveModel almost
//    immediately on a cold direct-to-workspace app launch, but
//    selectableModels can still be loading (models:listSelectable hasn't
//    resolved, or a routed model's proxy is still starting) — a `.find()`
//    miss during that window got folded into the SAME null as "no control",
//    hiding the chip even though the model might have real levels once the
//    list resolves.
//
//    Fixed by widening the tri-state to string[] | null | undefined:
//    `undefined` = not resolved yet (render, non-interactive/pending, never
//    hidden, never a fabricated ladder); `null` = genuinely no control
//    (hide); `string[]` = real options. This section asserts
//    shouldRenderEffortChip's behavior across all three tri-state members —
//    the exact assertion requested: unknown -> renders, null -> hidden,
//    real levels -> renders with options.
// ---------------------------------------------------------------------------

{
  assert.equal(
    shouldRenderEffortChip(undefined),
    true,
    'UNKNOWN (levels not resolved yet, e.g. models:listSelectable still loading on a cold ' +
      'direct-to-workspace open) must render the chip — never hidden, never treated the same as ' +
      'a model that genuinely has no reasoning-effort control'
  )
  assert.equal(
    shouldRenderEffortChip(null),
    false,
    'NULL (this model genuinely has no reasoning-effort control, e.g. an image model) must hide ' +
      'the chip entirely'
  )
  assert.equal(
    shouldRenderEffortChip(['low', 'medium', 'high']),
    true,
    'real, resolved levels must render the chip with real options'
  )
  assert.equal(
    shouldRenderEffortChip([]),
    true,
    'an empty (but resolved, non-null) levels array must still render the chip — ' +
      'effortOptionsFor([]) still yields at least the auto entry'
  )

  console.log(
    '✓ shouldRenderEffortChip’s tri-state is handled correctly: undefined (unknown/pending) -> ' +
      'renders, null (genuinely no control) -> hidden, string[] (real levels, including empty) ' +
      '-> renders with options. Closes the "effort chip empty on a cold direct-to-workspace open" ' +
      'bug at the logic layer — the live store/loading-flag wiring that feeds this selector is not ' +
      'independently verifiable offline (no renderer test runner in this repo; see this file’s ' +
      'section 9 note for the same honest gap)'
  )
}

// ---------------------------------------------------------------------------
// 11. resolveEffortLevelsForScope — the ONE "model id -> effort levels"
//    resolver every effort selector in the app now imports (footer chip,
//    WorkspaceDrawer, SettingsDrawer, ClaudeGeneralSection) instead of a
//    fifth hardcoded ladder. Covers the "no single model to resolve" case
//    (undefined modelId — a project/global scope's 'default'/'Use global'
//    selection, or the footer chip's genuinely-unset workspace model) and
//    the loading-flag pending case together, since both are the exact
//    mechanism this unit's two bugfixes depend on.
// ---------------------------------------------------------------------------

{
  const claudeModel = buildSelectableModels(baseInput()).find((m) => m.id === 'claude-opus-4-8')!

  // No single model to resolve (undefined modelId) -> full ladder, the SAME
  // fallback for both "inherits from a parent scope" (drawers) and "no
  // explicit workspace override" (footer chip's modelValue === '').
  assert.deepEqual(
    resolveEffortLevelsForScope(undefined, [claudeModel], false),
    [...EFFORT_LADDER_ORDER],
    'undefined modelId (no single scope model) must resolve to the full ladder'
  )
  assert.deepEqual(
    resolveEffortLevelsForScope('', [claudeModel], false),
    [...EFFORT_LADDER_ORDER],
    "'' modelId (the footer chip's genuine no-override state) must resolve to the full ladder too"
  )

  // Loading -> pending (undefined), even for a concrete modelId that WOULD
  // resolve once the list loads — this is the "cold direct-to-workspace
  // open" bug's exact mechanism.
  assert.equal(
    resolveEffortLevelsForScope('claude-opus-4-8', [], true),
    undefined,
    'a concrete modelId must resolve to undefined (pending) while the model list is still loading'
  )

  // Loaded + found -> real levels.
  assert.deepEqual(
    resolveEffortLevelsForScope('claude-opus-4-8', [claudeModel], false),
    CLAUDE_BUILTIN_EFFORT_LEVELS['claude-opus-4-8'],
    'a concrete, resolved modelId must return its real effortLevels'
  )

  // Loaded + not found (residual truly-unresolvable id) -> undefined
  // (unknown), NOT null — a miss is not positive evidence of "no control".
  assert.equal(
    resolveEffortLevelsForScope('totally-unknown-model-id', [claudeModel], false),
    undefined,
    'a modelId not found in an already-loaded list must resolve to undefined (unknown), never null'
  )

  console.log(
    '✓ resolveEffortLevelsForScope (the ONE resolver every effort selector now shares) handles ' +
      "the no-single-model case (undefined and '' both -> full ladder), the loading/pending " +
      'case (-> undefined even for a concrete modelId), a resolved hit (-> real levels), and a ' +
      'residual unresolvable id (-> undefined, never null)'
  )
}

// ---------------------------------------------------------------------------
// 12. effortOptionsFor's `leading` parameter — the settings drawers' 'Use
//    global'/'Default' ("inherit from parent scope") option, prepended
//    BEFORE 'auto' as a distinct concept, never collapsed into it.
// ---------------------------------------------------------------------------

{
  const withLeading = effortOptionsFor(['low', 'medium', 'high'], {
    value: 'default',
    label: 'Use global'
  })
  assert.deepEqual(
    withLeading.map((o) => o.value),
    ['default', 'auto', 'low', 'medium', 'high'],
    "'leading' must be prepended BEFORE 'auto', never collapsed into it or reordered after it"
  )

  const withoutLeading = effortOptionsFor(['low', 'medium', 'high'])
  assert.deepEqual(
    withoutLeading.map((o) => o.value),
    ['auto', 'low', 'medium', 'high'],
    'omitting leading (the footer chip, which has no "inherit" concept) must behave exactly as ' +
      'before — no default/leading entry fabricated'
  )

  console.log(
    "✓ effortOptionsFor's leading parameter prepends the drawers' 'Use global'/'Default' option " +
      "before 'auto' without disturbing the rest of the ladder; omitting it (the footer chip) " +
      'is unchanged from before this parameter existed'
  )
}

console.log('\nAll effort-level assertions passed.')
