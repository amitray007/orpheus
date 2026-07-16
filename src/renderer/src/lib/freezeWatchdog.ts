// Active-workspace tracking.
// Freeze detection and the recovery ladder were removed in Task 9 (root-fixed by
// the opaque-on-top terminal approach). The exports below are retained as
// load-bearing infrastructure consumed by the WorkspaceView/Dashboard components.
//
// requestRemount is stored (not discarded) so background-mount / stale-mount
// races can re-promote the currently active workspace's own surface back to
// native visibility after another workspace's mount steals it — see
// Dashboard.tsx's backgroundMountWorkspace and WorkspaceView.tsx's stale-mount
// branches (getActiveRemount consumers).

let activeWs: string | null = null
let activeRemount: (() => void) | null = null

export function setActiveWatchdogWorkspace(
  workspaceId: string | null,
  requestRemount: (() => void) | null
): void {
  activeWs = workspaceId
  activeRemount = requestRemount
}

export function getActiveWatchdogWorkspace(): string | null {
  return activeWs
}

export function getActiveRemount(): (() => void) | null {
  return activeRemount
}

export function setAuthoritativeActiveWorkspace(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workspaceId: string | null
): void {
  // No-op: authoritative-workspace tracking drove the removed freeze detector.
  // Retained as an export so Dashboard.tsx's call site stays intact.
}
