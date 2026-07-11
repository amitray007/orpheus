/**
 * Live per-workspace "last activity at" (epoch ms), bumped whenever the activity
 * pipeline reports activity. Per-key subscriptions so only the affected row
 * re-renders. Falls back to jsonl mtime (handled by the consumer) when a
 * workspace has no live entry yet.
 */

import { createPerKeyStore } from './createPerKeyStore'

// Monotonic-only write guard: a write is allowed only when it moves the
// timestamp forward (matches the original `if (prev !== undefined && atMs <=
// prev) return`). `equals` stays at the default identity check, which is
// irrelevant here since monotonic subsumes it for numbers.
const store = createPerKeyStore<number>({
  monotonic: (prev, next) => next > prev
})

/** Bump the live activity time for a workspace. Only moves forward — ignores older timestamps. */
export function bumpActivityTime(workspaceId: string, atMs: number): void {
  store.set(workspaceId, atMs)
}

/** Remove a workspace's activity time entry (e.g. on archive/removal). */
export function deleteActivityTime(workspaceId: string): void {
  store.remove(workspaceId)
}

/** Returns a stable snapshot reference of the current store state (no
 *  subscription) — mirrors activityStore.ts's getActivitySnapshot(). Used by
 *  useLiveAgents.ts to read "last activity at" per workspace without
 *  subscribing to every individual key (the caller re-renders via
 *  useActiveIdsKey on activityStore instead, then re-reads a fresh snapshot
 *  from both stores together). */
export function getActivityTimeSnapshot(): ReadonlyMap<string, number> {
  return store.getSnapshot()
}

/**
 * Subscribe to a single workspace's live activity time (epoch ms or null).
 * Components calling this re-render ONLY when that specific key changes.
 */
export function useWorkspaceActivityTime(workspaceId: string): number | null {
  return store.useKey(workspaceId) ?? null
}
