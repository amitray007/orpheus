// ---------------------------------------------------------------------------
// src/renderer/src/lib/paneRunStateStore.ts
//
// Panes v2 — issue #17 (real per-layout Restart/Stop) + #18 (fix blank-on-
// re-enable). Tiny external store (module-level state + listeners Set +
// notify(), same shape as panesSelectionStore.ts/panesRefreshStore.ts) that
// tracks whether each pane's native surface should be LIVE (mounted) or
// STOPPED (destroyed), keyed by paneId.
//
// WHY THIS EXISTS: the ⋯ menu's "Restart layout"/"Stop layout" need to
// command every pane in the active layout at once, but each pane's mount/
// destroy effect lives inside its own PaneCell instance (usePaneSurface in
// PaneCell.tsx) — there was previously no shared channel between "PanesView,
// which owns the layout-wide menu" and "PaneCell, which owns one pane's
// mount lifecycle". This store is that channel:
//
//   - Each PaneCell reads its own `running` flag via usePaneRunning(paneId)
//     and feeds it into usePaneSurface's `active` computation (running=false
//     means "destroyed, show the stopped placeholder"; true means "mounted/
//     live"). Its own ◼/▶ buttons call setPaneRunning(paneId, next) directly.
//   - PanesView's Stop/Restart-layout handlers call setPaneRunning for every
//     paneId in the active layout's tree (via splitTreeOps.leafIds) — stop
//     sets them all false, restart flips false->destroy->true so each
//     PaneCell's effect (keyed on the running-derived `active` prop) tears
//     down and re-mounts a FRESH surface, exactly like the per-pane ◼/▶ path.
//
// A pane defaults to `true` (running) the first time it's read — matches
// the pre-existing PaneCell behavior (`useState(true)`) where every pane is
// live as soon as it's created. Entries are intentionally never pruned on
// pane close/delete: a stale key for a deleted paneId is a few bytes of
// dead state, not a leak (PaneCell instances for a removed pane simply stop
// existing and stop reading it).
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle,
// and so PanesView (no shared parent with PaneCell) can write it directly.
// ---------------------------------------------------------------------------

const runningByPaneId = new Map<string, boolean>()
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
// Public read API (non-hook) — for callers outside React render (e.g. a
// restart handler that needs the CURRENT value before deciding what to do).
// ---------------------------------------------------------------------------

/** Reads a pane's current running state synchronously. Defaults to `true`
 *  (live) for a paneId never explicitly stopped — mirrors PaneCell's old
 *  `useState(true)` default so a freshly-created pane starts live. */
export function getPaneRunning(paneId: string): boolean {
  return runningByPaneId.get(paneId) ?? true
}

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

/** Sets a single pane's running state. `true` -> PaneCell mounts a fresh
 *  surface; `false` -> PaneCell destroys its surface and shows the stopped
 *  placeholder. No-ops (skips the notify) when the value isn't actually
 *  changing, so a redundant call from Stop-layout iterating an already-
 *  stopped pane doesn't cause an extra render. */
export function setPaneRunning(paneId: string, running: boolean): void {
  if (runningByPaneId.get(paneId) === running) return
  runningByPaneId.set(paneId, running)
  notify()
}

/** Restarts a single pane: forces running false THEN true on the next
 *  microtask so PaneCell's effect sees a genuine false->true transition
 *  even if the pane was already running (a plain `setPaneRunning(id, true)`
 *  would no-op when it's already true, which is exactly the case a "restart
 *  a live pane" call needs to NOT no-op). Mirrors stop-then-start, the same
 *  semantics PanesView's Restart-layout uses for a currently-stopped pane. */
export function restartPane(paneId: string): void {
  setPaneRunning(paneId, false)
  // Deferred, not synchronous: PaneCell's mount/destroy effect must actually
  // flush the `false` transition (destroy the old surface) before the `true`
  // transition remounts it — collapsing both into one synchronous set (React
  // batches same-tick state changes) would skip straight from running to
  // running with no destroy in between.
  queueMicrotask(() => setPaneRunning(paneId, true))
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/** Subscribes to one pane's running state. Re-renders only when THIS
 *  paneId's value actually changes (useSyncExternalStore's getSnapshot
 *  returns a plain boolean primitive, so React's identity check on re-read
 *  after any store-wide notify() correctly bails out for unrelated panes). */
export function usePaneRunning(paneId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getPaneRunning(paneId),
    () => true
  )
}
