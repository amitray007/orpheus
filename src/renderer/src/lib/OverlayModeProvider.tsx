import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import { OverlayModeContext } from './overlayMode'

// Provider for the dynamic z-order coordination context. See ./overlayMode.ts
// for the rationale and consumer hooks (useTerminalOverlay,
// useSetActiveOverlayWorkspace).

export function OverlayModeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const activeRef = useRef<string | null>(null)
  const countRef = useRef(0)

  // When the active workspace changes while overlays are open (e.g., the
  // user navigates between workspaces with a modal pinned at App level),
  // hand off the overlay state: take the previous workspace OUT of
  // overlay mode and put the new one IN, so the modal that was already
  // mounted continues to stack above whichever terminal is now visible.
  const setActiveWorkspace = useCallback((workspaceId: string | null): void => {
    const prevActive = activeRef.current
    if (prevActive === workspaceId) return
    if (countRef.current > 0) {
      if (prevActive) {
        window.api.terminal.setOverlay(prevActive, false).catch((e) => {
          console.error('[overlay] setOverlay(false) on handoff failed:', e)
        })
      }
      if (workspaceId) {
        window.api.terminal.setOverlay(workspaceId, true).catch((e) => {
          console.error('[overlay] setOverlay(true) on handoff failed:', e)
        })
      }
    }
    activeRef.current = workspaceId
  }, [])

  const acquire = useCallback((): void => {
    const prev = countRef.current
    countRef.current = prev + 1
    if (prev === 0 && activeRef.current) {
      window.api.terminal.setOverlay(activeRef.current, true).catch((e) => {
        console.error('[overlay] setOverlay(true) failed:', e)
      })
    }
  }, [])

  const release = useCallback((): void => {
    const prev = countRef.current
    countRef.current = Math.max(0, prev - 1)
    if (prev === 1 && activeRef.current) {
      window.api.terminal.setOverlay(activeRef.current, false).catch((e) => {
        console.error('[overlay] setOverlay(false) failed:', e)
      })
    }
  }, [])

  // Memoize the context value so consumers' [ctx]-dep effects don't
  // tear down + re-run (and accidentally re-fire setOverlay IPC) on
  // every provider render. The three callbacks are themselves stable
  // via useCallback, so the deps below are referentially stable and the
  // memo only re-computes if one of them is replaced — which shouldn't
  // happen during the provider's lifetime.
  const value = useMemo(
    () => ({ setActiveWorkspace, acquire, release }),
    [setActiveWorkspace, acquire, release]
  )

  return <OverlayModeContext.Provider value={value}>{children}</OverlayModeContext.Provider>
}
