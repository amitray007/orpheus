/**
 * Pure (non-React) helpers for Dashboard.tsx.
 *
 * Nothing in this file may import React, close over component state, or
 * produce side effects. Keep it that way — Dashboard.tsx imports from here
 * so that these utilities can be understood and tested in isolation.
 */

import type { View } from './MainContent'
import type { SidebarActiveView } from './Sidebar'
import type { AppUiState } from '@shared/types'

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

/** Map the current view to the sidebar's active-view discriminant. */
export function viewToSidebarActiveView(view: View): SidebarActiveView {
  if (view.kind === 'workspace') return 'workspace'
  if (view.kind === 'project') return 'project'
  if (view.kind === 'settings') return 'settings'
  if (view.kind === 'panes') return 'panes'
  if (view.kind === 'dashboard') return 'dashboard'
  return 'sessions'
}

/**
 * Return the Tailwind className string for the <main> content container.
 *
 * Workspace view keeps the container transparent so the native NSView paints
 * through. Settings and sessions each get their own scroll/padding treatment.
 * All other views (project) get the default padding.
 */
export function mainContainerClassName(viewKind: View['kind']): string {
  if (viewKind === 'workspace') return 'flex-1 overflow-hidden min-h-0'
  // Panes will host native terminal surfaces later — flush/no-padding like workspace.
  if (viewKind === 'panes') return 'flex-1 overflow-hidden min-h-0'
  if (viewKind === 'settings') return 'flex-1 overflow-hidden min-h-0 bg-surface-base'
  if (viewKind === 'sessions')
    // Workspaces kanban: tight padding so the board sits close to the app edges
    return 'flex-1 overflow-y-auto px-3 py-3 bg-surface-base'
  if (viewKind === 'dashboard') return 'flex-1 overflow-y-auto px-6 py-5 bg-surface-base'
  return 'flex-1 overflow-y-auto px-6 py-5 bg-surface-base'
}

// ---------------------------------------------------------------------------
// Activity rail / surface helpers
// ---------------------------------------------------------------------------

/**
 * Map the current view to the top-level surface the ActivityRail highlights.
 * Returns null while in Settings — the rail has no active icon in that case
 * (Settings is a bottom button, not one of the three top surfaces).
 */
export function deriveSurface(viewKind: View['kind']): 'dashboard' | 'projects' | 'panes' | null {
  if (viewKind === 'panes') return 'panes'
  if (viewKind === 'dashboard') return 'dashboard'
  if (viewKind === 'project' || viewKind === 'workspace' || viewKind === 'sessions')
    return 'projects'
  return null
}

/**
 * Resolve which View to land on when restoring uiState at launch, given
 * openAtLastView is true and no concrete workspace/project was last viewed
 * (those cases are handled by the caller before falling through to this).
 *
 * defaultSurface is the explicit "open at launch" user setting and wins the
 * top-level landing decision — it must be checked FIRST. lastViewKind is
 * only a fallback for when defaultSurface doesn't resolve to a recognized
 * surface (e.g. it was never set).
 */
export function resolveLandingView(
  uiState: Pick<AppUiState, 'lastViewKind' | 'defaultSurface'>
): View {
  // The explicit "open at launch" setting wins for the top-level landing view.
  if (uiState.defaultSurface === 'dashboard') return { kind: 'dashboard' }
  if (uiState.defaultSurface === 'panes') return { kind: 'panes' }
  // Otherwise fall back to the saved top-level view kind.
  if (uiState.lastViewKind === 'panes') return { kind: 'panes' }
  // 'dashboard' as a lastViewKind is now a real surface again (legacy DBs coerce
  // it to 'sessions' on read in uiState.ts); default everything else to Workspaces.
  return { kind: 'sessions' }
}

// ---------------------------------------------------------------------------
// Workspace naming
// ---------------------------------------------------------------------------

/**
 * Return the next available "Workspace N" name given an existing list.
 * Scans used numbers from names matching /^Workspace \d+$/ and picks the
 * smallest positive integer not yet taken.
 */
export function nextWorkspaceName(existing: { name: string }[]): string {
  const usedNumbers = new Set(
    existing
      .map((w) => /^Workspace\s+(\d+)$/.exec(w.name)?.[1])
      .filter((s): s is string => typeof s === 'string')
      .map((s) => parseInt(s, 10))
  )
  let n = 1
  while (usedNumbers.has(n)) n++
  return `Workspace ${n}`
}

// ---------------------------------------------------------------------------
// Reorder helpers
// ---------------------------------------------------------------------------

/**
 * Reorder an array of identifiable items according to `orderedIds`, dropping
 * any item whose id does not appear in the array. Used for optimistic project
 * reordering where the full list is replaced by the ordered subset.
 */
export function reorderById<T extends { id: string }>(arr: T[], orderedIds: string[]): T[] {
  const byId = new Map(arr.map((item) => [item.id, item]))
  return orderedIds.map((id) => byId.get(id)).filter((item): item is T => item !== undefined)
}

/**
 * Reorder a list by `orderedIds` then append any items whose ids were not
 * present in `orderedIds` to the tail. Used for optimistic workspace reordering
 * where archived workspaces sit outside the visible drag group.
 */
export function reorderWithTail<T extends { id: string }>(list: T[], orderedIds: string[]): T[] {
  const byId = new Map(list.map((item) => [item.id, item]))
  const reordered = orderedIds
    .map((id) => byId.get(id))
    .filter((item): item is T => item !== undefined)
  const seen = new Set(orderedIds)
  const tail = list.filter((item) => !seen.has(item.id))
  return [...reordered, ...tail]
}
