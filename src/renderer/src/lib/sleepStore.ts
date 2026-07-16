/**
 * Per-key external sleep store — tracks whether each workspace's terminal
 * is sleeping (occluded/backgrounded). Eliminates full-tree re-renders by
 * subscribing each leaf to its own workspace key.
 *
 * API:
 *   useTerminalSleeping(workspaceId) — hook: subscribe to ONE key only
 */

import { createPerKeyStore } from './createPerKeyStore'

// Presence-based: a key is only ever stored as `true` (sleeping); "not
// sleeping" is represented by key ABSENCE (store.remove), not a `false`
// value — matches the original Map<string, boolean> that only ever `.set`s
// `true` and `.delete`s on wake. The identity-only default guard is
// sufficient since `true` is the only value ever written.
const store = createPerKeyStore<boolean>()

// ---------------------------------------------------------------------------
// IPC subscription — wire up once at module load time
// ---------------------------------------------------------------------------

if (typeof window !== 'undefined' && window.api?.terminal?.onSleepStateChanged) {
  window.api.terminal.onSleepStateChanged(({ workspaceId, sleeping }) => {
    if (sleeping) {
      store.set(workspaceId, true)
    } else {
      // remove() no-ops (and skips notify) if the key was already absent —
      // the original hand-rolled store instead always called delete+notify
      // here, but useSyncExternalStore bails on a re-render when the
      // snapshotted value (store.get(key)) is unchanged, so that extra
      // notify was never observable. Behaviorally equivalent.
      store.remove(workspaceId)
    }
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
  return store.useKey(workspaceId) ?? false
}
