// ---------------------------------------------------------------------------
// scripts/verify-overlay-dismissal.ts
//
// Assertion harness for the pure dismissal/safety-net predicates exported
// from src/main/overlayDismissal.ts (decideHideAction,
// shouldForceDismissOnOutsideInteraction), consumed by src/main/
// overlayLayer.ts — the fix for the "stuck popover blocks the whole app" bug
// (model-routing unit 10-creation, follow-up).
//
// ROOT CAUSE PROVEN: every takesFocus overlay (newWorkspaceMenu,
// workspaceSettingsCard, chipPrompt, chipDropdown) is a card-sized child
// BrowserWindow with NO backdrop area (computeScreenBounds sizes it to the
// renderer-reported card size, nothing more), and every one of their call
// sites dismisses via a `document.addEventListener('pointerdown', ...)` on
// the MAIN window's own document (NewWorkspaceMenu.tsx,
// WorkspaceSettingsPopover.tsx, ActionChip.tsx, DropdownChip.tsx all use this
// exact idiom) — so this is a GENERAL overlay-layer gap, not specific to the
// new-workspace menu. Its failure mode is an ORPHANED descriptor: hideOverlay
// previously no-op'd unless state === 'visible', so a hide() call racing an
// in-flight (not-yet-acked) show for the same id — e.g. the owning React
// component unmounting between showOverlay() and its paint-ack, which a
// sidebar row re-render/idSuffix remount/StrictMode double-invoke can all
// trigger — was silently dropped. The show went on to complete, the overlay
// window became visible, and NO live component remained to ever call hide
// again: a permanently-visible popover with nothing left to dismiss it,
// exactly matching "stuck, can't even click anywhere to make it go away."
//
// MUST PASS FULLY OFFLINE — these are pure functions of primitive state
// snapshots (no Electron, no DOM), mirroring verify-new-workspace-menu.ts's
// own no-Electron/no-DB constraint for newWorkspaceMenuLogic.ts.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  decideHideAction,
  shouldForceDismissOnOutsideInteraction
} from '../src/main/overlayDismissal.ts'

// ---------------------------------------------------------------------------
// 1. decideHideAction — the orphaned-descriptor fix.
// ---------------------------------------------------------------------------

{
  // Stale/mismatched id: always a no-op, regardless of state.
  assert.equal(decideHideAction('a', null, 'idle'), 'noop')
  assert.equal(decideHideAction('a', 'b', 'visible'), 'noop')
  assert.equal(decideHideAction('a', 'b', 'pending'), 'noop')
  console.log('✓ decideHideAction: a stale/mismatched id is always a no-op, regardless of state')
}

{
  // THE FIX: id matches, but the show hasn't finished pending (paint-ack not
  // landed yet) — must force-hide, not silently no-op. This is exactly the
  // race an unmounting NewWorkspaceMenu/WorkspaceSettingsPopover hits.
  assert.equal(
    decideHideAction('newWorkspaceMenu:proj1', 'newWorkspaceMenu:proj1', 'pending'),
    'force-hide'
  )
  console.log(
    '✓ decideHideAction: id matches + state is "pending" -> "force-hide" (the orphaned-descriptor fix — previously this silently no-op\'d)'
  )
}

{
  // id matches + state is 'visible' -> the normal exit-fade hide path.
  assert.equal(
    decideHideAction('workspaceSettings:ws1', 'workspaceSettings:ws1', 'visible'),
    'normal-hide'
  )
  console.log(
    '✓ decideHideAction: id matches + state is "visible" -> "normal-hide" (unchanged happy path)'
  )
}

{
  // id matches but state is idle/exiting/recovering/unregistered/unavailable
  // -> no-op (nothing meaningful to hide; a prior hide/forceHide/recovery
  // already settled this id, or it never got past show() at all).
  for (const s of ['idle', 'exiting', 'recovering', 'unregistered', 'unavailable'] as const) {
    assert.equal(decideHideAction('x', 'x', s), 'noop', `expected noop for state=${s}`)
  }
  console.log(
    '✓ decideHideAction: id matches but state is idle/exiting/recovering/unregistered/unavailable -> "noop" (nothing left to settle)'
  )
}

// ---------------------------------------------------------------------------
// 2. shouldForceDismissOnOutsideInteraction — the guaranteed-way-out backstop
//    shared by the main-window-refocus dismissal and the Escape backstop.
// ---------------------------------------------------------------------------

{
  // The core case this whole fix exists for: a takesFocus overlay showing,
  // and an outside interaction lands (main window refocused, or Escape
  // reaches the main-process backstop) -> must force-dismiss. True for both
  // 'pending' (show in flight) and 'visible' (fully shown) since a stuck
  // popover can be observed in either sub-state.
  assert.equal(shouldForceDismissOnOutsideInteraction('visible', true), true)
  assert.equal(shouldForceDismissOnOutsideInteraction('pending', true), true)
  console.log(
    '✓ shouldForceDismissOnOutsideInteraction: takesFocus overlay in "visible" or "pending" -> true (guarantees a way out)'
  )
}

{
  // Non-takesFocus overlays (hoverCard, detailsCard, projectCard, noticeBanner,
  // chipTooltip) are NOT covered by this backstop — they're dismissed by
  // their own hover-leave/timer logic, have no keyboard focus to steal, and
  // (being acceptsClicks + !takesFocus) never become the key window, so a
  // main-window 'focus' event was never caused by them in the first place.
  // Force-dismissing them here would be an unjustified behavior change for
  // kinds this bug doesn't affect.
  assert.equal(shouldForceDismissOnOutsideInteraction('visible', false), false)
  assert.equal(shouldForceDismissOnOutsideInteraction('visible', undefined), false)
  console.log(
    '✓ shouldForceDismissOnOutsideInteraction: non-takesFocus overlays (hoverCard/detailsCard/projectCard/noticeBanner/chipTooltip) are never force-dismissed by this backstop — out of scope, own dismissal mechanism'
  )
}

{
  // No overlay actually showing (idle/exiting/recovering/unregistered/
  // unavailable) -> always false, even if takesFocus happens to be true from
  // a stale descriptor reference — nothing to dismiss.
  for (const s of ['idle', 'exiting', 'recovering', 'unregistered', 'unavailable'] as const) {
    assert.equal(
      shouldForceDismissOnOutsideInteraction(s, true),
      false,
      `expected false for state=${s}`
    )
  }
  console.log(
    '✓ shouldForceDismissOnOutsideInteraction: no overlay pending/visible -> always false, regardless of takesFocus (nothing to dismiss)'
  )
}

console.log('\nAll overlay-dismissal assertions passed.')
