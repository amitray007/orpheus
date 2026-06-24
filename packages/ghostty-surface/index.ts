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
   * Show/hide a transparent NSView overlay in front of the surface.
   * Used to suppress input events while the renderer is on top.
   */
  setOverlay: (workspaceId: string, on: boolean) => void

  /** Enable/disable layer compositing for the overlay NSView. */
  setOverlayCompositing: (on: boolean) => void

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
