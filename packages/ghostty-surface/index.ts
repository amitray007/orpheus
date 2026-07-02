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
  // Overlay first-responder primitives (child-window era)
  //
  // The overlay used to be a same-window WebContentsView sibling, tracked via
  // a begin/commit registration handshake plus a `reassertOverlayOrder` call
  // exposed to TS so callers could trigger the ordering self-heal directly.
  // The overlay is now a separate child BrowserWindow with its own compositor
  // (stacks above the main window natively), so that registration/ordering
  // surface is gone — the ordering self-heal is purely internal to the addon
  // now (still runs, just not TS-triggerable). What remains addon-side and
  // TS-facing is the focus-chain handoff below, used when a takesFocus
  // overlay is dismissed.
  // ---------------------------------------------------------------------------

  /**
   * Gate the terminal's mount-time / re-show `makeFirstResponder` calls.
   * While `suppressed` is true, those calls are skipped so a visible
   * `takesFocus` overlay never has keyboard focus yanked away by a terminal
   * attach/re-show happening underneath it.
   */
  setOverlayFocusSuppressed: (suppressed: boolean) => void

  /**
   * Save the window's current first responder into a slot dedicated to the
   * overlay layer's focus handoff. Refuses to overwrite the slot when the
   * current first responder is the overlay view itself (or a descendant of
   * it) — this is what keys the save to token acquisition rather than to
   * each individual overlay show.
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
