/**
 * Per-workspace Workbench UI state store — keyed by workspaceId, in-memory
 * only (no DB, no persistence across app restart).
 *
 * WHY this exists: `useWorkbenchState` used to hold `{ state, width }` in
 * plain component-local `useState` inside `WorkspaceView`. `MainContent`
 * only keeps `WorkspaceView` mounted while `view.kind === 'workspace'` —
 * navigating to a project (or the workspaces list) renders `ProjectView` /
 * `WorkspacesView` INSTEAD, unmounting the whole `WorkspaceView` subtree for
 * every kept workspace. On remount, local `useState` re-initializes to its
 * default ('dormant'), so the Workbench forgot whether it was open/expanded
 * and how wide it was.
 *
 * Moving the STORAGE (not the transition logic — that stays in
 * `workbenchReducer`'s `useWorkbenchState` hook) into this module-level
 * store fixes it the same way `sleepStore` / `activityStore` already keep
 * their per-workspace state alive across the same unmount/remount: the Map
 * lives outside any component's lifecycle, so a workspace's entry survives
 * regardless of whether its `WorkspaceView` is currently mounted.
 *
 * Follows the shared `createPerKeyStore` factory (see sleepStore.ts /
 * activityStore.ts for the same idiom) rather than hand-rolling another
 * Map+listeners store.
 */

import { createPerKeyStore } from './createPerKeyStore'
import type { WorkbenchTabId } from '../components/workbench/workbenchTabs'

export type WorkbenchState = 'dormant' | 'open' | 'expanded'

/** The two non-dormant modes — what `lastMode` remembers so re-opening from
 *  dormant restores whichever of these the workbench was in before it was
 *  last hidden, instead of always landing back on 'open'. */
export type WorkbenchMode = 'open' | 'expanded'

export interface WorkbenchEntry {
  state: WorkbenchState
  width: number
  /** Last non-dormant mode ('open' or 'expanded') this workspace's Workbench
   *  was in. Updated whenever `state` becomes 'open' or 'expanded'; left
   *  unchanged when `state` becomes 'dormant' — that's the whole point, so
   *  the dormant->reopen path (toggle/open) can restore it instead of
   *  hardcoding 'open'. See `nextLastMode` below and its callers in
   *  workbenchReducer.ts's `useWorkbenchState`. */
  lastMode: WorkbenchMode
  /** The currently active section tab (Git/Terminal/Files/Panes). Lifted up
   *  here (rather than local `useState` in WorkbenchPanel) so the top bar's
   *  tab strip (WorkspaceTitleBar) and the panel's body (WorkbenchPanel)
   *  agree on which tab is selected — both read/write through the same
   *  shared `WorkbenchApi` (see workbenchReducer.ts). Stored per-workspace,
   *  same survives-unmount rationale as state/width/lastMode above. */
  activeTab: WorkbenchTabId
}

export const DEFAULT_WORKBENCH_WIDTH = 760

export const DEFAULT_WORKBENCH_ENTRY: WorkbenchEntry = {
  state: 'dormant',
  width: DEFAULT_WORKBENCH_WIDTH,
  lastMode: 'open',
  activeTab: 'git'
}

/** Derives the next `lastMode` for a transition into `nextState`: tracks
 *  'open'/'expanded' as they happen, otherwise (transitioning to 'dormant')
 *  leaves the previous value untouched so it can be restored later. Kept
 *  here (not inside the pure `workbenchReducer`) so that reducer's
 *  signature/test table never has to change to support this. */
export function nextLastMode(
  nextState: WorkbenchState,
  prevLastMode: WorkbenchMode
): WorkbenchMode {
  return nextState === 'open' || nextState === 'expanded' ? nextState : prevLastMode
}

// Field-shallow equality — a freshly-constructed but value-identical entry
// (e.g. re-deriving { state, width, lastMode } on every dispatch) shouldn't
// notify subscribers or it would defeat the point of the guard in
// createPerKeyStore.
const store = createPerKeyStore<WorkbenchEntry>({
  equals: (prev, next) =>
    prev.state === next.state &&
    prev.width === next.width &&
    prev.lastMode === next.lastMode &&
    prev.activeTab === next.activeTab
})

/** Read a workspace's current entry, defaulting to dormant/DEFAULT_WORKBENCH_WIDTH if never set. */
export function getWorkbenchEntry(workspaceId: string): WorkbenchEntry {
  return store.raw.get(workspaceId) ?? DEFAULT_WORKBENCH_ENTRY
}

/** Write a workspace's entry. No-op if field-shallow-equal to the current entry. */
export function setWorkbenchEntry(workspaceId: string, entry: WorkbenchEntry): void {
  store.set(workspaceId, entry)
}

/** Drop a workspace's entry (e.g. on archive/remove). Harmless to skip — a
 *  leftover entry for a gone workspace id is not observable by anything. */
export function removeWorkbenchEntry(workspaceId: string): void {
  store.remove(workspaceId)
}

/**
 * Subscribe to one workspace's Workbench entry. Re-renders only when THIS
 * workspace's entry changes. Returns the shared DEFAULT entry (stable
 * reference) when the workspace has never been set, so callers can rely on
 * referential stability for memoization.
 */
export function useWorkbenchEntry(workspaceId: string): WorkbenchEntry {
  return store.useKey(workspaceId) ?? DEFAULT_WORKBENCH_ENTRY
}
