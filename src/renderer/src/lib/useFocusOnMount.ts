import { useEffect } from 'react'
import type { RefObject } from 'react'

/** Focuses the attached element once on mount. Explicit, StrictMode-safe
 *  replacement for the autoFocus attribute; works on any focusable element. */
export function useFocusOnMount(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    ref.current?.focus()
  }, [ref])
}
