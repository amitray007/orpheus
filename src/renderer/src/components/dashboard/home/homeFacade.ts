import type { HomeCounts, HomeSnapshot, HomeSourceState } from './home.types'

export function createEmptyHomeSource<T>(data: T): HomeSourceState<T> {
  return {
    data,
    loading: false,
    refreshing: false,
    error: null,
    unavailable: false,
    stale: false
  }
}

export function createEmptyHomeSnapshot(): HomeSnapshot {
  const counts: HomeCounts = {
    needsYou: 0,
    liveAgents: 0,
    github: 0
  }

  return {
    agents: createEmptyHomeSource([]),
    actions: createEmptyHomeSource([]),
    github: createEmptyHomeSource({ prs: [], issues: [] }),
    limits: createEmptyHomeSource([]),
    activity: createEmptyHomeSource([]),
    stats: createEmptyHomeSource([]),
    counts
  }
}
