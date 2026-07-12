// ---------------------------------------------------------------------------
// src/renderer/src/lib/paneLiveLayoutsStore.ts
//
// Panes v2 — issue #24 sidebar running loader. External store (module-level
// state + listeners Set + notify(), same shape as panesRefreshStore.ts /
// panesSelectionStore.ts / paneRunStateStore.ts) mirroring main's
// paneSurfacesByWorkspace map (src/main/index.ts) into the renderer: the set
// of layout ids that currently have >=1 LIVE native pane surface.
//
// "Live" here means background-aware, not "currently open in PanesView": a
// layout you navigated away from keeps its panes mounted-but-hidden (see
// PaneCell.tsx's `[]`-keyed true-teardown effect — it calls `pane:hide`,
// never `pane:destroy`, on ordinary unmount), so main's registry — and this
// store — still counts it as live. A layout only drops out of the set when
// EVERY one of its panes has been explicitly destroyed (✕-close, Stop, or
// workspace/project archival). A layout never opened this session never
// appears in the set at all.
//
// Sourced from a single push subscription (`panes:liveLayoutsChanged`, see
// src/shared/ipc.ts) set up once at module load — main sends the FULL
// current set on every change, so this store just replaces its local Set
// wholesale rather than diffing deltas.
//
// API:
//   useIsLayoutLive(layoutId)  — per-key hook (mirrors usePaneRunning's
//                                 shape): re-renders only when THIS layout's
//                                 membership in the set actually flips.
//   useLiveLayouts()           — whole-Set hook, for callers that need the
//                                 full membership (e.g. a "N running" count).
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle
// ---------------------------------------------------------------------------

let liveLayoutIds: Set<string> = new Set()
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
// Wire the single main->renderer subscription once at module load. Safe to
// import this module more than once (ESM module caching guarantees this
// body runs exactly once); no teardown needed since the store — like its
// sibling stores in this file family — lives for the app's lifetime.
// ---------------------------------------------------------------------------

window.api.panes.onLiveLayoutsChanged((layoutIds) => {
  liveLayoutIds = new Set(layoutIds)
  notify()
})

// ---------------------------------------------------------------------------
// React hooks
// ---------------------------------------------------------------------------

/** Subscribes to a single layout's live/idle membership. Re-renders only
 *  when THIS layoutId's boolean membership actually changes (a plain
 *  boolean snapshot means React's identity check on re-read after any
 *  store-wide notify() correctly bails out for unrelated layouts). */
export function useIsLayoutLive(layoutId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => liveLayoutIds.has(layoutId),
    () => false
  )
}

/** Subscribes to the full live-layouts Set — for callers that need whole-
 *  set membership (e.g. a sidebar-wide "N running" summary) rather than one
 *  layout's flag. */
export function useLiveLayouts(): Set<string> {
  return useSyncExternalStore(
    subscribe,
    () => liveLayoutIds,
    () => liveLayoutIds
  )
}
