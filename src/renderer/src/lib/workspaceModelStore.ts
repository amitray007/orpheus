// ---------------------------------------------------------------------------
// src/renderer/src/lib/workspaceModelStore.ts
//
// Per-workspace external store for "which model id is this workspace
// currently launching with" — backs the sidebar's provider-icon prefix slot
// (Sidebar.tsx's WorkspaceStatusIcon area). Mirrors titleStore.ts's shape
// exactly (a createPerKeyStore<string>, set/useKey), except the value here
// is fetched lazily (pull, via workspace:getEffectiveModel — the SAME IPC
// call/source of truth the footer Model chip already reads from) rather than
// pushed from main, since there is no dedicated push channel for model
// changes.
//
// Three write paths keep this in sync with reality, all funneling through
// the ONE setWorkspaceModel() below:
//   1. useWorkspaceProviderIcon (below) fetches once per workspace id on
//      first render (mirrors Dashboard.tsx's per-visible-row git-status
//      fetch pattern) and caches the result here.
//   2. NewWorkspaceMenu, right after creating a workspace with a non-default
//      model, writes the just-chosen model optimistically (no round trip
//      needed — the caller already knows what it just persisted).
//   3. DropdownChip's footer Model chip, right after a successful
//      workspace:setModel call, writes the newly-selected model here too —
//      so switching models later keeps the sidebar icon in sync without a
//      second poll.
// ---------------------------------------------------------------------------

import { createPerKeyStore } from './createPerKeyStore'

const store = createPerKeyStore<string>()

/** Record the model id a workspace is currently launching with. */
export function setWorkspaceModel(workspaceId: string, modelId: string): void {
  store.set(workspaceId, modelId)
}

/** Remove a workspace's cached model (e.g. on archive). */
export function deleteWorkspaceModel(workspaceId: string): void {
  store.remove(workspaceId)
}

/** Subscribe to a single workspace's cached effective model id. Returns
 *  undefined until something has populated it (fetch in flight or never
 *  fetched) — callers render nothing (not a placeholder) until then. */
export function useWorkspaceModel(workspaceId: string): string | undefined {
  return store.useKey(workspaceId)
}

/** Read without subscribing — used by the one-shot fetch-on-mount effect to
 *  decide whether a fetch is even needed. */
export function getCachedWorkspaceModel(workspaceId: string): string | undefined {
  return store.raw.get(workspaceId)
}
