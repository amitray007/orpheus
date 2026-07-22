// ---------------------------------------------------------------------------
// refreshModelsButtonLogic — the pure state-transition table
// RefreshModelsButton.tsx's own local useState drives, pulled out so
// scripts/verify-refresh-models-button.ts can assert it without React/DOM.
//
// The whole state machine, per the approved copy (exact — see the user's
// ASCII in the model-routing unit 12 spec):
//   idle       -> "Refresh models" (refresh icon)
//   refreshing -> "Refreshing…"    (spinner, button disabled) — NO sub-label
//   updated    -> "Updated"        (check icon), held ~2s, then back to idle
//
// idle --click--> refreshing --settled--> updated --timeout--> idle
//
// A click while already 'refreshing' or 'updated' is IGNORED (returns the
// same state unchanged) — this is the "disable the button while refreshing
// so a double-click can't stack refreshes" requirement, expressed as a pure
// no-op rather than relying solely on the `disabled` DOM attribute (which
// the component still sets too, as a second layer — see that file's own
// doc comment).
// ---------------------------------------------------------------------------

export type RefreshButtonState = 'idle' | 'refreshing' | 'updated'
export type RefreshButtonAction = 'click' | 'settled' | 'timeout'

export function reduceRefreshButtonState(
  state: RefreshButtonState,
  action: RefreshButtonAction
): RefreshButtonState {
  switch (action) {
    case 'click':
      return state === 'idle' ? 'refreshing' : state
    case 'settled':
      return state === 'refreshing' ? 'updated' : state
    case 'timeout':
      return state === 'updated' ? 'idle' : state
    default:
      return state
  }
}
