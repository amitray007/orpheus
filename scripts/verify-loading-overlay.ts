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
  __setClockForTest,
  MIN_SHOW_MS,
  SLOW_THRESHOLD_MS,
  SLOW_THRESHOLD_MS_ROUTED,
  type LoadingCopy
} from '../src/main/loadingOverlay.ts'

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
  const routedCopy = slowCopyFor(true)

  assert.equal(claudeCopy.title, 'Still starting…')
  assert.equal(
    claudeCopy.subtitle,
    'Hooks or auth check taking longer than usual',
    'Claude slow-copy subtitle must be byte-for-byte unchanged — no regression'
  )
  console.log('✓ Claude slow-copy is byte-for-byte unchanged from the pre-fix string')

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

console.log('\nAll loading-overlay assertions passed.')
