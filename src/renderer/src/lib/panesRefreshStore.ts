// ---------------------------------------------------------------------------
// src/renderer/src/lib/panesRefreshStore.ts
//
// Cross-component invalidation signal for Panes v2's two independent data
// fetchers. PanelsSection.tsx (the sidebar "Panels" tree) and usePanesData.ts
// (PanesView's data hook) each own their OWN, uncoordinated fetch of
// panels/layouts — see PanelsSection.tsx's header comment for why that
// duplication is deliberate (different concerns: sidebar nav-tree vs.
// PanesView's active-layout data).
//
// The gap that duplication opens: a mutation made through the SIDEBAR (e.g.
// deleting the currently-active layout) only refreshes the sidebar's own
// local state. usePanesData's `layouts` array — the one PanesView reads to
// decide what's currently selectable — never learns the mutation happened,
// so it keeps serving a stale list that still contains the deleted row.
// PanesView's seeding effect then re-picks a "first layout" from that STALE
// list and resurrects the very layout that was just deleted.
//
// This store is the fix: a tiny monotonically-increasing counter that any
// mutator can bump, and that usePanesData subscribes to (in addition to its
// own `reloadToken`) so a sidebar-driven mutation forces a real refetch
// there too. Modeled directly on panesSelectionStore.ts's external-store
// shape (module-level state + listeners Set + notify() + a
// useSyncExternalStore-based hook) for consistency with the rest of the
// Panes v2 store family — NOT createPerKeyStore.ts, since this is a single
// scalar counter, not workspace-keyed data.
//
// API:
//   bumpPanesRefresh()  — increments the counter + notifies subscribers.
//                          Call this after any window.api.panes.* mutation
//                          the OTHER fetcher needs to see (delete/rename
//                          layout or panel, create flows, etc).
//   usePanesRefresh()   — hook: returns the current counter value. Fold it
//                          into a data-loading effect's dependency array
//                          (alongside any existing reload token) so a bump
//                          triggers that effect to re-run.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle
// ---------------------------------------------------------------------------

let counter = 0
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

/** Bumps the shared refresh counter, notifying every subscriber (e.g.
 *  usePanesData's effects) to refetch. Call this right after a successful
 *  window.api.panes.* mutation made from the sidebar (or anywhere else)
 *  that the OTHER Panes fetcher needs to observe. */
export function bumpPanesRefresh(): void {
  counter += 1
  notify()
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function usePanesRefresh(): number {
  return useSyncExternalStore(
    subscribe,
    () => counter,
    () => counter
  )
}
