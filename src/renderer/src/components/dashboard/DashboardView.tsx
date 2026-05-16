import { useEffect, useState } from 'react'
import type React from 'react'
import { ActivityCalendar } from 'react-activity-calendar'
import type { HeatmapEntry, ProjectRecord, WorkspaceRecord, WorkspaceActivityDetail } from '@shared/types'
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
      <ActivityHeatmapSection />
      <RecentProjectsSection onNavigateToProject={onNavigateToProject} />
      <RecentWorkspacesSection
        onNavigateToWorkspace={onNavigateToWorkspace}
        workspaceActivities={workspaceActivities}
      />
    </div>
  )
}
