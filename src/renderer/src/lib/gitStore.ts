/**
 * Per-key external git-status store — eliminates full-tree re-renders on every
 * git status update. Each leaf subscribes to its own workspace key; unrelated
 * keys fire no re-render in that component.
 *
 * API:
 *   setGitStatus(workspaceId, status)   — set a single key (no-op on identity or shallow-field match)
 *   deleteGitStatus(workspaceId)        — remove a key (e.g. on archive)
 *   getGitSnapshot()                    — read the full map (no subscription)
 *   useGitStatus(workspaceId)           — hook: subscribe to ONE key only
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { GitStatus } from '@shared/types'

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle
// ---------------------------------------------------------------------------

const store = new Map<string, GitStatus | null>()

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

/** Update a single workspace's git status.
 *  No-op on identity match OR when all meaningful fields are equal — prevents
 *  spurious subscriber notifications when IPC returns a structurally identical
 *  status object (new object reference, same content). */
export function setGitStatus(workspaceId: string, status: GitStatus | null): void {
  const prev = store.get(workspaceId)
  if (prev === status) return
  if (
    prev != null &&
    status != null &&
    prev.branch === status.branch &&
    prev.insertions === status.insertions &&
    prev.deletions === status.deletions &&
    prev.hasChanges === status.hasChanges
  )
    return
  store.set(workspaceId, status)
  notify(workspaceId)
}

/** Remove a workspace's git status entry (e.g. on archive). */
export function deleteGitStatus(workspaceId: string): void {
  if (!store.has(workspaceId)) return
  store.delete(workspaceId)
  notify(workspaceId)
}

// ---------------------------------------------------------------------------
// Public read / snapshot API
// ---------------------------------------------------------------------------

/** Returns a stable snapshot reference of the current store state. */
export function getGitSnapshot(): ReadonlyMap<string, GitStatus | null> {
  return store
}

// ---------------------------------------------------------------------------
// React hook — subscribes only to the given workspaceId key
// ---------------------------------------------------------------------------

/**
 * Subscribe to a single workspace's git status.
 * Components calling this re-render ONLY when that specific key changes,
 * not when any other workspace's git status changes.
 */
export function useGitStatus(workspaceId: string): GitStatus | null {
  // Wrap the subscribe arg in useCallback so useSyncExternalStore receives the
  // same function reference across parent re-renders (only re-subscribes when
  // workspaceId changes). Without this, a new arrow would be created every render,
  // causing useSyncExternalStore to unsubscribe and resubscribe on every parent render.
  const subscribeForKey = useCallback((fn: () => void) => subscribe(workspaceId, fn), [workspaceId])
  return useSyncExternalStore(
    subscribeForKey,
    () => store.get(workspaceId) ?? null,
    () => store.get(workspaceId) ?? null // server snapshot — same in Electron context
  )
}
