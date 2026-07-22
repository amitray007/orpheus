// ---------------------------------------------------------------------------
// refreshModelsButtonLogic — the pure state-transition table
// RefreshModelsButton.tsx's own local useState drives, pulled out so
// scripts/verify-refresh-models-button.ts can assert it without React/DOM.
//
// The whole state machine, per the approved copy (exact — see the user's
// ASCII in the model-routing unit 12 spec), plus step-progress (the "1/4"
// follow-up):
//   idle       -> "Refresh models" (refresh icon)
//   refreshing -> "Refreshing…"    (spinner, button disabled) — progress
//                 count appended at the END once known: "Refreshing… 1/4".
//                 HIDDEN (no count rendered at all) until the first step
//                 reports — never a fabricated "0/?" or bare "/4".
//   updated    -> "Updated"        (check icon), held ~2s, then back to idle
//
// idle --click--> refreshing --progress*--> refreshing --settled--> updated --timeout--> idle
//
// `refreshing.progress` is `null` until the first 'progress' action arrives
// for THIS refresh — RefreshModelsButton.tsx renders no count while it's
// null, matching the "hidden until known" requirement exactly. A NEW click
// (the idle->refreshing transition) always resets progress to null, so a
// second refresh never starts by displaying the PREVIOUS refresh's stale
// count.
//
// A click while already 'refreshing' or 'updated' is IGNORED (returns the
// same state unchanged) — this is the "disable the button while refreshing
// so a double-click can't stack refreshes" requirement, expressed as a pure
// no-op rather than relying solely on the `disabled` DOM attribute (which
// the component still sets too, as a second layer — see that file's own
// doc comment).
//
// RefreshButtonState/RefreshButtonProgress live in @shared/types (not here)
// because they cross the overlay props/patch boundary — see that module's
// own doc comment above ChipGroupedDropdownProps for why. Re-exported here
// so every renderer-side caller of this reducer can import both the state
// type and the reducer from ONE module.
// ---------------------------------------------------------------------------

import type { RefreshButtonState, RefreshButtonProgress } from '@shared/types'

export type { RefreshButtonState, RefreshButtonProgress }

export type RefreshButtonAction =
  | { type: 'click' }
  | { type: 'progress'; done: number; total: number }
  | { type: 'settled' }
  | { type: 'timeout' }

export function reduceRefreshButtonState(
  state: RefreshButtonState,
  action: RefreshButtonAction
): RefreshButtonState {
  switch (action.type) {
    case 'click':
      return state.kind === 'idle' ? { kind: 'refreshing', progress: null } : state
    case 'progress':
      return state.kind === 'refreshing'
        ? { kind: 'refreshing', progress: { done: action.done, total: action.total } }
        : state
    case 'settled':
      return state.kind === 'refreshing' ? { kind: 'updated' } : state
    case 'timeout':
      return state.kind === 'updated' ? { kind: 'idle' } : state
    default:
      return state
  }
}
