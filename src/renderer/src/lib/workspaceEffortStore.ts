// ---------------------------------------------------------------------------
// src/renderer/src/lib/workspaceEffortStore.ts
//
// Per-workspace external store for "which effort value is this workspace
// currently launching with" — mirrors workspaceModelStore.ts's shape exactly
// (a createPerKeyStore<string>, set/useKey), but for the OTHER half of the
// footer's two DropdownChip instances (see WorkspaceFooter.tsx: the model
// chip and the effort chip are TWO SEPARATE component instances, each of
// which used to own its own local useState with no way to learn the OTHER
// chip just changed something).
//
// Bugfix (model-routing unit 11): before this store existed, switching the
// model via the footer's Model chip never updated the Effort chip's
// displayed options/value — it kept offering the PREVIOUS model's levels
// until the whole DropdownChip instance remounted. Root cause: each
// DropdownChip instance's `modelValue`/`effortValue` were local useState,
// invisible to the other chip's instance. Fixed by making BOTH values live
// in shared per-workspace stores (this one + workspaceModelStore.ts) that
// EVERY DropdownChip instance for a given workspaceId reads from, kept in
// sync by ONE push subscription wired in Dashboard.tsx (mirrors
// titleStore.ts/activityStore.ts's own onXxxChanged wiring there) — this is
// a pure data store with no IPC/push wiring of its own.
// ---------------------------------------------------------------------------

import { createPerKeyStore } from './createPerKeyStore'

const store = createPerKeyStore<string>()

/** Record the effort value a workspace is currently launching with. */
export function setWorkspaceEffort(workspaceId: string, effort: string): void {
  store.set(workspaceId, effort)
}

/** Remove a workspace's cached effort (e.g. on archive). */
export function deleteWorkspaceEffort(workspaceId: string): void {
  store.remove(workspaceId)
}

/** Subscribe to a single workspace's cached effective effort value. Returns
 *  undefined until something has populated it (fetch in flight or never
 *  fetched) — callers render nothing (not a placeholder) until then. */
export function useWorkspaceEffort(workspaceId: string): string | undefined {
  return store.useKey(workspaceId)
}

/** Read without subscribing — used by the one-shot fetch-on-mount effect to
 *  decide whether a fetch is even needed. */
export function getCachedWorkspaceEffort(workspaceId: string): string | undefined {
  return store.raw.get(workspaceId)
}
