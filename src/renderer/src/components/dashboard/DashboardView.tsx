import { useEffect, useState, useCallback } from 'react'
import type React from 'react'
import { ActivityCalendar } from 'react-activity-calendar'
import { ArrowsClockwise } from '@phosphor-icons/react'
import type {
  HeatmapEntry,
  ProjectRecord,
  WorkspaceRecord,
  WorkspaceActivityDetail,
  ClaudeUsageResult,
  ClaudeUsageBucket
} from '@shared/types'
import { DotmSquare11 } from '../ui/dotm-square-11'
import { ActivityIndicator } from './ActivityIndicator'
import { resolveWorkspaceName } from './resolveWorkspaceName'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function SectionCard({
  title,
  loading,
  error,
  children
}: {
  title: string
  loading: boolean
  error: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-2">
        {title}
      </h2>
      <div className="bg-surface-raised border border-border-default rounded-lg overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <DotmSquare11 className="text-text-muted opacity-60" />
          </div>
        ) : error ? (
          <div className="p-6 text-sm text-text-muted text-center">Couldn't load</div>
        ) : (
          children
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Claude Usage helpers
// ---------------------------------------------------------------------------

function humanizeMsUntil(isoOrNull: string | null): string {
  if (!isoOrNull) return ''
  const target = new Date(isoOrNull).getTime()
  const diff = target - Date.now()
  if (diff <= 0) return 'now'
  const totalSec = Math.floor(diff / 1000)
  const d = Math.floor(totalSec / 86400)
  if (d >= 1) return `${d}d`
  const h = Math.floor(totalSec / 3600)
  if (h >= 1) {
    const m = Math.floor((totalSec % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const m = Math.floor(totalSec / 60)
  if (m >= 1) return `${m}m`
  return `${totalSec}s`
}

function utilizationColor(pct: number): string {
  if (pct >= 80) return '#f87171' // red-400
  if (pct >= 50) return '#fbbf24' // amber-400
  return '#4ade80' // green-400
}

function UsageBar({
  label,
  bucket
}: {
  label: string
  bucket: ClaudeUsageBucket | null
}): React.JSX.Element {
  const pct = bucket?.utilization ?? 0
  const color = utilizationColor(pct)
  const resetLabel = bucket?.resetsAt ? humanizeMsUntil(bucket.resetsAt) : null

  return (
    <div className="flex items-center gap-3 py-2.5">
      <span className="w-32 shrink-0 text-xs text-text-secondary truncate">{label}</span>
      <div className="flex-1 relative h-1.5 rounded-full bg-surface-overlay overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
          style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-xs font-mono text-text-primary">
        {pct}%
      </span>
      {resetLabel ? (
        <span className="w-16 shrink-0 text-right text-xs text-text-muted">
          {resetLabel}
        </span>
      ) : (
        <span className="w-16 shrink-0" />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Claude Usage Section
// ---------------------------------------------------------------------------

function ClaudeUsageSection(): React.JSX.Element {
  const [result, setResult] = useState<ClaudeUsageResult | null>(null)
  const [loading, setLoading] = useState(true)

  const fetchUsage = useCallback(() => {
    setLoading(true)
    window.api.dashboard
      .getClaudeUsage()
      .then((r) => {
        setResult(r)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[dashboard] claude usage error', err)
        setResult({ kind: 'error', message: String(err) })
        setLoading(false)
      })
  }, [])

  useEffect(() => {
    fetchUsage()
  }, [fetchUsage])

  const snapshot =
    result?.kind === 'ok'
      ? result.snapshot
      : result?.kind === 'rate_limited'
        ? result.snapshot
        : null

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Claude Usage
        </h2>
        <button
          onClick={fetchUsage}
          disabled={loading}
          className="flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors disabled:opacity-40"
          title="Refresh usage"
        >
          <ArrowsClockwise
            size={13}
            weight="regular"
            className={loading ? 'animate-spin' : ''}
          />
        </button>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg overflow-hidden">
        {loading && !snapshot ? (
          <div className="flex items-center justify-center p-8">
            <DotmSquare11 className="text-text-muted opacity-60" />
          </div>
        ) : result?.kind === 'no_credentials' ? (
          <div className="px-4 py-5 text-sm text-text-muted text-center">
            Sign in to Claude Code to see usage
          </div>
        ) : result?.kind === 'auth_failed' ? (
          <div className="px-4 py-5 text-sm text-text-muted text-center">
            {result.message}
          </div>
        ) : result?.kind === 'error' && !snapshot ? (
          <div className="px-4 py-5 text-sm text-text-muted text-center">
            Couldn&apos;t load Claude usage
          </div>
        ) : snapshot ? (
          <div className="px-4">
            <UsageBar label="5-hour window" bucket={snapshot.fiveHour} />
            <div className="border-t border-border-default" />
            <UsageBar label="7-day overall" bucket={snapshot.sevenDay} />
            <div className="border-t border-border-default" />
            <UsageBar label="7-day Sonnet" bucket={snapshot.sevenDaySonnet} />
            <div className="border-t border-border-default" />
            <UsageBar label="7-day Opus" bucket={snapshot.sevenDayOpus} />
            {result?.kind === 'rate_limited' && (
              <div className="pb-2 text-xs text-text-muted">
                Rate-limited — retrying in {Math.ceil(result.retryAfterMs / 60000)}m
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Activity Heatmap
// ---------------------------------------------------------------------------

function ActivityHeatmapSection(): React.JSX.Element {
  const [data, setData] = useState<HeatmapEntry[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.dashboard
      .getActivityHeatmap(30)
      .then((entries) => {
        if (cancelled) return
        setData(entries)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[dashboard] heatmap error', err)
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const totalCount = data?.reduce((sum, e) => sum + e.count, 0) ?? 0

  return (
    <SectionCard title="Activity" loading={loading} error={error}>
      {data && (
        <div className="px-6 py-5">
          <ActivityCalendar
            data={data}
            blockSize={12}
            blockMargin={3}
            fontSize={11}
            showColorLegend={false}
            showMonthLabels={true}
            showWeekdayLabels={false}
            theme={{
              light: ['#2a2a2a', '#1a4d2e', '#2d7a4c', '#3fa362', '#4bd07c'],
              dark: ['#2a2a2a', '#1a4d2e', '#2d7a4c', '#3fa362', '#4bd07c']
            }}
            labels={{ totalCount: `${totalCount} contributions in the last 30 days` }}
            style={{ color: '#71717a' }}
          />
        </div>
      )}
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// Recent Projects
// ---------------------------------------------------------------------------

interface RecentProjectsProps {
  onNavigateToProject: (projectId: string) => void
}

function RecentProjectsSection({ onNavigateToProject }: RecentProjectsProps): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.dashboard
      .getRecentProjects(5)
      .then((rows) => {
        if (cancelled) return
        setProjects(rows)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[dashboard] recent projects error', err)
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <SectionCard title="Recent Projects" loading={loading} error={error}>
      {projects && projects.length === 0 ? (
        <div className="p-6 text-sm text-text-muted text-center">No projects yet</div>
      ) : projects ? (
        <ul>
          {projects.map((project, idx) => (
            <li key={project.id}>
              <button
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-overlay transition-colors ${idx < projects.length - 1 ? 'border-b border-border-default' : ''}`}
                onClick={() => onNavigateToProject(project.id)}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary font-medium truncate">
                    {project.name}
                  </div>
                  <div className="text-xs text-text-muted truncate mt-0.5">{project.path}</div>
                </div>
                {project.lastOpenedAt && (
                  <span className="text-xs text-text-muted shrink-0">
                    {relativeTime(project.lastOpenedAt)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// Recent Workspaces
// ---------------------------------------------------------------------------

interface RecentWorkspacesProps {
  onNavigateToWorkspace: (workspaceId: string, projectId: string) => void
  workspaceActivities: Record<string, WorkspaceActivityDetail>
}

function RecentWorkspacesSection({
  onNavigateToWorkspace,
  workspaceActivities
}: RecentWorkspacesProps): React.JSX.Element {
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[] | null>(null)
  const [projectMap, setProjectMap] = useState<Record<string, ProjectRecord>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.dashboard.getRecentWorkspaces(5),
      window.api.projects.list()
    ])
      .then(([rows, allProjects]) => {
        if (cancelled) return
        setWorkspaces(rows)
        const map: Record<string, ProjectRecord> = {}
        for (const p of allProjects) map[p.id] = p
        setProjectMap(map)
        setLoading(false)
      })
      .catch((err) => {
        console.error('[dashboard] recent workspaces error', err)
        if (!cancelled) {
          setError(true)
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <SectionCard title="Recent Workspaces" loading={loading} error={error}>
      {workspaces && workspaces.length === 0 ? (
        <div className="p-6 text-sm text-text-muted text-center">No workspaces yet</div>
      ) : workspaces ? (
        <ul>
          {workspaces.map((ws, idx) => {
            const { text: nameText, muted: nameMuted } = resolveWorkspaceName({
              workspace: ws,
              terminalTitle: null,
              sessionTitle: null
            })
            const activity = workspaceActivities[ws.id]
            const projectName = projectMap[ws.projectId]?.name ?? null
            const timestamp = ws.lastOpenedAt ?? ws.createdAt
            return (
              <li key={ws.id}>
                <button
                  className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-surface-overlay transition-colors ${idx < workspaces.length - 1 ? 'border-b border-border-default' : ''}`}
                  onClick={() => onNavigateToWorkspace(ws.id, ws.projectId)}
                >
                  {activity && (
                    <ActivityIndicator detail={activity} className="shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div
                      className={`text-sm font-medium truncate ${nameMuted ? 'text-text-muted italic' : 'text-text-primary'}`}
                    >
                      {nameText}
                    </div>
                    {projectName && (
                      <div className="text-xs text-text-muted truncate mt-0.5">{projectName}</div>
                    )}
                  </div>
                  <span className="text-xs text-text-muted shrink-0">
                    {relativeTime(timestamp)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </SectionCard>
  )
}

// ---------------------------------------------------------------------------
// DashboardView
// ---------------------------------------------------------------------------

export interface DashboardViewProps {
  onNavigateToProject: (projectId: string) => void
  onNavigateToWorkspace: (workspaceId: string, projectId: string) => void
  workspaceActivities: Record<string, WorkspaceActivityDetail>
}

export function DashboardView({
  onNavigateToProject,
  onNavigateToWorkspace,
  workspaceActivities
}: DashboardViewProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <ClaudeUsageSection />
      <ActivityHeatmapSection />
      <RecentProjectsSection onNavigateToProject={onNavigateToProject} />
      <RecentWorkspacesSection
        onNavigateToWorkspace={onNavigateToWorkspace}
        workspaceActivities={workspaceActivities}
      />
    </div>
  )
}
