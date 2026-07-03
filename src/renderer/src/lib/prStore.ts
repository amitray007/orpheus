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

import type { GhPullRequest } from '@shared/types'
import { createPerKeyStore } from './createPerKeyStore'

// Shallow-field equality — prevents spurious subscriber notifications when
// IPC returns a structurally identical PR object (new object reference, same
// content). Matches the original field list exactly.
const store = createPerKeyStore<GhPullRequest | null>({
  equals: (prev, next) =>
    prev != null &&
    next != null &&
    prev.number === next.number &&
    prev.state === next.state &&
    prev.title === next.title &&
    prev.reviewDecision === next.reviewDecision &&
    prev.checks === next.checks
})

/** Update a single workspace's PR (null = no PR for this branch).
 *  No-op on identity match OR when all displayed fields are equal — prevents
 *  spurious subscriber notifications when IPC returns a structurally identical
 *  PR object (new object reference, same content). */
export function setPr(workspaceId: string, pr: GhPullRequest | null): void {
  store.set(workspaceId, pr)
}

/** Remove a workspace's PR entry (e.g. on archive). */
export function deletePr(workspaceId: string): void {
  store.remove(workspaceId)
}

/** Returns a stable snapshot reference of the current store state. */
export function getPrSnapshot(): ReadonlyMap<string, GhPullRequest | null> {
  return store.getSnapshot()
}

/**
 * Subscribe to a single workspace's GitHub PR.
 * Components calling this re-render ONLY when that specific key changes,
 * not when any other workspace's PR changes.
 *
 * Returns null when either the key is absent (not yet fetched) or when the
 * fetch confirmed no PR exists for this workspace's branch.
 */
export function usePr(workspaceId: string): GhPullRequest | null {
  return store.useKey(workspaceId) ?? null
}
