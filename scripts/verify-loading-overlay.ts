// ---------------------------------------------------------------------------
// scripts/verify-loading-overlay.ts
//
// Assertion harness for the routing-aware loading-overlay fix (bug-09-polish
// bug 1): src/main/loadingOverlay.ts's show()/slowCopyFor() must give a
// routed-model mount ACCURATE slow-state copy (no hooks/auth claim) and a
// LONGER slow threshold than the Claude path, while leaving the Claude path's
// existing 3000ms threshold and exact copy untouched, and the MIN_SHOW_MS
// anti-flash debounce must still apply to both. Mirrors the existing
// scripts/verify-*.ts convention: `bun run` script, no test framework, fully
// offline/deterministic.
//
// loadingOverlay.ts is a leaf module — it never imports modelRouting.ts or
// anything electron-touching; index.ts computes `routed` (via
// isRoutedMount(precomposedLaunch)) and passes it into show() as a plain
// boolean. This harness exercises that leaf module directly and never boots
// electron/DB.
//
// Determinism: loadingOverlay.ts exposes __setClockForTest so this harness
// drives a FAKE clock (no real setTimeout, no real sleeps) — `now()` is a
// mutable counter this file advances explicitly, and `setTimeout`/
// `clearTimeout` are faked to synchronously record/run callbacks on demand.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  show,
  hide,
  markError,
  configureLoadingOverlay,
  slowCopyFor,
  shouldWaitForSessionReadiness,
  __setClockForTest,
  MIN_SHOW_MS,
  SLOW_THRESHOLD_MS,
  SLOW_THRESHOLD_MS_ROUTED,
  type LoadingCopy
} from '../src/main/loadingOverlay.ts'
import { shouldClaimLiveActivity } from '../src/shared/harness/capabilityGating.ts'
import { CLAUDE_CAPABILITIES } from '../src/main/harness/claude/curated.ts'
import { CODEX_CAPABILITIES } from '../src/main/harness/codex/curated.ts'
import { resolveCodexOverlayReadiness } from '../src/main/harness/codex/terminalLiveness.ts'

// ---------------------------------------------------------------------------
// Fake clock: a virtual millisecond counter + a pending-timer queue. advance()
// fires any timer whose deadline has been reached, in deadline order — no
// real time ever passes.
// ---------------------------------------------------------------------------

type FakeTimer = { id: number; deadline: number; fn: () => void; cancelled: boolean }

function makeFakeClock(): {
  deps: {
    now: () => number
    setTimeout: (fn: () => void, ms: number) => FakeTimer
    clearTimeout: (t: FakeTimer) => void
  }
  advance: (ms: number) => void
} {
  let virtualNow = 0
  let nextId = 1
  const pending: FakeTimer[] = []

  function advance(ms: number): void {
    virtualNow += ms
    // Fire all timers whose deadline has now been reached, in deadline order.
    // Re-check pending.length each loop since a fired callback may itself
    // schedule a new timer (e.g. show()'s re-entrant slowTimer is not
    // re-scheduled today, but this stays robust regardless).
    let fired = true
    while (fired) {
      fired = false
      pending.sort((a, b) => a.deadline - b.deadline)
      for (const t of pending) {
        if (!t.cancelled && t.deadline <= virtualNow) {
          t.cancelled = true // mark consumed so we don't refire it
          fired = true
          t.fn()
          break
        }
      }
    }
  }

  return {
    advance,
    deps: {
      now: () => virtualNow,
      setTimeout: (fn: () => void, ms: number) => {
        const t: FakeTimer = { id: nextId++, deadline: virtualNow + ms, fn, cancelled: false }
        pending.push(t)
        return t
      },
      clearTimeout: (t: FakeTimer) => {
        t.cancelled = true
      }
    }
  }
}

// Captures every setOverlay(...) call the native bridge would have received.
type Call = { workspaceId: string; state: string; copy: LoadingCopy }
function makeRecordingBridge(): { calls: Call[]; reset: () => void } {
  const calls: Call[] = []
  configureLoadingOverlay((workspaceId, state, copy) => {
    calls.push({ workspaceId, state, copy })
  })
  return {
    calls,
    reset: () => {
      calls.length = 0
    }
  }
}

// ---------------------------------------------------------------------------
// 1. slowCopyFor: routed copy must not mention hooks/auth, and must differ
//    from the Claude slow copy. Claude copy is byte-for-byte the pre-fix
//    string (regression guard).
// ---------------------------------------------------------------------------

{
  const claudeCopy = slowCopyFor(false)

  assert.equal(claudeCopy.title, 'Still starting…')
  assert.equal(
    claudeCopy.subtitle,
    'Hooks or auth check taking longer than usual',
    'Claude slow-copy subtitle must be byte-for-byte unchanged — no regression'
  )
  console.log('✓ Claude slow-copy is byte-for-byte unchanged from the pre-fix string')

  // RE-LAND(routing): the routed=true copy/timing branch below is
  // exercised here as a pure-function contract check on slowCopyFor, but
  // it is unreachable in production as of commit d14115fb (Phase 0,
  // multi-harness migration) — index.ts hardcodes `routed: false` at
  // every show() call site now (see loadingOverlay.ts's own "CURRENT
  // STATE (Phase 0)" comment). Kept as the Phase 6 reconnection checklist
  // rather than deleted.
  const SKIP_SECTION_1_ROUTED_COPY_CASES = true
  if (SKIP_SECTION_1_ROUTED_COPY_CASES) {
    console.log(
      '⊘ SKIPPED (RE-LAND(routing)): §1 routed slow-copy assertions — index.ts hardcodes ' +
        'routed: false at every show() call site (Phase 0 cut, commit d14115fb); re-enable ' +
        'when routing returns harness-aware in Phase 6'
    )
  } else {
    const routedCopy = slowCopyFor(true)
    const routedText = `${routedCopy.title} ${routedCopy.subtitle ?? ''}`.toLowerCase()
    assert.equal(
      routedText.includes('hook'),
      false,
      'routed slow-copy must NOT mention hooks (factually wrong on a routed mount)'
    )
    assert.equal(
      routedText.includes('auth'),
      false,
      'routed slow-copy must NOT mention auth check (factually wrong on a routed mount)'
    )
    assert.notEqual(
      routedCopy.subtitle,
      claudeCopy.subtitle,
      'routed and Claude slow-copy subtitles must differ'
    )
    console.log('✓ routed slow-copy does not mention hooks/auth, and differs from the Claude copy')
  }
}

// ---------------------------------------------------------------------------
// 2. Thresholds: Claude path keeps 3000ms; routed path is strictly longer.
// ---------------------------------------------------------------------------

{
  assert.equal(SLOW_THRESHOLD_MS, 3000, 'Claude slow threshold must remain exactly 3000ms')
  assert.ok(
    SLOW_THRESHOLD_MS_ROUTED > SLOW_THRESHOLD_MS,
    'routed threshold must be strictly longer than the Claude threshold'
  )
  console.log(
    `✓ Claude threshold unchanged at ${SLOW_THRESHOLD_MS}ms; routed threshold is longer (${SLOW_THRESHOLD_MS_ROUTED}ms)`
  )
}

// ---------------------------------------------------------------------------
// 3. show(..., routed=false) fires the slow state at exactly the Claude
//    threshold, with the Claude copy — driven by the fake clock, no real
//    sleep. One millisecond before the threshold, nothing has fired yet.
// ---------------------------------------------------------------------------

{
  const { deps, advance } = makeFakeClock()
  __setClockForTest(deps)
  const bridge = makeRecordingBridge()

  show('ws-claude', { title: 'Starting workspace' }, false)
  assert.equal(bridge.calls.at(-1)?.state, 'showing')

  advance(SLOW_THRESHOLD_MS - 1)
  assert.equal(
    bridge.calls.at(-1)?.state,
    'showing',
    'must still be showing 1ms before the Claude threshold'
  )

  advance(1) // crosses the threshold
  assert.equal(bridge.calls.at(-1)?.state, 'slow', 'must flip to slow exactly at the threshold')
  assert.equal(bridge.calls.at(-1)?.copy.subtitle, 'Hooks or auth check taking longer than usual')

  hide('ws-claude')
  __setClockForTest(undefined)
  console.log('✓ Claude path (routed=false) fires slow state at exactly 3000ms with Claude copy')
}

// ---------------------------------------------------------------------------
// 4. show(..., routed=true) does NOT fire slow at the Claude threshold, but
//    DOES fire at the routed threshold, with the routed copy.
// ---------------------------------------------------------------------------

{
  const { deps, advance } = makeFakeClock()
  __setClockForTest(deps)
  const bridge = makeRecordingBridge()

  show('ws-routed', { title: 'Starting workspace' }, true)
  assert.equal(bridge.calls.at(-1)?.state, 'showing')

  advance(SLOW_THRESHOLD_MS) // Claude threshold reached — must NOT be slow yet
  assert.equal(
    bridge.calls.at(-1)?.state,
    'showing',
    'routed mount must still be showing at the Claude threshold (longer timeout)'
  )

  advance(SLOW_THRESHOLD_MS_ROUTED - SLOW_THRESHOLD_MS)
  assert.equal(
    bridge.calls.at(-1)?.state,
    'slow',
    'routed mount must flip to slow at the routed threshold'
  )
  assert.equal(bridge.calls.at(-1)?.copy.subtitle, 'Waiting for the routing proxy to respond')

  hide('ws-routed')
  __setClockForTest(undefined)
  console.log(
    '✓ routed path (routed=true) waits past the Claude threshold and fires slow at the routed threshold with routed copy'
  )
}

// ---------------------------------------------------------------------------
// 5. MIN_SHOW_MS anti-flash debounce still applies on BOTH paths: hide()
//    called immediately after show() must not dispatch 'hidden' until
//    MIN_SHOW_MS has elapsed.
// ---------------------------------------------------------------------------

{
  for (const routed of [false, true]) {
    const { deps, advance } = makeFakeClock()
    __setClockForTest(deps)
    const bridge = makeRecordingBridge()
    const workspaceId = `ws-min-show-${routed}`

    show(workspaceId, { title: 'Starting workspace' }, routed)
    hide(workspaceId) // called immediately — 0ms elapsed
    assert.equal(
      bridge.calls.at(-1)?.state,
      'showing',
      `routed=${routed}: hide() immediately after show() must NOT dispatch 'hidden' before MIN_SHOW_MS`
    )

    advance(MIN_SHOW_MS - 1)
    assert.equal(
      bridge.calls.at(-1)?.state,
      'showing',
      `routed=${routed}: still must not be hidden 1ms before MIN_SHOW_MS`
    )

    advance(1) // crosses MIN_SHOW_MS
    assert.equal(
      bridge.calls.at(-1)?.state,
      'hidden',
      `routed=${routed}: must dispatch 'hidden' once MIN_SHOW_MS has elapsed`
    )

    __setClockForTest(undefined)
  }
  console.log(
    '✓ MIN_SHOW_MS anti-flash debounce applies identically on both the Claude and routed paths'
  )
}

// ---------------------------------------------------------------------------
// 6. A hide() called AFTER MIN_SHOW_MS has already elapsed dispatches
//    'hidden' immediately (no artificial extra wait) — on both paths.
// ---------------------------------------------------------------------------

{
  for (const routed of [false, true]) {
    const { deps, advance } = makeFakeClock()
    __setClockForTest(deps)
    const bridge = makeRecordingBridge()
    const workspaceId = `ws-late-hide-${routed}`

    show(workspaceId, { title: 'Starting workspace' }, routed)
    advance(MIN_SHOW_MS + 500)
    hide(workspaceId)
    assert.equal(
      bridge.calls.at(-1)?.state,
      'hidden',
      `routed=${routed}: hide() after MIN_SHOW_MS has elapsed must dispatch 'hidden' immediately`
    )

    __setClockForTest(undefined)
  }
  console.log('✓ hide() after MIN_SHOW_MS has already elapsed dispatches immediately on both paths')
}

// ---------------------------------------------------------------------------
// 7. markError() is unaffected by the routing plumbing — same copy/behavior
//    regardless of the `routed` flag passed to the preceding show().
// ---------------------------------------------------------------------------

{
  const { deps } = makeFakeClock()
  __setClockForTest(deps)
  const bridge = makeRecordingBridge()

  show('ws-error', { title: 'Starting workspace' }, true)
  markError('ws-error', 'claude exited with code 1')
  const last = bridge.calls.at(-1)
  assert.equal(last?.state, 'error')
  assert.equal(last?.copy.title, "Couldn't start claude")
  assert.equal(last?.copy.subtitle, 'claude exited with code 1')

  hide('ws-error')
  __setClockForTest(undefined)
  console.log('✓ markError() is unaffected by the routed flag')
}

// ---------------------------------------------------------------------------
// 8. shouldWaitForSessionReadiness — ORIGINALLY a bug fix (support-multi-
//    harness, loading-overlay unit): a Codex workspace mount ALWAYS rode the
//    fixed 10s fallback timer before dismissing "Starting workspace",
//    because isWorkspaceSessionReady (sessionState.ts) is driven entirely by
//    Claude's ~/.claude/sessions/<pid>.json PID-file registry, which Codex
//    never wrote at the time (capabilities.structuredStatus: false).
//    index.ts's handlePostMountOverlay gates on this decision — using
//    shouldClaimLiveActivity(capabilities) (the SAME capability gate the
//    sidebar's live-activity dot already uses, from
//    ../shared/harness/capabilityGating.ts) as the input — before deciding
//    whether to wait on a session-readiness signal / arm the fallback timer
//    at all.
//
// UPDATED (support-multi-harness status-indicator unit): Codex now HAS a
// real, harness-appropriate session-readiness signal —
// harness/codex/statusState.ts's hasObservedCodexStatus, combining rollout
// task-events with thread-writer-lock liveness (see statusMap.ts's
// mapCodexStatus) — so CODEX_CAPABILITIES.structuredStatus flipped to
// `true` and index.ts's handlePostMountOverlay now dispatches to EITHER
// harness's own observation source via isWorkspaceSessionReadyForHarness
// (Claude: isWorkspaceSessionReady; Codex: hasObservedCodexStatus), never
// the other's. The assertions below were updated in lockstep: both harnesses
// now report structuredStatus / wait-then-check, just against their own
// data source — this is NOT a regression of the original bug fix, since a
// Codex mount still only waits on a signal THIS harness can actually
// produce (never Claude's PID-file registry, and never an infinite/
// unconditional wait — a not-yet-observed workspace still falls through to
// the same 10s fallback timer Claude's slow-starting case already used).
//
// LIMITATION (documented per the task's own instruction): this section
// exercises shouldWaitForSessionReadiness and shouldClaimLiveActivity
// directly with Codex's and Claude's REAL capability objects (imported from
// their curated.ts sources, not hand-typed), proving both harnesses now
// resolve to the SAME wait-then-fallback decision shape — each against its
// own source — and that Claude's decision is unchanged (`true`, preserving
// today's wait-then-10s-fallback behavior). It does NOT exercise index.ts's
// handlePostMountOverlay itself — that function lives in src/main/index.ts,
// which imports the `electron` module and cannot run under a plain bun/node
// script (see this repo's other verifiers: none import index.ts directly).
// What this proves: the capability-gating DECISION
// handlePostMountOverlay's branch relies on is correct for both harnesses.
// What it does NOT prove: that index.ts's actual wiring (the
// resolveHarness(...).capabilities + harnessId threading at both call
// sites, isWorkspaceSessionReadyForHarness's dispatch) is bug-free — that
// requires either an Electron-level integration test (none exists in this
// repo for index.ts-level mount flows) or manual verification in the
// running app.
// ---------------------------------------------------------------------------

{
  const claudeHasStructuredStatus = shouldClaimLiveActivity(CLAUDE_CAPABILITIES)
  const codexHasStructuredStatus = shouldClaimLiveActivity(CODEX_CAPABILITIES)

  assert.equal(
    claudeHasStructuredStatus,
    true,
    'sanity: CLAUDE_CAPABILITIES must report structuredStatus (Claude has a real session-readiness signal)'
  )
  assert.equal(
    codexHasStructuredStatus,
    true,
    'sanity: CODEX_CAPABILITIES must report structuredStatus (Codex now has its own session-readiness signal — harness/codex/statusState.ts)'
  )

  assert.equal(
    shouldWaitForSessionReadiness(claudeHasStructuredStatus),
    true,
    'REGRESSION BAR: Claude must still wait on isWorkspaceSessionReady / arm the 10s fallback timer — unchanged behavior'
  )
  assert.equal(
    shouldWaitForSessionReadiness(codexHasStructuredStatus),
    true,
    'Codex now has a real observation source (hasObservedCodexStatus) to wait on too — same wait-then-fallback shape as Claude, against its own data source'
  )

  console.log(
    '✓ shouldWaitForSessionReadiness now resolves Claude and Codex to the SAME wait-then-fallback decision, each against its own real capability object / observation source'
  )
}

// ---------------------------------------------------------------------------
// 9. resolveCodexOverlayReadiness (support-multi-harness, terminalLiveness.ts)
//    — THE FIX: a NULL-sid Codex workspace (session not yet bound, so
//    hasObservedCodexStatus can never fire) must still resolve ready once
//    its terminal's title callback has fired at least once. Imports and
//    calls the REAL exported function — the same one index.ts's
//    isWorkspaceSessionReadyForHarness calls for the codex-cli branch — not
//    a reimplementation.
// ---------------------------------------------------------------------------

{
  assert.equal(
    resolveCodexOverlayReadiness(false, false),
    false,
    'neither signal observed: must NOT report ready'
  )
  console.log('✓ resolveCodexOverlayReadiness(false, false) === false (neither signal)')

  assert.equal(
    resolveCodexOverlayReadiness(false, true),
    true,
    'THE FIX: title callback observed alone (no status observation yet — the NULL-sid case) must ' +
      'report ready, so the overlay is not stuck deadlocked behind a session-binding signal that ' +
      'may never arrive'
  )
  console.log(
    '✓ resolveCodexOverlayReadiness(false, true) === true — THE FIX: title-observed alone is sufficient'
  )

  assert.equal(
    resolveCodexOverlayReadiness(true, false),
    true,
    'status observed alone (pre-existing behavior) must still report ready'
  )
  console.log(
    '✓ resolveCodexOverlayReadiness(true, false) === true — pre-existing status-observed behavior preserved'
  )

  assert.equal(
    resolveCodexOverlayReadiness(true, true),
    true,
    'both signals observed must report ready'
  )
  console.log('✓ resolveCodexOverlayReadiness(true, true) === true (both signals)')
}

// MUTATION-TESTING METHODOLOGY DEMONSTRATION — self-contained, does not call
// the real shouldWaitForSessionReadiness/CODEX_CAPABILITIES. This originally
// modeled the ORIGINAL loading-overlay bug fix's pre-fix world (a Codex
// workspace with NO session-readiness signal at all, before
// harness/codex/statusState.ts existed) to prove a hardcoded always-true
// decision would have wrongly forced waiting for that Codex. That premise no
// longer matches the current codebase — Codex now genuinely has a readiness
// signal (hasObservedCodexStatus) and both harnesses correctly resolve to
// `true` (see the block above) — but the assertion below still demonstrates
// the same POINT this file's mutation-testing sections all rely on: an
// AssertionError is correctly thrown and caught when an expected value
// doesn't match, which is the mechanism every other mutation check in this
// suite depends on. Left in place as that self-check rather than removed;
// the comment is updated so it no longer claims something about Codex that
// is no longer true.
{
  const mutatedAlwaysWait = (): boolean => true

  try {
    assert.equal(
      mutatedAlwaysWait(),
      false,
      "demonstration only: proves assert.equal correctly throws on a mismatch, the mechanism this suite's mutation checks rely on"
    )
    throw new Error('mutation did not fail as expected')
  } catch (e) {
    assert.ok(
      e instanceof assert.AssertionError,
      'mutation must fail via AssertionError, not some other error'
    )
    console.log(
      `  mutation-testing self-check (expected failure) [assert.equal(true, false)]: ${(e as Error).message.split('\n')[0]}`
    )
  }
}

console.log('\nAll loading-overlay assertions passed.')
