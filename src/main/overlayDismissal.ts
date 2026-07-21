// ---------------------------------------------------------------------------
// src/main/overlayDismissal.ts
//
// Pure dismissal/safety-net predicates for src/main/overlayLayer.ts — the
// "stuck popover blocks the whole app" fix (model-routing unit 10-creation,
// follow-up). Extracted into their OWN module (importing nothing from
// electron) so they're independently assertable offline via
// scripts/verify-overlay-dismissal.ts, the same way
// src/renderer/src/lib/newWorkspaceMenuLogic.ts's decide* functions are
// tested by scripts/verify-new-workspace-menu.ts — overlayLayer.ts itself
// can't be imported standalone (it imports `electron` at module scope, which
// only resolves inside the Electron runtime).
//
// Every stateful call site in overlayLayer.ts (hideOverlay,
// dismissInteractiveOverlayOnMainFocus, the before-input-event Escape
// backstop) is a thin wrapper that reads the module's live
// state/currentDescriptor and defers the actual decision to these functions.
// ---------------------------------------------------------------------------

export type OverlayState =
  | 'unregistered'
  | 'unavailable'
  | 'recovering'
  | 'idle'
  | 'pending'
  | 'visible'
  | 'exiting'

/**
 * hideOverlay's core decision: given the live state for the id being hidden,
 * should this call (a) act as a normal exit-fade hide, (b) force an
 * immediate hide (the id matched but the show hadn't finished pending), or
 * (c) no-op (stale id, or nothing to do)?
 *
 * ROOT CAUSE this codifies: every takesFocus overlay (newWorkspaceMenu,
 * workspaceSettingsCard, chipPrompt, chipDropdown) is a card-sized child
 * BrowserWindow with no backdrop, dismissed by each call site's own
 * `document.addEventListener('pointerdown', ...)` on the MAIN window (see
 * NewWorkspaceMenu.tsx, WorkspaceSettingsPopover.tsx, ActionChip.tsx,
 * DropdownChip.tsx — all four use this exact idiom, so this is a GENERAL
 * overlay-layer gap, not specific to one menu). Their unmount cleanup calls
 * hideOverlay(id) unconditionally — but hideOverlay previously silently
 * no-op'd unless state === 'visible', so a hide() racing an in-flight
 * (not-yet-acked) show for the SAME id (owning component unmounts between
 * showOverlay() and its paint-ack — a sidebar row re-render, an idSuffix
 * remount, or a StrictMode double-invoke can all trigger this) was dropped
 * entirely. The show went on to complete and paint the popover, with no live
 * component left to ever call hide again: a permanently-visible overlay with
 * nothing left to dismiss it, exactly matching "stuck, can't even click
 * anywhere to make it go away." Once an id match is confirmed here, the
 * caller unambiguously wants that id gone regardless of which sub-state it's
 * in, so 'pending' now forces an immediate hide instead of being dropped.
 */
export function decideHideAction(
  requestedId: string,
  currentId: string | null,
  state: OverlayState
): 'normal-hide' | 'force-hide' | 'noop' {
  if (currentId === null || currentId !== requestedId) return 'noop'
  if (state === 'pending') return 'force-hide'
  if (state === 'visible') return 'normal-hide'
  return 'noop'
}

/**
 * The general "outside interaction while an interactive overlay is showing"
 * backstop shared by two call sites in overlayLayer.ts: the main-window
 * 'focus' listener (a click anywhere on the main window while a takesFocus
 * overlay is pending/visible is unambiguous proof the click did NOT land on
 * the overlay — a takesFocus overlay is the key window while shown, and only
 * a click on the main window makes AppKit hand key-window status back to
 * it) and the overlay window's own before-input-event Escape backstop
 * (defense-in-depth alongside OverlayRoot.tsx's renderer-side Escape
 * handler, for the case the overlay renderer is wedged/mid-recovery and its
 * own JS never runs).
 *
 * Scoped to takesFocus overlays only: hoverCard/detailsCard/projectCard/
 * noticeBanner/chipTooltip are acceptsClicks-but-not-takesFocus, dismissed by
 * their own hover-leave/timer logic, and never become the key window in the
 * first place — force-dismissing them here would be an unjustified behavior
 * change for kinds this bug doesn't affect.
 */
export function shouldForceDismissOnOutsideInteraction(
  state: OverlayState,
  takesFocus: boolean | undefined
): boolean {
  if (state !== 'pending' && state !== 'visible') return false
  return !!takesFocus
}
