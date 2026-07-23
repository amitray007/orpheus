// ---------------------------------------------------------------------------
// src/renderer/src/lib/workspaceModelStore.ts
//
// Per-workspace external store for "which model id is this workspace
// currently launching with" — backs the sidebar's provider-icon prefix slot
// (Sidebar.tsx's WorkspaceStatusIcon area) AND, since the model-routing
// unit 11 bugfix, the footer's Effort chip's live-reactivity. Mirrors
// titleStore.ts's shape exactly (a createPerKeyStore<string>, set/useKey) —
// a pure data store with no IPC/push wiring of its own; that wiring lives in
// Dashboard.tsx, exactly like titleStore.ts/activityStore.ts/gitStore.ts's
// own onXxxChanged subscriptions.
//
// Write paths, all funneling through setWorkspaceModel():
//   1. useWorkspaceProviderIcon.ts fetches once per workspace id on first
//      render (mirrors Dashboard.tsx's per-visible-row git-status fetch
//      pattern) and caches the result here.
//   2. NewWorkspaceMenu, right after creating a workspace with a non-default
//      model, writes the just-chosen model optimistically (no round trip
//      needed — the caller already knows what it just persisted).
//   3. DropdownChip's footer Model chip, right after a successful
//      workspace:setModel call, writes the newly-selected model here too —
//      so switching models later keeps the sidebar icon in sync without a
//      second poll.
//   4. THE BUGFIX: Dashboard.tsx's window.api.workspaces.onEffectiveSettings
//      Changed subscription (see that file — same useEffect also writes
//      into workspaceEffortStore.ts from the SAME push event). Pushed by
//      every main-process handler that can change a workspace's effective
//      model/effort (footer chip, creation menu, settings drawers, CLI —
//      see registerClaudeSettingsIpc's four handlers, all of which now call
//      this push after persisting). Updating BOTH stores from one push is
//      what makes the footer's Effort chip (a SEPARATE DropdownChip
//      component instance from the Model chip — see WorkspaceFooter.tsx)
//      react live to a model change made by the OTHER chip instance,
//      instead of only updating on its own next mount.
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
