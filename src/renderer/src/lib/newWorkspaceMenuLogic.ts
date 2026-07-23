// ---------------------------------------------------------------------------
// src/renderer/src/lib/newWorkspaceMenuLogic.ts
//
// Pure logic backing the "+ new workspace" popover's native-overlay port
// (model-routing unit 10-creation) — kept free of React/Electron so
// scripts/verify-new-workspace-menu.ts can exercise every decision offline,
// mirroring creationProviderMenu.ts's own pattern. Three independently
// assertable pieces:
//
//   1. The create-payload decision (rule 4's inversion): given the current
//      isolation mode + selection + branch text, what does pressing
//      Enter/clicking the top line actually do? ('local' create with model,
//      or 'worktree' create with branch+model, or disabled).
//   2. The hover-intent timer state machine — now scoped to the PROVIDER ->
//      MODEL FLYOUT SUBMENU only (the trigger itself is click-only, see #3):
//      a tiny reducer over enter-row/leave-row/enter-submenu/leave-submenu
//      events that decides whether a pending open/close timer should fire,
//      be cancelled, or be re-armed — the classic "diagonal traversal into a
//      submenu" problem every hierarchical menu (macOS menus, VS Code
//      context menus) has to solve. useOverlayHoverCard (existing hook)
//      already implements the TIMING half (setTimeout bookkeeping); this
//      module is the DECISION half — same shape as every other pure/hook
//      split in this codebase (creationProviderMenu.ts is the data half of
//      NewWorkspaceMenu.tsx, useCreationLastUsedState is the React half).
//   3. The submenu flip/clamp placement decision — given the parent panel's
//      measured rect, the submenu's natural size, and the available screen
//      width, does the submenu open to the right (preferred) or flip to the
//      left, and how far (if at all) does it need to be nudged up to stay
//      on-screen vertically? Mirrors src/main/overlayLayer.ts's own
//      computeAnchoredPlacement flip/clamp shape, but computed CLIENT-SIDE
//      against the parent row's rect since both panels live inside the SAME
//      overlay window/surface (see NewWorkspaceMenu.tsx's kind-level doc
//      comment for why: a second overlay WINDOW would need its own
//      cross-window pointer-boundary bridge, which the existing overlay
//      infra doesn't support and isn't needed when one window can size to
//      fit both panels side-by-side).
// ---------------------------------------------------------------------------

export type NewWorkspaceMenuIsolation = 'local' | 'worktree'

export type CreateDecision =
  | { kind: 'local'; modelId: string | undefined }
  | { kind: 'worktree'; modelId: string | undefined; branch: string }
  | { kind: 'disabled' }

/**
 * What pressing Enter / clicking the top line actually does, given the
 * current isolation mode + selection + branch text. Mirrors
 * NewWorkspaceMenu.tsx's handleCreate exactly:
 *   - 'local' isolation always creates (selectedModelId undefined means "use
 *     the global/project default", unchanged pre-existing behavior).
 *   - 'worktree' isolation creates ONLY when the branch field has non-blank
 *     text (matches the top line's own disabled condition in the overlay
 *     kind) — an empty/whitespace-only branch resolves to 'disabled' rather
 *     than silently creating with a garbage branch name.
 */
export function decideCreateAction(
  isolation: NewWorkspaceMenuIsolation,
  selectedModelId: string | null | undefined,
  branchValue: string
): CreateDecision {
  const modelId = selectedModelId ?? undefined
  if (isolation === 'local') return { kind: 'local', modelId }
  const trimmed = branchValue.trim()
  if (!trimmed) return { kind: 'disabled' }
  return { kind: 'worktree', modelId, branch: trimmed }
}

// ---------------------------------------------------------------------------
// Submenu hover-intent decision reducer (the provider-row -> model-flyout
// diagonal-traversal problem).
// ---------------------------------------------------------------------------

export type HoverIntentEvent = 'enterTrigger' | 'leaveTrigger' | 'enterCard' | 'leaveCard' | 'click'

export type HoverIntentAction =
  | { type: 'scheduleOpen' }
  | { type: 'scheduleClose' }
  | { type: 'cancelTimer' }
  | { type: 'toggleImmediate' }
  | { type: 'noop' }

/**
 * Decides what a hover-intent event should do to the pending open/close
 * timer for the provider -> model FLYOUT SUBMENU, given whether it's
 * currently open. Event names stay generic ('enterTrigger'/'enterCard' etc.)
 * rather than renamed to 'enterRow'/'enterSubmenu' — the underlying shape
 * (anchor row vs. floating panel) is identical, only WHAT plays the
 * "trigger"/"card" role changed (a provider row instead of the whole
 * popover's own "+" trigger, now that the top-level popover is click-only —
 * see NewWorkspaceMenu.tsx's own doc comment on why hover-to-open was
 * removed at that level).
 *
 * The crux fix this encodes — the classic "diagonal traversal into a
 * submenu" problem every hierarchical menu (macOS menus, VS Code context
 * menus) has to solve: 'enterCard' (pointer reaches the submenu) while open
 * must CANCEL any close scheduled by a prior 'leaveTrigger' (pointer left
 * the parent row on its way to the submenu) — never let the submenu vanish
 * out from under an in-transit pointer crossing the gap between the row and
 * the flyout. 'leaveCard' re-arms the SAME close timer 'leaveTrigger' would
 * have scheduled, so leaving via the submenu behaves identically to leaving
 * via the row. Hovering a DIFFERENT provider row isn't a distinct event here
 * — the call site treats it as an immediate re-target (new
 * activeProviderId) plus 'enterTrigger' semantics (cancel any pending close)
 * since the popover is already open.
 */
export function decideHoverIntentAction(
  event: HoverIntentEvent,
  isOpen: boolean
): HoverIntentAction {
  switch (event) {
    case 'enterTrigger':
      // Already open (e.g. re-entering after a moment, or switching to a
      // different row) — just cancel any pending close rather than
      // re-scheduling a redundant open.
      return isOpen ? { type: 'cancelTimer' } : { type: 'scheduleOpen' }
    case 'leaveTrigger':
      return { type: 'scheduleClose' }
    case 'enterCard':
      // The crux of the bug fix: reaching the submenu (across the row-to-
      // flyout gap) must cancel any close scheduled by a prior leaveTrigger
      // — never let the submenu vanish out from under an in-transit pointer.
      return { type: 'cancelTimer' }
    case 'leaveCard':
      return { type: 'scheduleClose' }
    case 'click':
      return { type: 'toggleImmediate' }
    default:
      return { type: 'noop' }
  }
}

// ---------------------------------------------------------------------------
// Submenu left/right flip — CLIENT-SIDE, computed against the parent panel's
// own measured screen rect. Both panels are laid out as IN-FLOW flex
// siblings inside the SAME overlay window (see NewWorkspaceMenu.tsx's — the
// overlay-kind half's — header comment for why: an out-of-flow `position:
// absolute` submenu wouldn't contribute to the ancestor `width: max-content`
// card's intrinsic size, so the overlay window's ResizeObserver-driven
// bounds would clip it). Only the SIDE is decided here (a CSS flex `order`
// swap at the call site); VERTICAL clamping of the resulting (now wider)
// card is handled entirely by the EXISTING main-process placement machinery
// (src/main/overlayLayer.ts's computeAnchoredPlacement), which already
// clamps whatever total card size gets reported — no duplicate vertical
// clamp needed here.
// ---------------------------------------------------------------------------

export interface SubmenuSideInput {
  /** The parent panel's LEFT edge, in real screen coordinates (window.screenX + the panel's own client rect left) — needed because the overlay window itself is sized to its CURRENT content, which may not yet include the submenu on the frame this is computed. */
  parentPanelLeft: number
  parentPanelWidth: number
  /** The submenu's own (fixed) width. */
  submenuWidth: number
  /** The display's available width (screen coordinates). */
  screenWidth: number
  /** Gap between the parent panel's edge and the submenu, matching ANCHOR_GAP's role in overlayLayer.ts. */
  gap: number
}

/**
 * Decides whether the model flyout opens to the right (preferred) or flips
 * to the left of the parent panel when there isn't room on the right. Pure
 * function of measured geometry — no timers, no React — so it's assertable
 * without an Electron BrowserWindow in the test harness, the same way
 * computeAnchoredPlacement's equivalent decision would be.
 */
export function computeSubmenuSide(input: SubmenuSideInput): 'left' | 'right' {
  const { parentPanelLeft, parentPanelWidth, submenuWidth, screenWidth, gap } = input
  const fitsRight = parentPanelLeft + parentPanelWidth + gap + submenuWidth <= screenWidth
  if (fitsRight) return 'right'
  const fitsLeft = parentPanelLeft - gap - submenuWidth >= 0
  return fitsLeft ? 'left' : 'right'
}

// ---------------------------------------------------------------------------
// Phantom-hover gate — root-caused via runtime instrumentation (not guessed):
// this popover is the only overlay kind whose card size changes as a DIRECT
// consequence of a hover handler (hovering a provider row opens a flyout
// submenu, growing the card, which grows the host BrowserWindow via
// overlayLayer's setBounds). The window starts at a generous default guess
// and then shrinks/grows several times as the real size is measured and as
// submenus open/close. Every one of those resizes moves the WINDOW under
// whatever the OS mouse cursor is resting on (the cursor itself never
// moves) — Chromium then delivers a perfectly genuine, but spurious, native
// mouseenter/mouseleave for that transition. Left unguarded this cascades:
// a phantom mouseenter opens a DIFFERENT provider's submenu, growing the
// window again, moving yet another element under the stationary cursor —
// an observed, self-sustaining open/close/reassign loop with no real input
// at all (reproduced live: with the popover left open and no attached
// input, hoverProvider fired repeatedly across every provider in the list,
// driven purely by the window's own resizes). This is the mechanism behind
// the reported "I can see it for a split second and then it's gone."
//
// This is the pure decision half (assertable without a live BrowserWindow,
// same split as decideHoverIntentAction above): a resize event ends any
// "genuine hover" streak; only a real mousemove re-establishes it. A hover
// (mouseenter) is trusted only when the pointer has genuinely moved since
// the last resize.
// ---------------------------------------------------------------------------

export type HoverGateEvent = 'resize' | 'mousemove'

/** Decides the next "has the pointer genuinely moved since the last resize"
 *  flag value for one new event — independent of the PRIOR flag value
 *  (deliberately so, not an oversight): `resize` always clears it back to
 *  false (a window-geometry change, real or not, must not be mistaken for
 *  consent to open something) and `mousemove` always sets it true (the ONLY
 *  thing that can re-arm trust), so neither branch needs the previous value
 *  to decide the next one. */
export function reduceHoverGate(event: HoverGateEvent): boolean {
  return event === 'mousemove'
}

/** Whether a hover (mouseenter/onPointerEnter) firing right now should be
 *  trusted as user-driven, given the current gate flag. */
export function isGenuineHover(hasMoved: boolean): boolean {
  return hasMoved
}

// ---------------------------------------------------------------------------
// Provider-row intent decision (bug fixes reported after the flyout-submenu
// redesign shipped):
//
//   Bug A — hovering a provider row was mutating the COMMITTED top-line
//   selection (selectedProviderId/selectedModelId), which is also the create
//   payload — so merely moving the mouse over "openai" silently changed what
//   Enter/the top line would create. Hover must be PURELY navigational: it
//   may only switch which provider's model list the flyout submenu shows, a
//   plain UI-navigation fact, never the create payload.
//
//   Bug B — picking a model used to close the submenu (conventional-menu
//   behavior: a leaf pick ends the interaction). That's wrong here because
//   the create-action inversion means picking a model is only a STEP, not
//   the action itself — the user still has to reach the top line and click
//   it (or press Enter) afterward. Closing the submenu on pick made that
//   next step harder to find. Picking a model must leave the submenu OPEN.
//
// This function is the pure decision half of both fixes: given the kind of
// interaction with a provider row, does it commit the provider to the top
// line, and does it keep the submenu open? (Explicit clicks and the
// keyboard's ArrowRight/Enter-into-row use the SAME 'pick' intent as a mouse
// click — see NewWorkspaceMenu.tsx's onPickProvider handler and the overlay
// kind's pickProviderRow.)
// ---------------------------------------------------------------------------

export type ProviderRowIntent = 'hover' | 'pick'

export interface ProviderRowIntentAction {
  /** Whether this interaction commits the provider (and its last-used model)
   *  to the top line — the create payload. */
  commitsSelection: boolean
  /** Whether the flyout submenu should stay open afterward. Always true for
   *  provider-row interactions (unlike a model pick, which ALSO always keeps
   *  the submenu open per Bug B — see decideModelPickAction below — a
   *  provider row interaction opens/keeps the submenu by definition). */
  keepsSubmenuOpen: boolean
}

/** Decides what a provider-ROW interaction (hover vs. explicit pick) should
 *  do to the committed selection. A hover only ever previews (opens/switches
 *  the submenu); only an explicit pick (click, or ArrowRight/Enter navigating
 *  into the row) commits that provider's last-used model to the top line. */
export function decideProviderRowIntent(intent: ProviderRowIntent): ProviderRowIntentAction {
  return { commitsSelection: intent === 'pick', keepsSubmenuOpen: true }
}

/** Decides what picking a SPECIFIC model (a leaf row inside the flyout
 *  submenu) should do. Unlike a conventional menu (where a leaf pick IS the
 *  action and closes the menu), this popover's create action lives on the
 *  top line — so picking a model always commits the selection AND always
 *  keeps the submenu open (Bug B): the user still needs to reach the top
 *  line afterward. */
export function decideModelPickAction(): ProviderRowIntentAction {
  return { commitsSelection: true, keepsSubmenuOpen: true }
}

// ---------------------------------------------------------------------------
// Row-hover reducer — the "three rows stuck highlighted at once" fix.
//
// ROOT CAUSE (confirmed, not guessed): every row in both panels carried a
// CSS `hover:bg-surface-raised` pseudo-class IN ADDITION TO the JS-tracked
// `highlighted` index. `:hover` is evaluated by Chromium purely off live
// window/cursor geometry — it is NOT an event this component intercepts, so
// it completely bypasses the existing genuine-hover gate
// (reduceHoverGate/isGenuineHover, above) that was built specifically to
// stop this popover's own resizes from being misread as user input. This
// popover's card size changes as a DIRECT side effect of hovering (opening a
// submenu grows the card, which grows the host BrowserWindow via
// overlayLayer.ts's setBounds, moving the window under a STATIONARY OS
// cursor across several intermediate resize frames). Each intermediate
// frame can leave a DIFFERENT row's rect under the cursor, and because
// `:hover` is a live pseudo-class rather than a discrete event, Chromium can
// end up with more than one row simultaneously satisfying `:hover` across
// those settling frames — reproducing the reported "three rows painted at
// once while the pointer is elsewhere" bug. Swapping `hover:` for a single
// JS-tracked hovered-row index (gated through the SAME genuine-hover check)
// makes "at most one row highlighted" structurally true: there is exactly
// ONE `HoveredRow` value in state, not a per-row browser-computed boolean.
//
// This is the pure decision half (assertable without a live DOM/BrowserWindow,
// same split as reduceHoverGate/decideHoverIntentAction above): given a
// pointer-enter/leave/clear event and the current hovered row, what should
// the next hovered row be?
// ---------------------------------------------------------------------------

export type HoverRowPanel = 'providers' | 'models'

/** Exactly one row (or none) may be hovered at a time — a single optional
 *  value, not a per-row flag, so "at most one highlighted row" is
 *  structurally guaranteed rather than incidentally true. */
export type HoveredRow = { panel: HoverRowPanel; index: number } | null

export type RowHoverEvent =
  | { type: 'pointerEnter'; panel: HoverRowPanel; index: number; genuine: boolean }
  | { type: 'pointerLeave'; panel: HoverRowPanel; index: number }
  | { type: 'clear' }

/**
 * Decides the next hovered-row value for one new event.
 *
 * - `pointerEnter` only takes effect when `genuine` is true (the caller has
 *   already run it through isGenuineHover) — a phantom pointerenter fired by
 *   the window's own resize must leave the CURRENT hovered row untouched
 *   (not clear it either: a resize-driven phantom enter on one row should
 *   not blow away a still-valid hover on a different one; the entire point
 *   of the gate is that non-genuine events are simply ignored).
 * - `pointerLeave` only clears the hovered row when it matches the row that
 *   is leaving — an out-of-order/stale leave for a row that's no longer the
 *   current hover (e.g. after a different row's genuine enter already
 *   replaced it) must not clobber the newer hover.
 * - `clear` unconditionally resets to no hover — used for resize, submenu
 *   provider switch, and popover close (see call site).
 */
export function reduceRowHover(event: RowHoverEvent, current: HoveredRow): HoveredRow {
  switch (event.type) {
    case 'pointerEnter':
      if (!event.genuine) return current
      return { panel: event.panel, index: event.index }
    case 'pointerLeave':
      if (current && current.panel === event.panel && current.index === event.index) return null
      return current
    case 'clear':
      return null
    default:
      return current
  }
}
