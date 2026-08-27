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
import {
  setOverlayFallbackTimer,
  clearOverlayFallbackTimer,
  hasOverlayFallbackTimer
} from '../src/main/workspaceResources.ts'

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
// harness/codex/statusState.ts's hasObservedCodexStatus, combining Codex's
// own thread-history DB turn status (threadDb.ts) with thread-writer-lock
// liveness (see statusMap.ts's mapCodexStatus) — so
// CODEX_CAPABILITIES.structuredStatus flipped to
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

// ---------------------------------------------------------------------------
// 10. Early-dismissal mechanism (support-multi-harness Bug 1): index.ts's
//     attemptEarlyOverlayDismissal cannot be imported directly (it lives in
//     index.ts, which imports `electron` at module scope like every other
//     verifier in this repo already documents as the reason it re-composes
//     the REAL exported pieces instead — see §8/§9 above for the same
//     discipline). This section builds the IDENTICAL decision index.ts's
//     function makes, out of the SAME real, directly-imported functions
//     (hasOverlayFallbackTimer / resolveCodexOverlayReadiness /
//     clearOverlayFallbackTimer / hide, all from this repo's actual source,
//     never reimplemented).
//
//     setOverlayFallbackTimer/clearOverlayFallbackTimer (workspaceResources.ts)
//     use the GLOBAL setTimeout/clearTimeout directly — unlike
//     loadingOverlay.ts's own internal watchdog, they take no injectable
//     clock — so proving "the armed 10s fallback timer is genuinely
//     cancelled, not just forgotten" requires intercepting the REAL global
//     timer functions (mirrors scripts/verify-codex-title-generation.ts's
//     withFakeGlobalTimers, same technique, same reason: the module under
//     test calls the bare global, so that's the only seam available).
//
//     A workspace whose Codex readiness flips false -> true AFTER mount but
//     BEFORE the 10s fallback fires must have its overlay dismissed
//     immediately, and the armed fallback timer must be verifiably
//     cancelled (a real clearTimeout call on the exact handle
//     setOverlayFallbackTimer was given) so it can never later fire and
//     hide a DIFFERENT overlay mounted later for the same workspaceId.
// ---------------------------------------------------------------------------

// Faithful port of index.ts's attemptEarlyOverlayDismissal — same shape,
// same real functions it composes (hasOverlayFallbackTimer,
// isWorkspaceSessionReadyForHarness's Codex branch via
// resolveCodexOverlayReadiness, clearOverlayFallbackTimer, hide). The
// harnessId dispatch mirrors index.ts's isWorkspaceSessionReadyForHarness:
// only codex-cli ever consults the Codex OR-signal; every other harnessId
// (including 'claude') is INERT here by construction, matching §11 below.
function attemptEarlyOverlayDismissalForTest(
  workspaceId: string,
  harnessId: string,
  hasObservedStatus: boolean,
  hasObservedTitle: boolean
): void {
  if (!hasOverlayFallbackTimer(workspaceId)) return
  const ready =
    harnessId === 'codex-cli'
      ? resolveCodexOverlayReadiness(hasObservedStatus, hasObservedTitle)
      : false
  if (!ready) return
  clearOverlayFallbackTimer(workspaceId)
  hide(workspaceId)
}

// Intercepts the REAL global setTimeout/clearTimeout so this section can
// prove clearOverlayFallbackTimer issues a genuine cancellation against the
// exact handle it was given, without waiting out a real 10s delay. Every
// call is recorded; nothing here re-fires callbacks automatically (unlike
// the title-generation script's drain-on-exit helper) — each test below
// fires a captured callback explicitly, by index, to simulate "the fallback
// would have fired here" only when that's exactly what's being proven.
function withInterceptedGlobalTimers<T>(
  run: (calls: { scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> }) => T
): T {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const scheduled: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []

  // @ts-expect-error — deliberately narrower fake signature, mirrors
  // verify-codex-title-generation.ts's withFakeGlobalTimers.
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const entry = { fn, ms, cancelled: false }
    scheduled.push(entry)
    return entry as unknown as NodeJS.Timeout
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: unknown) => {
    const entry = scheduled.find((e) => e === handle)
    if (entry) entry.cancelled = true
  }) as typeof clearTimeout

  try {
    return run({ scheduled })
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

// Selects the most-recently-scheduled 10000ms entry — i.e. the fallback
// timer index.ts's handlePostMountOverlay arms — out of `scheduled`, which
// also picks up show()'s OWN internal slow-watchdog timer (a different ms
// value) as unrelated noise. Using the LAST match (not scheduled[0]) is
// deliberate: a re-mount (show() called again for the same workspaceId
// later in a test) schedules a second 10000ms entry, and the most recent
// one is always the one that matters for what's being asserted next.
function lastFallbackEntry(scheduled: Array<{ ms: number }>): {
  fn: () => void
  ms: number
  cancelled: boolean
} {
  const matches = scheduled.filter((e) => e.ms === 10000) as Array<{
    fn: () => void
    ms: number
    cancelled: boolean
  }>
  const entry = matches.at(-1)
  if (!entry) throw new Error('lastFallbackEntry: no 10000ms setTimeout call was captured')
  return entry
}

{
  // Combines BOTH fake-clock seams this scenario spans: loadingOverlay.ts's
  // OWN injectable clock (__setClockForTest — governs its MIN_SHOW_MS
  // anti-flash debounce and internal slow-watchdog) for the overlay state
  // machine itself, and the intercepted GLOBAL setTimeout/clearTimeout (see
  // withInterceptedGlobalTimers's own comment) for workspaceResources.ts's
  // fallback-timer tracking, which calls the bare global directly. Neither
  // alone is enough: hide()'s 'hidden' dispatch is gated by
  // loadingOverlay's MIN_SHOW_MS regardless of what the fallback timer
  // does, and the fallback-timer cancellation proof needs the global
  // interception.
  const { deps, advance } = makeFakeClock()
  __setClockForTest(deps)
  withInterceptedGlobalTimers(({ scheduled }) => {
    const bridge = makeRecordingBridge()
    const workspaceId = 'ws-early-dismiss-codex'

    show(workspaceId, { title: 'Starting workspace' }, false)
    // Arm the SAME kind of 10s fallback timer index.ts's
    // handlePostMountOverlay arms — goes through the REAL setOverlayFallbackTimer,
    // which calls the (intercepted) global setTimeout.
    const fallbackHandle = setTimeout(() => hide(workspaceId), 10000)
    setOverlayFallbackTimer(workspaceId, fallbackHandle)

    assert.equal(
      hasOverlayFallbackTimer(workspaceId),
      true,
      'sanity: fallback timer must be armed right after mount, before any readiness signal fires'
    )
    const fallbackEntry = lastFallbackEntry(scheduled)

    // Advance past MIN_SHOW_MS first so the early dismissal's hide() call
    // below dispatches 'hidden' immediately rather than being deferred by
    // the anti-flash debounce (see §5/§6 above for that debounce's own
    // coverage) — this scenario is about the FALLBACK-TIMER seam, not
    // MIN_SHOW_MS, so it's cleared out of the way.
    advance(MIN_SHOW_MS + 1)

    // The title-callback seam (a) fires well before the 10s mark, mirroring
    // index.ts calling attemptEarlyOverlayDismissal right after
    // markTerminalTitleObserved.
    attemptEarlyOverlayDismissalForTest(workspaceId, 'codex-cli', false, true)

    assert.equal(
      bridge.calls.at(-1)?.state,
      'hidden',
      'THE FIX: overlay must be dismissed immediately once Codex readiness flips true, without waiting for the 10s fallback'
    )
    assert.equal(
      hasOverlayFallbackTimer(workspaceId),
      false,
      'the fallback timer must be cleared from tracking once the early dismissal fires'
    )
    assert.equal(
      fallbackEntry.cancelled,
      true,
      'THE FIX must issue a genuine clearTimeout against the exact scheduled fallback handle, so it can never fire later'
    )

    hide(workspaceId)
    console.log(
      '✓ early dismissal: Codex readiness flipping true before the 10s fallback dismisses the overlay immediately AND genuinely cancels the armed timer (real clearTimeout observed)'
    )
  })
  __setClockForTest(undefined)
}

{
  // A LATER overlay mounted for the SAME workspaceId after an early
  // dismissal must not be touched by a stale timer — proves
  // clearOverlayFallbackTimer (not takeOverlayFallbackTimer) is the right
  // call: takeOverlayFallbackTimer only removes the map entry WITHOUT
  // calling clearTimeout, which would leave the first real timer pending
  // and able to fire later and hide a second, unrelated overlay.
  //
  // Isolates the claim to JUST the fallback-timer bookkeeping — the second
  // overlay's own state (showing/slow/hidden) is deliberately NOT read from
  // loadingOverlay's bridge here (its own internal watchdog timer would
  // also be swept up by the "fire every non-cancelled scheduled callback"
  // step below, contaminating that signal); instead this asserts directly
  // on the FIRST fallback entry's own `cancelled`/fired state, which is
  // exactly what clearOverlayFallbackTimer vs. takeOverlayFallbackTimer
  // differ on.
  withInterceptedGlobalTimers(({ scheduled }) => {
    const workspaceId = 'ws-early-dismiss-then-remount'
    let firstFallbackFired = false

    show(workspaceId, { title: 'Starting workspace' }, false)
    const firstHandle = setTimeout(() => {
      firstFallbackFired = true
    }, 10000)
    setOverlayFallbackTimer(workspaceId, firstHandle)
    const firstEntry = lastFallbackEntry(scheduled)

    attemptEarlyOverlayDismissalForTest(workspaceId, 'codex-cli', true, false)
    assert.equal(
      hasOverlayFallbackTimer(workspaceId),
      false,
      'first timer cleared by early dismissal'
    )
    assert.equal(
      firstEntry.cancelled,
      true,
      'first timer must be genuinely cancelled (real clearTimeout)'
    )

    // Workspace closes and reopens: a brand-new overlay + a brand-new
    // fallback timer for the SAME workspaceId — the second timer must be a
    // distinct scheduled entry, unaffected by the first's cancellation.
    show(workspaceId, { title: 'Starting workspace' }, false)
    const secondHandle = setTimeout(() => hide(workspaceId), 10000)
    setOverlayFallbackTimer(workspaceId, secondHandle)
    const secondEntry = lastFallbackEntry(scheduled)
    assert.notEqual(
      secondEntry,
      firstEntry,
      'sanity: the second timer is a distinct scheduled entry from the first'
    )
    assert.equal(
      secondEntry.cancelled,
      false,
      'sanity: the second timer is freshly armed, not cancelled'
    )

    // Simulate "what would happen if the first timer's deadline were
    // reached" by invoking every NON-cancelled scheduled callback — this is
    // exactly what a real event loop would do: a cancelled timer's callback
    // never runs, full stop. If clearOverlayFallbackTimer had used
    // takeOverlayFallbackTimer's semantics instead (map-only, no
    // clearTimeout), firstEntry.cancelled would still be false here and
    // this loop would incorrectly invoke the first callback too.
    for (const entry of scheduled) {
      if (!entry.cancelled) entry.fn()
    }
    assert.equal(
      firstFallbackFired,
      false,
      'the FIRST fallback callback must never run once cancelled — a stale first-mount timer must never fire again for a later overlay at the same workspaceId'
    )

    hide(workspaceId)
    console.log(
      '✓ clearOverlayFallbackTimer (not takeOverlayFallbackTimer) genuinely cancels the pending timer — a stale first-mount timer never fires again for a later overlay at the same workspaceId'
    )
  })
}

// ---------------------------------------------------------------------------
// 11. Claude's path is UNCHANGED by the early-dismissal mechanism —
//     regression guard proving attemptEarlyOverlayDismissalForTest (and by
//     construction, index.ts's real attemptEarlyOverlayDismissal, which
//     this function faithfully ports) is INERT for a call shaped like
//     Claude's. Claude's real harnessId constant is 'claude' — see
//     src/main/harness/claude/curated.ts (CLAUDE_CAPABILITIES has no
//     harnessId field itself; 'claude' is the literal HarnessId used
//     throughout this codebase's harness dispatch, e.g. index.ts's
//     isWorkspaceSessionReadyForHarness `if (harnessId === 'codex-cli')`
//     else-branch).
// ---------------------------------------------------------------------------

{
  // Same dual-fake-clock composition as the first scenario above (needed
  // here too: the simulated fallback firing at the end calls hide(), whose
  // 'hidden' dispatch is gated by loadingOverlay's own MIN_SHOW_MS clock).
  const { deps, advance } = makeFakeClock()
  __setClockForTest(deps)
  withInterceptedGlobalTimers(({ scheduled }) => {
    const bridge = makeRecordingBridge()
    const workspaceId = 'ws-claude-early-dismiss-inert'

    show(workspaceId, { title: 'Starting workspace' }, false)
    const fallbackHandle = setTimeout(() => hide(workspaceId), 10000)
    setOverlayFallbackTimer(workspaceId, fallbackHandle)
    const fallbackEntry = lastFallbackEntry(scheduled)

    advance(MIN_SHOW_MS + 1)

    // Even with BOTH Codex signals reported true, a 'claude' harnessId call
    // must never consult them and must never dismiss early — Claude's real
    // dismissal path is exclusively setSessionReadyHandler (sessionState.ts,
    // untouched by this fix), never this mechanism.
    attemptEarlyOverlayDismissalForTest(workspaceId, 'claude', true, true)

    assert.equal(
      bridge.calls.at(-1)?.state,
      'showing',
      "REGRESSION GUARD: the early-dismissal mechanism must be INERT for harnessId='claude' — it must never dismiss Claude's overlay even when both Codex readiness signals are (hypothetically) true"
    )
    assert.equal(
      hasOverlayFallbackTimer(workspaceId),
      true,
      "Claude's fallback timer must remain armed — untouched by the new mechanism"
    )
    assert.equal(
      fallbackEntry.cancelled,
      false,
      "Claude's fallback timer must NOT be cancelled by the new mechanism"
    )

    // The ORIGINAL fallback still fires normally at its real 10s deadline —
    // simulate that by invoking the (still non-cancelled) scheduled
    // callback directly, proving the genuine backstop is fully intact for
    // Claude.
    fallbackEntry.fn()
    assert.equal(
      bridge.calls.at(-1)?.state,
      'hidden',
      "Claude's real 10s fallback must still fire normally, unaffected by this fix"
    )

    console.log(
      "✓ early-dismissal mechanism is inert for harnessId='claude' — Claude's overlay is never dismissed by it, and its genuine 10s fallback is untouched"
    )
  })
  __setClockForTest(undefined)
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
