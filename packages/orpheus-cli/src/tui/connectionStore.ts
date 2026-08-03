/**
 * tui/connectionStore.ts — external store for the Ink build's reconnect/
 * disconnected UI state.
 *
 * WHY A SEPARATE STORE FROM frameStore.ts
 * -----------------------------------------------------------------------
 * frameStore.ts exists specifically to coalesce a HOT path (~20 tree frames/
 * sec at the server's 50ms debounce) into a bounded number of React renders
 * — see its own file header. Connection-state transitions (connecting →
 * connected → reconnecting → connected, or → disconnected) are the opposite:
 * rare, discrete events (at most a handful per picker-loop iteration), so
 * they don't need — and shouldn't share — that coalescing machinery. A
 * plain `useSyncExternalStore`-compatible store (subscribe/getSnapshot, no
 * buffering) is simplest and matches the existing established pattern in
 * this file's sibling.
 *
 * Mirrors tui-otui/App.tsx's `disconnected: () => string | null` signal
 * shape (a null value means "not disconnected/reconnecting"; a non-null
 * string is shown to the user) so the two builds' connection-state UI reads
 * the same conceptually, even though the underlying reactivity primitive
 * (Solid signal vs. this store) differs.
 */

type Listener = () => void

let currentNotice: string | null = null
const listeners = new Set<Listener>()

/**
 * Set the current reconnect/disconnected notice. `null` clears it (back to
 * the normal "connected" or plain "connecting…" states, both already driven
 * by frameStore's frame != null check). A non-null string is shown to the
 * user in place of the ordinary connecting/list UI — see App.tsx.
 */
export function setConnectionNotice(notice: string | null): void {
  if (notice === currentNotice) return
  currentNotice = notice
  for (const listener of listeners) listener()
}

function getSnapshot(): string | null {
  return currentNotice
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The store object handed to `useSyncExternalStore` in App.tsx. */
export const connectionStore = { subscribe, getSnapshot }
