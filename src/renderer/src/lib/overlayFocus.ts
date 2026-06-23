import { useEffect } from 'react'
import { getActiveWatchdogWorkspace } from './freezeWatchdog'

// Global count of DOM overlays currently drawn over the terminal (popovers,
// hover cards, drawers, modals). ghostty's render loop only runs when the
// surface is visible AND focused; an overlay that opens over the terminal and
// closes leaves it visible-but-unfocused, stalling the render loop. When the
// LAST overlay closes (count 1->0) we re-focus the active terminal once. The
// open-count means overlapping overlays don't fight: focus is restored only
// after every overlay is gone.
let openCount = 0

export function registerOverlayOpen(): () => void {
  openCount += 1
  let released = false
  return () => {
    if (released) return
    released = true
    openCount -= 1
    if (openCount <= 0) {
      openCount = 0
      const ws = getActiveWatchdogWorkspace()
      if (ws) {
        void window.api.terminal.focus(ws).catch(() => {})
      }
    }
  }
}

// Hook: declare an overlay's open state. While `isOpen` is true the overlay is
// counted; when it flips to false (or the component unmounts) it unregisters,
// and the active terminal regains focus once no overlays remain open.
export function useOverlayOpen(isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return
    const unregister = registerOverlayOpen()
    return unregister
  }, [isOpen])
}
