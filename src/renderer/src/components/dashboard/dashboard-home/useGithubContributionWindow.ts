import { useCallback, useEffect, useRef, useState } from 'react'

type GithubContributionWindowResult = Awaited<
  ReturnType<typeof window.api.github.contributionWindow>
>

interface GithubContributionWindowState {
  result: GithubContributionWindowResult | null
  preparing: boolean
  refreshing: boolean
  error: string | null
  refresh: () => void
}

const sessionCache = new Map<number, GithubContributionWindowResult>()

interface SettledRequest {
  weekOffset: number
  result: GithubContributionWindowResult | null
  error: string | null
}

export function useGithubContributionWindow(weekOffset: number): GithubContributionWindowState {
  const [settled, setSettled] = useState<SettledRequest>(() => ({
    weekOffset,
    result: sessionCache.get(weekOffset) ?? null,
    error: null
  }))
  const [refreshingOffset, setRefreshingOffset] = useState<number | null>(null)
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const requestId = ++requestIdRef.current
    if (sessionCache.has(weekOffset)) return

    async function synchronizeWindow(): Promise<void> {
      try {
        const next = await window.api.github.contributionWindow(weekOffset, false)
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        sessionCache.set(weekOffset, next)
        setSettled({ weekOffset, result: next, error: null })
      } catch (cause: unknown) {
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        setSettled({
          weekOffset,
          result: null,
          error:
            cause instanceof Error ? cause.message : 'GitHub contribution activity is unavailable'
        })
      }
    }

    void synchronizeWindow()
  }, [weekOffset])

  const refresh = useCallback(() => {
    const requestId = ++requestIdRef.current
    setRefreshingOffset(weekOffset)

    void (async (): Promise<void> => {
      try {
        const next = await window.api.github.contributionWindow(weekOffset, true)
        if (!mountedRef.current) return
        if (requestId !== requestIdRef.current) {
          setRefreshingOffset((current) => (current === weekOffset ? null : current))
          return
        }
        sessionCache.set(weekOffset, next)
        setSettled({ weekOffset, result: next, error: null })
        setRefreshingOffset(null)
      } catch (cause: unknown) {
        if (!mountedRef.current) return
        if (requestId !== requestIdRef.current) {
          setRefreshingOffset((current) => (current === weekOffset ? null : current))
          return
        }
        setRefreshingOffset(null)
        setSettled({
          weekOffset,
          result: sessionCache.get(weekOffset) ?? null,
          error:
            cause instanceof Error ? cause.message : 'GitHub contribution activity is unavailable'
        })
      }
    })()
  }, [weekOffset])

  const cachedResult = sessionCache.get(weekOffset) ?? null
  const result = cachedResult ?? (settled.weekOffset === weekOffset ? settled.result : null)
  const error = settled.weekOffset === weekOffset ? settled.error : null

  return {
    result,
    preparing: result === null && error === null,
    refreshing: refreshingOffset === weekOffset,
    error,
    refresh
  }
}
