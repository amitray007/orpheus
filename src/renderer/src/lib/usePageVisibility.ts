import { useEffect, useState } from 'react'

export function shouldAnimatePage(
  documentVisible: boolean,
  browserWindowVisible: boolean,
  appKitOcclusionVisible: boolean
): boolean {
  return documentVisible && browserWindowVisible && appKitOcclusionVisible
}

export type BrowserWindowVisibilityState = Readonly<{
  visible: boolean
  pendingSnapshotGeneration: number | null
}>

export type AppKitOcclusionVisibilityState = Readonly<{
  visible: boolean
}>

export const INITIAL_VISIBILITY_SNAPSHOT_GENERATION = 1

export const INITIAL_BROWSER_WINDOW_VISIBILITY: BrowserWindowVisibilityState = {
  visible: false,
  pendingSnapshotGeneration: INITIAL_VISIBILITY_SNAPSHOT_GENERATION
}

export const INITIAL_APPKIT_OCCLUSION_VISIBILITY: AppKitOcclusionVisibilityState = {
  visible: true
}

export function applyBrowserWindowVisibilityPush(
  state: BrowserWindowVisibilityState,
  visible: boolean
): BrowserWindowVisibilityState {
  if (state.pendingSnapshotGeneration === null && state.visible === visible) return state
  return { visible, pendingSnapshotGeneration: null }
}

export function applyInitialBrowserWindowVisibility(
  state: BrowserWindowVisibilityState,
  visible: boolean,
  snapshotGeneration: number
): BrowserWindowVisibilityState {
  if (state.pendingSnapshotGeneration !== snapshotGeneration) return state
  return { visible, pendingSnapshotGeneration: null }
}

export function applyAppKitOcclusionVisibility(
  state: AppKitOcclusionVisibilityState,
  visible: boolean
): AppKitOcclusionVisibilityState {
  return state.visible === visible ? state : { visible }
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
  const [browserWindowVisibility, setBrowserWindowVisibility] = useState(
    INITIAL_BROWSER_WINDOW_VISIBILITY
  )
  const [appKitOcclusionVisibility, setAppKitOcclusionVisibility] = useState(
    INITIAL_APPKIT_OCCLUSION_VISIBILITY
  )

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
      if (active) {
        setBrowserWindowVisibility((state) => applyBrowserWindowVisibilityPush(state, visible))
      }
    })
    const unsubscribeOcclusion = window.api.terminal.onSleepStateChanged(({ sleeping }) => {
      if (active) {
        setAppKitOcclusionVisibility((state) => applyAppKitOcclusionVisibility(state, !sleeping))
      }
    })
    void window.api.window
      .isVisible()
      .then((visible) => {
        if (active) {
          setBrowserWindowVisibility((state) =>
            applyInitialBrowserWindowVisibility(
              state,
              visible,
              INITIAL_VISIBILITY_SNAPSHOT_GENERATION
            )
          )
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

  return shouldAnimatePage(
    documentVisible,
    browserWindowVisibility.visible,
    appKitOcclusionVisibility.visible
  )
}
