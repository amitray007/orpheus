/** Minimal engine interface for U2. U5 expands this into the full engine abstraction. */
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
   * Set the data callback. Called when the PTY produces output.
   * Seam for U3: U3 will replace or wrap this to add batching + ACK flow control.
   */
  setDataHandler(handler: (workspaceId: string, data: string) => void): void
  /**
   * Set the exit callback. Called when a PTY process exits.
   * Seam for U9: U9 wires this to terminal:exit IPC + overlay.
   */
  setExitHandler(handler: (workspaceId: string, exitCode: number, signal?: number) => void): void
}

export type PhaseKind = 'none' | 'live' | 'dead'
