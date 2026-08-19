// ---------------------------------------------------------------------------
// scripts/verify-harness-actions.ts
//
// Multi-harness migration, unit U6 (R8) — BEHAVIOR guard for
// src/main/footerActions.ts's filterActionsForHarness and the
// FOOTER_ACTION_GATES lookup table it drives, plus
// src/main/harness/claude/actions.ts's CLAUDE_DEFAULT_ACTIONS.
//
// Deliberately NOT a source-grep: every assertion below calls the REAL
// exported filterActionsForHarness against fixture FooterActionDescriptor
// rows and a fixture HarnessDescriptor, then checks which actionIds survive
// — the same discipline verify-harness-registry.ts uses for resolveHarness.
//
// IMPORTABILITY: footerActions.ts imports './db' (-> electron `app`) and
// './harness/registry' (-> claudeSettings.ts -> electron `app`/
// `BrowserWindow`). filterActionsForHarness itself never touches either (it
// takes an array + a descriptor, no DB/registry lookup), but the module
// can't link under plain `bun run` without mock.module() stubs — same
// precedent as verify-harness-registry.ts and verify-project-add.ts. Stubs
// throw if actually invoked, proving filterActionsForHarness never needs
// them.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import type { FooterActionDescriptor } from '../src/shared/types.ts'
import type { HarnessCapabilities, HarnessDescriptor } from '../src/shared/harness/types.ts'

const mainDir = new URL('../src/main/', import.meta.url)
const abs = (rel: string): string => new URL(rel, mainDir).pathname

mock.module('electron', () => ({}))
mock.module(abs('db/index.ts'), () => ({
  getDb: () => {
    throw new Error('getDb() must not be called by filterActionsForHarness')
  }
}))
mock.module(abs('workspaces.ts'), () => ({
  getWorkspace: () => {
    throw new Error('getWorkspace() must not be called by filterActionsForHarness')
  }
}))
mock.module(abs('claudeSettings.ts'), () => ({
  composeClaudeLaunch: () => {
    throw new Error('composeClaudeLaunch must not be called by filterActionsForHarness')
  }
}))

const { filterActionsForHarness } = await import('../src/main/footerActions.ts')
const { CLAUDE_DEFAULT_ACTIONS } = await import('../src/main/harness/claude/actions.ts')
const { resolveHarness, HARNESSES } = await import('../src/main/harness/registry.ts')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const now = Date.now()

function action(
  actionId: string,
  overrides: Partial<FooterActionDescriptor> = {}
): FooterActionDescriptor {
  return {
    id: `id-${actionId}-${Math.random().toString(36).slice(2)}`,
    scope: 'global',
    scopeId: null,
    label: overrides.label ?? actionId,
    icon: null,
    actionId,
    params: {},
    visibleWhen: 'always',
    position: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function baseCapabilities(overrides: Partial<HarnessCapabilities> = {}): HarnessCapabilities {
  return {
    structuredStatus: true,
    transcript: true,
    resume: true,
    fork: true,
    usage: true,
    hooks: true,
    inlineSettingsJson: true,
    modelRouting: false,
    ...overrides
  }
}

function fixtureHarness(overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor {
  return {
    id: 'claude',
    label: 'Fixture Harness',
    binary: 'fixture-bin',
    wrapperScript: 'fixture.sh',
    capabilities: baseCapabilities(),
    settingsSections: [],
    composeLaunch: () => {
      throw new Error('composeLaunch must not be called by filterActionsForHarness fixtures')
    },
    // Default fixture curates both model and effort, so a test that only
    // overrides `capabilities` isolates that one gate instead of
    // incidentally also filtering footer.modelSelect/effortSelect via a
    // default-undefined `curated`.
    curated: {
      model: {
        flag: '--model',
        options: [],
        allowCustom: true,
        liveApply: { kind: 'restartRequired' }
      },
      effort: {
        flag: '--effort',
        options: [],
        allowCustom: true,
        liveApply: { kind: 'restartRequired' }
      }
    },
    knownGoodVersions: new Set(),
    ...overrides
  }
}

const ALL_EIGHT_ACTIONS: FooterActionDescriptor[] = [
  action('workspace.fork', { label: 'Fork' }),
  action('terminal.sendInput', { label: '/copy', params: { text: '/copy', submit: true } }),
  action('terminal.sendInput', { label: '/context', params: { text: '/context', submit: true } }),
  action('terminal.sendInput', { label: '/clear', params: { text: '/clear', submit: true } }),
  action('session.getUsage', { label: 'Context' }),
  action('session.getCost', { label: 'Cost' }),
  action('footer.effortSelect', { label: 'Effort' }),
  action('footer.modelSelect', { label: 'Model' })
]

// ---------------------------------------------------------------------------
// 1. fork: false -> workspace.fork filtered out; everything else stays.
// ---------------------------------------------------------------------------

{
  const harness = fixtureHarness({ capabilities: baseCapabilities({ fork: false }) })
  const result = filterActionsForHarness(ALL_EIGHT_ACTIONS, harness)
  assert.equal(
    result.some((a) => a.actionId === 'workspace.fork'),
    false,
    'workspace.fork must be filtered out when capabilities.fork is false'
  )
  assert.equal(
    result.length,
    ALL_EIGHT_ACTIONS.length - 1,
    'exactly one action (workspace.fork) should be removed'
  )
  console.log('✓ capabilities.fork: false filters out workspace.fork')
}

// ---------------------------------------------------------------------------
// 2. usage: false -> session.getUsage AND session.getCost filtered out.
// ---------------------------------------------------------------------------

{
  const harness = fixtureHarness({ capabilities: baseCapabilities({ usage: false }) })
  const result = filterActionsForHarness(ALL_EIGHT_ACTIONS, harness)
  assert.equal(
    result.some((a) => a.actionId === 'session.getUsage'),
    false,
    'session.getUsage must be filtered out when capabilities.usage is false'
  )
  assert.equal(
    result.some((a) => a.actionId === 'session.getCost'),
    false,
    'session.getCost must be filtered out when capabilities.usage is false'
  )
  assert.equal(
    result.length,
    ALL_EIGHT_ACTIONS.length - 2,
    'exactly two actions (getUsage, getCost) should be removed'
  )
  console.log('✓ capabilities.usage: false filters out session.getUsage and session.getCost')
}

// ---------------------------------------------------------------------------
// 3. no curated.model -> footer.modelSelect filtered out (curated.effort
//    unaffected).
// ---------------------------------------------------------------------------

{
  const harness = fixtureHarness({ curated: undefined })
  const result = filterActionsForHarness(ALL_EIGHT_ACTIONS, harness)
  assert.equal(
    result.some((a) => a.actionId === 'footer.modelSelect'),
    false,
    'footer.modelSelect must be filtered out when curated.model is absent'
  )
  assert.equal(
    result.some((a) => a.actionId === 'footer.effortSelect'),
    false,
    'footer.effortSelect must also be filtered out when curated is entirely undefined'
  )
  console.log('✓ no curated.model (curated undefined) filters out footer.modelSelect')
}

{
  // curated present but only effort populated: modelSelect gated off,
  // effortSelect stays — proves the two gates are independent, not a
  // single "has curated at all" check.
  const harness = fixtureHarness({
    curated: {
      effort: {
        flag: '--effort',
        options: [],
        allowCustom: true,
        liveApply: { kind: 'restartRequired' }
      }
    }
  })
  const result = filterActionsForHarness(ALL_EIGHT_ACTIONS, harness)
  assert.equal(
    result.some((a) => a.actionId === 'footer.modelSelect'),
    false,
    'footer.modelSelect must be filtered out when curated.model specifically is absent'
  )
  assert.equal(
    result.some((a) => a.actionId === 'footer.effortSelect'),
    true,
    'footer.effortSelect must survive when curated.effort is present, independent of model'
  )
  console.log('✓ curated.model/curated.effort gate independently, not as a single flag')
}

// ---------------------------------------------------------------------------
// 4. Claude -> all 8 of the user's action types survive (regression guard).
//    Resolved through the REAL registry (resolveHarness('claude')), not a
//    fixture, so this proves the shipped Claude descriptor's real
//    capabilities/curated fields don't accidentally gate out its own
//    footer.
// ---------------------------------------------------------------------------

{
  const claude = resolveHarness('claude')
  const result = filterActionsForHarness(ALL_EIGHT_ACTIONS, claude)
  assert.equal(
    result.length,
    ALL_EIGHT_ACTIONS.length,
    `all 8 of the user's action rows must survive against the real Claude descriptor, got ${result.length}`
  )
  const survivingIds = new Set(result.map((a) => a.actionId))
  for (const expected of [
    'workspace.fork',
    'terminal.sendInput',
    'session.getUsage',
    'session.getCost',
    'footer.effortSelect',
    'footer.modelSelect'
  ]) {
    assert.equal(
      survivingIds.has(expected),
      true,
      `action_id ${expected} must survive filtering against the real Claude descriptor`
    )
  }
  console.log(
    "✓ REGRESSION GUARD: all 8 of the user's action types survive Claude's real descriptor"
  )
}

// ---------------------------------------------------------------------------
// 5. A user's own custom row (an actionId not in FOOTER_ACTION_GATES) is
//    never filtered by the seeding/gating logic, even under a maximally
//    restrictive harness (every capability false, no curated fields).
// ---------------------------------------------------------------------------

{
  const restrictive = fixtureHarness({
    capabilities: baseCapabilities({
      fork: false,
      usage: false,
      structuredStatus: false,
      transcript: false,
      resume: false,
      hooks: false,
      inlineSettingsJson: false
    }),
    curated: undefined
  })
  const customRows: FooterActionDescriptor[] = [
    action('terminal.sendInput', { label: 'My custom snippet', params: { text: 'echo hi' } }),
    action('workspace.archive', { label: 'Archive' }),
    action('workspace.rename', { label: 'Rename' }),
    action('some.made.up.action.id', { label: 'Whatever this is' })
  ]
  const result = filterActionsForHarness(customRows, restrictive)
  assert.deepEqual(
    result.map((a) => a.id),
    customRows.map((a) => a.id),
    "a user's custom/unknown-action_id rows must never be filtered, regardless of harness capabilities"
  )
  console.log(
    "✓ a user's custom row (unknown/unrestricted action_id) is never filtered, even under a maximally restrictive harness"
  )
}

// ---------------------------------------------------------------------------
// 6. C5 (support-multi-harness) UPDATE: CLAUDE_DEFAULT_ACTIONS is now the
//    CANONICAL 8-row list — drift-resolved against a READ-ONLY inspection of
//    the user's actual PRODUCTION footer_actions_global (8 rows: Fork,
//    /copy, /context, /clear, Context/getUsage, Cost/getCost, Effort,
//    Model — almost exactly this file's original 8, not footerActions.ts's
//    now-derived DEFAULT_SEEDS' shape) — see harness/claude/actions.ts's own
//    header for the full resolution, including the earlier (wrong) guess
//    made from dev-DB inspection before the production data was available.
//    Now IS wired into per-harness seeding (seedDefaultFooterActionsForHarness
//    in footerActions.ts); this assertion previously pinned the OLD, pre-C5
//    unwired state; see scripts/verify-footer-actions.ts for the
//    seeding-behavior coverage (per-harness idempotency, provenance
//    stamping, mutation tests, and the real-user-shaped fixture proving an
//    existing install's rows — of EITHER shape — are never touched).
//    filterActionsForHarness itself remains pure/non-mutating, still
//    asserted here.
// ---------------------------------------------------------------------------

{
  assert.equal(
    CLAUDE_DEFAULT_ACTIONS.length,
    8,
    'CLAUDE_DEFAULT_ACTIONS should describe exactly the 8 production rows (drift-resolved against real production data, C5)'
  )
  const claudeDescriptor = HARNESSES.find((h: HarnessDescriptor) => h.id === 'claude')
  assert.ok(claudeDescriptor, 'claude descriptor must exist in HARNESSES')
  assert.equal(
    claudeDescriptor!.defaultActions,
    CLAUDE_DEFAULT_ACTIONS,
    'the claude descriptor must carry the same CLAUDE_DEFAULT_ACTIONS array, not a copy'
  )

  const before = JSON.stringify(ALL_EIGHT_ACTIONS)
  filterActionsForHarness(ALL_EIGHT_ACTIONS, fixtureHarness())
  assert.equal(
    JSON.stringify(ALL_EIGHT_ACTIONS),
    before,
    'filterActionsForHarness must not mutate its input array/elements'
  )
  console.log(
    '✓ CLAUDE_DEFAULT_ACTIONS is the canonical 8-row list, matching real production data (now wired into per-harness seeding, C5) and filtering never mutates input'
  )
}

console.log('\nAll harness-actions assertions passed.')
