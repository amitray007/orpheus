import { useMemo } from 'react'
import { getHomeLiveAgentRows, refreshHomeSource } from '../home/homeFacade'
import { useHomeSnapshot } from '../home/useHomeSnapshot'
import type { LiveAgentRow } from './liveAgents.helpers'

export interface LiveAgentsData {
  loading: boolean
  error: string | null
  rows: LiveAgentRow[]
  waitingCount: number
  finishedCount: number
}

/** Compatibility selector for the legacy table. The facade owns the one
 * project/workspace/session join; this selector only reads its preserved rows. */
export function useLiveAgents(): LiveAgentsData {
  const source = useHomeSnapshot().agents
  return useMemo(() => {
    const rows = [...getHomeLiveAgentRows()]
    return {
      loading: source.loading,
      error: source.error,
      rows,
      waitingCount: rows.filter((agent) => agent.state === 'attention').length,
      finishedCount: rows.filter((agent) => agent.state === 'ready').length
    }
  }, [source])
}

export function refreshLiveAgents(): void {
  refreshHomeSource('agents')
}
