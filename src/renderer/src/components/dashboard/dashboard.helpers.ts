/**
 * Pure (non-React) helpers for Dashboard.tsx.
 *
 * Nothing in this file may import React, close over component state, or
 * produce side effects. Keep it that way — Dashboard.tsx imports from here
 * so that these utilities can be understood and tested in isolation.
 */

import type { View } from './MainContent'
import type { SidebarActiveView } from './Sidebar'

// ---------------------------------------------------------------------------
// View helpers
// ---------------------------------------------------------------------------

/** Map the current view to the sidebar's active-view discriminant. */
export function viewToSidebarActiveView(view: View): SidebarActiveView {
  if (view.kind === 'workspace') return 'workspace'
  if (view.kind === 'project') return 'project'
  if (view.kind === 'settings') return 'settings'
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
  if (viewKind === 'settings') return 'flex-1 overflow-hidden min-h-0 bg-surface-base'
  if (viewKind === 'sessions')
    // Workspaces kanban: tight padding so the board sits close to the app edges
    return 'flex-1 overflow-y-auto px-3 py-3 bg-surface-base'
  return 'flex-1 overflow-y-auto px-6 py-5 bg-surface-base'
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
