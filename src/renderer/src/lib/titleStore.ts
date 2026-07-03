/**
 * Per-key external title store — eliminates full-tree re-renders on every
 * OSC title update. Each leaf subscribes to its own workspace key; unrelated
 * keys fire no re-render in that component.
 *
 * API:
 *   setTitle(workspaceId, title)   — set a single key
 *   deleteTitle(workspaceId)       — remove a key (e.g. on archive)
 *   getTitleSnapshot()             — read the full map (no subscription)
 *   useWorkspaceTitle(workspaceId) — hook: subscribe to ONE key only
 */

import { createPerKeyStore } from './createPerKeyStore'

// Identity-only write guard (matches the original `store.get(key) === title`).
const store = createPerKeyStore<string>()

/** Update a single workspace's terminal title. */
export function setTitle(workspaceId: string, title: string): void {
  store.set(workspaceId, title)
}

/** Remove a workspace's title entry (e.g. on archive or null push from main). */
export function deleteTitle(workspaceId: string): void {
  store.remove(workspaceId)
}

/** Returns a stable snapshot reference of the current store state. */
export function getTitleSnapshot(): ReadonlyMap<string, string> {
  return store.getSnapshot()
}

/**
 * Subscribe to a single workspace's terminal title.
 * Components calling this re-render ONLY when that specific key changes,
 * not when any other workspace's title changes.
 */
export function useWorkspaceTitle(workspaceId: string): string | null {
  return store.useKey(workspaceId) ?? null
}
