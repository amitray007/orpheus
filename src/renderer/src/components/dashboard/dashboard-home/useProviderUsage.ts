import { useCallback, useEffect, useState } from 'react'
import type { ProviderUsageSnapshot } from '@shared/types'

export interface ProviderUsageData {
  loading: boolean
  snapshot: ProviderUsageSnapshot | null
  refreshing: boolean
  refreshError: string | null
  refresh: () => void
}

const EMPTY: Omit<ProviderUsageData, 'refresh'> = {
  loading: true,
  snapshot: null,
  refreshing: false,
  refreshError: null
}

function hasAvailableUsage(snapshot: ProviderUsageSnapshot): boolean {
  return snapshot.providers.some((provider) => provider.availability === 'available')
}

function mergeLastGoodProviders(
  current: ProviderUsageSnapshot | null,
  next: ProviderUsageSnapshot
): { snapshot: ProviderUsageSnapshot; retainedStaleProvider: boolean } {
  if (!current) return { snapshot: next, retainedStaleProvider: false }
  let retainedStaleProvider = false
  const providers = next.providers.map((provider) => {
    const previous = current.providers.find(
      (candidate) => candidate.providerId === provider.providerId
    )
    if (
      provider.availability === 'unavailable' &&
      provider.unavailableReason === 'error' &&
      previous?.availability === 'available'
    ) {
      retainedStaleProvider = true
      return previous
    }
    return provider
  })
  return {
    snapshot: { ...next, providers },
    retainedStaleProvider
  }
}

export function useProviderUsage(): ProviderUsageData {
  const [state, setState] = useState<Omit<ProviderUsageData, 'refresh'>>(EMPTY)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => {
    setState((current) => ({ ...current, refreshing: true, refreshError: null }))
    setNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    const isRefresh = nonce > 0

    if (!isRefresh) {
      void (async (): Promise<void> => {
        try {
          const cached = await window.api.providerUsage.cached()
          if (cancelled || !cached) return
          setState({
            loading: false,
            snapshot: cached.value,
            refreshing: false,
            refreshError: null
          })
        } catch {
          // Best-effort cache read; the fresh request below is authoritative.
        }
      })()
    }

    void (async (): Promise<void> => {
      try {
        const snapshot = await window.api.providerUsage.get(isRefresh)
        if (cancelled) return
        setState((current) => {
          const merged = mergeLastGoodProviders(current.snapshot, snapshot)
          const keepWholeSnapshot =
            !hasAvailableUsage(merged.snapshot) &&
            current.snapshot !== null &&
            hasAvailableUsage(current.snapshot)
          return {
            loading: false,
            snapshot: keepWholeSnapshot ? current.snapshot : merged.snapshot,
            refreshing: false,
            refreshError:
              keepWholeSnapshot || merged.retainedStaleProvider
                ? 'Provider usage could not be refreshed'
                : null
          }
        })
      } catch (err: unknown) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : 'Failed to load provider usage'
        setState((current) => ({
          ...current,
          loading: false,
          refreshing: false,
          refreshError: message
        }))
      }
    })()

    return () => {
      cancelled = true
    }
  }, [nonce])

  useEffect(() => {
    return window.api.providerUsage.onPushed((snapshot) => {
      if (!hasAvailableUsage(snapshot)) return
      setState((current) => {
        const merged = mergeLastGoodProviders(current.snapshot, snapshot)
        return {
          loading: false,
          snapshot: merged.snapshot,
          refreshing: false,
          refreshError: merged.retainedStaleProvider
            ? 'Some provider usage is temporarily unavailable'
            : null
        }
      })
    })
  }, [])

  return { ...state, refresh }
}
