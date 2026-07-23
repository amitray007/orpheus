// workspaceResources — the 5 per-workspace in-memory maps/sets that track
// transient launch/UI state, plus their disposal.
//
// This module is a LEAF: it must never import from ./index (or anything that
// imports ./index) — dependency-cruiser's no-circular rule is BLOCKING. The
// only way it reaches the renderer is via a `broadcast` function INJECTED
// once at boot (mirrors the loadingOverlay.ts `configureLoadingOverlay`
// pattern), so this module never needs `getMainWindow` directly.
//
// Ownership: this module owns ONLY the 5 containers below and their
// per-type disposal. It does NOT know about loading overlays, activity
// status, session accumulators, settings caches, or git watchers — those
// stay in src/main/index.ts (see teardownWorkspaceResources there), which
// composes teardownWorkspaceState() from here with those other cross-module
// calls.

import type { ClaudeLaunch } from './claudeSettings'

// The snapshot taken at terminal:mount time. Extends the pure ClaudeLaunch
// (composeClaudeLaunch's output) with the auth env layer (ANTHROPIC_API_KEY,
// cloud-provider routing vars, etc.) that's merged in downstream by
// buildMountEnv/orpheusSurfaceAdapter — composeClaudeLaunch itself never sees
// auth, so it must be captured separately to make auth changes (e.g.
// cloud_provider, auth_base_url) visible to the dirty/"Restart to apply"
// comparison. Values here are the same plaintext auth env already merged into
// the surface process's env at mount time — never logged (see terminal:mount's
// envKeys-only log line) and never leaves this in-memory map.
export type LaunchSnapshot = ClaudeLaunch & { authEnv: Record<string, string> }

type BroadcastFn = (channel: string, payload: unknown) => void

let broadcast: BroadcastFn = () => {
  // No-op until configureWorkspaceResources() runs at boot. Guards against
  // accidental use before wiring (e.g. from a stray module-load-time call).
}

/** Inject the main→renderer broadcast bridge once on app startup. */
export function configureWorkspaceResources(deps: { broadcast: BroadcastFn }): void {
  broadcast = deps.broadcast
}

// ---------------------------------------------------------------------------
// launchSnapshots — snapshot of the ClaudeLaunch used at terminal:mount time,
// diffed later by recomputeDirty() (in index.ts) to detect settings drift.
// ---------------------------------------------------------------------------

const launchSnapshots = new Map<string, LaunchSnapshot>()

export function getLaunchSnapshot(workspaceId: string): LaunchSnapshot | undefined {
  return launchSnapshots.get(workspaceId)
}

export function setLaunchSnapshot(workspaceId: string, launch: LaunchSnapshot): void {
  launchSnapshots.set(workspaceId, launch)
}

export function deleteLaunchSnapshot(workspaceId: string): boolean {
  return launchSnapshots.delete(workspaceId)
}

export function launchSnapshotEntries(): IterableIterator<[string, LaunchSnapshot]> {
  return launchSnapshots.entries()
}

export function launchSnapshotCount(): number {
  return launchSnapshots.size
}

// ---------------------------------------------------------------------------
// dirty tracking — workspaces whose live launch has drifted from the snapshot
// taken at mount time ("Restart to apply" chip).
// ---------------------------------------------------------------------------

const dirtyWorkspaces = new Set<string>()

export function isDirty(workspaceId: string): boolean {
  return dirtyWorkspaces.has(workspaceId)
}

export function setDirty(workspaceId: string, dirty: boolean): void {
  const was = dirtyWorkspaces.has(workspaceId)
  if (dirty) dirtyWorkspaces.add(workspaceId)
  else dirtyWorkspaces.delete(workspaceId)
  if (was !== dirty) broadcast('workspace:dirtyChanged', { workspaceId, dirty })
}

// ---------------------------------------------------------------------------
// workspaceTitles — most recent terminal title from OSC 0/2.
// ---------------------------------------------------------------------------

const workspaceTitles = new Map<string, string>()

export function getTitle(workspaceId: string): string | undefined {
  return workspaceTitles.get(workspaceId)
}

/** Set + broadcast the new title (mirrors the native title-callback path). */
export function setTitle(workspaceId: string, title: string): void {
  workspaceTitles.set(workspaceId, title)
  broadcast('workspace:titleChanged', { workspaceId, title })
}

/** Delete + broadcast title:null, but ONLY if an entry was actually present. */
export function deleteTitle(workspaceId: string): void {
  if (workspaceTitles.delete(workspaceId)) {
    broadcast('workspace:titleChanged', { workspaceId, title: null })
  }
}

/**
 * Startup seed from the DB's persisted last_title — deliberately NO
 * broadcast (matches pre-refactor behavior: the renderer reads the seeded
 * value via workspace:getTitle / initial state, not a push).
 */
export function seedTitle(workspaceId: string, title: string): void {
  workspaceTitles.set(workspaceId, title)
}

// ---------------------------------------------------------------------------
// overlayFallbackTimers — auto-hide timers for loading overlays, ensuring a
// stuck overlay is always dismissed even if claude never registers a session
// file.
// ---------------------------------------------------------------------------

const overlayFallbackTimers = new Map<string, NodeJS.Timeout>()

/** Sets a new fallback timer, clearing any previous one for this workspace first. */
export function setOverlayFallbackTimer(workspaceId: string, timer: NodeJS.Timeout): void {
  const prev = overlayFallbackTimers.get(workspaceId)
  if (prev) clearTimeout(prev)
  overlayFallbackTimers.set(workspaceId, timer)
}

/** Clears + deletes the fallback timer for a workspace. No-op if absent. */
export function clearOverlayFallbackTimer(workspaceId: string): void {
  const timer = overlayFallbackTimers.get(workspaceId)
  if (timer) {
    clearTimeout(timer)
    overlayFallbackTimers.delete(workspaceId)
  }
}

/**
 * For use ONLY from inside the timer's own callback, once it has already
 * fired: removes the map entry WITHOUT calling clearTimeout (the timer is
 * already firing/fired — clearing it again is a harmless no-op on Node's
 * Timeout, but doing so here would misleadingly suggest this path can cancel
 * a still-pending timer).
 */
export function takeOverlayFallbackTimer(workspaceId: string): void {
  overlayFallbackTimers.delete(workspaceId)
}

// ---------------------------------------------------------------------------
// injectLocks — per-workspace injection mutex (RACE-10). Serializes the
// stage-then-submit critical section per workspace so two concurrent CLI
// injections into the SAME workspace can't interleave.
// ---------------------------------------------------------------------------

const injectLocks = new Map<string, Promise<unknown>>()

export function withInjectLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = injectLocks.get(workspaceId) ?? Promise.resolve()
  const next = prev.then(
    () => fn(),
    () => fn()
  )
  // Store a silent version so map entry errors don't surface as unhandled rejections.
  injectLocks.set(
    workspaceId,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

export function deleteInjectLock(workspaceId: string): boolean {
  return injectLocks.delete(workspaceId)
}

// ---------------------------------------------------------------------------
// Full teardown — state-only. Clears ALL 5 containers for a workspace that
// has been archived, destroyed, or removed. Idempotent.
//
// NOTE: this is ONLY the 5-map slice of the full teardown. The cross-module
// cleanup (hideLoadingOverlay, cancelAttentionRetry, clearWorkspaceActivity,
// evictAccumulator, invalidateClaudeWorkspaceSettingsCache, stopGitWatch)
// stays in index.ts's teardownWorkspaceResources, which calls this plus those.
// ---------------------------------------------------------------------------

export function teardownWorkspaceState(workspaceId: string): void {
  deleteLaunchSnapshot(workspaceId)
  setDirty(workspaceId, false)
  deleteTitle(workspaceId)
  clearOverlayFallbackTimer(workspaceId)
  deleteInjectLock(workspaceId)
}
