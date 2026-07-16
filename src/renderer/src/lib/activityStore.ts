/**
 * Per-key external activity store — eliminates full-tree re-renders on every
 * hook event. Each leaf subscribes to its own workspace key; unrelated keys
 * fire no re-render in that component.
 *
 * API:
 *   setActivity(workspaceId, detail)      — set a single key
 *   setActivityBatch(updates)             — set many keys atomically
 *   useWorkspaceActivity(workspaceId)     — hook: subscribe to ONE key only
 *   getActivitySnapshot()                 — read the full map (no subscription)
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { WorkspaceActivityDetail } from '@shared/types'
import { createPerKeyStore } from './createPerKeyStore'

// Identity-only write guard (matches the original `store.get(key) === detail`).
const store = createPerKeyStore<WorkspaceActivityDetail>()

/** Update a single workspace's activity detail. */
export function setActivity(workspaceId: string, detail: WorkspaceActivityDetail): void {
  store.set(workspaceId, detail)
}

/** Apply a batch of updates — notifies each changed key once. */
export function setActivityBatch(
  updates: Array<{ workspaceId: string; detail: WorkspaceActivityDetail }>
): void {
  for (const { workspaceId, detail } of updates) {
    store.set(workspaceId, detail)
  }
}

/** Remove a workspace's activity entry (e.g. on archive). */
export function deleteActivity(workspaceId: string): void {
  store.remove(workspaceId)
}

/** Returns a stable snapshot reference of the current store state. */
export function getActivitySnapshot(): ReadonlyMap<string, WorkspaceActivityDetail> {
  return store.getSnapshot()
}

/**
 * Subscribe to a single workspace's activity detail.
 * Components calling this re-render ONLY when that specific key changes,
 * not when any other workspace's activity changes.
 */
export function useWorkspaceActivity(workspaceId: string): WorkspaceActivityDetail | undefined {
  return store.useKey(workspaceId)
}

const ACTIVE_DETAILS = new Set<WorkspaceActivityDetail>(['working', 'attention', 'ready'])

/**
 * Subscribe to a list of workspaces; returns a stable '|'-joined string of the
 * ids currently "active" (working/attention/ready), in the given order. The
 * string changes whenever the active SET changes (including a compensating
 * swap that keeps the count constant), so consumers re-render and can
 * recompute their partition from a fresh snapshot. Returns a primitive so
 * useSyncExternalStore's identity check stays stable.
 */
export function useActiveIdsKey(workspaceIds: string[]): string {
  const key = workspaceIds.join('|')
  // Subscribe to every id in the list; combine into a single unsubscribe.
  // Memoized on the joined key (not the array reference) so we don't
  // resubscribe on every parent render when the id list is unchanged.
  const subscribeToAll = useCallback(
    (fn: () => void) => {
      if (workspaceIds.length === 0) return () => {}
      const unsubscribes = workspaceIds.map((id) => store.subscribe(id, fn))
      return () => unsubscribes.forEach((unsub) => unsub())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stable joined string, not the array reference
    [key]
  )
  const getSnapshot = useMemo(
    () => () => workspaceIds.filter((id) => ACTIVE_DETAILS.has(store.raw.get(id)!)).join('|'),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the stable joined string, not the array reference
    [key]
  )
  return useSyncExternalStore(subscribeToAll, getSnapshot, getSnapshot)
}
