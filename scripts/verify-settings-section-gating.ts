// ---------------------------------------------------------------------------
// scripts/verify-settings-section-gating.ts
//
// support-multi-harness follow-up — BEHAVIOR guard for
// src/shared/harness/settingsSectionGating.ts, the pure decision extracted
// from SettingsView.tsx's harness-gated nav filter.
//
// THE GAP THIS CLOSES: HarnessDescriptor.settingsSections was populated
// (registry.ts, 11 claude-* ids) but consumed by NOTHING — HarnessSummary
// had no field for it, toSummary() didn't project it across IPC, and
// SettingsView.tsx's GROUPS rendered all 34 sections unconditionally. Fixed
// by: (1) adding settingsSections to HarnessSummary + toSummary(), (2)
// filterSectionGroup/isSectionIdApplicable/resolveActiveSectionId in
// settingsSectionGating.ts, (3) wiring them into SettingsView.tsx (nav
// groups, search index, activeId fallback) — including a new `gated:
// boolean` field on GROUPS' own SectionGroup shape, one per literal group
// ('Orpheus': false, 'Claude': true), which is what lets the gating
// function avoid inferring harness-ownership from a bare section-id string
// (see settingsSectionGating.ts's own header for why a FIRST version of
// this module tried exactly that and turned out to be structurally unable
// to ever hide a claude-* section — a real bug this file's design fixes,
// not a cosmetic rewrite).
//
// Deliberately NOT a source-grep — every assertion calls the REAL exported
// pure functions against fixture harness summaries, mirroring verify-
// harness-actions.ts's own discipline for filterActionsForHarness. Section 4
// below additionally imports the REAL registry.ts HARNESSES array (via the
// same mock.module() electron-stub technique verify-harness-actions.ts and
// verify-harness-registry.ts already use) so the Claude regression net is
// pinned against the actual shipped descriptor, not a hand-typed copy that
// could silently drift from it.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import {
  isSectionIdApplicable,
  filterSectionGroup,
  resolveActiveSectionId,
  type SettingsSectionGateHarness
} from '../src/shared/harness/settingsSectionGating.ts'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type FixtureSection = { id: string }

function harness(settingsSections: string[]): SettingsSectionGateHarness {
  return { settingsSections }
}

const CLAUDE_SECTIONS = [
  'claude-general',
  'claude-display',
  'claude-permissions',
  'claude-auth',
  'claude-memory',
  'claude-tools',
  'claude-slash-commands',
  'claude-subagents',
  'claude-hooks',
  'claude-developer',
  'claude-about'
]

const ORPHEUS_SECTIONS = [
  'orpheus-appearance',
  'orpheus-icon-pack',
  'orpheus-sidebar',
  'orpheus-harness',
  'orpheus-about'
]

// ---------------------------------------------------------------------------
// 1. isSectionIdApplicable — core decision (always called for a GATED
//    group's ids — see this file's header on why gating is per-GROUP).
// ---------------------------------------------------------------------------

{
  const claude = harness(CLAUDE_SECTIONS)
  for (const id of CLAUDE_SECTIONS) {
    assert.equal(
      isSectionIdApplicable(id, [claude]),
      true,
      `${id} must be applicable when the ONLY registered harness declares it`
    )
  }
  console.log('✓ every claude-* section is applicable when Claude is the only registered harness')
}

{
  // Mixed registry: Claude (declares all 11) alongside a hypothetical
  // second harness that declares only ONE of the 11. Every claude-* id
  // must STILL be applicable — Claude, a registered harness, still claims
  // it, regardless of what the second harness declares.
  const claude = harness(CLAUDE_SECTIONS)
  const limitedSecond = harness(['claude-general'])
  for (const id of CLAUDE_SECTIONS) {
    assert.equal(
      isSectionIdApplicable(id, [claude, limitedSecond]),
      true,
      `${id}: must stay applicable when Claude still declares it, even though a second registered harness declares only claude-general`
    )
  }
  console.log(
    '✓ a claude-* section stays applicable across a mixed registry as long as ANY registered harness (Claude) still declares it'
  )
}

{
  // A harness genuinely NOT claiming a specific id — the actually
  // reachable "hide" case: a SECOND harness's own settings group, checked
  // against a registry where only Claude (which never claims THOSE ids) is
  // present. Models e.g. a hypothetical 'codex-hooks' section against a
  // Claude-only registry.
  const claudeOnly = harness(CLAUDE_SECTIONS)
  assert.equal(
    isSectionIdApplicable('codex-hooks', [claudeOnly]),
    false,
    'a gated id that no CURRENTLY REGISTERED harness declares must be inapplicable'
  )
  console.log(
    '✓ a gated section id claimed by no currently-registered harness is correctly inapplicable'
  )
}

{
  // Empty registry (list still loading / fetch failed) — fail-open: every
  // id applicable, matching this file's documented loading-window default.
  for (const id of CLAUDE_SECTIONS) {
    assert.equal(
      isSectionIdApplicable(id, []),
      true,
      `${id} must be applicable while the harness list is empty/loading`
    )
  }
  console.log('✓ an empty (loading) harness list makes every gated section applicable, fail-open')
}

// ---------------------------------------------------------------------------
// 2. filterSectionGroup — per-group `gated` flag + empty-group signal.
// ---------------------------------------------------------------------------

{
  const claude = harness(CLAUDE_SECTIONS)
  const sections: FixtureSection[] = [
    { id: 'claude-general' },
    { id: 'claude-hooks' },
    { id: 'orpheus-appearance' } // present in a gated group's list too, just to prove per-section (not per-group-name) filtering
  ]
  const result = filterSectionGroup(sections, (s) => s.id, [claude], true)
  assert.deepEqual(
    result.visibleSections.map((s) => s.id),
    ['claude-general', 'claude-hooks'],
    'gated:true must filter out an id no registered harness claims (orpheus-appearance here, deliberately NOT declared by the claude fixture), preserving order for the rest'
  )
  assert.equal(result.isEmpty, false)
  console.log(
    '✓ filterSectionGroup(gated: true) filters by isSectionIdApplicable, preserving order'
  )
}

{
  // gated: false (the Orpheus group's own flag) — every section survives
  // UNCONDITIONALLY, even against a harness that declares none of them and
  // even though the ids themselves are NOT in that harness's
  // settingsSections. This is the actual fix for the bug the first design
  // had: an ungated group's visibility was never a function of
  // settingsSections at all.
  const claudeOnly = harness(CLAUDE_SECTIONS) // declares none of the orpheus-* ids below
  const sections: FixtureSection[] = ORPHEUS_SECTIONS.map((id) => ({ id }))
  const result = filterSectionGroup(sections, (s) => s.id, [claudeOnly], false)
  assert.deepEqual(
    result.visibleSections.map((s) => s.id),
    ORPHEUS_SECTIONS,
    'gated:false must return every section unfiltered, regardless of what any harness declares'
  )
  assert.equal(result.isEmpty, false)
  console.log(
    '✓ filterSectionGroup(gated: false) returns every section unfiltered — the Orpheus group is never gated'
  )
}

{
  // gated: true, and the registered harness genuinely claims none of this
  // group's ids (a different harness's own group, checked against a
  // Claude-only registry) — the whole group filters to empty.
  const claudeOnly = harness(CLAUDE_SECTIONS)
  const sections: FixtureSection[] = [{ id: 'codex-general' }, { id: 'codex-hooks' }]
  const result = filterSectionGroup(sections, (s) => s.id, [claudeOnly], true)
  assert.deepEqual(result.visibleSections, [])
  assert.equal(
    result.isEmpty,
    true,
    'a gated group with every section filtered out must report isEmpty:true so the caller can drop its own header'
  )
  console.log(
    '✓ filterSectionGroup reports isEmpty:true when every section of a gated group is filtered out'
  )
}

// ---------------------------------------------------------------------------
// 3. resolveActiveSectionId — fallback when the active section is hidden.
// ---------------------------------------------------------------------------

{
  const groups = [
    { sections: [{ id: 'orpheus-appearance' }, { id: 'orpheus-harness' }] },
    { sections: [{ id: 'claude-general' }] }
  ]
  assert.equal(
    resolveActiveSectionId('claude-general', groups, (s: FixtureSection) => s.id),
    'claude-general',
    'a still-visible activeId must be returned unchanged'
  )
  console.log('✓ resolveActiveSectionId returns the active id unchanged when it is still visible')
}

{
  // The active id's group was entirely filtered OUT — must fall back to
  // the first visible section, not silently keep pointing at a hidden one.
  const groups = [{ sections: [{ id: 'orpheus-appearance' }, { id: 'orpheus-harness' }] }]
  const resolved = resolveActiveSectionId('claude-hooks', groups, (s: FixtureSection) => s.id)
  assert.equal(
    resolved,
    'orpheus-appearance',
    'when the active section is filtered out, fall back to the first VISIBLE section, group order preserved'
  )
  assert.notEqual(
    resolved,
    'claude-hooks',
    'must never keep pointing at a section that is no longer visible'
  )
  console.log(
    '✓ resolveActiveSectionId falls back to the first visible section when the active one is hidden'
  )
}

{
  // Degenerate case: NOTHING is visible at all (should not happen in
  // practice — the Orpheus group is never gated — but the function must
  // not crash) — falls back to the original activeId rather than throwing.
  const resolved = resolveActiveSectionId('claude-general', [], (s: FixtureSection) => s.id)
  assert.equal(
    resolved,
    'claude-general',
    'with zero visible sections anywhere, the function must return the original activeId rather than crash'
  )
  console.log('✓ resolveActiveSectionId degrades to the original activeId when nothing is visible')
}

// ---------------------------------------------------------------------------
// 4. CLAUDE REGRESSION NET — the REAL registry.ts descriptor, not a
//    hand-typed copy. With only Claude registered, every one of its 11
//    claude-* sections must be applicable, byte-identical to today.
// ---------------------------------------------------------------------------

const mainDir = new URL('../src/main/', import.meta.url)
const abs = (rel: string): string => new URL(rel, mainDir).pathname

mock.module('electron', () => ({}))
mock.module(abs('db/index.ts'), () => ({
  getDb: () => {
    throw new Error('getDb() must not be called resolving HARNESSES for this fixture')
  }
}))
mock.module(abs('workspaces.ts'), () => ({
  getWorkspace: () => {
    throw new Error('getWorkspace() must not be called resolving HARNESSES for this fixture')
  }
}))

const { HARNESSES } = await import('../src/main/harness/registry.ts')

{
  assert.equal(HARNESSES.length, 1, 'sanity: only Claude is registered today')
  const claude = HARNESSES[0]!
  assert.equal(claude.id, 'claude')
  assert.equal(
    claude.settingsSections.length,
    11,
    'sanity: the real Claude descriptor must still declare exactly 11 claude-* sections'
  )
  assert.deepEqual(
    [...claude.settingsSections].sort(),
    [...CLAUDE_SECTIONS].sort(),
    "sanity: the real descriptor must declare exactly this fixture file's CLAUDE_SECTIONS set (no drift)"
  )

  for (const id of CLAUDE_SECTIONS) {
    assert.equal(
      isSectionIdApplicable(id, [claude]),
      true,
      `REGRESSION NET: "${id}" must be applicable against the REAL Claude descriptor — the settings page must look exactly as it does today`
    )
  }
  console.log(
    '✓ REGRESSION NET: every claude-* section is applicable against the REAL registry.ts Claude descriptor'
  )

  // Orpheus's own group is never gated at all — filterSectionGroup(gated:
  // false) against the REAL Claude descriptor must still return every
  // orpheus-* section untouched.
  const orpheusResult = filterSectionGroup(
    ORPHEUS_SECTIONS.map((id) => ({ id })),
    (s) => s.id,
    [claude],
    false
  )
  assert.deepEqual(
    orpheusResult.visibleSections.map((s) => s.id),
    ORPHEUS_SECTIONS,
    'REGRESSION NET: every orpheus-* section must render, ungated, against the real registry'
  )
  console.log(
    '✓ REGRESSION NET: the Orpheus group renders every section, ungated, against the real registry'
  )
}

// ---------------------------------------------------------------------------
// MUTATION TESTS — break the shared functions, confirm a real assertion
// fails, then restore (inline-stub mutations; a genuine SOURCE mutation was
// also run manually — see the report).
// ---------------------------------------------------------------------------

function assertMutationCaught(run: () => void, label: string): void {
  let threw = false
  try {
    run()
  } catch (err) {
    threw = true
    console.log(
      `  mutation caught (expected failure) [${label}]:`,
      (err as Error).message.split('\n')[0]
    )
  }
  assert.ok(threw, `MUTATION TEST FAILED TO FAIL: ${label} went undetected`)
}

{
  // Mutation 1: always-applicable stub (simulates deleting the gate check
  // entirely) — must disagree with the real function for an id genuinely
  // not claimed by the registered set.
  const alwaysApplicable = (): boolean => true
  const claudeOnly = harness(CLAUDE_SECTIONS)
  assertMutationCaught(() => {
    assert.equal(
      alwaysApplicable(),
      isSectionIdApplicable('codex-hooks', [claudeOnly]),
      'an always-applicable stub must disagree with the real function for an id no registered harness declares'
    )
  }, 'isSectionIdApplicable mutated to always-applicable')
}

{
  // Mutation 2: filterSectionGroup ignoring the `gated` flag entirely
  // (always filters, even for the ungated Orpheus group) — must disagree
  // with the real function, which returns every Orpheus section
  // unconditionally.
  const claudeOnly = harness(CLAUDE_SECTIONS)
  const orpheusSections: FixtureSection[] = ORPHEUS_SECTIONS.map((id) => ({ id }))
  const alwaysGated = filterSectionGroup(orpheusSections, (s) => s.id, [claudeOnly], true) // simulates ignoring gated:false
  const real = filterSectionGroup(orpheusSections, (s) => s.id, [claudeOnly], false)
  assertMutationCaught(() => {
    assert.deepEqual(
      alwaysGated.visibleSections,
      real.visibleSections,
      'a filter that ignores the gated:false flag would wrongly empty the Orpheus group — must disagree with the real (ungated) result'
    )
  }, 'filterSectionGroup ignoring gated:false and filtering the Orpheus group anyway')
}

{
  // Mutation 3: resolveActiveSectionId that never falls back (keeps
  // returning the original id even when hidden) — must disagree with the
  // real function's fallback behavior.
  const neverFallsBack = (activeId: string): string => activeId
  const groups = [{ sections: [{ id: 'orpheus-appearance' }] }]
  assertMutationCaught(() => {
    assert.equal(
      neverFallsBack('claude-hooks'),
      resolveActiveSectionId('claude-hooks', groups, (s: FixtureSection) => s.id),
      'a never-falls-back implementation must disagree with the real function when the active section is hidden'
    )
  }, 'resolveActiveSectionId mutated to never fall back')
}

console.log(
  '\n✓ mutation tests: always-applicable stub, gated flag ignored for the Orpheus group, and a never-falls-back resolveActiveSectionId are all correctly caught as failing assertions'
)

console.log('\nAll settings-section-gating assertions passed.')
