// Active-workspace tracking.
// Freeze detection and the recovery ladder were removed in Task 9 (root-fixed by
// the opaque-on-top terminal approach). The exports below are retained as
// load-bearing infrastructure consumed by the WorkspaceView/Dashboard components,
// so their signatures are kept exactly even where an argument is now unused.

let activeWs: string | null = null

export function setActiveWatchdogWorkspace(
  workspaceId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _requestRemount: (() => void) | null
): void {
  activeWs = workspaceId
}

export function getActiveWatchdogWorkspace(): string | null {
  return activeWs
}

export function setAuthoritativeActiveWorkspace(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workspaceId: string | null
): void {
  // No-op: authoritative-workspace tracking drove the removed freeze detector.
  // Retained as an export so Dashboard.tsx's call site stays intact.
}
