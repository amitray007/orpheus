// ---------------------------------------------------------------------------
// scripts/verify-harness-capability-gating.ts
//
// C4 (multi-harness migration) BEHAVIOR guard for TWO things at once:
//
//   Half A — the fallback bug: harnessStore.ts's CLAUDE_FALLBACK_SUMMARY
//   used to hardcode ALL EIGHT HarnessCapabilities to `true`, so a harness
//   whose capabilities were genuinely unknown (list still loading, or a
//   stale/unrecognized id) was reported as having Claude's FULL capability
//   set. Fixed by making both fallback paths grant NOTHING (see
//   src/renderer/src/lib/harnessStore.ts's UNKNOWN_CAPABILITIES_SUMMARY).
//
//   Half B — the (formerly) dead code: `capabilities.*` had ZERO renderer
//   consumers before this unit. Fixed by extracting each gating DECISION
//   into a pure function in src/shared/harness/capabilityGating.ts and
//   calling those functions from Sidebar.tsx (transcript-derived title/
//   freshness, live-activity claim), WorkspacesView.tsx/WorkspacesTab.tsx
//   (the "no session id -> waiting" inference), and WorkspaceTitleBar.tsx
//   (the usage/cost hover-card fetches).
//
// Runs as a plain `bun run` script — no Electron/DOM. capabilityGating.ts is
// pure (imports only ./types); harnessStore.ts imports `react`, which bun
// resolves fine for plain function calls (no JSX/DOM needed) — verified
// empirically the same way verify-harness-curated.ts imports curated.ts
// directly rather than going through session.ts's Electron/db chain.
//
// Covers:
//   1. THE REGRESSION NET (half A, positive case) — with Claude's REAL
//      capabilities (imported directly from
//      src/main/harness/claude/curated.ts's CLAUDE_CAPABILITIES, not
//      hand-typed, so this can't drift from the actual descriptor), every
//      gated decision matches today's UN-gated behavior exactly.
//   2. THE FALLBACK FIX (half A, negative case) — resolveHarnessSummary's
//      loading-fallback and unknown-id-fallback both grant NOTHING: every
//      capability is false, and every gated decision degrades accordingly.
//   3. transcript: false -> no transcript-derived title, no transcript-
//      derived freshness mtime, no false "waiting" inference from a missing
//      session id.
//   4. structuredStatus: false -> live activity must not be claimed.
//   5. usage: false -> the usage/cost hover-card fetches are gated off.
//   6. E1/E2/E3 (support-multi-harness follow-up) — three DropdownChip.tsx/
//      WorkspaceSettingsPopover.tsx blockers where a declared descriptor
//      behavior was silently ignored:
//        E1 — a harness declaring `curated.effort.liveApply = replInject`
//             must have that injection FIRE even when its models report
//             isClaude:false (the bug: DropdownChip.tsx gated the effort
//             branch on `currentModelIsClaude`, which dropped a
//             non-Claude harness's own declared liveApply).
//        E2 — an UNSET model on a non-Claude harness must not be treated
//             as Claude (isModelEffectivelyClaude, footerChipGating.ts).
//        E3 — the Loco toggle must be hidden for a harness that doesn't
//             own the underlying Claude CLI flag (shouldShowLocoToggle,
//             same file).
//      All three are asserted unchanged for Claude.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import type { HarnessCapabilities } from '../src/shared/harness/types.ts'
import {
  shouldUseTranscriptDerivedTitle,
  shouldUseTranscriptDerivedFreshness,
  shouldClaimLiveActivity,
  canMissingSessionIdImplyWaiting,
  shouldFetchUsageDetails,
  messageCountForWorkspace
} from '../src/shared/harness/capabilityGating.ts'
import {
  isModelEffectivelyClaude,
  shouldShowLocoToggle
} from '../src/shared/harness/footerChipGating.ts'
import { buildLiveApplyText } from '../src/shared/harness/liveApply.ts'
import { resolveHarnessSummary, isHarnessIdKnown } from '../src/renderer/src/lib/harnessStore.ts'
import { CLAUDE_CAPABILITIES, CLAUDE_CURATED } from '../src/main/harness/claude/curated.ts'
import type { HarnessSummary } from '../src/shared/types.ts'
import type { CuratedField } from '../src/shared/harness/types.ts'

const ALL_FALSE: HarnessCapabilities = {
  structuredStatus: false,
  transcript: false,
  resume: false,
  fork: false,
  usage: false,
  hooks: false,
  inlineSettingsJson: false,
  modelRouting: false
}

function makeSummary(id: string, capabilities: HarnessCapabilities): HarnessSummary {
  return { id, label: id, binary: id, capabilities }
}

// ---------------------------------------------------------------------------
// 1. THE REGRESSION NET — Claude's real capabilities must be a complete
//    no-op for every gated decision. Fixture is CLAUDE_CAPABILITIES itself
//    (the real descriptor's source of truth), not a hand-typed {...: true}
//    literal disconnected from it — so if a future edit to curated.ts ever
//    flips one of Claude's flags to false, this assertion fails loudly
//    instead of silently testing a stale copy.
// ---------------------------------------------------------------------------

function testClaudeEquivalence(): void {
  assert.equal(
    Object.values(CLAUDE_CAPABILITIES).every((v) => v === true),
    true,
    'fixture sanity: CLAUDE_CAPABILITIES must be all-true today — if this fails, Claude capability ' +
      'values changed and the "byte-identical" regression net below is no longer meaningful as written'
  )

  assert.equal(
    shouldUseTranscriptDerivedTitle(CLAUDE_CAPABILITIES),
    true,
    "Claude must still resolve transcript-derived session titles (today's behavior)"
  )
  assert.equal(
    shouldUseTranscriptDerivedFreshness(CLAUDE_CAPABILITIES),
    true,
    "Claude must still resolve transcript-derived (jsonl mtime) freshness (today's behavior)"
  )
  assert.equal(
    shouldClaimLiveActivity(CLAUDE_CAPABILITIES),
    true,
    "Claude must still claim/render live activity status (today's behavior)"
  )
  assert.equal(
    canMissingSessionIdImplyWaiting(CLAUDE_CAPABILITIES),
    true,
    'Claude must still treat "no session id yet" as a real "waiting to start" signal (today\'s behavior)'
  )
  assert.equal(
    shouldFetchUsageDetails(CLAUDE_CAPABILITIES),
    true,
    "Claude must still fire the usage/cost hover-card fetches (today's behavior)"
  )
  assert.equal(
    messageCountForWorkspace(
      { claudeSessionId: 'sess-1' },
      { 'sess-1': { messageCount: 42 } },
      CLAUDE_CAPABILITIES
    ),
    42,
    "Claude must still resolve the Msgs-column count from sessionStats (today's behavior)"
  )
}

// ---------------------------------------------------------------------------
// 2. THE FALLBACK FIX — loading and unknown-id fallbacks grant NOTHING.
// ---------------------------------------------------------------------------

function testFallbackGrantsNothing(): void {
  // Unknown id, list already loaded (durably unknown).
  const loadedList: HarnessSummary[] = [makeSummary('claude', CLAUDE_CAPABILITIES)]
  const unknownSummary = resolveHarnessSummary(loadedList, 'some-future-harness-cli')
  assert.deepEqual(
    unknownSummary.capabilities,
    ALL_FALSE,
    'an id absent from a LOADED list must resolve to all-false capabilities, not a Claude-shaped fallback'
  )
  assert.equal(
    isHarnessIdKnown(loadedList, 'some-future-harness-cli'),
    false,
    'isHarnessIdKnown must report false for an id the loaded list does not contain'
  )
  assert.equal(
    isHarnessIdKnown(loadedList, 'claude'),
    true,
    'isHarnessIdKnown must report true for an id the loaded list DOES contain (sanity check)'
  )

  // List still loading (empty harnesses array is what the store's initial
  // state looks like before harness:list resolves).
  const loadingSummary = resolveHarnessSummary([], 'claude')
  assert.deepEqual(
    loadingSummary.capabilities,
    ALL_FALSE,
    'the loading-window fallback (empty harnesses list) must grant no capabilities'
  )

  // Absent/null/undefined id — same never-throws contract, same all-false grant.
  for (const id of [null, undefined, ''] as const) {
    const summary = resolveHarnessSummary(loadedList, id)
    assert.deepEqual(
      summary.capabilities,
      ALL_FALSE,
      `resolveHarnessSummary(${JSON.stringify(id)}) must grant no capabilities`
    )
  }

  // Every gated decision must degrade for the fallback, not just the raw
  // capability object — proves the gates actually consult the fallback's
  // values rather than some other all-true default.
  assert.equal(shouldUseTranscriptDerivedTitle(unknownSummary.capabilities), false)
  assert.equal(shouldUseTranscriptDerivedFreshness(unknownSummary.capabilities), false)
  assert.equal(shouldClaimLiveActivity(unknownSummary.capabilities), false)
  assert.equal(canMissingSessionIdImplyWaiting(unknownSummary.capabilities), false)
  assert.equal(shouldFetchUsageDetails(unknownSummary.capabilities), false)
  assert.equal(
    messageCountForWorkspace(
      { claudeSessionId: 'sess-1' },
      { 'sess-1': { messageCount: 42 } },
      unknownSummary.capabilities
    ),
    null,
    'an unknown/fallback harness must not resolve a Msgs-column count'
  )
}

// ---------------------------------------------------------------------------
// 3. transcript: false — title/freshness/status-group degradation.
// ---------------------------------------------------------------------------

function testTranscriptGate(): void {
  const withTranscript: HarnessCapabilities = { ...ALL_FALSE, transcript: true }
  const withoutTranscript: HarnessCapabilities = { ...ALL_FALSE, transcript: false }

  assert.equal(shouldUseTranscriptDerivedTitle(withTranscript), true)
  assert.equal(
    shouldUseTranscriptDerivedTitle(withoutTranscript),
    false,
    'a transcript-incapable harness must not resolve a transcript-derived session title'
  )

  assert.equal(shouldUseTranscriptDerivedFreshness(withTranscript), true)
  assert.equal(
    shouldUseTranscriptDerivedFreshness(withoutTranscript),
    false,
    'a transcript-incapable harness must not resolve transcript-derived (jsonl mtime) freshness'
  )

  assert.equal(
    canMissingSessionIdImplyWaiting(withTranscript),
    true,
    'a transcript-capable harness with no session id yet is honestly "waiting to start"'
  )
  assert.equal(
    canMissingSessionIdImplyWaiting(withoutTranscript),
    false,
    'a transcript-incapable harness can NEVER populate a session id — that absence must not be read as a real signal'
  )
}

// ---------------------------------------------------------------------------
// 3b. transcript: false — Msgs-column count degradation (WorkspacesTab.tsx's
//     messageCountForWorkspace, D1 support-multi-harness).
// ---------------------------------------------------------------------------

function testMessageCountGate(): void {
  const withTranscript: HarnessCapabilities = { ...ALL_FALSE, transcript: true }
  const withoutTranscript: HarnessCapabilities = { ...ALL_FALSE, transcript: false }
  const stats = { 'sess-1': { messageCount: 42 } }

  assert.equal(
    messageCountForWorkspace({ claudeSessionId: 'sess-1' }, stats, withTranscript),
    42,
    'a transcript-capable harness with a populated sessionStats entry must resolve its message count'
  )
  assert.equal(
    messageCountForWorkspace({ claudeSessionId: 'sess-1' }, stats, withoutTranscript),
    null,
    'a transcript-incapable harness must not resolve a Msgs-column count even if sessionStats happens to hold a value'
  )
  assert.equal(
    messageCountForWorkspace({ claudeSessionId: null }, stats, withTranscript),
    null,
    'no claudeSessionId yet must resolve to null regardless of capability (nothing to look up)'
  )
}

// ---------------------------------------------------------------------------
// 4. structuredStatus: false — live activity must not be claimed.
// ---------------------------------------------------------------------------

function testStructuredStatusGate(): void {
  const withStatus: HarnessCapabilities = { ...ALL_FALSE, structuredStatus: true }
  const withoutStatus: HarnessCapabilities = { ...ALL_FALSE, structuredStatus: false }

  assert.equal(shouldClaimLiveActivity(withStatus), true)
  assert.equal(
    shouldClaimLiveActivity(withoutStatus),
    false,
    'a structuredStatus-incapable harness must not have live activity claimed/rendered for it'
  )
}

// ---------------------------------------------------------------------------
// 5. usage: false — usage/cost hover-card fetches gated off.
// ---------------------------------------------------------------------------

function testUsageGate(): void {
  const withUsage: HarnessCapabilities = { ...ALL_FALSE, usage: true }
  const withoutUsage: HarnessCapabilities = { ...ALL_FALSE, usage: false }

  assert.equal(shouldFetchUsageDetails(withUsage), true)
  assert.equal(
    shouldFetchUsageDetails(withoutUsage),
    false,
    'a usage-incapable harness must not fire the session.getUsage/session.getCost hover-card fetches'
  )
}

// ---------------------------------------------------------------------------
// 6. E1 — a harness's declared replInject liveApply must fire regardless of
//    isClaude. Simulates DropdownChip.tsx's effort onSelect handler: after
//    the fix, the call site is just `buildLiveApplyText(harness.curated
//    ?.effort, value)` with no `currentModelIsClaude` gate around it (see
//    DropdownChip.tsx's onSelect for footer.effortSelect). This directly
//    exercises that exact call against a NON-Claude, replInject-declaring
//    descriptor — the case the old `if (currentModelIsClaude)` guard would
//    have silently dropped.
// ---------------------------------------------------------------------------

const NON_CLAUDE_REPL_INJECT_EFFORT: CuratedField = {
  options: ['low', 'high'],
  allowCustom: true,
  liveApply: { kind: 'replInject', template: '/reasoning {value}', submit: true },
  flag: '--effort'
}

function testE1EffortLiveApplyIgnoresModelProvider(): void {
  // The bug case: a harness whose curated.effort declares replInject, but
  // whose selectableModels entries (or lack thereof) report isClaude:false.
  // The fixed call site — buildLiveApplyText alone, no model-provider gate
  // — must still build injectable text.
  const result = buildLiveApplyText(NON_CLAUDE_REPL_INJECT_EFFORT, 'high')
  assert.deepEqual(
    result,
    { kind: 'inject', text: '/reasoning high', submit: true },
    'E1: a harness declaring replInject for effort must have that liveApply text built ' +
      'even though its own models are not Claude — the descriptor is the sole authority, ' +
      'not a currentModelIsClaude side-gate'
  )

  // Claude unchanged: same call shape, same real descriptor, same literal
  // "/effort high" the pre-refactor hardcoded string produced.
  assert.deepEqual(
    buildLiveApplyText(CLAUDE_CURATED.effort, 'high'),
    { kind: 'inject', text: '/effort high', submit: true },
    'E1 regression net: Claude effort liveApply must remain exactly "/effort high", submit:true'
  )

  // A restartRequired harness must still produce no injectable text (proves
  // this isn't "always inject now" — buildLiveApplyText's own kind gate
  // still applies, only the extra model-provider gate was removed).
  const restartOnly: CuratedField = {
    options: [],
    allowCustom: true,
    liveApply: { kind: 'restartRequired' },
    flag: '--effort'
  }
  assert.deepEqual(
    buildLiveApplyText(restartOnly, 'high'),
    { kind: 'restartRequired' },
    'E1: a restartRequired harness must still signal restartRequired, not inject'
  )
}

// MUTATION: reinstate the currentModelIsClaude guard around the call —
// i.e. simulate "only build liveApply text when isClaude is true" — and
// confirm the E1 case above would have been (wrongly) suppressed.
function testE1Mutation(): void {
  const currentModelIsClaude = false // the non-Claude harness's own model list
  const guarded = currentModelIsClaude
    ? buildLiveApplyText(NON_CLAUDE_REPL_INJECT_EFFORT, 'high')
    : { kind: 'none' as const }
  try {
    assert.deepEqual(guarded, { kind: 'inject', text: '/reasoning high', submit: true })
    throw new Error('E1 mutation did not fail as expected')
  } catch (e) {
    assert.ok(
      e instanceof assert.AssertionError,
      'E1 mutation must fail via AssertionError, not some other error'
    )
    console.log(
      `  mutation caught (expected failure) [E1 currentModelIsClaude guard reinstated]: ${(e as Error).message.split('\n')[0]}`
    )
  }
}

// ---------------------------------------------------------------------------
// 7. E2 — isModelEffectivelyClaude: an unset model on a non-Claude harness
//    must not be treated as Claude.
// ---------------------------------------------------------------------------

type ModelLookup = { id: string; isClaude: boolean }
const MODELS: ModelLookup[] = [
  { id: 'opus', isClaude: true },
  { id: 'grok-4', isClaude: false }
]

function testE2UnsetModelNotClaudeOnNonClaudeHarness(): void {
  assert.equal(
    isModelEffectivelyClaude('codex-cli', MODELS, ''),
    false,
    'E2: an unset model on a non-Claude harness must not resolve to isClaude:true'
  )
  assert.equal(
    isModelEffectivelyClaude('codex-cli', MODELS, 'some-transient-fetch-gap-id'),
    false,
    'E2: a model absent from the list on a non-Claude harness must not resolve to isClaude:true'
  )
  // Present-in-list answers always come from the model's own flag,
  // regardless of harness id.
  assert.equal(isModelEffectivelyClaude('codex-cli', MODELS, 'opus'), true)
  assert.equal(isModelEffectivelyClaude('claude', MODELS, 'grok-4'), false)

  // Claude unchanged: unset model on a Claude workspace still resolves true
  // (today's behavior — a Claude workspace mid-fetch still gets its
  // live-apply chip).
  assert.equal(
    isModelEffectivelyClaude('claude', MODELS, ''),
    true,
    'E2 regression net: an unset model on a Claude harness must still resolve isClaude:true'
  )
  assert.equal(
    isModelEffectivelyClaude('claude', [], 'not-yet-loaded'),
    true,
    'E2 regression net: a Claude harness with a not-yet-loaded model list must still resolve isClaude:true'
  )
}

// MUTATION: restore the old `?? modelValue === ''` behavior (unset always
// means Claude, regardless of harness) and confirm it wrongly passes for a
// non-Claude harness.
function testE2Mutation(): void {
  const oldBehavior = (models: ModelLookup[], modelValue: string): boolean =>
    models.find((m) => m.id === modelValue)?.isClaude ?? modelValue === ''
  try {
    assert.equal(
      oldBehavior(MODELS, ''),
      false,
      'the OLD `?? modelValue === \'\'` resolution must be shown wrong: it resolves true for ANY unset model'
    )
    throw new Error('E2 mutation did not fail as expected')
  } catch (e) {
    assert.ok(e instanceof assert.AssertionError)
    console.log(
      `  mutation caught (expected failure) [E2 old modelValue === '' fallback restored]: ${(e as Error).message.split('\n')[0]}`
    )
  }
}

// ---------------------------------------------------------------------------
// 8. E3 — shouldShowLocoToggle: hidden for a harness that doesn't own the
//    flag, shown for Claude (and for the absent/unresolved default).
// ---------------------------------------------------------------------------

function testE3LocoToggleGate(): void {
  assert.equal(shouldShowLocoToggle('codex-cli'), false, 'E3: a non-Claude harness must hide the Loco toggle')
  assert.equal(shouldShowLocoToggle('claude'), true, 'E3 regression net: Claude must still show the Loco toggle')
  assert.equal(
    shouldShowLocoToggle(undefined),
    true,
    'E3: an unresolved/absent harnessId must default to shown (matches pre-fix behavior for the only registered harness today)'
  )
  assert.equal(shouldShowLocoToggle(null), true, 'E3: null harnessId must also default to shown')
}

// MUTATION: ungate the toggle (always show) and confirm it wrongly passes
// for a non-Claude harness.
function testE3Mutation(): void {
  const ungated = (): boolean => true
  try {
    assert.equal(
      ungated(),
      false,
      'an ungated toggle must be shown false-for-non-Claude to be correct — always-true fails that'
    )
    throw new Error('E3 mutation did not fail as expected')
  } catch (e) {
    assert.ok(e instanceof assert.AssertionError)
    console.log(
      `  mutation caught (expected failure) [E3 toggle ungated / always shown]: ${(e as Error).message.split('\n')[0]}`
    )
  }
}

testClaudeEquivalence()
testFallbackGrantsNothing()
testTranscriptGate()
testMessageCountGate()
testStructuredStatusGate()
testUsageGate()
testE1EffortLiveApplyIgnoresModelProvider()
testE1Mutation()
testE2UnsetModelNotClaudeOnNonClaudeHarness()
testE2Mutation()
testE3LocoToggleGate()
testE3Mutation()

console.log('verify-harness-capability-gating: all assertions passed')
