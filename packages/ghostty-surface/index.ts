// ---------------------------------------------------------------------------
// packages/ghostty-surface/index.ts
//
// Generic TypeScript API layer over the ghostty_native NAPI addon.
//
// This file has ZERO Orpheus-specific imports — it only knows about the native
// binary and generic surface types. A future external package could expose
// exactly this surface.
// ---------------------------------------------------------------------------

import { createRequire } from 'module'

// ---------------------------------------------------------------------------
// Generic geometry type
//
// Mirrors the { x, y, w, h } shape the native addon expects. Structurally
// identical to TerminalRect in src/shared/types.ts; redefined here so this
// package is self-contained with no src/ imports.
// ---------------------------------------------------------------------------

export type SurfaceRect = {
  x: number
  y: number
  w: number
  h: number
}

// ---------------------------------------------------------------------------
// GhosttySurfaceAddon — generic interface for the native addon
//
// The opaque per-surface key is named `workspaceId` in the native ABI (the
// .mm was written with Orpheus in mind). We keep that field name here to
// avoid a large mechanical rename across the native layer; treat it as an
// opaque surface identifier string.
// ---------------------------------------------------------------------------

export type GhosttySurfaceAddon = {
  /**
   * Mount (or re-attach) a libghostty surface into the given native window
   * handle. The surface is identified by `workspaceId` (opaque surface id).
   * Pass `command` and `env` to control what the terminal runs.
   */
  mount: (
    handle: Buffer,
    opts: {
      /** Opaque surface identifier — stable for the lifetime of the surface. */
      workspaceId: string
      rect: SurfaceRect
      scaleFactor: number
      cwd?: string
      /** Full path to the binary to run inside the terminal. */
      command?: string
      /** Environment variables for the launched process. */
      env?: Record<string, string>
    }
  ) => { workspaceId: string; created: boolean }

  /**
   * Install a backstop NSView so the window background stays opaque while
   * the surface is loading.
   */
  installBackstop: (handle: Buffer) => void

  /** Hide a surface without destroying it. Re-mount to show it again. */
  hide: (workspaceId: string) => void

  /** Resize a surface to a new rect at the given display scale factor. */
  resize: (workspaceId: string, rect: SurfaceRect, scaleFactor: number) => void

  /** Permanently destroy a surface and free its resources. */
  destroy: (workspaceId: string) => void

  /** Move keyboard focus to the surface. */
  focus: (workspaceId: string) => void

  /**
   * Register a callback for OSC 0/2 title changes.
   * Fired per-surface; workspaceId identifies which surface changed.
   */
  setTitleCallback: (cb: (workspaceId: string, title: string) => void) => void

  /**
   * Register a callback for window occlusion state changes.
   * `occluded` is true when the surface is fully hidden behind other windows.
   */
  setOcclusionCallback: (cb: (workspaceId: string, occluded: boolean) => void) => void

  /**
   * Register a global liveness callback fired on input/draw ticks.
   * Useful for detecting a frozen terminal render loop.
   */
  setLivenessCallback: (
    cb: (workspaceId: string, inputTick: number, liveTick: number, occluded: boolean) => void
  ) => void

  /**
   * Register a diagnostic callback that fires for every libghostty action tag.
   * Very high frequency — gate on a debug flag.
   */
  setActionTraceCallback: (cb: (tagName: string) => void) => void

  /**
   * Control the loading overlay shown while the terminal process is booting.
   * State transitions: showing → slow → error → hidden.
   */
  setLoadingOverlay: (
    workspaceId: string,
    state: 'showing' | 'slow' | 'error' | 'hidden',
    copy: { title: string; subtitle?: string; actionLabel?: string }
  ) => void

  /** Register a callback for the loading overlay's action button press. */
  setLoadingActionCallback: (cb: (workspaceId: string) => void) => void

  /**
   * Push a color palette to the loading overlay for theme alignment.
   * RGB values are 0–255 integers.
   */
  setLoadingTheme: (colors: {
    backdrop: [number, number, number]
    card: [number, number, number]
    textPrimary: [number, number, number]
    textSecondary: [number, number, number]
    border: [number, number, number]
    isDark: boolean
    tintAlpha: number
  }) => void

  /** Write UTF-8 text directly into the surface's PTY input. */
  sendInput: (workspaceId: string, utf8Text: string) => boolean

  /**
   * Synthesize one or more key events into the surface.
   * `keycode` is a macOS virtual key code; `mods` is a ghostty_input_mods_e bitmask.
   */
  sendKeys: (
    workspaceId: string,
    keys: Array<{ keycode: number; mods?: number; action?: 'press' | 'release' | 'repeat' }>
  ) => boolean

  /** Tell ghostty to re-read its config file (affects all surfaces). */
  reloadGhosttyConfig: () => boolean

  /**
   * Return the current surface phase string (e.g. "booting", "ready").
   * Used to gate UI actions that require a running process.
   */
  getSurfacePhase: (workspaceId: string) => string

  // ---------------------------------------------------------------------------
  // Native popover chassis (Phase A — generic info-card over terminal)
  // ---------------------------------------------------------------------------

  /**
   * Show a native popover card above the terminal for the given workspace.
   * The card is positioned relative to anchorRect (CSS px from getBoundingClientRect)
   * and clamped to stay on-screen.
   *
   * @param workspaceId  opaque surface identifier
   * @param kind         'details' (252px) | 'hover' (224px)
   * @param anchorRect   bounding rect of the trigger element in CSS px (top-left origin)
   * @param data         generic data object (Phase B populates real fields)
   * @param fontDir      optional: absolute path to Geist fonts directory.
   *                     Packaged: path.join(process.resourcesPath, 'fonts')
   *                     Dev:      resolved from node_modules by native fallback when omitted
   */
  showPopover: (
    workspaceId: string,
    kind: string,
    anchorRect: { x: number; y: number; w: number; h: number },
    data: Record<string, unknown>,
    fontDir?: string
  ) => void

  /**
   * Update the content of an already-visible popover in place.
   * Used for the Details card's async fields (cost, context, usage).
   * Phase A: no-op stub.
   */
  updatePopover: (workspaceId: string, data: Record<string, unknown>) => void

  /**
   * Hide and remove the popover for the given workspace.
   * Fades out 100ms then removes from superview. Idempotent.
   */
  hidePopover: (workspaceId: string) => void

  /**
   * Register a callback fired when a clickable element inside a popover is
   * activated (Phase B: PR chip). The identifier string encodes
   * "workspaceId::elementId" for routing.
   */
  setPopoverActionCallback: (cb: (identifier: string) => void) => void

  /**
   * Push a color palette to native popovers for theme alignment.
   * RGB values are 0–255 integers. Call on startup and on theme change.
   */
  setPopoverTheme: (colors: {
    card: [number, number, number]
    textPrimary: [number, number, number]
    textSecondary: [number, number, number]
    textMuted: [number, number, number]
    border: [number, number, number]
    accent: [number, number, number]
    isDark: boolean
  }) => void

  // ---------------------------------------------------------------------------
  // Overlay registration, ordering, and first-responder primitives
  // (Phase A — the overlay WebContentsView kept above the terminal NSView)
  // ---------------------------------------------------------------------------

  /**
   * Begin overlay registration for the given native window handle: bridges
   * the handle to `contentView` and snapshots its current subviews. Call
   * this BEFORE the caller adds the overlay WebContentsView's NSView (e.g.
   * via `addChildView`), then call `commitOverlayRegistration` after.
   * Re-entrant — safe (and required) to call again when the BrowserWindow is
   * recreated (e.g. dock-activate); each call discards prior registration
   * state rather than being a permanent one-shot.
   */
  beginOverlayRegistration: (handle: Buffer) => void

  /**
   * Complete overlay registration: diffs `contentView.subviews` against the
   * snapshot taken by `beginOverlayRegistration`. Exactly one new subview is
   * treated as the overlay view and registered; returns `true`. Zero or more
   * than one new subview leaves no registration and returns `false` (the
   * native side logs the count for diagnosis).
   */
  commitOverlayRegistration: () => boolean

  /**
   * True iff the overlay view is registered and still parented under the
   * contentView it was registered against.
   */
  isOverlayRegistered: () => boolean

  /**
   * Re-raise the registered overlay above the terminal (or any other view)
   * if something has been ordered above it in `contentView.subviews`. Cheap
   * no-op when the order is already correct. Call after events known to
   * reshuffle native subviews (fullscreen enter/exit, DevTools dock toggle)
   * as a self-heal for ordering regressions.
   */
  reassertOverlayOrder: () => void

  /**
   * Gate the terminal's mount-time / re-show `makeFirstResponder` calls.
   * While `suppressed` is true, those calls are skipped so a visible
   * `takesFocus` overlay never has keyboard focus yanked away by a terminal
   * attach/re-show happening underneath it.
   */
  setOverlayFocusSuppressed: (suppressed: boolean) => void

  /**
   * Save the window's current first responder into a slot dedicated to the
   * overlay layer (separate from the native popover chassis's own saved
   * responder). Refuses to overwrite the slot when the current first
   * responder is the overlay view itself (or a descendant of it) — this is
   * what keys the save to token acquisition rather than to each individual
   * overlay show.
   */
  saveOverlayFirstResponder: () => void

  /**
   * Restore the first responder saved by `saveOverlayFirstResponder`, if it
   * is still valid (non-nil, still attached to the same window). Clears the
   * saved slot either way. Returns `true` on a successful restore, `false`
   * if there was nothing valid to restore — the caller should then run its
   * own fallback chain (e.g. focus the active workspace's terminal, then the
   * main webContents).
   */
  restoreOverlayFirstResponder: () => boolean

  /**
   * True iff the window's current first responder is the registered overlay
   * view or a descendant of it. Intended to be checked on every overlay hide
   * (not just modal-class overlays) since any click on an `acceptsClicks`
   * overlay can move first responder there.
   */
  isOverlayFirstResponder: () => boolean
}

// ---------------------------------------------------------------------------
// loadGhosttySurface — generic factory
//
// Loads the compiled .node addon from `addonPath` and returns a typed
// GhosttySurfaceAddon. Throws on load failure; the caller is responsible for
// error caching / singleton semantics.
// ---------------------------------------------------------------------------

export function loadGhosttySurface(opts: { addonPath: string }): GhosttySurfaceAddon {
  return createRequire(import.meta.url)(opts.addonPath) as GhosttySurfaceAddon
}
