import { useEffect, useState } from 'react'

export function shouldAnimatePage(documentVisible: boolean, nativeWindowVisible: boolean): boolean {
  return documentVisible && nativeWindowVisible
}

export type WindowVisibilityState = Readonly<{
  visible: boolean
  pushVersion: number
}>

export const INITIAL_WINDOW_VISIBILITY: WindowVisibilityState = {
  visible: false,
  pushVersion: 0
}

export function applyWindowVisibilityPush(
  state: WindowVisibilityState,
  visible: boolean
): WindowVisibilityState {
  return { visible, pushVersion: state.pushVersion + 1 }
}

export function applyInitialWindowVisibility(
  state: WindowVisibilityState,
  visible: boolean
): WindowVisibilityState {
  return state.pushVersion === 0 ? { visible, pushVersion: 0 } : state
}

/**
 * Tracks whether Chromium is actually presenting this renderer page.
 * BrowserWindow show/hide state provides the initial snapshot and lifecycle
 * events. Native terminal sleep state adds AppKit occlusion and remains correct
 * when Ghostty's NSView is first responder. Page Visibility is a final guard.
 */
export function usePageVisibility(): boolean {
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible'
  )
  const [windowVisibility, setWindowVisibility] = useState(INITIAL_WINDOW_VISIBILITY)

  useEffect(() => {
    const onVisibilityChange = (): void => {
      setDocumentVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])

  useEffect(() => {
    let active = true
    const unsubscribeWindow = window.api.window.onVisibilityChanged(({ visible }) => {
      if (active) setWindowVisibility((state) => applyWindowVisibilityPush(state, visible))
    })
    const unsubscribeOcclusion = window.api.terminal.onSleepStateChanged(({ sleeping }) => {
      if (active) setWindowVisibility((state) => applyWindowVisibilityPush(state, !sleeping))
    })
    void window.api.window
      .isVisible()
      .then((visible) => {
        if (active) {
          setWindowVisibility((state) => applyInitialWindowVisibility(state, visible))
        }
      })
      .catch(() => {
        // Fail closed: the static running indicator remains visible, but no
        // animation starts without an authoritative presentation snapshot.
      })

    return () => {
      active = false
      unsubscribeWindow()
      unsubscribeOcclusion()
    }
  }, [])

  return shouldAnimatePage(documentVisible, windowVisibility.visible)
}
