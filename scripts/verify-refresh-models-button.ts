// ---------------------------------------------------------------------------
// scripts/verify-refresh-models-button.ts
//
// Assertion harness for the pinned "Refresh models" control's state machine
// (model-routing unit 12, user-approved ASCII): reduceRefreshButtonState
// (src/renderer/src/lib/refreshModelsButtonLogic.ts), the pure transition
// table RefreshModelsButton.tsx's own local useState drives. Mirrors the
// existing scripts/verify-*.ts convention: a script run directly via
// `bun run` (the `test:refresh-models-button` package.json script), no test
// framework. This module has no React/DOM/window/IPC dependency by
// construction, so it's exercised directly and fully offline/deterministic.
//
// Exact copy this state machine drives (per the approved ASCII):
//   idle       -> "Refresh models" (refresh icon)
//   refreshing -> "Refreshing…"    (spinner, button disabled)
//   updated    -> "Updated"        (check icon), held ~2s, then back to idle
//
// Covers exactly the four transitions the spec calls out:
//   1. idle + click -> refreshing
//   2. refreshing + settled -> updated
//   3. updated + timeout -> idle
//   4. click while refreshing (or updated) -> ignored (state unchanged)
// Plus the full idle -> refreshing -> updated -> idle round trip, and that
// 'settled'/'timeout' are themselves no-ops from the wrong state (so an
// out-of-order or duplicate event can't corrupt the state machine).
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  reduceRefreshButtonState,
  type RefreshButtonState
} from '../src/renderer/src/lib/refreshModelsButtonLogic.ts'

// ---------------------------------------------------------------------------
// 1. idle + click -> refreshing
// ---------------------------------------------------------------------------

{
  assert.equal(
    reduceRefreshButtonState('idle', 'click'),
    'refreshing',
    "idle + 'click' must transition to 'refreshing'"
  )
  console.log('✓ idle + click -> refreshing')
}

// ---------------------------------------------------------------------------
// 2. refreshing + settled -> updated
// ---------------------------------------------------------------------------

{
  assert.equal(
    reduceRefreshButtonState('refreshing', 'settled'),
    'updated',
    "refreshing + 'settled' must transition to 'updated'"
  )
  console.log('✓ refreshing + settled -> updated')
}

// ---------------------------------------------------------------------------
// 3. updated + timeout -> idle
// ---------------------------------------------------------------------------

{
  assert.equal(
    reduceRefreshButtonState('updated', 'timeout'),
    'idle',
    "updated + 'timeout' must transition back to 'idle'"
  )
  console.log('✓ updated + timeout -> idle')
}

// ---------------------------------------------------------------------------
// 4. click while refreshing (or updated) -> ignored, state unchanged. This
//    is the "disable the button while refreshing so a double-click can't
//    stack refreshes" requirement expressed as a pure no-op, independent of
//    the DOM `disabled` attribute RefreshModelsButton.tsx also sets as a
//    second layer.
// ---------------------------------------------------------------------------

{
  assert.equal(
    reduceRefreshButtonState('refreshing', 'click'),
    'refreshing',
    "a click while 'refreshing' must be ignored — never starts a second overlapping refresh"
  )
  assert.equal(
    reduceRefreshButtonState('updated', 'click'),
    'updated',
    "a click while 'updated' (the brief post-refresh hold window) must also be ignored"
  )
  console.log('✓ click while refreshing/updated is ignored (state unchanged either way)')
}

// ---------------------------------------------------------------------------
// 5. Out-of-order/duplicate events are no-ops from a state that doesn't
//    expect them — 'settled' only fires the refreshing->updated transition
//    from 'refreshing'; 'timeout' only fires updated->idle from 'updated'.
//    Proves a stray/duplicate event (e.g. a second timer somehow firing)
//    can't corrupt the machine by skipping states or bouncing backward.
// ---------------------------------------------------------------------------

{
  assert.equal(
    reduceRefreshButtonState('idle', 'settled'),
    'idle',
    "'settled' from 'idle' (no refresh in flight) must be a no-op"
  )
  assert.equal(
    reduceRefreshButtonState('updated', 'settled'),
    'updated',
    "'settled' from 'updated' (already settled once) must be a no-op, not double-transition"
  )
  assert.equal(
    reduceRefreshButtonState('idle', 'timeout'),
    'idle',
    "'timeout' from 'idle' must be a no-op"
  )
  assert.equal(
    reduceRefreshButtonState('refreshing', 'timeout'),
    'refreshing',
    "'timeout' firing while still 'refreshing' (the hold-timer somehow outliving a fresh refresh) must be a no-op, never jumping straight to 'idle' out of turn"
  )
  console.log(
    '✓ out-of-order/duplicate settled/timeout events from an unexpected state are no-ops — the machine cannot skip or bounce states'
  )
}

// ---------------------------------------------------------------------------
// 6. Full round trip: idle -> refreshing -> updated -> idle, exactly the
//    sequence a real click drives (click, then the async work settling,
//    then the ~2s hold timer firing) — proven end-to-end, not just as
//    isolated single-transition assertions.
// ---------------------------------------------------------------------------

{
  let state: RefreshButtonState = 'idle'
  state = reduceRefreshButtonState(state, 'click')
  assert.equal(state, 'refreshing', 'step 1: click must move to refreshing')
  state = reduceRefreshButtonState(state, 'settled')
  assert.equal(state, 'updated', 'step 2: settled must move to updated')
  state = reduceRefreshButtonState(state, 'timeout')
  assert.equal(state, 'idle', 'step 3: timeout must move back to idle')
  console.log(
    '✓ full round trip idle -> refreshing -> updated -> idle matches a real click sequence'
  )
}

// ---------------------------------------------------------------------------
// HONEST COVERAGE NOTE: this proves the pure state-transition table
// RefreshModelsButton.tsx's local useState drives. It does NOT exercise the
// component itself — the actual DOM button/spinner/label text, the
// stopPropagation guard, the two real calls (window.api.routingProxy.
// refreshAuthFiles() + refetchSelectableModels()), the unmount-during-
// "Updated"-window timer cleanup, or the overlay:update push that keeps an
// open ChipGroupedDropdown/NewWorkspaceMenu flyout's `groups` in sync
// (DropdownChip.tsx's/components/dashboard/NewWorkspaceMenu.tsx's own "keep
// the open popover in sync" effects) — none of that is verifiable by this
// offline, DOM-free harness (no renderer test runner in this repo — same
// constraint every other verify-*.ts script in this repo is under). Manually
// confirmed by reading the source: RefreshModelsButton.tsx's handleClick
// calls reduceRefreshButtonState('click') and bails if the result equals the
// current state (the double-click guard), sets 'refreshing', awaits
// refreshAuthFiles() inside a try/catch that never lets a throw skip the
// rest of the sequence, calls refetchSelectableModels(currentModelId), then
// (guarded by mountedRef) transitions to 'updated' and arms a 2000ms
// (UPDATED_HOLD_MS) timer back to 'idle', clearing that timer on unmount.
// The live cold-open/refresh-while-open TIMING itself (does clicking the
// button in a real running app visibly update the flyout's rows) cannot be
// driven in this environment — no UI automation for the native Electron
// window, and CLAUDE.md forbids foregrounding the dev build during a
// build/test loop (open -g only).
// ---------------------------------------------------------------------------

console.log('\nAll refresh-models-button assertions passed.')
