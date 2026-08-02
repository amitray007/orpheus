/**
 * tui/frameStore.ts — external store for the latest `tree` frame.
 *
 * WHY THIS EXISTS (fixes the rerender-thrash)
 * -----------------------------------------------------------------------
 * Previously, tui/entry.ts's /subscribe callback called `instance.rerender(
 * <App frame={...} .../>)` with a BRAND NEW element tree on every incoming
 * socket frame — up to ~20x/sec at the 50ms debounce (docs/TUI_SPEC.md D5).
 * `rerender` forces Ink to reconcile the whole tree from a fresh root
 * element every time, which is far more work than a state update inside an
 * already-mounted tree, and — because `onOpen`/`onQuit` closures were
 * recreated each call — defeated any memoization lower in the tree anyway.
 *
 * The fix: mount <App> ONCE. Frames flow into this tiny store from OUTSIDE
 * React (same as before — the /subscribe callback still doesn't live inside
 * a component), and App.tsx subscribes via `useSyncExternalStore`, which
 * lets React diff against the previous render instead of rebuilding from
 * scratch. The existing revision-monotonicity guard (stale/out-of-order
 * frames dropped) moves in here so it's enforced once, at the single point
 * frames enter the app, regardless of how many components end up reading
 * the store.
 *
 * COALESCING FLUSH (ref-buffer, not one setState per socket message)
 * -----------------------------------------------------------------------
 * `applyFrame` doesn't publish straight to the value `getSnapshot()` reads —
 * it buffers the latest frame in `pendingFrame` and schedules a flush on a
 * short timer (FLUSH_INTERVAL_MS). If several frames land within that
 * window (a burst of buffered socket messages delivered across a few
 * microtasks, which `useSyncExternalStore`'s per-call notification can't
 * guarantee React batches into one render), they collapse into a single
 * published frame and a single listener notification instead of one
 * publish-and-render per message. The revision-monotonicity guard still
 * runs on every incoming frame (so a stale/reordered one is dropped
 * immediately, not just at flush time), and `resetFrame()` synchronously
 * clears any pending flush so a picker-loop restart never flashes a queued
 * frame from the PREVIOUS loop iteration.
 */

import type { TreeFrame } from './types.js'

type Listener = () => void

const FLUSH_INTERVAL_MS = 32

let currentFrame: TreeFrame | null = null
let pendingFrame: TreeFrame | null = null
let lastRevision = -1
let flushTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<Listener>()

function flush(): void {
  flushTimer = null
  if (pendingFrame == null) return
  currentFrame = pendingFrame
  pendingFrame = null
  for (const listener of listeners) listener()
}

function scheduleFlush(): void {
  if (flushTimer != null) return
  flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS)
  flushTimer.unref?.()
}

/**
 * Apply an incoming frame if it's newer than the last-applied revision;
 * older/duplicate frames are silently ignored (self-heals a
 * reordered/duplicated frame on a flaky link — see docs/TUI_SPEC.md D5).
 * The frame is buffered, not published immediately — see the file header's
 * "COALESCING FLUSH" note. Returns whether the frame was accepted (newer
 * than the last-applied revision), purely so callers/tests can assert on
 * it; entry.ts itself doesn't need the return value.
 */
export function applyFrame(frame: TreeFrame): boolean {
  if (frame.revision <= lastRevision) return false
  lastRevision = frame.revision
  pendingFrame = frame
  scheduleFlush()
  return true
}

/** Reset to the "connecting…" state — used by tests, and by entry.ts at the
 * start of every picker-loop iteration so a stale queued frame from the
 * PREVIOUS iteration can never flash before the new subscription's first
 * real frame lands. */
export function resetFrame(): void {
  if (flushTimer != null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  pendingFrame = null
  currentFrame = null
  lastRevision = -1
  for (const listener of listeners) listener()
}

function getSnapshot(): TreeFrame | null {
  return currentFrame
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The store object handed to `useSyncExternalStore` in App.tsx. */
export const frameStore = { subscribe, getSnapshot }
