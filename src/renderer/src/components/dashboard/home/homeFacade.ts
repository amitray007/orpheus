import type {
  ClaudeActivitySummary,
  ClaudeUsage,
  ClaudeUsageResult,
  ProjectRecord,
  SessionRecord,
  WorkspaceRecord
} from '@shared/types'
import { getActivitySnapshot } from '@/lib/activityStore'
import { getActivityTimeSnapshot } from '@/lib/activityTimeStore'
import {
  buildLiveAgentRows,
  formatSinceLabel,
  type LiveAgentRow
} from '../dashboard-home/liveAgents.helpers'
import type {
  HomeActionItem,
  HomeAgent,
  HomeCounts,
  HomeSnapshot,
  LimitBucket,
  HomeSourceState,
  HomeStatsSnapshot,
  ProviderDescriptor,
  ProviderLimitSnapshot
} from './home.types'

const CLAUDE_PROVIDER = {
  id: 'claude',
  label: 'Claude',
  kind: 'claude'
} satisfies ProviderDescriptor

type HomeSourceName = 'agents' | 'actions' | 'github' | 'limits' | 'activity' | 'stats'
type HomeSourceData = Omit<HomeSnapshot, 'counts'>
type SourcePayload<K extends HomeSourceName> = HomeSourceData[K]['data']

const listeners = new Set<() => void>()
const generations: Record<HomeSourceName, number> = {
  agents: 0,
  actions: 0,
  github: 0,
  limits: 0,
  activity: 0,
  stats: 0
}

let started = false
let pushUnsubscribes: Array<() => void> = []
let privacyMode = false
let liveAgentRows: LiveAgentRow[] = []
let latestUsage: ClaudeUsageResult | null = null
let latestActivitySummary: ClaudeActivitySummary | null = null
const modelLabelCache = new Map<string, string>()
let modelLabelsInFlight: Promise<void> | null = null
let pendingModelIds = new Set<string>()
let modelLabelsGeneration = 0
const inFlight: Partial<Record<HomeSourceName, Promise<void>>> = {}
let agentInputs: {
  projects: ProjectRecord[]
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
} | null = null

function initialSource<T>(data: T): HomeSourceState<T> {
  return {
    data,
    loading: true,
    refreshing: false,
    error: null,
    unavailable: false,
    stale: false
  }
}

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
  return withCounts({
    agents: initialSource([]),
    actions: initialSource([]),
    github: initialSource({ prs: [], issues: [] }),
    limits: initialSource([]),
    activity: initialSource([]),
    stats: initialSource([])
  })
}

let snapshot = createEmptyHomeSnapshot()

function withCounts(sources: HomeSourceData): HomeSnapshot {
  const counts: HomeCounts = {
    needsYou: sources.actions.data.length,
    liveAgents: sources.agents.data.filter(
      (agent) => agent.state === 'working' || agent.state === 'waiting' || agent.state === 'ready'
    ).length,
    github: sources.github.data.prs.length + sources.github.data.issues.length
  }
  return { ...sources, counts }
}

function publish(nextSources: HomeSourceData): void {
  snapshot = withCounts(nextSources)
  for (const listener of listeners) listener()
}

function replaceSource<K extends HomeSourceName>(
  source: K,
  next: HomeSourceState<SourcePayload<K>>
): void {
  publish({ ...snapshot, [source]: next } as HomeSourceData)
}

function startSource(source: HomeSourceName): number {
  const generation = ++generations[source]
  const current = snapshot[source]
  replaceSource(source, {
    ...current,
    loading: current.fetchedAt === undefined,
    refreshing: current.fetchedAt !== undefined,
    error: null,
    stale: current.fetchedAt !== undefined
  })
  return generation
}

function canAcceptCached(source: HomeSourceName, generation: number, fetchedAt: number): boolean {
  if (generations[source] !== generation) return false
  const current = snapshot[source]
  return (
    (current.loading || current.refreshing) &&
    (current.fetchedAt === undefined || fetchedAt > current.fetchedAt)
  )
}

function acceptCached<K extends HomeSourceName>(
  source: K,
  generation: number,
  data: SourcePayload<K>,
  fetchedAt: number
): boolean {
  if (!canAcceptCached(source, generation, fetchedAt)) return false
  replaceSource(source, {
    data,
    loading: false,
    refreshing: true,
    error: null,
    unavailable: false,
    fetchedAt,
    stale: true
  })
  return true
}

function acceptFresh<K extends HomeSourceName>(
  source: K,
  generation: number,
  data: SourcePayload<K>
): boolean {
  if (generations[source] !== generation) return false
  replaceSource(source, {
    data,
    loading: false,
    refreshing: false,
    error: null,
    unavailable: false,
    fetchedAt: Date.now(),
    stale: false
  })
  return true
}

function rejectFresh(source: HomeSourceName, generation: number, error: unknown): void {
  if (generations[source] !== generation) return
  const current = snapshot[source]
  replaceSource(source, {
    ...current,
    loading: false,
    refreshing: false,
    error: error instanceof Error ? error.message : `Failed to load ${source}`,
    stale: current.fetchedAt !== undefined
  })
}

export function normalizeHomeAgents(rows: LiveAgentRow[], nowMs: number): HomeAgent[] {
  return rows.map((row) => ({
    id: row.workspaceId,
    provider: CLAUDE_PROVIDER,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    task: row.taskTitle,
    state: row.state === 'attention' ? 'waiting' : row.state,
    observedAt: row.sinceMs,
    elapsedLabel: formatSinceLabel(row.sinceMs, nowMs)
  }))
}

export function normalizeHomeActions(agents: HomeAgent[]): HomeActionItem[] {
  return agents.flatMap((agent) => {
    if (!agent.workspaceId || !agent.projectId || agent.state === 'working') return []
    return [
      {
        id: `${agent.state}:${agent.id}`,
        source: agent.state === 'waiting' ? 'agent' : 'completed-run',
        priority: agent.state === 'waiting' ? 'high' : 'normal',
        title: agent.task,
        detail:
          agent.state === 'waiting'
            ? 'Claude is waiting for your input.'
            : 'Claude finished this run.',
        observedAt: agent.observedAt,
        target: { kind: 'workspace', workspaceId: agent.workspaceId, projectId: agent.projectId }
      }
    ]
  })
}

export function normalizeUsage(
  result: ClaudeUsageResult,
  fetchedAt: number,
  stale: boolean
): ProviderLimitSnapshot[] {
  if ('unavailable' in result) return []
  const toBucket = (id: string, label: string, usage: ClaudeUsage['fiveHour']): LimitBucket => ({
    id,
    label,
    scopes: id === 'weekly' ? ['weekly'] : [],
    used: usage.utilization ?? undefined,
    total: usage.utilization === null ? undefined : 100,
    resetsAt: usage.resetsAt ? new Date(usage.resetsAt).getTime() : undefined
  })
  return [
    {
      provider: CLAUDE_PROVIDER,
      fetchedAt,
      stale,
      availability: 'available',
      buckets: [
        toBucket('session', 'Session', result.fiveHour),
        toBucket('weekly', 'Weekly', result.sevenDay),
        ...result.limits
          .filter((limit) => limit.modelName !== null)
          .map(
            (limit): LimitBucket => ({
              id: `${limit.kind}:${limit.group}:${limit.modelName}`,
              label: limit.modelName ?? limit.kind,
              scopes: [],
              used: limit.percent,
              total: 100,
              resetsAt: limit.resetsAt ? new Date(limit.resetsAt).getTime() : undefined,
              modelFamily: limit.modelName ?? undefined
            })
          )
      ]
    }
  ]
}

export function normalizeActivity(
  summary: ClaudeActivitySummary,
  fetchedAt: number,
  stale: boolean
): HomeSnapshot['activity']['data'] {
  return [
    {
      provider: CLAUDE_PROVIDER,
      supportedRanges: ['weekly'],
      summaries: summary.weeklyActivity,
      freshness: { fetchedAt, stale }
    }
  ]
}

export function normalizeStats(summary: ClaudeActivitySummary): HomeStatsSnapshot[] {
  return [
    {
      provider: CLAUDE_PROVIDER,
      window: 'weekly',
      sessions: summary.sessionsLast7Days,
      tokens: summary.tokensLast7Days,
      activeDays: summary.activeDays,
      streak: summary.currentStreak,
      peakHour: summary.peakHour ?? undefined
    },
    {
      provider: CLAUDE_PROVIDER,
      window: 'all',
      sessions: summary.allTimeSessions,
      tokens: summary.allTimeTokens
    }
  ]
}

function getModelLabel(modelId: string | null): string {
  if (!modelId) return '—'
  return modelLabelCache.get(modelId) ?? '—'
}

function resolvePendingModelLabels(): void {
  if (modelLabelsInFlight || pendingModelIds.size === 0) return
  const generation = modelLabelsGeneration
  const request = (async (): Promise<void> => {
    while (started && generation === modelLabelsGeneration && pendingModelIds.size > 0) {
      const modelIds = Array.from(pendingModelIds)
      pendingModelIds = new Set()
      try {
        const labels = await window.api.models.resolveLabels(modelIds)
        if (!started || generation !== modelLabelsGeneration) return
        for (const [modelId, label] of Object.entries(labels)) {
          modelLabelCache.set(modelId, label)
        }
        publishAgentsFromInputs()
      } catch {
        // Leave labels unresolved so a later agent projection can retry.
      }
    }
  })()
  modelLabelsInFlight = request
  void request.finally(() => {
    if (modelLabelsInFlight !== request) return
    modelLabelsInFlight = null
    if (started && pendingModelIds.size > 0) resolvePendingModelLabels()
  })
}

function queueModelLabelResolution(rows: readonly LiveAgentRow[]): void {
  for (const row of rows) {
    if (row.model && !modelLabelCache.has(row.model)) pendingModelIds.add(row.model)
  }
  resolvePendingModelLabels()
}

function publishAgentsFromInputs(): void {
  if (!agentInputs) return
  const visibleProjects = agentInputs.projects.filter(
    (project) => !project.hidden && !(privacyMode && project.classified)
  )
  const visibleProjectIds = new Set(visibleProjects.map((project) => project.id))
  const projectNameById = new Map(visibleProjects.map((project) => [project.id, project.name]))
  const sessionById = new Map(agentInputs.sessions.map((session) => [session.id, session]))
  liveAgentRows = buildLiveAgentRows(
    agentInputs.workspaces.filter((workspace) => visibleProjectIds.has(workspace.projectId)),
    projectNameById,
    sessionById,
    getActivitySnapshot(),
    getActivityTimeSnapshot(),
    getModelLabel
  )
  const agents = normalizeHomeAgents(liveAgentRows, Date.now())
  const current = snapshot.agents
  const fetchedAt = current.fetchedAt ?? Date.now()
  publish({
    ...snapshot,
    agents: {
      ...current,
      data: agents,
      loading: false,
      refreshing: false,
      error: null,
      fetchedAt,
      stale: false
    },
    actions: {
      ...snapshot.actions,
      data: normalizeHomeActions(agents),
      loading: false,
      refreshing: false,
      error: null,
      fetchedAt,
      stale: false
    }
  })
  queueModelLabelResolution(liveAgentRows)
}

function refreshAgentsAfterActivityPush(updates: Array<{ workspaceId: string }>): void {
  if (!agentInputs) return
  const workspaceIds = new Set(agentInputs.workspaces.map((workspace) => workspace.id))
  if (!updates.some((update) => workspaceIds.has(update.workspaceId))) return
  // Dashboard updates activityStore from the same main-process push. Queue after
  // its subscriber so this facade reads the completed batch, not an intermediate map.
  queueMicrotask(() => {
    if (started) publishAgentsFromInputs()
  })
}

async function loadAgentsOnce(): Promise<void> {
  const agentsGeneration = startSource('agents')
  const actionsGeneration = startSource('actions')
  try {
    const [projects, uiState] = await Promise.all([
      window.api.projects.list(),
      window.api.uiState.get()
    ])
    const workspaceLists = await Promise.all(
      projects.map((project) => window.api.workspaces.listForProject(project.id, { scope: 'all' }))
    )
    const sessions = await window.api.sessions.listAll()
    if (generations.agents !== agentsGeneration || generations.actions !== actionsGeneration) return
    privacyMode = uiState.privacyMode
    agentInputs = { projects, workspaces: workspaceLists.flat(), sessions }
    publishAgentsFromInputs()
  } catch (error: unknown) {
    rejectFresh('agents', agentsGeneration, error)
    rejectFresh('actions', actionsGeneration, error)
  }
}

function loadAgents(): Promise<void> {
  if (inFlight.agents) return inFlight.agents
  const request = loadAgentsOnce()
  inFlight.agents = request
  inFlight.actions = request
  void request.finally(() => {
    if (inFlight.agents === request) delete inFlight.agents
    if (inFlight.actions === request) delete inFlight.actions
  })
  return request
}

async function loadGithubOnce(): Promise<void> {
  const generation = startSource('github')
  void Promise.all([window.api.github.myOpenPrsCached(), window.api.github.myIssuesCached()])
    .then(([prs, issues]) => {
      if (prs && issues)
        acceptCached(
          'github',
          generation,
          { prs: prs.value, issues: issues.value },
          Math.min(prs.fetchedAt, issues.fetchedAt)
        )
    })
    .catch(() => undefined)
  try {
    const [prs, issues] = await Promise.all([
      window.api.github.myOpenPrs(),
      window.api.github.myIssues()
    ])
    acceptFresh('github', generation, { prs, issues })
  } catch (error: unknown) {
    rejectFresh('github', generation, error)
  }
}

function loadGithub(): Promise<void> {
  if (inFlight.github) return inFlight.github
  const request = loadGithubOnce()
  inFlight.github = request
  void request.finally(() => {
    if (inFlight.github === request) delete inFlight.github
  })
  return request
}

function setUsageUnavailable(generation: number, fetchedAt?: number): boolean {
  if (
    generations.limits !== generation ||
    (fetchedAt !== undefined && !canAcceptCached('limits', generation, fetchedAt))
  ) {
    return false
  }
  const current = snapshot.limits
  replaceSource('limits', {
    ...current,
    loading: false,
    refreshing: false,
    unavailable: true,
    error: null,
    stale: current.fetchedAt !== undefined
  })
  return true
}

async function loadLimitsOnce(): Promise<void> {
  const generation = startSource('limits')
  void window.api.claude
    .usageCached()
    .then((cached) => {
      if (!cached) return
      const usage = cached.value as ClaudeUsageResult
      if ('unavailable' in usage) {
        if (setUsageUnavailable(generation, cached.fetchedAt)) latestUsage = usage
        return
      }
      if (
        acceptCached(
          'limits',
          generation,
          normalizeUsage(usage, cached.fetchedAt, true),
          cached.fetchedAt
        )
      ) {
        latestUsage = usage
      }
    })
    .catch(() => undefined)
  try {
    const usage = await window.api.claude.usage()
    if ('unavailable' in usage) {
      if (setUsageUnavailable(generation)) latestUsage = usage
    } else if (acceptFresh('limits', generation, normalizeUsage(usage, Date.now(), false))) {
      latestUsage = usage
    }
  } catch (error: unknown) {
    rejectFresh('limits', generation, error)
  }
}

function loadLimits(): Promise<void> {
  if (inFlight.limits) return inFlight.limits
  const request = loadLimitsOnce()
  inFlight.limits = request
  void request.finally(() => {
    if (inFlight.limits === request) delete inFlight.limits
  })
  return request
}

function acceptActivity(summary: ClaudeActivitySummary, generation?: number): boolean {
  if (generation !== undefined && generations.activity !== generation) return false
  const fetchedAt = Date.now()
  const activity = normalizeActivity(summary, fetchedAt, false)
  const stats = normalizeStats(summary)
  publish({
    ...snapshot,
    activity: {
      data: activity,
      loading: false,
      refreshing: false,
      error: null,
      unavailable: false,
      fetchedAt,
      stale: false
    },
    stats: {
      data: stats,
      loading: false,
      refreshing: false,
      error: null,
      unavailable: false,
      fetchedAt,
      stale: false
    }
  })
  latestActivitySummary = summary
  return true
}

async function loadActivityOnce(): Promise<void> {
  const activityGeneration = startSource('activity')
  const statsGeneration = startSource('stats')
  void window.api.claude
    .activityCached()
    .then((cached) => {
      if (!cached || generations.stats !== statsGeneration) return
      if (
        acceptCached(
          'activity',
          activityGeneration,
          normalizeActivity(cached.value, cached.fetchedAt, true),
          cached.fetchedAt
        )
      ) {
        latestActivitySummary = cached.value
      }
      acceptCached('stats', statsGeneration, normalizeStats(cached.value), cached.fetchedAt)
    })
    .catch(() => undefined)
  try {
    const activity = await window.api.claude.activity()
    if (generations.stats !== statsGeneration) return
    acceptActivity(activity, activityGeneration)
  } catch (error: unknown) {
    rejectFresh('activity', activityGeneration, error)
    rejectFresh('stats', statsGeneration, error)
  }
}

function loadActivity(): Promise<void> {
  if (inFlight.activity) return inFlight.activity
  const request = loadActivityOnce()
  inFlight.activity = request
  inFlight.stats = request
  void request.finally(() => {
    if (inFlight.activity === request) delete inFlight.activity
    if (inFlight.stats === request) delete inFlight.stats
  })
  return request
}

function start(): void {
  if (started) return
  started = true
  void loadAgents()
  void loadGithub()
  void loadLimits()
  void loadActivity()
  pushUnsubscribes = [
    window.api.workspaces.onActivityBatch(refreshAgentsAfterActivityPush),
    window.api.workspaces.onCreated(() => {
      void loadAgents()
    }),
    window.api.workspaces.onChanged(() => {
      void loadAgents()
    }),
    window.api.workspaces.onArchived(() => {
      void loadAgents()
    }),
    window.api.projects.onChanged((project) => {
      if (!agentInputs) return
      agentInputs = {
        ...agentInputs,
        projects: agentInputs.projects.map((current) =>
          current.id === project.id ? project : current
        )
      }
      publishAgentsFromInputs()
    }),
    window.api.uiState.onChanged((state) => {
      if (privacyMode === state.privacyMode) return
      privacyMode = state.privacyMode
      publishAgentsFromInputs()
    }),
    window.api.claude.onUsagePushed((usage) => {
      const generation = ++generations.limits
      if ('unavailable' in usage) {
        if (setUsageUnavailable(generation)) latestUsage = usage
        return
      }
      if (acceptFresh('limits', generation, normalizeUsage(usage, Date.now(), false))) {
        latestUsage = usage
      }
    }),
    window.api.claude.onActivityPushed((activity) => {
      generations.activity++
      generations.stats++
      acceptActivity(activity)
    })
  ]
}

function stop(): void {
  if (listeners.size > 0 || !started) return
  started = false
  for (const unsubscribe of pushUnsubscribes) unsubscribe()
  pushUnsubscribes = []
  modelLabelsGeneration++
  pendingModelIds = new Set()
  for (const source of Object.keys(generations) as HomeSourceName[]) {
    generations[source]++
    delete inFlight[source]
  }
}

export function getHomeSnapshot(): HomeSnapshot {
  return snapshot
}

/** Legacy dashboard selectors read the same facade-owned source results. */
export function getHomeLiveAgentRows(): readonly LiveAgentRow[] {
  return liveAgentRows
}

export function getHomeUsageResult(): ClaudeUsageResult | null {
  return latestUsage
}

/** Legacy dashboard selector for fields intentionally absent from HomeSnapshot. */
export function getHomeActivitySummary(): ClaudeActivitySummary | null {
  return latestActivitySummary
}

export function subscribeHome(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    stop()
  }
}

export function refreshHomeSource(source: HomeSourceName): void {
  start()
  if (source === 'agents' || source === 'actions') void loadAgents()
  else if (source === 'github') void loadGithub()
  else if (source === 'limits') void loadLimits()
  else void loadActivity()
}
