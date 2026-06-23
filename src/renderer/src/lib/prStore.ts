/**
 * Per-key external PR store — eliminates full-tree re-renders on every
 * GitHub PR update. Each leaf subscribes to its own workspace key; unrelated
 * keys fire no re-render in that component.
 *
 * The map distinguishes "not yet fetched" (key absent) from "fetched, none
 * found" (key present with value null), mirroring the original prByWorkspaceId
 * semantics.
 *
 * API:
 *   setPr(workspaceId, pr)   — set a single key (no-op on identity or shallow-field match; null means "no PR")
 *   deletePr(workspaceId)    — remove a key (e.g. on archive)
 *   getPrSnapshot()          — read the full map (no subscription)
 *   usePr(workspaceId)       — hook: subscribe to ONE key only
 */

import { useCallback, useSyncExternalStore } from 'react'
import type { GhPullRequest } from '@shared/types'

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle
// ---------------------------------------------------------------------------

const store = new Map<string, GhPullRequest | null>()

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

/** Update a single workspace's PR (null = no PR for this branch).
 *  No-op on identity match OR when all displayed fields are equal — prevents
 *  spurious subscriber notifications when IPC returns a structurally identical
 *  PR object (new object reference, same content). */
export function setPr(workspaceId: string, pr: GhPullRequest | null): void {
  const prev = store.get(workspaceId)
  if (prev === pr) return
  if (
    prev != null &&
    pr != null &&
    prev.number === pr.number &&
    prev.state === pr.state &&
    prev.title === pr.title &&
    prev.reviewDecision === pr.reviewDecision &&
    prev.checks === pr.checks
  )
    return
  store.set(workspaceId, pr)
  notify(workspaceId)
}

/** Remove a workspace's PR entry (e.g. on archive). */
export function deletePr(workspaceId: string): void {
  if (!store.has(workspaceId)) return
  store.delete(workspaceId)
  notify(workspaceId)
}

// ---------------------------------------------------------------------------
// Public read / snapshot API
// ---------------------------------------------------------------------------

/** Returns a stable snapshot reference of the current store state. */
export function getPrSnapshot(): ReadonlyMap<string, GhPullRequest | null> {
  return store
}

// ---------------------------------------------------------------------------
// React hook — subscribes only to the given workspaceId key
// ---------------------------------------------------------------------------

/**
 * Subscribe to a single workspace's GitHub PR.
 * Components calling this re-render ONLY when that specific key changes,
 * not when any other workspace's PR changes.
 *
 * Returns null when either the key is absent (not yet fetched) or when the
 * fetch confirmed no PR exists for this workspace's branch.
 */
export function usePr(workspaceId: string): GhPullRequest | null {
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
