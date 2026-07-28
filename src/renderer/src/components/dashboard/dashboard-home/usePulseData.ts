import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ClaudeActivityWindowResult,
  ClaudeModelActivityDay,
  ClaudeRecentSession,
  WeeklyActivityDay
} from '@shared/types'

interface RequestState {
  key: string
  result: ClaudeActivityWindowResult | null
  error: string | null
  refreshError: string | null
  refreshing: boolean
}

export interface PulseData {
  result: ClaudeActivityWindowResult | null
  preparing: boolean
  refreshing: boolean
  error: string | null
  refreshError: string | null
  weeklyActivity: WeeklyActivityDay[]
  sessions: number
  messages: number
  tokens: number
  peakHour: number | null
  activeDays: number
  longestStreak: number
  recentSessions: ClaudeRecentSession[]
  modelActivity: ClaudeModelActivityDay[]
  refresh: () => void
}

const visitedWindows = new Map<string, ClaudeActivityWindowResult>()

function localDateKey(value: Date): string {
  return [
    String(value.getFullYear()).padStart(4, '0'),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0')
  ].join('-')
}

function selectionKey(weekOffset: number, now = new Date()): string {
  const monday = new Date(now)
  const daysSinceMonday = (monday.getDay() + 6) % 7
  monday.setDate(monday.getDate() - daysSinceMonday + weekOffset * 7)
  monday.setHours(0, 0, 0, 0)
  return `${weekOffset}:${localDateKey(monday)}`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Failed to load Claude activity'
}

export function usePulseData(weekOffset: number): PulseData {
  const key = selectionKey(weekOffset)
  const [requestState, setRequestState] = useState<RequestState>(() => ({
    key,
    result: visitedWindows.get(key) ?? null,
    error: null,
    refreshError: null,
    refreshing: false
  }))
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)

  const cached = visitedWindows.get(key) ?? null
  const result = requestState.key === key ? (requestState.result ?? cached) : cached
  const error = requestState.key === key ? requestState.error : null
  const refreshError = requestState.key === key ? requestState.refreshError : null
  const refreshing = requestState.key === key && requestState.refreshing
  const preparing = result === null && error === null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const requestId = ++requestIdRef.current
    const retained = visitedWindows.get(key) ?? null

    void (async (): Promise<void> => {
      try {
        const next = await window.api.claude.activityWindow(weekOffset, false)
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        visitedWindows.set(key, next)
        setRequestState({
          key,
          result: next,
          error: null,
          refreshError: null,
          refreshing: false
        })
      } catch (cause: unknown) {
        if (!mountedRef.current || requestId !== requestIdRef.current) return
        const message = errorMessage(cause)
        setRequestState({
          key,
          result: retained,
          error: retained ? null : message,
          refreshError: retained ? message : null,
          refreshing: false
        })
      }
    })()
  }, [key, weekOffset])

  const refresh = useCallback(() => {
    const requestId = ++requestIdRef.current
    const activeKey = key
    const activeOffset = weekOffset
    const retained = result
    setRequestState({
      key: activeKey,
      result: retained,
      error: null,
      refreshError: null,
      refreshing: true
    })

    void (async (): Promise<void> => {
      try {
        const next = await window.api.claude.activityWindow(activeOffset, true)
        if (
          !mountedRef.current ||
          requestId !== requestIdRef.current ||
          activeKey !== selectionKey(activeOffset)
        ) {
          return
        }
        visitedWindows.set(activeKey, next)
        setRequestState({
          key: activeKey,
          result: next,
          error: null,
          refreshError: null,
          refreshing: false
        })
      } catch (cause: unknown) {
        if (
          !mountedRef.current ||
          requestId !== requestIdRef.current ||
          activeKey !== selectionKey(activeOffset)
        ) {
          return
        }
        const message = errorMessage(cause)
        setRequestState({
          key: activeKey,
          result: retained,
          error: retained ? null : message,
          refreshError: retained ? message : null,
          refreshing: false
        })
      }
    })()
  }, [key, result, weekOffset])

  useEffect(() => {
    return window.api.claude.onActivityPushed(() => {
      if (weekOffset !== 0) return
      const requestId = ++requestIdRef.current
      const activeKey = key
      const retained = result
      void (async (): Promise<void> => {
        try {
          const next = await window.api.claude.activityWindow(0, true)
          if (
            !mountedRef.current ||
            requestId !== requestIdRef.current ||
            activeKey !== selectionKey(0)
          ) {
            return
          }
          visitedWindows.set(activeKey, next)
          setRequestState({
            key: activeKey,
            result: next,
            error: null,
            refreshError: null,
            refreshing: false
          })
        } catch (cause: unknown) {
          if (
            !mountedRef.current ||
            requestId !== requestIdRef.current ||
            activeKey !== selectionKey(0)
          ) {
            return
          }
          const message = errorMessage(cause)
          setRequestState({
            key: activeKey,
            result: retained,
            error: retained ? null : message,
            refreshError: retained ? message : null,
            refreshing: false
          })
        }
      })()
    })
  }, [key, result, weekOffset])

  return {
    result,
    preparing,
    refreshing,
    error,
    refreshError,
    weeklyActivity: result?.weeklyActivity ?? [],
    sessions: result?.sessions ?? 0,
    messages: result?.messages ?? 0,
    tokens: result?.tokens ?? 0,
    peakHour: result?.peakHour ?? null,
    activeDays: result?.activeDays ?? 0,
    longestStreak: result?.longestStreak ?? 0,
    recentSessions: result?.recentSessions ?? [],
    modelActivity: result?.modelActivity ?? [],
    refresh
  }
}
