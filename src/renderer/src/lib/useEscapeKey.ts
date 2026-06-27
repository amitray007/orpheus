import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Registers a document-level Escape keydown listener that calls `handler` on
 * each Escape keydown.
 *
 * Internally keeps a ref to the latest `handler` so callers do not need to
 * stabilize it with useCallback — the ref is updated via useLayoutEffect before
 * any event can fire against a stale closure.
 */
export function useEscapeKey(handler: () => void): void {
  const handlerRef = useRef<() => void>(handler)
  useLayoutEffect(() => {
    handlerRef.current = handler
  })
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') handlerRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
