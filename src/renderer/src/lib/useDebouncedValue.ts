import { useEffect, useState } from 'react'

/**
 * Returns a debounced copy of `value` that updates `ms` milliseconds after
 * the last change. Does NOT transform the value (no lowercasing, no
 * trimming) — callers that need a transform (e.g. `.trim()`, `.toLowerCase()`)
 * apply it themselves, either before passing the value in or on the debounced
 * result, so each call site keeps its own exact prior behavior.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])

  return debounced
}
