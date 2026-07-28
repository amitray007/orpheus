import { useEffect, useState } from 'react'

export function shouldAnimatePage(documentVisible: boolean, nativeWindowVisible: boolean): boolean {
  return documentVisible && nativeWindowVisible
}

/**
 * Tracks whether Chromium is actually presenting this renderer page.
 * Native terminal sleep state comes from the host NSWindow's AppKit occlusion
 * state, so it remains correct when Ghostty's NSView is first responder.
 * Page Visibility remains a separate hide/minimize guard.
 */
export function usePageVisibility(): boolean {
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible'
  )
  const [nativeWindowVisible, setNativeWindowVisible] = useState(true)

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
    const unsubscribe = window.api.terminal.onSleepStateChanged(({ sleeping }) => {
      setNativeWindowVisible(!sleeping)
    })
    return () => {
      unsubscribe()
    }
  }, [])

  return shouldAnimatePage(documentVisible, nativeWindowVisible)
}
