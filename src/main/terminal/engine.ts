/**
 * TerminalEngine — abstraction seam between the ghostty and xterm engines.
 *
 * Full method set used by the renderer / IPC layer:
 *   spawn       — start a PTY (xterm) or validate/noop (ghostty delegates to addon.mount)
 *   write       — send bytes to the PTY / terminal
 *   resize      — resize the PTY / terminal
 *   destroy     — kill PTY and evict all state (called for restart-or-archive)
 *   getPhase    — 'none' | 'live' | 'dead' — PTY-liveness query (xterm analog of getSurfacePhase)
 *   setDataHandler  — called when the PTY produces output
 *   setExitHandler  — called when a PTY process exits
 *   ackChars    — flow-control ACK from renderer (xterm); no-op for ghostty
 *   resetFlow   — reset ACK window on (re)mount (xterm); no-op for ghostty
 *
 * Engine-specific notes:
 *   - `focus`: renderer DOM concern for the xterm engine (term.focus() in XtermSurface);
 *     ghostty routes focus via the native IPC handler. Neither engine exposes it here.
 *   - `setOverlay` / `setOverlayCompositing`: ghostty-only compositing toggles; the xterm
 *     engine treats these as no-ops so the renderer / main calls don't error.
 *   - `getSurfacePhase` (ghostty IPC): maps to `getPhase` here for the xterm engine.
 *
 * Routing: the renderer selects which surface to mount based on app_ui_state.terminal_engine.
 * Engine-switch takes effect at next mount — live workspaces show "Restart to apply"
 * (see uiState:update handler in index.ts). The ghostty IPC handlers (terminal:mount,
 * terminal:hide, terminal:resize, terminal:destroy, etc.) remain routed directly to the
 * ghostty addon for the ghostty engine path; xterm handlers are separate IPC channels
 * added in U2/U3. Full routing unification is deferred to a later unit.
 */
export interface TerminalEngine {
  /** Spawn a PTY for the workspace. Idempotent: second call for the same workspaceId is a no-op. Returns {created:true} on first spawn, {created:false, error?} on failure. */
  spawn(params: {
    workspaceId: string
    cwd: string
    cols?: number
    rows?: number
    notifySockPath?: string
    notifyShimPath?: string
    userPath?: string
  }): { created: boolean; error?: string }
  /** Write bytes/string to the PTY. No-op if no live PTY for workspaceId. */
  write(workspaceId: string, data: string | Buffer): void
  /** Resize the PTY. No-op if no live PTY. */
  resize(workspaceId: string, cols: number, rows: number): void
  /** Kill and evict the PTY. Idempotent. */
  destroy(workspaceId: string): void
  /** Returns 'none' | 'live' | 'dead'. */
  getPhase(workspaceId: string): 'none' | 'live' | 'dead'
  /**
   * Set the data callback. Called when the PTY produces output (after batching).
   */
  setDataHandler(handler: (workspaceId: string, data: string) => void): void
  /**
   * Set the exit callback. Called when a PTY process exits.
   */
  setExitHandler(handler: (workspaceId: string, exitCode: number, signal?: number) => void): void
  /** ACK chars from renderer. Decrements unacked; resumes PTY if below Low watermark. */
  ackChars(workspaceId: string, count: number): void
  /** Reset flow control state for a workspace (call on mount/re-mount). */
  resetFlow(workspaceId: string): void
}

/** Alias used by XtermEngine.getPhase() return annotation; not exported to callers outside this package. */
export type PhaseKind = 'none' | 'live' | 'dead'
