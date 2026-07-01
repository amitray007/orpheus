// ---------------------------------------------------------------------------
// src/main/overlayLayer.ts
//
// U4 — the single owner of the overlay WebContentsView: one pre-warmed,
// transparent, always-`setVisible(true)` view kept above the terminal NSView
// by the native addon (see packages/ghostty-surface/index.ts, "Overlay
// registration, ordering, and first-responder primitives"). Hosts the show /
// update / hide state machine described in the plan's HTD state-machine
// paragraph and U4 approach section:
//
//   unregistered -> idle -> pending(gen) -> visible(gen) -> exiting(gen) -> idle
//   exiting(A) -> pending(B)   (an incoming show preempts the exit fade)
//   idle/pending/visible/exiting -> recovering  (overlay renderer crash / nav)
//   recovering -> idle                          (renderer ready ping)
//   unregistered -> idle | unavailable          (registration handshake)
//   unavailable -> idle                         (ONLY via a fresh initOverlayLayer)
//
// "Idle" is bounds-based, not visibility-based: the view is `setVisible(true)`
// exactly once at pre-warm and never hidden again — see KTD "Idle state is
// bounds-based, not setVisible(false)". Hiding = bounds {0,0,0,0}.
// ---------------------------------------------------------------------------

import { BrowserWindow, WebContentsView, ipcMain, screen } from 'electron'
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
let view: WebContentsView | null = null

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
const ANCHOR_SHADOW_MARGIN = 24

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function viewAlive(): boolean {
  return !!view && !view.webContents.isDestroyed()
}

function winAlive(): boolean {
  return !!win && !win.isDestroyed()
}

function zeroBounds(): void {
  if (!viewAlive()) return
  view!.setBounds({ x: 0, y: 0, width: 0, height: 0 })
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
  const restored = addon.restoreOverlayFirstResponder()
  if (restored) return
  const focusedTerminal = deps?.focusActiveWorkspaceTerminal() ?? false
  if (focusedTerminal) return
  if (winAlive()) win!.webContents.focus()
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function getWindowContentSize(): { width: number; height: number } {
  if (!winAlive()) return { width: 0, height: 0 }
  const b = win!.getContentBounds()
  return { width: b.width, height: b.height }
}

/** Compute the target bounds (DIPs relative to contentView) for the current descriptor. */
function computeBounds(descriptor: OverlayDescriptor): {
  x: number
  y: number
  width: number
  height: number
} {
  const { width, height } = getWindowContentSize()
  if (descriptor.placement.mode === 'centered') {
    return { x: 0, y: 0, width, height }
  }
  // Anchored: grow anchorRect by the shadow margin, multiply by the main
  // window's zoom factor (anchorRect comes from the main renderer's DOM —
  // see plan KTD on getBoundingClientRect() * getZoomFactor()), then clamp to
  // the window's content bounds.
  const zoom = winAlive() ? win!.webContents.getZoomFactor() : 1
  const anchor = descriptor.placement.anchorRect
  let x = anchor.x * zoom - ANCHOR_SHADOW_MARGIN
  let y = anchor.y * zoom - ANCHOR_SHADOW_MARGIN
  let w = anchor.w * zoom + ANCHOR_SHADOW_MARGIN * 2
  let h = anchor.h * zoom + ANCHOR_SHADOW_MARGIN * 2

  if (x < 0) x = 0
  if (y < 0) y = 0
  if (x + w > width) w = Math.max(0, width - x)
  if (y + h > height) h = Math.max(0, height - y)

  return { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }
}

function applyCurrentBounds(): void {
  if (!viewAlive() || !currentDescriptor) return
  view!.setBounds(computeBounds(currentDescriptor))
}

// ---------------------------------------------------------------------------
// initOverlayLayer — construction + registration handshake
//
// Re-entrant: called once per window (per plan, on `ready-to-show`). Tears
// down prior view/state on each call so window recreation (dock-activate)
// re-registers cleanly.
// ---------------------------------------------------------------------------

export function initOverlayLayer(
  window: BrowserWindow,
  ghosttyAddon: GhosttySurfaceAddon,
  layerDeps: OverlayLayerDeps
): void {
  // Idempotency guard (per-window): 'ready-to-show' can refire for the SAME
  // BrowserWindow — e.g. backgroundThrottling: false on the main window means
  // each new overlay WebContentsView's first paint re-triggers 'ready-to-show'.
  // If we're already initialized for this exact window and the view is still
  // alive, skip the teardown/reconstruct entirely; otherwise every refire
  // tears down + recreates the view, which itself re-triggers the event —
  // a self-sustaining loop. Re-init must still proceed for a genuinely new
  // BrowserWindow instance (window recreation) or a dead view.
  if (win === window && state !== 'unregistered' && viewAlive()) {
    console.log(
      '[overlayLayer] init skipped — already initialized for this window (ready-to-show refire)'
    )
    return
  }

  // Tear down any prior view/state (window recreation path).
  clearPendingShowTimer()
  clearPendingExitTimer()
  pendingShow = null
  pendingExit = null
  currentDescriptor = null
  currentGeneration = 0
  currentScaleFactor = null
  overlayTokenHeld = false
  initialLoadDone = false
  if (geometryListenersCleanup) {
    geometryListenersCleanup()
    geometryListenersCleanup = null
  }
  // Fully dispose the old view (if any) so recreated windows don't leak a
  // renderer process: detach from its (possibly still-alive, e.g. old-window)
  // contentView, then close its webContents.
  if (view && !view.webContents.isDestroyed()) {
    const oldWin = win
    const oldView = view
    try {
      if (oldWin && !oldWin.isDestroyed()) {
        oldWin.contentView.removeChildView(oldView)
      }
    } catch (err) {
      console.error('[overlayLayer] removeChildView on old view failed:', err)
    }
    try {
      oldView.webContents.close()
    } catch (err) {
      console.error('[overlayLayer] closing old view webContents failed:', err)
    }
  }
  view = null

  win = window
  addon = ghosttyAddon
  deps = layerDeps
  state = 'unregistered'

  const overlayView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      sandbox: false,
      backgroundThrottling: false
    }
  })
  view = overlayView

  // Transparency recipe (KTD): setBackgroundColor before loadURL.
  overlayView.setBackgroundColor('#00000000')

  wireOverlayWebContentsListeners(overlayView)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlayView.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
  } else {
    overlayView.webContents.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  // Registration handshake — must happen in one synchronous JS turn.
  addon.beginOverlayRegistration(win.getNativeWindowHandle())
  win.contentView.addChildView(overlayView)
  const committed = addon.commitOverlayRegistration()

  if (!committed) {
    state = 'unavailable'
    console.error(
      '[overlayLayer] registration failed — overlay unavailable, chassis fallback remains'
    )
    // Never call setVisible/focus on the view again per plan; park it at
    // zero bounds so it can't intercept input even though it's unregistered.
    overlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    return
  }

  overlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  overlayView.setVisible(true)
  state = 'idle'

  wireWindowGeometryListeners(win)

  // Push current theme immediately once the view exists (also re-sent on the
  // renderer's `ready` ping and embedded in every show message — see
  // ipcMain.on('overlayRenderer:ready', ...) below and setOverlayTheme()).
  sendThemeToView()
}

// ---------------------------------------------------------------------------
// overlayRenderer:* ipcMain.on registrations (sends, not invokes — scoped to
// the single overlay WebContentsView; no sender check for now since there is
// exactly one overlay view per the plan's "one pre-warmed overlay view" model)
// ---------------------------------------------------------------------------

function wireOverlayWebContentsListeners(overlayView: WebContentsView): void {
  const wc = overlayView.webContents

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
  if (viewAlive()) {
    try {
      view!.webContents.reload()
    } catch (err) {
      console.error('[overlayLayer] reload after recovering failed:', err)
    }
    view!.setBackgroundColor('#00000000')
  }
  zeroBounds()
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
    zeroBounds()
    releaseToken()
    state = 'idle'
    currentDescriptor = null
    p.reject(new Error(`[overlayLayer] overlay renderer reported error: ${ack.error}`))
    return
  }

  state = 'visible'
  if (currentDescriptor?.takesFocus && viewAlive()) {
    view!.webContents.focus()
    addon?.setOverlayFocusSuppressed(true)
    // Chromium can re-stack its own child views on focus; with the new
    // move-terminal-not-overlay semantics in reassertOverlayOrder this is
    // safe and cheap to call unconditionally here.
    addon?.reassertOverlayOrder()
  }
  p.resolve({ shown: true })
}

function handleReportSize(report: OverlaySizeReport): void {
  if (report.generation !== currentGeneration) return
  if (!currentDescriptor || currentDescriptor.id !== report.id) return
  if (currentDescriptor.placement.mode !== 'anchored') return // centered overlays ignore reportSize
  if (!viewAlive()) return

  const base = computeBounds(currentDescriptor)
  const { width: winW, height: winH } = getWindowContentSize()
  let w = report.w
  let h = report.h
  if (base.x + w > winW) w = Math.max(0, winW - base.x)
  if (base.y + h > winH) h = Math.max(0, winH - base.y)
  view!.setBounds({ x: base.x, y: base.y, width: Math.round(w), height: Math.round(h) })
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
    // KTD: reassert order after events known to reshuffle native subviews,
    // not just on the next idle->pending show.
    addon?.reassertOverlayOrder()
    if (state !== 'visible' && state !== 'pending') return
    if (!currentDescriptor) return
    if (currentDescriptor.placement.mode === 'centered') {
      applyCurrentBounds()
    } else {
      forceHide('fullscreen-enter')
    }
  }

  const onLeaveFullScreen = (): void => {
    addon?.reassertOverlayOrder()
    if (state === 'visible' || state === 'pending') {
      if (currentDescriptor?.placement.mode === 'centered') {
        applyCurrentBounds()
        // Mirror the ~250ms stale-bounds resync workaround index.ts already
        // uses for the main window's own bounds-save logic after leave-full-screen.
        setTimeout(() => {
          if (winAlive() && (state === 'visible' || state === 'pending')) {
            addon?.reassertOverlayOrder()
            applyCurrentBounds()
          }
        }, 250)
      } else if (currentDescriptor) {
        forceHide('fullscreen-leave')
      }
    }
  }

  const onMove = (): void => {
    if (state !== 'visible' && state !== 'pending') return
    if (!currentDescriptor || currentDescriptor.placement.mode !== 'anchored') return
    if (currentScaleFactor === null) return
    if (!winAlive()) return
    const display = screen.getDisplayMatching(win!.getBounds())
    if (display.scaleFactor !== currentScaleFactor) {
      forceHide('display-scale-changed')
    }
  }

  // DevTools dock-mode changes reshuffle native subviews (KTD); the
  // detach-mode toggle used by `window:openDevTools` doesn't affect
  // `contentView` layout, but a future docked mode would, and this is a
  // cheap no-op self-heal either way. Docked-mode changes WITHIN an already-
  // open DevTools panel emit no event — a known dev-only gap (KTD).
  const onDevToolsOpened = (): void => {
    addon?.reassertOverlayOrder()
  }
  const onDevToolsClosed = (): void => {
    addon?.reassertOverlayOrder()
  }

  window.on('resize', onResize)
  window.on('enter-full-screen', onEnterFullScreen)
  window.on('leave-full-screen', onLeaveFullScreen)
  window.on('move', onMove)
  window.webContents.on('devtools-opened', onDevToolsOpened)
  window.webContents.on('devtools-closed', onDevToolsClosed)

  const cleanup = (): void => {
    window.removeListener('resize', onResize)
    window.removeListener('enter-full-screen', onEnterFullScreen)
    window.removeListener('leave-full-screen', onLeaveFullScreen)
    window.removeListener('move', onMove)
    if (!window.webContents.isDestroyed()) {
      window.webContents.removeListener('devtools-opened', onDevToolsOpened)
      window.webContents.removeListener('devtools-closed', onDevToolsClosed)
    }
  }
  geometryListenersCleanup = cleanup
  window.once('closed', () => {
    cleanup()
    if (geometryListenersCleanup === cleanup) geometryListenersCleanup = null
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
  if (!viewAlive() || !winAlive()) {
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

  if (wasIdle) {
    // Token-acquisition-keyed save — only on fresh acquire, not replacement shows.
    addon?.saveOverlayFirstResponder()
  }

  addon?.reassertOverlayOrder()

  if (winAlive()) {
    currentScaleFactor = screen.getDisplayMatching(win!.getBounds()).scaleFactor
  }

  state = 'pending'
  applyCurrentBounds()

  view!.webContents.send('overlayRenderer:show', {
    descriptor,
    generation: gen,
    theme: currentTheme
  } satisfies OverlayShowMessage)

  return new Promise<OverlayShowResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (pendingShow?.generation !== gen) return
      pendingShow = null
      zeroBounds()
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
  if (!viewAlive()) return
  view!.webContents.send('overlayRenderer:update', {
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

  if (viewAlive()) {
    view!.webContents.send('overlayRenderer:hide', { id, generation: gen })
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

  zeroBounds()
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

  if (wasActive && viewAlive()) {
    try {
      view!.webContents.send('overlayRenderer:hide', {
        id: currentDescriptor?.id ?? '',
        generation: currentGeneration
      })
    } catch (err) {
      console.error('[overlayLayer] forceHide send failed (renderer likely dead):', err)
    }
  }

  zeroBounds()
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
  if (!viewAlive()) return
  view!.webContents.focus()
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function sendThemeToView(): void {
  if (!viewAlive()) return
  view!.webContents.send('overlayRenderer:theme', currentTheme)
}

export function setOverlayTheme(theme: string): void {
  currentTheme = theme
  sendThemeToView()
}
