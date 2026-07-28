import { useSyncExternalStore } from 'react'

function subscribeToPageVisibility(onVisibilityChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}

  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('focus', onVisibilityChange)
  window.addEventListener('blur', onVisibilityChange)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('focus', onVisibilityChange)
    window.removeEventListener('blur', onVisibilityChange)
  }
}

function getPageVisibility(): boolean {
  if (typeof document === 'undefined') return true
  return document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Tracks whether Chromium is presenting this renderer page in the foreground.
 * Focus is included because the main BrowserWindow intentionally disables
 * background throttling, which can keep Page Visibility at "visible" while the
 * app is backgrounded. Minimized, hidden, and unfocused windows stop animation
 * work without changing the semantic running state represented by the page.
 */
export function usePageVisibility(): boolean {
  return useSyncExternalStore(subscribeToPageVisibility, getPageVisibility, getPageVisibility)
}
