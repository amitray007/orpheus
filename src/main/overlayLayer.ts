// ---------------------------------------------------------------------------
// src/main/overlayLayer.ts
//
// U4 — the single owner of the overlay host: a pre-warmed, transparent,
// frameless CHILD BrowserWindow attached to the main window via `parent`.
//
// Why a child window and not a same-window WebContentsView: all Electron web
// content in ONE window composites through a single native
// ViewsCompositorSuperview, so a same-window WebContentsView can never render
// above the native libghostty terminal NSView that the addon parents onto
// that same window. A separate window has its OWN compositor and, attached
// via `parent`, always stacks above the main window and moves with it on
// macOS. Everything else here (overlay renderer, overlayApi bridge, state
// machine, generations, exclusivity token, events) is unchanged from the
// WebContentsView-hosted design.
//
// State machine (unchanged shape; registration handshake removed — see below):
//
//   unregistered -> idle -> pending(gen) -> visible(gen) -> exiting(gen) -> idle
//   exiting(A) -> pending(B)   (an incoming show preempts the exit fade)
//   idle/pending/visible/exiting -> recovering  (overlay renderer crash / nav)
//   recovering -> idle                          (renderer ready ping)
//   unregistered -> idle | unavailable          (ONLY if child-window create/load fails)
//   unavailable -> idle                         (ONLY via a fresh initOverlayLayer)
//
// There is no more addon-side registration handshake (beginOverlayRegistration
// / commitOverlayRegistration / isOverlayRegistered / reassertOverlayOrder) —
// those addon exports still exist but are no longer called from here; a
// same-window-sibling ordering problem doesn't apply to a separate window.
// 'unavailable' is now reached only if creating/loading the child window
// itself fails.
// ---------------------------------------------------------------------------

import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import type {
  OverlayDescriptor,
  OverlayShowResult,
  OverlayShowMessage,
  OverlayUpdateMessage,
  OverlaySizeReport,
  OverlayAck,
  OverlayEvent
} from '../shared/types'
import type { GhosttySurfaceAddon } from '../../packages/ghostty-surface/index'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type OverlayState =
  | 'unregistered'
  | 'unavailable'
  | 'recovering'
  | 'idle'
  | 'pending'
  | 'visible'
  | 'exiting'

let win: BrowserWindow | null = null
let addon: GhosttySurfaceAddon | null = null
let overlayWin: BrowserWindow | null = null

// Cleanup callback for the geometry listeners wired onto the current `win`
// (plan: "listeners on the window registered at init and cleaned on
// 'closed'"). Also invoked defensively at the top of `initOverlayLayer` in
// case of a re-entrant call without an intervening 'closed' (window recreation).
let geometryListenersCleanup: (() => void) | null = null

let state: OverlayState = 'unregistered'
let generation = 0

// The descriptor currently pending/visible/exiting (cleared back to null at idle).
let currentDescriptor: OverlayDescriptor | null = null
let currentGeneration = 0
// Latest renderer-reported natural card size for the CURRENT generation (anchored
// mode only). Cleared on every new showOverlay() so a stale size from a prior
// descriptor is never reused for a new one. Null until the first reportSize for
// this generation lands, in which case DEFAULT_ANCHORED is used as a
// generous-then-shrink placeholder (the window is transparent, so oversize before
// the first report is invisible — see plan KTD).
let currentAnchoredSize: { w: number; h: number } | null = null
// Display scale factor captured at show time, for the `move` scaleFactor-diff
// dismissal check on anchored overlays (KTD: "dismiss anchored overlays on
// monitor change").
let currentScaleFactor: number | null = null

// True once the overlay webContents has finished its FIRST load — used to
// distinguish the initial navigation from a genuine "navigated away" event
// that should trigger recovery.
let initialLoadDone = false

// Exclusivity token — held by an interactive (acceptsClicks || takesFocus)
// overlay from idle->pending acquisition through exiting, released at the
// point hide/forceHide completes (transition back to idle).
let overlayTokenHeld = false

// Current theme string, pushed to the overlay renderer at init, on every
// uiState theme change, and embedded in every show message.
let currentTheme = 'midnight'

// Pending show() promise plumbing, keyed by generation.
type PendingShow = {
  generation: number
  resolve: (r: OverlayShowResult) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}
let pendingShow: PendingShow | null = null

// Pending hide() exit-wait plumbing, keyed by id+generation.
type PendingExit = {
  id: string
  generation: number
  resolve: () => void
  timer: ReturnType<typeof setTimeout>
}
let pendingExit: PendingExit | null = null

// Deps injected from index.ts (see initOverlayLayer's third param) — mirrors
// the `startPowerAwake(getMainWindow)` accessor-injection convention so this
// module never imports index.ts's module-level `mainWindowRef` directly.
export type OverlayLayerDeps = {
  getMainWindow: () => BrowserWindow | null
  /** Focus the active workspace's terminal (via getCurrentlyViewedWorkspace() + addon.focus). No-op if there's no currently-viewed workspace. */
  focusActiveWorkspaceTerminal: () => boolean
  /** Force-dismiss the currently-open native popover chassis card, if any (dismiss-on-acquire, KTD). No-op if none is open. */
  dismissActiveNativePopover: () => void
}
let deps: OverlayLayerDeps | null = null

const SHOW_TIMEOUT_MS = 500
const EXIT_WAIT_CAP_MS = 150
const ANCHOR_GAP = 6
// Generous-then-shrink default window size for an anchored overlay before the
// first renderer-reported card size lands for its generation. The overlay
// window is transparent, so any oversize beyond the card's actual content is
// invisible to the user — a brief input-swallow in that dead zone (mouse
// events over transparent-but-window-covered pixels) is a known accepted
// side effect (see plan KTD).
const DEFAULT_ANCHORED = { w: 440, h: 380 }

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function overlayAlive(): boolean {
  return !!overlayWin && !overlayWin.isDestroyed()
}

function winAlive(): boolean {
  return !!win && !win.isDestroyed()
}

function clearPendingShowTimer(): void {
  if (pendingShow) {
    clearTimeout(pendingShow.timeout)
  }
}

function clearPendingExitTimer(): void {
  if (pendingExit) {
    clearTimeout(pendingExit.timer)
  }
}

/** Reject and clear any in-flight show promise (used by forceHide / recovery / unavailable transitions). */
function rejectPendingShow(reason: string): void {
  if (!pendingShow) return
  clearPendingShowTimer()
  const p = pendingShow
  pendingShow = null
  p.reject(new Error(`[overlayLayer] show rejected: ${reason}`))
}

/** Resolve and clear any pending exit-wait promise (used when the renderer's `exited` event lands, or when we give up waiting). */
function resolvePendingExit(): void {
  if (!pendingExit) return
  clearPendingExitTimer()
  const p = pendingExit
  pendingExit = null
  p.resolve()
}

// ---------------------------------------------------------------------------
// Focus-restore chain (R6): saved responder -> active workspace terminal -> main webContents
// ---------------------------------------------------------------------------

function runFocusRestoreChain(hadTakesFocus: boolean): void {
  if (!addon) return
  addon.setOverlayFocusSuppressed(false)
  const shouldRestore = hadTakesFocus || addon.isOverlayFirstResponder()
  if (!shouldRestore) return
  // Re-key the main window first so the subsequent restore chain (which
  // operates on the MAIN window's native first responder / webContents) has
  // a focused window to act on — the overlay's own child window currently
  // holds key-window status when hadTakesFocus.
  if (hadTakesFocus && winAlive()) win!.focus()
  const restored = addon.restoreOverlayFirstResponder()
  if (restored) return
  const focusedTerminal = deps?.focusActiveWorkspaceTerminal() ?? false
  if (focusedTerminal) return
  if (winAlive()) win!.webContents.focus()
}

// ---------------------------------------------------------------------------
// Geometry (screen coordinates — the overlay is now a separate top-level
// window, so all bounds must be in SCREEN space, not contentView-relative
// DIPs as when it was a WebContentsView child).
// ---------------------------------------------------------------------------

function getWindowContentBounds(): { x: number; y: number; width: number; height: number } {
  if (!winAlive()) return { x: 0, y: 0, width: 0, height: 0 }
  return win!.getContentBounds()
}

/**
 * Anchored placement algorithm.
 *
 * The anchorRect (already zoomFactor-scaled to screen-ish DIPs by the caller)
 * is the element to attach TO — e.g. a 200x32 chip — never the window size.
 * The window is sized to the latest renderer-reported natural card size for
 * the current generation (falling back to DEFAULT_ANCHORED before the first
 * report), then placed adjacent to the anchor on `preferredSide` (default
 * 'bottom'), flipping to the opposite side when the preferred side doesn't
 * have room within the parent content bounds, and finally clamped so the
 * window stays fully inside those content bounds.
 *
 * `content` and `anchor` must both already be in the SAME coordinate space
 * (parent-content-relative DIPs); the result is translated to screen space
 * by the caller.
 */
function computeAnchoredPlacement(
  anchor: { x: number; y: number; w: number; h: number },
  size: { w: number; h: number },
  preferredSide: 'top' | 'bottom' | 'left' | 'right',
  content: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const w = Math.min(size.w, content.width)
  const h = Math.min(size.h, content.height)

  const fitsBottom = anchor.y + anchor.h + ANCHOR_GAP + h <= content.height
  const fitsTop = anchor.y - ANCHOR_GAP - h >= 0
  const fitsRight = anchor.x + anchor.w + ANCHOR_GAP + w <= content.width
  const fitsLeft = anchor.x - ANCHOR_GAP - w >= 0

  const fits: Record<'top' | 'bottom' | 'left' | 'right', boolean> = {
    top: fitsTop,
    bottom: fitsBottom,
    left: fitsLeft,
    right: fitsRight
  }
  const opposite: Record<'top' | 'bottom' | 'left' | 'right', 'top' | 'bottom' | 'left' | 'right'> =
    { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

  // Flip to the opposite side when the preferred side has insufficient room;
  // if neither fits, keep the preferred side (clamp below will pull it back
  // on-screen as best-effort).
  const side = fits[preferredSide]
    ? preferredSide
    : fits[opposite[preferredSide]]
      ? opposite[preferredSide]
      : preferredSide

  let x: number
  let y: number
  if (side === 'bottom') {
    x = anchor.x
    y = anchor.y + anchor.h + ANCHOR_GAP
  } else if (side === 'top') {
    x = anchor.x
    y = anchor.y - ANCHOR_GAP - h
  } else if (side === 'right') {
    x = anchor.x + anchor.w + ANCHOR_GAP
    y = anchor.y
  } else {
    x = anchor.x - ANCHOR_GAP - w
    y = anchor.y
  }

  // Clamp fully inside the parent content bounds.
  x = Math.min(Math.max(x, 0), Math.max(0, content.width - w))
  y = Math.min(Math.max(y, 0), Math.max(0, content.height - h))

  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }
}

/** Compute the target bounds (SCREEN coordinates) for the current descriptor. */
function computeScreenBounds(descriptor: OverlayDescriptor): {
  x: number
  y: number
  width: number
  height: number
} {
  const content = getWindowContentBounds()
  if (descriptor.placement.mode === 'centered') {
    return { x: content.x, y: content.y, width: content.width, height: content.height }
  }
  // Anchored: the anchorRect comes from the main renderer's DOM (see plan KTD
  // on getBoundingClientRect() * getZoomFactor()) — scale it to screen-ish
  // DIPs, then run the side-selection/flip/clamp placement algorithm against
  // the latest reported card size (or the generous default before the first
  // report), then offset by the content bounds' screen origin to land in
  // screen coordinates.
  const zoom = winAlive() ? win!.webContents.getZoomFactor() : 1
  const anchorRect = descriptor.placement.anchorRect
  const anchor = {
    x: anchorRect.x * zoom,
    y: anchorRect.y * zoom,
    w: anchorRect.w * zoom,
    h: anchorRect.h * zoom
  }
  const size = currentAnchoredSize ?? DEFAULT_ANCHORED
  const preferredSide = descriptor.placement.preferredSide ?? 'bottom'

  const placed = computeAnchoredPlacement(anchor, size, preferredSide, {
    width: content.width,
    height: content.height
  })

  return {
    x: Math.round(content.x + placed.x),
    y: Math.round(content.y + placed.y),
    width: placed.width,
    height: placed.height
  }
}

function applyCurrentBounds(): void {
  if (!overlayAlive() || !currentDescriptor) return
  overlayWin!.setBounds(computeScreenBounds(currentDescriptor))
}

// ---------------------------------------------------------------------------
// initOverlayLayer — construction of the child overlay window
//
// Re-entrant: called once per window (per plan, on `ready-to-show`). Tears
// down prior overlay window/state on each call so window recreation
// (dock-activate) re-attaches cleanly to the new parent.
// ---------------------------------------------------------------------------

export function initOverlayLayer(
  window: BrowserWindow,
  ghosttyAddon: GhosttySurfaceAddon,
  layerDeps: OverlayLayerDeps
): void {
  // Idempotency guard (per-window): 'ready-to-show' can refire for the SAME
  // BrowserWindow — e.g. backgroundThrottling: false on the main window means
  // each new overlay window's first paint can re-trigger 'ready-to-show'. If
  // we're already initialized for this exact window and the child window is
  // still alive, skip the teardown/reconstruct entirely; otherwise every
  // refire tears down + recreates the child window, which itself re-triggers
  // the event — a self-sustaining loop. Re-init must still proceed for a
  // genuinely new BrowserWindow instance (window recreation) or a dead child.
  if (win === window && state !== 'unregistered' && overlayAlive()) {
    console.log(
      '[overlayLayer] init skipped — already initialized for this window (ready-to-show refire)'
    )
    return
  }

  // Tear down any prior child window/state (window recreation path).
  clearPendingShowTimer()
  clearPendingExitTimer()
  pendingShow = null
  pendingExit = null
  currentDescriptor = null
  currentGeneration = 0
  currentScaleFactor = null
  currentAnchoredSize = null
  overlayTokenHeld = false
  initialLoadDone = false
  if (geometryListenersCleanup) {
    geometryListenersCleanup()
    geometryListenersCleanup = null
  }
  if (overlayAlive()) {
    try {
      overlayWin!.destroy()
    } catch (err) {
      console.error('[overlayLayer] destroying old overlay window failed:', err)
    }
  }
  overlayWin = null

  win = window
  addon = ghosttyAddon
  deps = layerDeps
  state = 'unregistered'

  try {
    overlayWin = new BrowserWindow({
      parent: win,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      skipTaskbar: true,
      roundedCorners: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.js'),
        sandbox: false,
        backgroundThrottling: false
      }
    })
  } catch (err) {
    state = 'unavailable'
    overlayWin = null
    console.error(
      '[overlayLayer] child window creation failed — overlay unavailable, chassis fallback remains:',
      err
    )
    return
  }

  wireOverlayWebContentsListeners(overlayWin)

  try {
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      overlayWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
    } else {
      overlayWin.loadFile(join(__dirname, '../renderer/overlay.html'))
    }
  } catch (err) {
    state = 'unavailable'
    console.error(
      '[overlayLayer] child window load failed — overlay unavailable, chassis fallback remains:',
      err
    )
    try {
      overlayWin.destroy()
    } catch {
      /* already gone */
    }
    overlayWin = null
    return
  }

  state = 'idle'

  wireWindowGeometryListeners(win)

  // Push current theme immediately once the view exists (also re-sent on the
  // renderer's `ready` ping and embedded in every show message — see
  // ipcMain.on('overlayRenderer:ready', ...) below and setOverlayTheme()).
  sendThemeToView()
}

// ---------------------------------------------------------------------------
// overlayRenderer:* ipcMain.on registrations (sends, not invokes — scoped to
// the single overlay window; no sender check for now since there is exactly
// one overlay window per the plan's "one pre-warmed overlay view" model)
// ---------------------------------------------------------------------------

function wireOverlayWebContentsListeners(window: BrowserWindow): void {
  const wc = window.webContents

  wc.on('did-finish-load', () => {
    initialLoadDone = true
  })

  wc.on('render-process-gone', () => {
    enterRecovering('render-process-gone')
  })

  wc.on('did-start-navigation', () => {
    // Only a genuine navigation AWAY from overlay.html counts — guard against
    // firing on the initial load.
    if (!initialLoadDone) return
    enterRecovering('did-start-navigation')
  })
}

function enterRecovering(reason: string): void {
  if (state === 'unregistered' || state === 'unavailable') return
  console.error(`[overlayLayer] entering recovering (${reason})`)
  state = 'recovering'
  rejectPendingShow(`overlay-recovering:${reason}`)
  resolvePendingExit()
  currentDescriptor = null
  overlayTokenHeld = false
  if (overlayAlive()) {
    try {
      overlayWin!.webContents.reload()
    } catch (err) {
      console.error('[overlayLayer] reload after recovering failed:', err)
    }
    overlayWin!.hide()
  }
}

// Registers the ipcMain.on handlers used by the overlay renderer. Called once
// from index.ts alongside initOverlayLayer's call site (module init), NOT
// per-window, since ipcMain.on is process-global by channel name.
let ipcListenersRegistered = false
export function registerOverlayRendererIpc(): void {
  if (ipcListenersRegistered) return
  ipcListenersRegistered = true

  ipcMain.on('overlayRenderer:ready', () => {
    if (state === 'unregistered' || state === 'unavailable') return
    if (state === 'recovering') {
      state = 'idle'
      console.log('[overlayLayer] recovering -> idle (renderer ready)')
    }
    sendThemeToView()
  })

  ipcMain.on('overlayRenderer:ackPainted', (_e, ack: OverlayAck) => {
    handleAckPainted(ack)
  })

  ipcMain.on('overlayRenderer:reportSize', (_e, report: OverlaySizeReport) => {
    handleReportSize(report)
  })

  ipcMain.on('overlayRenderer:event', (_e, event: OverlayEvent) => {
    handleOverlayRendererEvent(event)
  })
}

function handleAckPainted(ack: OverlayAck): void {
  if (!pendingShow || ack.generation !== pendingShow.generation) return // stale — dropped
  if (ack.generation !== currentGeneration) return

  clearPendingShowTimer()
  const p = pendingShow
  pendingShow = null

  if (ack.error) {
    if (overlayAlive()) overlayWin!.hide()
    releaseToken()
    state = 'idle'
    currentDescriptor = null
    p.reject(new Error(`[overlayLayer] overlay renderer reported error: ${ack.error}`))
    return
  }

  state = 'visible'
  if (currentDescriptor?.takesFocus && overlayAlive()) {
    overlayWin!.show()
    overlayWin!.webContents.focus()
    addon?.setOverlayFocusSuppressed(true)
  }
  p.resolve({ shown: true })
}

function handleReportSize(report: OverlaySizeReport): void {
  if (report.generation !== currentGeneration) return
  if (!currentDescriptor || currentDescriptor.id !== report.id) return
  if (currentDescriptor.placement.mode !== 'anchored') return // centered overlays ignore reportSize
  if (!overlayAlive()) return

  // Store the reported natural card size for this generation, then recompute
  // the FULL anchored placement (side selection + flip + clamp again, not a
  // naive in-place resize) — the new size can change which side fits.
  currentAnchoredSize = { w: report.w, h: report.h }
  overlayWin!.setBounds(computeScreenBounds(currentDescriptor))
}

function handleOverlayRendererEvent(event: OverlayEvent): void {
  // Forward verbatim to the main renderer.
  deps?.getMainWindow()?.webContents.send('overlay:event', event)

  // Resolve the hide()-side exit-wait promise, if one is pending for this id+gen.
  if (
    event.type === 'exited' &&
    pendingExit &&
    pendingExit.id === event.overlayId
    // generation is not carried on OverlayEvent; id match is sufficient since
    // only one overlay is ever exiting at a time.
  ) {
    resolvePendingExit()
  }
}

// ---------------------------------------------------------------------------
// Window geometry listeners (resize / fullscreen / move)
// ---------------------------------------------------------------------------

function wireWindowGeometryListeners(window: BrowserWindow): void {
  const onResize = (): void => {
    if (
      (state === 'visible' || state === 'pending') &&
      currentDescriptor?.placement.mode === 'centered'
    ) {
      applyCurrentBounds()
    }
  }

  const onEnterFullScreen = (): void => {
    // Child windows don't reliably follow their parent into a fullscreen
    // Space on macOS (a fullscreen window gets its own Space; a child
    // BrowserWindow is not guaranteed to be moved into that Space with it).
    // Rather than try to chase the parent across Spaces, force-hide any
    // active overlay on both fullscreen transitions — same policy on enter
    // and leave. This is a known limitation to revisit in the verification
    // sweep (U6) if fullscreen + overlay turns out to be a common pairing.
    console.log('[overlayLayer] enter-full-screen — force-hiding overlay (known limitation)')
    if (state === 'visible' || state === 'pending' || state === 'exiting') {
      forceHide('fullscreen-enter')
    }
  }

  const onLeaveFullScreen = (): void => {
    console.log('[overlayLayer] leave-full-screen — force-hiding overlay (known limitation)')
    if (state === 'visible' || state === 'pending' || state === 'exiting') {
      forceHide('fullscreen-leave')
    }
  }

  const onMove = (): void => {
    // On macOS, a child BrowserWindow attached via `parent` moves with its
    // parent automatically (the OS handles this at the window-server level)
    // — so, unlike the old WebContentsView host, we do NOT strictly need to
    // recompute bounds here for attachment to hold. Still, recompute centered
    // bounds on 'move' as a cheap self-heal in case the parent's content
    // bounds size/origin drifts (e.g. a move that coincides with a display
    // change) — this is defensive, not required for the child to keep
    // tracking the parent.
    if (
      (state === 'visible' || state === 'pending') &&
      currentDescriptor?.placement.mode === 'centered'
    ) {
      applyCurrentBounds()
    }

    // Anchored overlays: preserve the existing display-scale-change dismissal
    // check (monitor change while an anchored overlay is open).
    if (state !== 'visible' && state !== 'pending') return
    if (!currentDescriptor || currentDescriptor.placement.mode !== 'anchored') return
    if (currentScaleFactor === null) return
    if (!winAlive()) return
    const display = screen.getDisplayMatching(win!.getBounds())
    if (display.scaleFactor !== currentScaleFactor) {
      forceHide('display-scale-changed')
    }
  }

  window.on('resize', onResize)
  window.on('enter-full-screen', onEnterFullScreen)
  window.on('leave-full-screen', onLeaveFullScreen)
  window.on('move', onMove)

  const cleanup = (): void => {
    window.removeListener('resize', onResize)
    window.removeListener('enter-full-screen', onEnterFullScreen)
    window.removeListener('leave-full-screen', onLeaveFullScreen)
    window.removeListener('move', onMove)
  }
  geometryListenersCleanup = cleanup
  window.once('closed', () => {
    cleanup()
    if (geometryListenersCleanup === cleanup) geometryListenersCleanup = null
    // Parent window gone — destroy the child window and clear state. A fresh
    // initOverlayLayer(newWindow, ...) call will recreate everything.
    if (overlayAlive()) {
      try {
        overlayWin!.destroy()
      } catch (err) {
        console.error('[overlayLayer] destroying overlay window on parent close failed:', err)
      }
    }
    overlayWin = null
    win = null
    state = 'unregistered'
    currentDescriptor = null
    overlayTokenHeld = false
  })
}

// ---------------------------------------------------------------------------
// Exclusivity token
// ---------------------------------------------------------------------------

export function isOverlayTokenHeld(): boolean {
  return overlayTokenHeld
}

function acquireToken(): void {
  overlayTokenHeld = true
}

function releaseToken(): void {
  overlayTokenHeld = false
}

// ---------------------------------------------------------------------------
// showOverlay
// ---------------------------------------------------------------------------

export async function showOverlay(descriptor: OverlayDescriptor): Promise<OverlayShowResult> {
  if (state === 'unavailable' || state === 'recovering' || state === 'unregistered') {
    throw new Error(`[overlayLayer] cannot show overlay while state is '${state}'`)
  }
  if (!overlayAlive() || !winAlive()) {
    throw new Error('[overlayLayer] cannot show overlay — view or window destroyed')
  }

  const interactive = descriptor.acceptsClicks || descriptor.takesFocus

  // Dismiss-on-acquire of an open native chassis card (KTD: "Acquiring for
  // an interactive overlay dismisses an already-open native card first").
  // TODO(U7): the pointerInCard force-hide variant (bypassing HidePopover's
  // hover-deferral so a card can't strand itself above a modal scrim) is
  // deferred to U7 per the plan — this call goes through the existing
  // `hidePopover` path, which is sufficient for U4 since no interactive
  // overlay kinds exist yet to race against an open card.
  if (interactive) deps?.dismissActiveNativePopover()

  const wasIdle = state === 'idle'

  // Replacement semantics: settle the prior descriptor (if any) as dismissed
  // without waiting out its exit fade.
  if (!wasIdle && currentDescriptor) {
    deps?.getMainWindow()?.webContents.send('overlay:event', {
      overlayId: currentDescriptor.id,
      kind: currentDescriptor.kind,
      type: 'dismissed'
    } satisfies OverlayEvent)
    // Any in-flight show promise for the replaced descriptor should also settle.
    rejectPendingShow('replaced')
    resolvePendingExit()
  }

  if (interactive) acquireToken()

  generation += 1
  const gen = generation
  currentGeneration = gen
  currentDescriptor = descriptor
  // New generation — any reported size belongs to the PREVIOUS descriptor/show
  // and must not be reused. computeScreenBounds() below (via applyCurrentBounds)
  // falls back to DEFAULT_ANCHORED until the first reportSize for this gen lands.
  currentAnchoredSize = null

  if (wasIdle) {
    // Token-acquisition-keyed save — only on fresh acquire, not replacement shows.
    addon?.saveOverlayFirstResponder()
  }

  if (winAlive()) {
    currentScaleFactor = screen.getDisplayMatching(win!.getBounds()).scaleFactor
  }

  state = 'pending'

  // Order matters here: set bounds first, then show the (now correctly
  // positioned) window, THEN send the descriptor — so the renderer's first
  // paint happens while the window is already visible on screen, rather than
  // painting into a hidden window and hoping the ack still arrives. This
  // sidesteps any question of whether a hidden BrowserWindow's renderer
  // continues to produce rAF frames (the historical Electron #44590 concern
  // for hidden webContents) — backgroundThrottling: false is kept as a
  // belt-and-suspenders measure, but visibility no longer gates the paint.
  applyCurrentBounds()

  // Tooltip-class overlays (acceptsClicks === false, e.g. hover cards) must
  // never intercept mouse input even though they're visible — route mouse
  // events through to whatever is beneath instead of relying on geometry
  // alone.
  overlayWin!.setIgnoreMouseEvents(!descriptor.acceptsClicks)

  if (descriptor.takesFocus) {
    // Focus-taking overlays (confirm modals, palette) become the key window.
    overlayWin!.show()
  } else {
    // Non-focus-taking overlays (cards/tooltips) must never steal key-window
    // status from the main window.
    overlayWin!.showInactive()
  }

  overlayWin!.webContents.send('overlayRenderer:show', {
    descriptor,
    generation: gen,
    theme: currentTheme
  } satisfies OverlayShowMessage)

  return new Promise<OverlayShowResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingShow?.generation !== gen) return
      pendingShow = null
      if (overlayAlive()) overlayWin!.hide()
      releaseToken()
      state = 'idle'
      currentDescriptor = null
      reject(new Error('[overlayLayer] show timed out waiting for paint ack'))
    }, SHOW_TIMEOUT_MS)

    pendingShow = { generation: gen, resolve, reject, timeout }
  })
}

// ---------------------------------------------------------------------------
// updateOverlay
// ---------------------------------------------------------------------------

export function updateOverlay(id: string, props: Record<string, unknown>): void {
  if (!currentDescriptor || currentDescriptor.id !== id) return // silently dropped — expected race
  if (state !== 'pending' && state !== 'visible') return
  if (!overlayAlive()) return
  overlayWin!.webContents.send('overlayRenderer:update', {
    id,
    generation: currentGeneration,
    props
  } satisfies OverlayUpdateMessage)
}

// ---------------------------------------------------------------------------
// hideOverlay / forceHide
// ---------------------------------------------------------------------------

export async function hideOverlay(id: string): Promise<void> {
  if (!currentDescriptor || currentDescriptor.id !== id) return // no-op, silent
  if (state !== 'visible') return

  const hadTakesFocus = currentDescriptor.takesFocus
  const gen = currentGeneration
  state = 'exiting'

  if (overlayAlive()) {
    overlayWin!.webContents.send('overlayRenderer:hide', { id, generation: gen })
  }

  await new Promise<void>((resolve) => {
    clearPendingExitTimer()
    const timer = setTimeout(() => {
      if (pendingExit?.id === id && pendingExit.generation === gen) {
        pendingExit = null
      }
      resolve()
    }, EXIT_WAIT_CAP_MS)
    pendingExit = { id, generation: gen, resolve, timer }
  })

  // An incoming show() may have preempted us while we were waiting (exiting(A)
  // -> pending(B)) — only finish the idle transition if we're still the
  // current show and still in 'exiting'.
  if (currentDescriptor?.id !== id || state !== 'exiting') return

  if (overlayAlive()) {
    overlayWin!.setIgnoreMouseEvents(false)
    overlayWin!.hide()
  }
  state = 'idle'
  currentDescriptor = null
  releaseToken()
  runFocusRestoreChain(hadTakesFocus)
}

/** Synchronous-ish force hide, used by crash/nav recovery, quit paths, and the ownerWorkspaceId backstop. No fade, no exit-wait. */
export function forceHide(reason: string): void {
  const hadTakesFocus = currentDescriptor?.takesFocus ?? false
  const wasActive = state === 'pending' || state === 'visible' || state === 'exiting'

  clearPendingShowTimer()
  rejectPendingShow(reason)
  clearPendingExitTimer()
  resolvePendingExit()

  if (wasActive && overlayAlive()) {
    try {
      overlayWin!.webContents.send('overlayRenderer:hide', {
        id: currentDescriptor?.id ?? '',
        generation: currentGeneration
      })
    } catch (err) {
      console.error('[overlayLayer] forceHide send failed (renderer likely dead):', err)
    }
  }

  if (overlayAlive()) {
    overlayWin!.setIgnoreMouseEvents(false)
    overlayWin!.hide()
  }
  if (state !== 'unavailable' && state !== 'unregistered' && state !== 'recovering') {
    state = 'idle'
  }
  currentDescriptor = null
  if (wasActive) {
    releaseToken()
    runFocusRestoreChain(hadTakesFocus)
  }
}

/** ownerWorkspaceId backstop — no-ops unless the current descriptor is anchored and owned by this workspace. */
export function forceHideOwnedBy(workspaceId: string): void {
  if (!currentDescriptor) return
  if (currentDescriptor.placement.mode !== 'anchored') return
  if (currentDescriptor.ownerWorkspaceId !== workspaceId) return
  forceHide(`workspace-unmount:${workspaceId}`)
}

// ---------------------------------------------------------------------------
// kickActiveTerminal guard
// ---------------------------------------------------------------------------

export function isInteractiveOverlayVisible(): boolean {
  return (state === 'pending' || state === 'visible') && !!currentDescriptor?.takesFocus
}

export function focusOverlay(): void {
  if (!overlayAlive()) return
  overlayWin!.focus()
  overlayWin!.webContents.focus()
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function sendThemeToView(): void {
  if (!overlayAlive()) return
  overlayWin!.webContents.send('overlayRenderer:theme', currentTheme)
}

export function setOverlayTheme(theme: string): void {
  currentTheme = theme
  sendThemeToView()
}
