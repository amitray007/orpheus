// ---------------------------------------------------------------------------
// useClaudeUsage — fetches `window.api.claude.usage()` for the "Usage" pulse
// card, stale-while-revalidate (Dashboard D2). On mount, a disk-backed
// cached read (`usageCached()`) and the live network fetch both kick off in
// parallel. Whichever resolves first paints the screen — if a cache row
// exists, the UI paints INSTANTLY with `loading: false` and no skeleton; the
// live fetch then lands and silently overwrites `result` (no flash, no
// layout jump). `loading` is only ever true on a genuine first-ever load: no
// cache row AND the fresh fetch hasn't landed yet.
//
// Deliberately NO polling loop: the main process already TTL-caches (~3min)
// + inflight-dedupes the underlying network call (see src/main/claudeUsage.ts),
// and this is an internal/undocumented Anthropic endpoint the user explicitly
// does not want hammered. A manual `refresh()` re-fires only the live fetch
// (skipping the cached read — the user wants fresh) and never resets
// `result` to null first, so the card never blanks or flashes a skeleton on
// refresh; the main-process cache absorbs any accidental double-click within
// the TTL anyway.
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
    const isRefresh = nonce > 0

    // On manual refresh, skip the cached read (the user explicitly wants
    // fresh data) and never blank the current result — only the live fetch
    // below runs, swapping state in silently when it lands.
    if (!isRefresh) {
      void (async (): Promise<void> => {
        try {
          const cached = await window.api.claude.usageCached()
          if (cancelled || !cached) return
          setState({ loading: false, error: null, result: cached.value })
        } catch {
          // Cached read is best-effort — the live fetch below is authoritative.
        }
      })()
    }

    async function loadFresh(): Promise<void> {
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

    void loadFresh()
    return () => {
      cancelled = true
    }
  }, [nonce])

  return { ...state, refresh }
}
