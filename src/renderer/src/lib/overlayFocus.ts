import { useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { getActiveWatchdogWorkspace } from './freezeWatchdog'

// Single coordinator for DOM overlays drawn over the terminal. On 0->1 (first
// overlay opens) it lowers the active surface below the web layer AND hands focus
// to the web view via the native setOverlay(ws, true). On 1->0 (last closes) it
// restores the surface on top + reclaims focus via setOverlay(ws, false). Z-order
// and focus move together so they can never disagree (that disagreement is the
// freeze). Targets the CURRENT active workspace on each edge, not a snapshot.
let openCount = 0
const listeners = new Set<() => void>()

window.addEventListener('beforeunload', () => {
  openCount = 0
  emit()
})

function emit(): void {
  for (const l of listeners) l()
}

export function registerOverlayOpen(): () => void {
  openCount += 1
  if (openCount === 1) {
    const ws = getActiveWatchdogWorkspace()
    if (ws) void window.api.terminal.setOverlay(ws, true).catch(() => {})
    emit()
  }
  let released = false
  return () => {
    if (released) return
    released = true
    openCount -= 1
    if (openCount <= 0) {
      openCount = 0
      const ws = getActiveWatchdogWorkspace()
      if (ws) void window.api.terminal.setOverlay(ws, false).catch(() => {})
      emit()
    }
  }
}

// Hook: declare an overlay's open state. While `isOpen` is true the overlay is
// counted; on unmount or false it unregisters. The coordinator drives the native
// z-swap + focus handoff on the 0->1 / 1->0 edges.
export function useOverlayOpen(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return
    const unregister = registerOverlayOpen()
    return unregister
  }, [isOpen])
}

// Hook: subscribe to whether ANY overlay is currently open. Used by WorkspaceView /
// Dashboard to toggle the terminal container's transparency in lockstep with the
// native z-swap.
export function useOverlayOpenState(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => openCount > 0,
    () => false
  )
}
