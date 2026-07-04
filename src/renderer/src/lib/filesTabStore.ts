/**
 * Per-workspace Workbench FILES tab state store — keyed by workspaceId,
 * in-memory only (no DB, no persistence across app restart). Sibling to
 * `workbenchStore.ts` / `workbenchTerminalsStore.ts` (same `createPerKeyStore`
 * idiom); read either header for the general "why a module-level store"
 * rationale.
 *
 * WHY this exists: same unmount/remount class of bug already fixed twice.
 * `MainContent` only keeps `WorkspaceView`/the Workbench mounted while
 * `view.kind === 'workspace'`; navigating to a project (or the workspaces
 * list) unmounts the whole subtree, so `FilesTab`'s plain component-local
 * `useState` (`selectedFile`, `mode`, `treeOpen`, `treeOptions`) re-initialized
 * to defaults on remount — you'd lose the file you were viewing, the
 * viewer/editor mode, and the tree toggles just by navigating away and back.
 *
 * Moving that STATE into this module-level store (same pattern as
 * workbenchStore.ts's state/width/lastMode/activeTab) means a remounted
 * `FilesTab` seeds from the saved entry and restores exactly where it was.
 *
 * DIRTY-BUFFER NOTE (deliberate scope): we persist `selectedFile` + `mode` +
 * tree state, NOT the editor's in-memory unsaved buffer. On nav-away/back the
 * editor re-reads the file from disk, so unsaved (never-saved) edits made just
 * before navigating are lost — but the file + mode + tree toggles are all
 * restored. Persisting the raw dirty buffer here was considered and rejected:
 * it risks the stashed buffer going stale vs. an on-disk change and is far more
 * failure-prone than the file+mode restoration this bug is actually about.
 *
 * SELECTION-POINTER NOTE: `selectedFile` already restored the CONTENT pane
 * (the viewer/editor opened the right file on remount) — but until now nothing
 * pushed it back into the TREE's own selection, so the tree row never
 * re-highlighted/scrolled-to on return even though the content pane showed the
 * file. `expandedPaths` closes the other half of that gap: @pierre/trees has
 * no public getter or change-event for "the current expanded set" (verified
 * against node_modules/@pierre/trees/dist/model/FileTreeController.js — expand/
 * collapse never appears in the exported mutation-event union), so this field
 * is a best-effort snapshot of the ANCESTOR DIRECTORIES OF THE SELECTED FILE
 * (recomputed alongside `selectedFile` in FilesTab.tsx), not a true "everything
 * the user manually expanded" record. That's sufficient for the bug this fixes:
 * making the restored selection visible without every ancestor being collapsed.
 */

import { createPerKeyStore } from './createPerKeyStore'
import type { TreeOptionsState } from '../components/workbench/TreeOptionsPopover'

/** Viewer (read-only Pierre <File>) vs Editor (CodeMirror). Mirrors the
 *  `FilesViewMode` union local to FilesTab.tsx. */
export type FilesViewMode = 'viewer' | 'editor'

export interface FilesTabEntry {
  /** The single non-directory path currently selected/viewed, or null. */
  selectedFile: string | null
  /** Viewer (default) vs Editor mode. */
  mode: FilesViewMode
  /** Whether the left file-tree pane is open. */
  treeOpen: boolean
  /** The tree-view toggles (Show hidden / Dim gitignored). */
  treeOptions: TreeOptionsState
  /** Directory paths (trailing-slash, tree-canonical form) to expand when the
   *  tree remounts — the ancestor chain of `selectedFile` at the time it was
   *  last selected. See the SELECTION-POINTER NOTE above for why this is an
   *  ancestors-of-selection snapshot rather than a full expansion record. */
  expandedPaths: string[]
}

export const DEFAULT_FILES_TAB_ENTRY: FilesTabEntry = {
  selectedFile: null,
  mode: 'viewer',
  treeOpen: true,
  treeOptions: { showHidden: false, dimGitignored: true },
  expandedPaths: []
}

// Field-shallow equality (treeOptions compared by its two fields; expandedPaths
// by length + order — it's always derived+written as a single array, never
// mutated in place, so this is a cheap and correct comparison) — a
// freshly-constructed but value-identical entry shouldn't notify subscribers,
// matching the guard in createPerKeyStore / the sibling stores.
function sameExpandedPaths(prev: readonly string[], next: readonly string[]): boolean {
  return prev.length === next.length && prev.every((p, i) => p === next[i])
}

const store = createPerKeyStore<FilesTabEntry>({
  equals: (prev, next) =>
    prev.selectedFile === next.selectedFile &&
    prev.mode === next.mode &&
    prev.treeOpen === next.treeOpen &&
    prev.treeOptions.showHidden === next.treeOptions.showHidden &&
    prev.treeOptions.dimGitignored === next.treeOptions.dimGitignored &&
    sameExpandedPaths(prev.expandedPaths, next.expandedPaths)
})

/** Read a workspace's current Files-tab entry, defaulting to the shared
 *  DEFAULT entry (stable reference) if never set. */
export function getFilesTabEntry(workspaceId: string): FilesTabEntry {
  return store.raw.get(workspaceId) ?? DEFAULT_FILES_TAB_ENTRY
}

/** Write a workspace's Files-tab entry. No-op if field-shallow-equal to the
 *  current entry. */
export function setFilesTabEntry(workspaceId: string, entry: FilesTabEntry): void {
  store.set(workspaceId, entry)
}

/** Drop a workspace's entry (e.g. on close/archive/remove). Harmless to skip —
 *  a leftover entry for a gone workspace id is not observable by anything, but
 *  dropping it keeps this store from growing unbounded across a long session. */
export function removeFilesTabEntry(workspaceId: string): void {
  store.remove(workspaceId)
}

/**
 * Subscribe to one workspace's Files-tab entry. Re-renders only when THIS
 * workspace's entry changes. Returns the shared DEFAULT entry (stable
 * reference) when the workspace has never been set.
 */
export function useFilesTabEntry(workspaceId: string): FilesTabEntry {
  return store.useKey(workspaceId) ?? DEFAULT_FILES_TAB_ENTRY
}
