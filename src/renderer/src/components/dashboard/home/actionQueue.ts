import type { HomeActionItem, HomeActionSource, HomeAgent } from './home.types'

/** A queue only exposes action sources backed by the current Home snapshot. */
export type HomeActionFilter = 'all' | HomeActionSource

export interface HomeAgentSummary {
  working: number
  waiting: number
  ready: number
}

const SUPPORTED_ACTION_SOURCES = new Set<HomeActionSource>([
  'agent',
  'completed-run',
  'github-issue'
])

const ACTION_SOURCE_RANK: Record<HomeActionSource, number> = {
  agent: 0,
  'github-check': 1,
  'completed-run': 2,
  'github-review': 3,
  'github-issue': 3
}

/**
 * Orders supported actions by what can be acted on first. IDs make ties
 * deterministic across source refreshes; an input-order fallback only handles
 * duplicate IDs.
 */
export function orderHomeActions(items: readonly HomeActionItem[]): HomeActionItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => SUPPORTED_ACTION_SOURCES.has(item.source))
    .sort((left, right) => {
      const sourceRank =
        ACTION_SOURCE_RANK[left.item.source] - ACTION_SOURCE_RANK[right.item.source]
      if (sourceRank !== 0) return sourceRank

      const observedAtDifference =
        (right.item.observedAt ?? -Infinity) - (left.item.observedAt ?? -Infinity)
      if (observedAtDifference !== 0) return observedAtDifference

      const idOrder = left.item.id.localeCompare(right.item.id)
      return idOrder !== 0 ? idOrder : left.index - right.index
    })
    .map(({ item }) => item)
}

export function actionFilters(items: readonly HomeActionItem[]): HomeActionFilter[] {
  const availableSources = new Set(orderHomeActions(items).map((item) => item.source))
  return [
    'all',
    ...(['agent', 'completed-run', 'github-issue'] as const).filter((source) =>
      availableSources.has(source)
    )
  ]
}

export function summarizeHomeAgents(agents: readonly HomeAgent[]): HomeAgentSummary {
  const summary: HomeAgentSummary = { working: 0, waiting: 0, ready: 0 }
  for (const agent of agents) {
    summary[agent.state] += 1
  }
  return summary
}
