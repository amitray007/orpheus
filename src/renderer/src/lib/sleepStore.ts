/**
 * Per-key external sleep store — tracks whether each workspace's terminal
 * is sleeping (occluded/backgrounded). Eliminates full-tree re-renders by
 * subscribing each leaf to its own workspace key.
 *
 * API:
 *   useTerminalSleeping(workspaceId) — hook: subscribe to ONE key only
 */

import { useCallback, useSyncExternalStore } from 'react'

// ---------------------------------------------------------------------------
// Internal state — module-level so it lives outside React's render cycle
// ---------------------------------------------------------------------------

const store = new Map<string, boolean>()

// Per-key listeners: each workspaceId has its own Set of notify fns so that
// a write to key A only wakes up subscribers of key A.
const listeners = new Map<string, Set<() => void>>()

function notify(workspaceId: string): void {
  listeners.get(workspaceId)?.forEach((fn) => fn())
}

function subscribe(workspaceId: string, fn: () => void): () => void {
  let set = listeners.get(workspaceId)
  if (!set) {
    set = new Set()
    listeners.set(workspaceId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(workspaceId)
  }
}

// ---------------------------------------------------------------------------
// Public write API — used by the xterm engine (visibility known in JS)
// ---------------------------------------------------------------------------

export function setSleeping(workspaceId: string, sleeping: boolean): void {
  if (store.get(workspaceId) === sleeping) return
  if (sleeping) {
    store.set(workspaceId, true)
  } else {
    store.delete(workspaceId)
  }
  notify(workspaceId)
}

// ---------------------------------------------------------------------------
// IPC subscription — wire up once at module load time
// ---------------------------------------------------------------------------

let _unsub: (() => void) | null = null
if (typeof window !== 'undefined' && window.api?.terminal?.onSleepStateChanged) {
  _unsub = window.api.terminal.onSleepStateChanged(({ workspaceId, sleeping }) => {
    setSleeping(workspaceId, sleeping)
  })
  window.addEventListener('beforeunload', () => {
    _unsub?.()
    _unsub = null
  })
}

// ---------------------------------------------------------------------------
// React hook — subscribes only to the given workspaceId key
// ---------------------------------------------------------------------------

/**
 * Subscribe to a single workspace's terminal sleep state.
 * Components calling this re-render ONLY when that specific key changes,
 * not when any other workspace's state changes.
 */
export function useTerminalSleeping(workspaceId: string): boolean {
  const subscribeForKey = useCallback((fn: () => void) => subscribe(workspaceId, fn), [workspaceId])
  return useSyncExternalStore(
    subscribeForKey,
    () => store.get(workspaceId) ?? false,
    () => store.get(workspaceId) ?? false
  )
}
