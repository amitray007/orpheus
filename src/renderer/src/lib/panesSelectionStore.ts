/**
 * Single-value external store for the Panes sidebar's active-panel /
 * active-layout selection (Panes v2, U6). Modeled on uiStateStore.ts's
 * single-value external-store shape (module-level state + listeners Set +
 * notify() + useSyncExternalStore-based hook) — NOT createPerKeyStore.ts,
 * since this isn't keyed per-workspace data, it's two scalar ids shared by
 * the whole Panes view.
 *
 * The sidebar (Sidebar.tsx's PanelsSection) is the writer: clicking a panel
 * row calls setActivePanel, clicking a layout row calls setActiveLayout.
 * PanesView.tsx is the primary reader (via usePanesSelection) and also
 * seeds a first-run default (first panel / first layout) once panels/layouts
 * load and nothing is selected yet.
 *
 * Deliberately in-memory only for this unit — no IPC persistence, so the
 * selection does not survive an app restart. Persisting it (e.g. through
 * uiState) is deferred to a later unit.
 *
 * API:
 *   usePanesSelection()          — hook: subscribe to { activePanelId, activeLayoutId }
 *   setActivePanel(panelId)      — sets activePanelId; also clears activeLayoutId to
 *                                  null so a stale cross-panel layout id never leaks
 *   setActiveLayout(layoutId)    — sets activeLayoutId directly
 */

import { useSyncExternalStore } from 'react'

export interface PanesSelection {
  activePanelId: string | null
  activeLayoutId: string | null
}

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle
// ---------------------------------------------------------------------------

let state: PanesSelection = { activePanelId: null, activeLayoutId: null }
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

/** Sets the active panel. Always resets activeLayoutId to null when the
 *  panel actually changes, so a caller must separately pick (and set) the
 *  new panel's first layout — see PanesView's seeding effect. */
export function setActivePanel(panelId: string | null): void {
  if (state.activePanelId === panelId) return
  state = { activePanelId: panelId, activeLayoutId: null }
  notify()
}

/** Sets the active layout directly (used for layout-row clicks and for
 *  auto-selecting a newly active panel's first layout). */
export function setActiveLayout(layoutId: string | null): void {
  if (state.activeLayoutId === layoutId) return
  state = { ...state, activeLayoutId: layoutId }
  notify()
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export function usePanesSelection(): PanesSelection {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  )
}
