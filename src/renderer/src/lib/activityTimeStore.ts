/**
 * Live per-workspace "last activity at" (epoch ms), bumped whenever the activity
 * pipeline reports activity. Per-key subscriptions so only the affected row
 * re-renders. Falls back to jsonl mtime (handled by the consumer) when a
 * workspace has no live entry yet.
 */

import { useCallback, useSyncExternalStore } from 'react'

const store = new Map<string, number>()
const listeners = new Map<string, Set<() => void>>()

function notify(workspaceId: string): void {
  listeners.get(workspaceId)?.forEach((fn) => fn())
}

function subscribe(workspaceId: string, fn: () => void): () => void {
  let set = listeners.get(workspaceId)
  if (!set) {
    set = new Set()
    listeners.set(workspaceId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(workspaceId)
  }
}

/** Bump the live activity time for a workspace. Only moves forward — ignores older timestamps. */
export function bumpActivityTime(workspaceId: string, atMs: number): void {
  const prev = store.get(workspaceId)
  if (prev !== undefined && atMs <= prev) return
  store.set(workspaceId, atMs)
  notify(workspaceId)
}

/** Remove a workspace's activity time entry (e.g. on archive/removal). */
export function deleteActivityTime(workspaceId: string): void {
  if (store.delete(workspaceId)) notify(workspaceId)
}

/**
 * Subscribe to a single workspace's live activity time (epoch ms or null).
 * Components calling this re-render ONLY when that specific key changes.
 */
export function useWorkspaceActivityTime(workspaceId: string): number | null {
  const subscribeForKey = useCallback((fn: () => void) => subscribe(workspaceId, fn), [workspaceId])
  return useSyncExternalStore(
    subscribeForKey,
    () => store.get(workspaceId) ?? null,
    () => store.get(workspaceId) ?? null
  )
}
