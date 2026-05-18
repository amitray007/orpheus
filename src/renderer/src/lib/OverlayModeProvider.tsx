import { useCallback, useRef, type ReactNode } from 'react'
import { OverlayModeContext } from './overlayMode'

// Provider for the dynamic z-order coordination context. See ./overlayMode.ts
// for the rationale and consumer hooks (useTerminalOverlay,
// useSetActiveOverlayWorkspace).

export function OverlayModeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const activeRef = useRef<string | null>(null)
  const countRef = useRef(0)

  const setActiveWorkspace = useCallback((workspaceId: string | null): void => {
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

  return (
    <OverlayModeContext.Provider value={{ setActiveWorkspace, acquire, release }}>
      {children}
    </OverlayModeContext.Provider>
  )
}
