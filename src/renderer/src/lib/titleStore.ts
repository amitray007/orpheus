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

import { useCallback, useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle
// ---------------------------------------------------------------------------

const store = new Map<string, string>()

// Per-key listeners: each workspaceId has its own Set of notify fns so that
// a write to key A only wakes up subscribers of key A.
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

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

/** Update a single workspace's terminal title. */
export function setTitle(workspaceId: string, title: string): void {
  if (store.get(workspaceId) === title) return // no-op on identity match
  store.set(workspaceId, title)
  notify(workspaceId)
}

/** Remove a workspace's title entry (e.g. on archive or null push from main). */
export function deleteTitle(workspaceId: string): void {
  if (!store.has(workspaceId)) return
  store.delete(workspaceId)
  notify(workspaceId)
}

// ---------------------------------------------------------------------------
// Public read / snapshot API
// ---------------------------------------------------------------------------

/** Returns a stable snapshot reference of the current store state. */
export function getTitleSnapshot(): ReadonlyMap<string, string> {
  return store
}

// ---------------------------------------------------------------------------
// React hook — subscribes only to the given workspaceId key
// ---------------------------------------------------------------------------

/**
 * Subscribe to a single workspace's terminal title.
 * Components calling this re-render ONLY when that specific key changes,
 * not when any other workspace's title changes.
 */
export function useWorkspaceTitle(workspaceId: string): string | null {
  // Wrap the subscribe arg in useCallback so useSyncExternalStore receives the
  // same function reference across parent re-renders (only re-subscribes when
  // workspaceId changes). Without this, a new arrow would be created every render,
  // causing useSyncExternalStore to unsubscribe and resubscribe on every parent render.
  const subscribeForKey = useCallback((fn: () => void) => subscribe(workspaceId, fn), [workspaceId])
  return (
    useSyncExternalStore(
      subscribeForKey,
      () => store.get(workspaceId) ?? null,
      () => store.get(workspaceId) ?? null // server snapshot — same in Electron context
    ) ?? null
  )
}
