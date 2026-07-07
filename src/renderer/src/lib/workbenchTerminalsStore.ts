/**
 * Per-workspace Workbench TERMINAL LIST store — keyed by workspaceId,
 * in-memory only (no DB, no persistence across app restart). Sibling to
 * `workbenchStore.ts` (same `createPerKeyStore` idiom); read its header
 * comment first for the general "why a module-level store" rationale.
 *
 * WHY this exists: U9 fixed `TerminalTab.tsx`'s unmount cleanup to `hide`
 * (not `destroy`) every terminal surface, so the native libghostty surfaces
 * now survive `WorkspaceView` unmount/remount (nav to project/settings, LRU
 * eviction). But the terminal STRIP itself — the `{id, label}[]` list,
 * `activeTerminalId`, and the monotonic id counter — was plain component
 * `useState`/`useRef` inside `TerminalTab`. A remounted `TerminalTab` would
 * still reset to a single fresh "Terminal 1" and mount a BRAND NEW surface,
 * orphaning every still-alive-but-now-unreferenced hidden surface (a leak
 * until archive/quit) even though the fix above kept them alive.
 *
 * Moving that list/active-id/next-id STORAGE into this module-level store
 * (same pattern as workbenchStore.ts's state/width/lastMode/activeTab) means
 * a remounted `TerminalTab` rebuilds the EXACT same tab strip and re-attaches
 * (mounts) each previously-created key instead of resetting — nav-away and
 * back shows the same terminals with their scrollback intact.
 */

import { createPerKeyStore } from './createPerKeyStore'

export interface WorkbenchTerminalModel {
  id: number
  label: string
}

export interface WorkbenchTerminalsEntry {
  terminals: WorkbenchTerminalModel[]
  activeTerminalId: number
  /** Monotonic next-id counter — never reused after a close, so ids never
   *  collide across remounts (survives here, not component state). */
  nextId: number
}

const FIRST_TERMINAL: WorkbenchTerminalModel = { id: 1, label: 'Terminal 1' }

export const DEFAULT_WORKBENCH_TERMINALS_ENTRY: WorkbenchTerminalsEntry = {
  terminals: [FIRST_TERMINAL],
  activeTerminalId: FIRST_TERMINAL.id,
  nextId: FIRST_TERMINAL.id + 1
}

// Field-shallow-ish equality — terminals is compared by length + per-item
// id/label so re-deriving an equivalent array (e.g. a label update that maps
// every item but changes none) doesn't spuriously notify subscribers.
function entriesEqual(prev: WorkbenchTerminalsEntry, next: WorkbenchTerminalsEntry): boolean {
  if (prev.activeTerminalId !== next.activeTerminalId) return false
  if (prev.nextId !== next.nextId) return false
  if (prev.terminals.length !== next.terminals.length) return false
  return prev.terminals.every(
    (t, i) => t.id === next.terminals[i].id && t.label === next.terminals[i].label
  )
}

const store = createPerKeyStore<WorkbenchTerminalsEntry>({ equals: entriesEqual })

/** Read a workspace's current terminals entry, defaulting to a single fresh
 *  "Terminal 1" if never set. */
export function getWorkbenchTerminalsEntry(workspaceId: string): WorkbenchTerminalsEntry {
  return store.raw.get(workspaceId) ?? DEFAULT_WORKBENCH_TERMINALS_ENTRY
}

/** Write a workspace's terminals entry. No-op if equal (per entriesEqual) to
 *  the current entry. */
export function setWorkbenchTerminalsEntry(
  workspaceId: string,
  entry: WorkbenchTerminalsEntry
): void {
  store.set(workspaceId, entry)
}

/** Drop a workspace's entry (e.g. on close/archive/remove). Harmless to skip
 *  — a leftover entry for a gone workspace id is not observable by anything,
 *  but dropping it keeps this store from growing unbounded across a long
 *  session with many closed/archived workspaces. */
export function removeWorkbenchTerminalsEntry(workspaceId: string): void {
  store.remove(workspaceId)
}
