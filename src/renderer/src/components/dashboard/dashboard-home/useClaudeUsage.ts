// ---------------------------------------------------------------------------
// useClaudeUsage — fetches `window.api.claude.usage()` ONCE on mount for the
// "Usage" pulse card. Deliberately NO polling loop: the main process already
// TTL-caches (~3min) + inflight-dedupes the underlying network call (see
// src/main/claudeUsage.ts), but the renderer side stays a single fetch-on-
// mount by design — this is an internal/undocumented Anthropic endpoint and
// the user explicitly does not want it hammered. If a future revision wants
// auto-refresh, use a LONG interval (3+ min, matching the cache TTL) and
// clear it on unmount; until then, a manual `refresh()` is exposed for a
// future refresh button, gated by the same "don't spam" instinct (the main-
// process cache absorbs any accidental double-click within the TTL anyway).
//
// Shape mirrors useGithubData.ts's single-state-object + nonce-triggered
// re-fetch pattern (initial `loading: true` baked into the state object
// rather than a synchronous setState at the top of the effect, which the
// react-hooks/set-state-in-effect rule flags).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import type { ClaudeUsageResult } from '@shared/types'

export interface ClaudeUsageData {
  loading: boolean
  /** IPC-layer failure only (bridge broken) — distinct from the `unavailable`
   *  states below, which are normal/expected degrade outcomes from main. */
  error: string | null
  result: ClaudeUsageResult | null
  refresh: () => void
}

const EMPTY: Omit<ClaudeUsageData, 'refresh'> = {
  loading: true,
  error: null,
  result: null
}

export function useClaudeUsage(): ClaudeUsageData {
  const [state, setState] = useState<Omit<ClaudeUsageData, 'refresh'>>(EMPTY)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      setState((prev) => ({ ...prev, loading: true }))
      try {
        const res = await window.api.claude.usage()
        if (cancelled) return
        setState({ loading: false, error: null, result: res })
      } catch (err: unknown) {
        if (cancelled) return
        setState({
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load usage',
          result: null
        })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { ...state, refresh }
}
