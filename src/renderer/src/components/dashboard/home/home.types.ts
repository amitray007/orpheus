import type React from 'react'
import type { SectionId as SettingsSectionId } from '../SettingsView'
import type { ClaudeActivitySummary, GhSearchIssue, GhSearchPr, HomePageId } from '@shared/types'

export type { HomePageId } from '@shared/types'

export type SurfaceId = 'home' | 'projects' | 'panes' | 'settings'
export type PersistedSurfaceId = Exclude<SurfaceId, 'settings'> | 'dashboard'

export type AppView =
  | { kind: 'home'; page: HomePageId }
  | { kind: 'project'; projectId: string }
  | { kind: 'sessions' }
  | { kind: 'workspace'; workspaceId: string; projectId: string }
  | { kind: 'settings'; section?: SettingsSectionId }
  | { kind: 'panes' }

export interface ProviderDescriptor {
  id: string
  label: string
  kind: 'claude' | 'other'
}

export type HomeAgentState = 'working' | 'waiting' | 'ready'

export interface HomeAgent {
  id: string
  provider: ProviderDescriptor
  workspaceId?: string
  projectId?: string
  projectLabel: string
  workspaceLabel: string
  task: string
  state: HomeAgentState
  observedAt: number
  elapsedLabel: string
}

export type HomeActionSource =
  | 'agent'
  | 'github-check'
  | 'completed-run'
  | 'github-review'
  | 'github-issue'

export type HomeActionPriority = 'urgent' | 'high' | 'normal'

export type HomeActionTarget =
  | { kind: 'workspace'; workspaceId: string; projectId: string }
  | { kind: 'external-url'; url: string }
  | { kind: 'home-page'; page: HomePageId }

export interface HomeActionItem {
  id: string
  source: HomeActionSource
  priority: HomeActionPriority
  title: string
  detail?: string
  observedAt?: number
  target?: HomeActionTarget
}

export type LimitScope = 'current' | 'daily' | 'weekly' | 'all'

export interface LimitBucket {
  id: string
  label: string
  scopes: LimitScope[]
  remaining?: number
  used?: number
  total?: number
  resetsAt?: number
  modelFamily?: string
}

export interface ProviderLimitSnapshot {
  provider: ProviderDescriptor
  fetchedAt?: number
  stale: boolean
  availability: 'available' | 'unavailable' | 'error'
  buckets: LimitBucket[]
}

export type ActivityRange = 'daily' | 'weekly' | 'monthly' | 'custom'

export interface HomeActivitySnapshot {
  provider: ProviderDescriptor
  supportedRanges: ActivityRange[]
  summaries: ClaudeActivitySummary['weeklyActivity']
  freshness: { fetchedAt?: number; stale: boolean }
}

export interface HomeStatsSnapshot {
  provider: ProviderDescriptor
  window: 'weekly' | 'all'
  sessions?: number
  tokens?: number
  activeDays?: number
  streak?: number
  peakHour?: number
  breakdowns?: Array<{ id: string; label: string; value: number }>
}

export interface SurfaceNavigationRequest {
  surface: SurfaceId
  homePage?: HomePageId
  input: 'pointer' | 'keyboard' | 'programmatic'
}

export type NavigateSurface = (request: SurfaceNavigationRequest) => void
export type NavigateWorkspace = (workspaceId: string, projectId: string) => void

export interface HomeSourceState<T> {
  data: T
  loading: boolean
  refreshing: boolean
  error: string | null
  unavailable: boolean
  fetchedAt?: number
  stale: boolean
}

export interface HomeCounts {
  needsYou: number
  liveAgents: number
  github: number
}

export interface HomeSnapshot {
  agents: HomeSourceState<HomeAgent[]>
  actions: HomeSourceState<HomeActionItem[]>
  github: HomeSourceState<{ prs: GhSearchPr[]; issues: GhSearchIssue[] }>
  limits: HomeSourceState<ProviderLimitSnapshot[]>
  activity: HomeSourceState<HomeActivitySnapshot[]>
  stats: HomeSourceState<HomeStatsSnapshot[]>
  counts: HomeCounts
}

export interface HomePageProps {
  snapshot: HomeSnapshot
  onNavigate: NavigateSurface
  onSelectWorkspace: NavigateWorkspace
}

export type HomePageComponent = React.ComponentType<HomePageProps>

export declare function getHomeSnapshot(): HomeSnapshot
export declare function subscribeHome(listener: () => void): () => void
export declare function refreshHomeSource(source: keyof Omit<HomeSnapshot, 'counts'>): void
export declare function useHomeSnapshot(): HomeSnapshot
