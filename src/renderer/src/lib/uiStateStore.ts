/**
 * Single-value external AppUiState store — eliminates the "stale until
 * restart" bug where most consumers called `window.api.uiState.get()` once
 * on mount and never subscribed to `uiState.onChanged`, so any toggle made
 * in Settings only took effect in whichever component instance was the
 * source of the change (or after a full app relaunch).
 *
 * There is exactly ONE subscription to `window.api.uiState.onChanged` (owned
 * by this module) and exactly ONE initial `window.api.uiState.get()` call.
 * Every consumer reads through `useUiState()` (useSyncExternalStore) and
 * writes through `updateUiState()` (optimistic local set + IPC `uiState.update`).
 *
 * API:
 *   useUiState()            — hook: subscribe to the whole AppUiState value
 *   updateUiState(patch)    — optimistic patch + persist via IPC
 */

import { useSyncExternalStore } from 'react'
import type { AppUiState, AppUiStatePatch } from '@shared/types'

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle
// ---------------------------------------------------------------------------

let state: AppUiState | null = null
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

function setState(next: AppUiState): void {
  state = next
  notify()
}

// ---------------------------------------------------------------------------
// Bootstrap — one seed fetch + one push subscription, module-scoped so it
// only ever runs once regardless of how many components call useUiState().
// ---------------------------------------------------------------------------

let started = false

function ensureStarted(): void {
  if (started) return
  started = true
  window.api.uiState
    .get()
    .then(setState)
    .catch((err) => {
      console.error('[uiStateStore] failed to load initial ui state', err)
    })
  window.api.uiState.onChanged(setState)
}

// ---------------------------------------------------------------------------
// Public write API
// ---------------------------------------------------------------------------

/**
 * Optimistically patch the local snapshot, then persist via IPC. If the IPC
 * call resolves with the authoritative record, that becomes the new
 * snapshot (covers server-side clamping/validation); failures are logged —
 * the main process is the source of truth and the next onChanged push (or
 * a future successful update) reconciles any drift.
 */
export function updateUiState(patch: AppUiStatePatch): void {
  if (state) {
    setState({ ...state, ...patch })
  }
  window.api.uiState
    .update(patch)
    .then(setState)
    .catch((err) => {
      console.error('[uiStateStore] uiState update failed', err)
    })
}

// ---------------------------------------------------------------------------
// React hook — subscribes to the whole AppUiState value
// ---------------------------------------------------------------------------

/**
 * Subscribe to the live AppUiState. Returns null until the initial
 * `uiState.get()` resolves; after that, every `uiState:changed` push
 * (from ANY writer — this tab, settings, another IPC caller) updates all
 * subscribers immediately.
 */
export function useUiState(): AppUiState | null {
  ensureStarted()
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state // server snapshot — same in Electron context
  )
}
