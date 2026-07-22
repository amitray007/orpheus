// ---------------------------------------------------------------------------
// scripts/verify-refresh-models-button.ts
//
// Assertion harness for the pinned "Refresh models" control's state machine
// (model-routing unit 12, user-approved ASCII, plus the "1/4" step-progress
// follow-up): reduceRefreshButtonState
// (src/renderer/src/lib/refreshModelsButtonLogic.ts), the pure transition
// table RefreshModelsButton.tsx's own local useState drives. Mirrors the
// existing scripts/verify-*.ts convention: a script run directly via
// `bun run` (the `test:refresh-models-button` package.json script), no test
// framework. This module has no React/DOM/window/IPC dependency by
// construction, so it's exercised directly and fully offline/deterministic.
//
// Exact copy this state machine drives (per the approved ASCII + follow-up):
//   idle       -> "Refresh models" (refresh icon)
//   refreshing -> "Refreshing…"    (spinner, button disabled), with a
//                 "d/t" step count appended at the END once known — hidden
//                 (no count at all) until the first step reports
//   updated    -> "Updated"        (check icon), held ~2s, then back to idle
//
// Covers exactly the four base transitions the original spec calls out:
//   1. idle + click -> refreshing (progress: null)
//   2. refreshing + settled -> updated
//   3. updated + timeout -> idle
//   4. click while refreshing (or updated) -> ignored (state unchanged)
// Plus the full idle -> refreshing -> updated -> idle round trip, that
// settled/timeout are no-ops from the wrong state, and the step-progress
// follow-up: total-unknown -> no count rendered; total known -> "d/t";
// progress resets on a new refresh; count never shows in idle/updated.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  reduceRefreshButtonState,
  type RefreshButtonState
} from '../src/renderer/src/lib/refreshModelsButtonLogic.ts'

const idle: RefreshButtonState = { kind: 'idle' }
const updated: RefreshButtonState = { kind: 'updated' }
const refreshingNoProgress: RefreshButtonState = { kind: 'refreshing', progress: null }

// ---------------------------------------------------------------------------
// 1. idle + click -> refreshing, with progress: null (not yet known)
// ---------------------------------------------------------------------------

{
  const next = reduceRefreshButtonState(idle, { type: 'click' })
  assert.deepEqual(
    next,
    { kind: 'refreshing', progress: null },
    "idle + 'click' must transition to refreshing with progress: null (unknown, not yet reported)"
  )
  console.log('✓ idle + click -> refreshing (progress: null)')
}

// ---------------------------------------------------------------------------
// 2. refreshing + settled -> updated
// ---------------------------------------------------------------------------

{
  assert.deepEqual(
    reduceRefreshButtonState(refreshingNoProgress, { type: 'settled' }),
    updated,
    "refreshing + 'settled' must transition to 'updated'"
  )
  // Also from mid-progress — settling doesn't care what progress was.
  const midProgress: RefreshButtonState = {
    kind: 'refreshing',
    progress: { done: 2, total: 4 }
  }
  assert.deepEqual(
    reduceRefreshButtonState(midProgress, { type: 'settled' }),
    updated,
    "refreshing + 'settled' must transition to 'updated' regardless of the progress value at settle time"
  )
  console.log('✓ refreshing + settled -> updated')
}

// ---------------------------------------------------------------------------
// 3. updated + timeout -> idle
// ---------------------------------------------------------------------------

{
  assert.deepEqual(
    reduceRefreshButtonState(updated, { type: 'timeout' }),
    idle,
    "updated + 'timeout' must transition back to 'idle'"
  )
  console.log('✓ updated + timeout -> idle')
}

// ---------------------------------------------------------------------------
// 4. click while refreshing (or updated) -> ignored, state unchanged
//    (reference-identical, not just deep-equal — reduceRefreshButtonState
//    returns the SAME state object in the no-op branches). This is the
//    "disable the button while refreshing so a double-click can't stack
//    refreshes" requirement expressed as a pure no-op, independent of the
//    DOM `disabled` attribute RefreshModelsButton.tsx also sets as a second
//    layer.
// ---------------------------------------------------------------------------

{
  assert.equal(
    reduceRefreshButtonState(refreshingNoProgress, { type: 'click' }),
    refreshingNoProgress,
    "a click while 'refreshing' must be ignored — never starts a second overlapping refresh"
  )
  assert.equal(
    reduceRefreshButtonState(updated, { type: 'click' }),
    updated,
    "a click while 'updated' (the brief post-refresh hold window) must also be ignored"
  )
  console.log('✓ click while refreshing/updated is ignored (state unchanged either way)')
}

// ---------------------------------------------------------------------------
// 5. Out-of-order/duplicate events are no-ops from a state that doesn't
//    expect them — 'settled' only fires the refreshing->updated transition
//    from 'refreshing'; 'timeout' only fires updated->idle from 'updated';
//    'progress' only applies while 'refreshing'. Proves a stray/duplicate
//    event can't corrupt the machine by skipping states or bouncing
//    backward.
// ---------------------------------------------------------------------------

{
  assert.equal(
    reduceRefreshButtonState(idle, { type: 'settled' }),
    idle,
    "'settled' from 'idle' (no refresh in flight) must be a no-op"
  )
  assert.equal(
    reduceRefreshButtonState(updated, { type: 'settled' }),
    updated,
    "'settled' from 'updated' (already settled once) must be a no-op, not double-transition"
  )
  assert.equal(
    reduceRefreshButtonState(idle, { type: 'timeout' }),
    idle,
    "'timeout' from 'idle' must be a no-op"
  )
  assert.equal(
    reduceRefreshButtonState(refreshingNoProgress, { type: 'timeout' }),
    refreshingNoProgress,
    "'timeout' firing while still 'refreshing' (the hold-timer somehow outliving a fresh refresh) must be a no-op, never jumping straight to 'idle' out of turn"
  )
  assert.equal(
    reduceRefreshButtonState(idle, { type: 'progress', done: 1, total: 4 }),
    idle,
    "a stray 'progress' event while 'idle' (no refresh in flight) must be a no-op"
  )
  assert.equal(
    reduceRefreshButtonState(updated, { type: 'progress', done: 1, total: 4 }),
    updated,
    "a stray 'progress' event while 'updated' (this refresh already settled) must be a no-op"
  )
  console.log(
    '✓ out-of-order/duplicate settled/timeout/progress events from an unexpected state are no-ops — the machine cannot skip or bounce states'
  )
}

// ---------------------------------------------------------------------------
// 6. Full round trip: idle -> refreshing -> updated -> idle, exactly the
//    sequence a real click drives (click, then the async work settling,
//    then the ~2s hold timer firing) — proven end-to-end, not just as
//    isolated single-transition assertions.
// ---------------------------------------------------------------------------

{
  let state: RefreshButtonState = idle
  state = reduceRefreshButtonState(state, { type: 'click' })
  assert.deepEqual(
    state,
    refreshingNoProgress,
    'step 1: click must move to refreshing, progress null'
  )
  state = reduceRefreshButtonState(state, { type: 'settled' })
  assert.deepEqual(state, updated, 'step 2: settled must move to updated')
  state = reduceRefreshButtonState(state, { type: 'timeout' })
  assert.deepEqual(state, idle, 'step 3: timeout must move back to idle')
  console.log(
    '✓ full round trip idle -> refreshing -> updated -> idle matches a real click sequence'
  )
}

// ---------------------------------------------------------------------------
// 7. STEP PROGRESS ("1/4" follow-up):
//    - total-unknown (progress: null, right after a click) -> no count
//      rendered — asserted at the STATE level here (RefreshModelsButton.tsx
//      itself only renders a count when state.progress is non-null, see
//      that component's own progressText derivation).
//    - a 'progress' event while refreshing sets progress to {done,total}
//      exactly as reported — proving "d/t" derives from real reported
//      values, never fabricated.
//    - progress accumulates correctly across multiple steps (1/4 -> 2/4 ->
//      3/4 -> 4/4), each 'progress' event overwriting the previous one
//      (not accumulating additively) — matches the real caller's contract
//      (manager.ts's onProgress reports the ABSOLUTE done count each time,
//      not a delta).
//    - a NEW click (a second refresh) resets progress to null — the second
//      refresh must never open by showing the FIRST refresh's stale count.
//    - progress never appears outside 'refreshing' — 'idle' and 'updated'
//      states have no `progress` field at all (enforced by the type itself,
//      reasserted here at the value level for the harness's own honesty).
// ---------------------------------------------------------------------------

{
  // total-unknown: right after click, progress is null.
  const afterClick = reduceRefreshButtonState(idle, { type: 'click' })
  assert.deepEqual(
    afterClick,
    { kind: 'refreshing', progress: null },
    'immediately after click, progress must be null (unknown) — RefreshModelsButton.tsx must render ' +
      'no count at all in this state, never "0/?" or a bare "/4"'
  )

  // First step reports -> progress becomes known.
  let state = reduceRefreshButtonState(afterClick, { type: 'progress', done: 1, total: 4 })
  assert.deepEqual(
    state,
    { kind: 'refreshing', progress: { done: 1, total: 4 } },
    "the first 'progress' event must set progress to exactly the reported {done,total} — here 1/4"
  )

  // Subsequent steps overwrite (absolute, not additive).
  state = reduceRefreshButtonState(state, { type: 'progress', done: 2, total: 4 })
  assert.deepEqual(
    state,
    { kind: 'refreshing', progress: { done: 2, total: 4 } },
    "a later 'progress' event must REPLACE the previous {done,total}, not accumulate additively"
  )
  state = reduceRefreshButtonState(state, { type: 'progress', done: 3, total: 4 })
  state = reduceRefreshButtonState(state, { type: 'progress', done: 4, total: 4 })
  assert.deepEqual(
    state,
    { kind: 'refreshing', progress: { done: 4, total: 4 } },
    'progress must reach the FINAL step (4/4) exactly as reported'
  )

  // Settle, then a SECOND click (a fresh refresh) must reset progress to
  // null — never carry over the previous refresh's 4/4.
  state = reduceRefreshButtonState(state, { type: 'settled' })
  state = reduceRefreshButtonState(state, { type: 'timeout' })
  assert.deepEqual(state, idle, 'sanity: back to idle after the first refresh fully completes')
  state = reduceRefreshButtonState(state, { type: 'click' })
  assert.deepEqual(
    state,
    { kind: 'refreshing', progress: null },
    'a SECOND refresh (a new click) must start with progress: null again — it must never open by ' +
      "showing the FIRST refresh's stale 4/4"
  )

  // Progress never appears outside 'refreshing' — idle/updated states carry
  // no progress field at all (structural, re-asserted at the value level).
  assert.ok(!('progress' in idle), "the 'idle' state must carry no progress field at all")
  assert.ok(!('progress' in updated), "the 'updated' state must carry no progress field at all")

  console.log(
    '✓ step progress: hidden (null) until the first step reports, set to exactly the reported ' +
      'values (absolute, not additive) across a full 1/4 -> 4/4 sequence, reset to null on a fresh ' +
      "click, and never present outside the 'refreshing' state"
  )
}

// ---------------------------------------------------------------------------
// HONEST COVERAGE NOTE: this proves the pure state-transition table
// RefreshModelsButton.tsx's local useState drives. It does NOT exercise the
// component itself — the actual DOM button/spinner/label/count text, the
// stopPropagation guard, the two real calls (window.api.routingProxy.
// refreshAuthFiles() + refetchSelectableModels()), the routingProxy:
// refreshProgress subscription lifecycle (subscribe only while 'refreshing',
// unsubscribe on leaving that state or on unmount), the unmount-during-
// "Updated"-window timer cleanup, or the overlay:update push that keeps an
// open ChipGroupedDropdown/NewWorkspaceMenu flyout's `groups` in sync — none
// of that is verifiable by this offline, DOM-free harness (no renderer test
// runner in this repo — same constraint every other verify-*.ts script in
// this repo is under).
//
// Manually confirmed by reading the source: RefreshModelsButton.tsx's
// handleClick computes `reduceRefreshButtonState(state, {type:'click'})` and
// bails if the result is REFERENCE-IDENTICAL to the current state (the
// double-click guard — reduceRefreshButtonState's no-op branches literally
// `return state`, so this comparison is sound), sets the new state, awaits
// refreshAuthFiles() inside a try/catch that never lets a throw skip the
// rest of the sequence, calls refetchSelectableModels(currentModelId), then
// (guarded by mountedRef) dispatches 'settled' and arms a 2000ms
// (UPDATED_HOLD_MS) timer that dispatches 'timeout', clearing that timer on
// unmount. A separate useEffect keyed on `state.kind` subscribes to
// window.api.routingProxy.onRefreshProgress ONLY while state.kind ===
// 'refreshing', dispatching 'progress' events into the SAME reducer — that
// effect's cleanup (returned by onRefreshProgress itself) unsubscribes the
// instant state.kind changes away from 'refreshing', including on unmount.
//
// manager.ts's refreshAuthFilesNow (the ONLY caller that broadcasts on
// routingProxy:refreshProgress) computes total as PROVIDERS.length + 1 —
// confirmed in code to derive from the real PROVIDERS array (never
// hardcoded), and to report onProgress(totalSteps, totalSteps) immediately
// when there's nothing to refresh (no secret / proxy not running), so the
// button still reaches 'updated' promptly rather than hanging on progress
// that will never arrive otherwise.
//
// The live TIMING itself (does a real click in the running app show
// 1/4 -> 2/4 -> 3/4 -> 4/4 -> Updated, and does the flyout's row content
// visibly refresh) cannot be driven in this environment — no UI automation
// for the native Electron window, and CLAUDE.md forbids foregrounding the
// dev build during a build/test loop (open -g only).
// ---------------------------------------------------------------------------

console.log('\nAll refresh-models-button assertions passed.')
