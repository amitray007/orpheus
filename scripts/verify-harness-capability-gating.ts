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
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import type { HarnessCapabilities } from '../src/shared/harness/types.ts'
import {
  shouldUseTranscriptDerivedTitle,
  shouldUseTranscriptDerivedFreshness,
  shouldClaimLiveActivity,
  canMissingSessionIdImplyWaiting,
  shouldFetchUsageDetails
} from '../src/shared/harness/capabilityGating.ts'
import { resolveHarnessSummary, isHarnessIdKnown } from '../src/renderer/src/lib/harnessStore.ts'
import { CLAUDE_CAPABILITIES } from '../src/main/harness/claude/curated.ts'
import type { HarnessSummary } from '../src/shared/types.ts'

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

testClaudeEquivalence()
testFallbackGrantsNothing()
testTranscriptGate()
testStructuredStatusGate()
testUsageGate()

console.log('verify-harness-capability-gating: all assertions passed')
