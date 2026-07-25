import type { ClaudeUsageResult } from '@shared/types'
import { getHomeUsageResult, refreshHomeSource } from '../home/homeFacade'
import { useHomeSnapshot } from '../home/useHomeSnapshot'

export interface ClaudeUsageData {
  loading: boolean
  error: string | null
  result: ClaudeUsageResult | null
  refresh: () => void
}

/** Compatibility selector for the legacy Usage card. It preserves the
 * authoritative result retained by the shared facade rather than rebuilding
 * fields the frozen Home snapshot deliberately does not expose. */
export function useClaudeUsage(): ClaudeUsageData {
  const source = useHomeSnapshot().limits
  return {
    loading: source.loading,
    error: source.error,
    result: getHomeUsageResult(),
    refresh: () => refreshHomeSource('limits')
  }
}
