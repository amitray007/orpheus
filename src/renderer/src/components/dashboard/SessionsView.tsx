import { useState, useEffect, useMemo } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import type {
  SessionRecord,
  WorkspaceRecord,
  WorkspaceActivityDetail,
  ProjectRecord
} from '@shared/types'
import { SessionListSkeleton } from '../Skeleton'
import { ActivityIndicator } from './ActivityIndicator'

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

function shortModel(model: string | null): string {
  if (!model) return '—'
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'Opus'
  if (m.includes('sonnet')) return 'Sonnet'
  if (m.includes('haiku')) return 'Haiku'
  return model
}

// ---------------------------------------------------------------------------
// Group derivation
// ---------------------------------------------------------------------------

type GroupKey = 'in_review' | 'in_progress' | 'done' | 'waiting'

function deriveGroup(
  session: SessionRecord,
  workspaces: WorkspaceRecord[],
  activities: Record<string, WorkspaceActivityDetail>
): GroupKey {
  const ws = workspaces.find((w) => w.claudeSessionId === session.id)
  if (!ws) return 'waiting'
  const a = activities[ws.id]
  if (a === 'attention' || a === 'asking') return 'in_review'
  if (a === 'thinking' || a === 'tool' || a === 'compacting') return 'in_progress'
  if (a === 'ready') return 'done'
  return 'waiting'
}

// ---------------------------------------------------------------------------
// Group config
// ---------------------------------------------------------------------------

interface GroupConfig {
  key: GroupKey
  label: string
  tagline: string
  defaultExpanded: boolean
  emptyText: string
  indicatorDetail: WorkspaceActivityDetail
}

const GROUP_CONFIGS: GroupConfig[] = [
  {
    key: 'in_review',
    label: 'In Review',
    tagline: 'needs you',
    defaultExpanded: true,
    emptyText: 'No sessions need your attention.',
    indicatorDetail: 'attention'
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    tagline: 'working',
    defaultExpanded: true,
    emptyText: 'No sessions currently running.',
    indicatorDetail: 'thinking'
  },
  {
    key: 'done',
    label: 'Done',
    tagline: '',
    defaultExpanded: false,
    emptyText: 'No completed sessions.',
    indicatorDetail: 'ready'
  },
  {
    key: 'waiting',
    label: 'Waiting',
    tagline: '',
    defaultExpanded: false,
    emptyText: 'No sessions waiting.',
    indicatorDetail: 'idle'
  }
]

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

type Filter = 'all' | GroupKey

const FILTERS: { label: string; value: Filter }[] = [
  { label: 'All', value: 'all' },
  { label: 'In Review', value: 'in_review' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Done', value: 'done' },
  { label: 'Waiting', value: 'waiting' }
]

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

interface SessionRowProps {
  session: SessionRecord
  projectName: string
  group: GroupKey
  workspaces: WorkspaceRecord[]
  activities: Record<string, WorkspaceActivityDetail>
  onClick: () => void
}

function SessionRow({
  session,
  projectName,
  group,
  workspaces,
  activities,
  onClick
}: SessionRowProps): React.JSX.Element {
  const displayTitle = session.title ?? `Session ${session.id.slice(0, 8)}`
  const ws = workspaces.find((w) => w.claudeSessionId === session.id)
  const activity: WorkspaceActivityDetail | undefined = ws ? activities[ws.id] : undefined

  // Effective indicator: use live activity when available, otherwise fall back
  // to a static representation that matches the group
  const effectiveActivity: WorkspaceActivityDetail | undefined =
    activity ??
    (group === 'in_review'
      ? 'attention'
      : group === 'in_progress'
        ? 'thinking'
        : group === 'done'
          ? 'ready'
          : 'idle')

  const msgCount = session.messageCount ?? null

  return (
    <button
      onClick={onClick}
      className="w-full flex items-start gap-3 px-4 py-3 hover:bg-surface-overlay transition-colors duration-100 text-left group cursor-pointer"
    >
      {/* Activity glyph */}
      <span className="mt-0.5 flex-shrink-0">
        <ActivityIndicator detail={effectiveActivity} />
      </span>

      {/* Main content */}
      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
        {/* Title row */}
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm text-text-primary truncate" title={displayTitle}>
            {displayTitle}
          </span>
          {/* Project chip */}
          <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default text-text-secondary truncate max-w-[120px]">
            {projectName}
          </span>
        </span>

        {/* Subline: model · msgs · time */}
        <span className="text-[11px] text-text-muted flex items-center gap-1.5 flex-wrap">
          <span className="font-mono">{shortModel(session.model)}</span>
          {msgCount !== null && (
            <>
              <span className="opacity-30">·</span>
              <span>{msgCount} msgs</span>
            </>
          )}
          <span className="opacity-30">·</span>
          <span>{relativeTime(session.updatedAt)}</span>
        </span>

        {/* Last-message preview snippet (Chunk B) */}
        {session.lastMessagePreview && (
          <span
            className="text-[11px] text-text-muted italic truncate"
            title={session.lastMessagePreview}
          >
            &ldquo;{session.lastMessagePreview}&rdquo;
          </span>
        )}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Group section
// ---------------------------------------------------------------------------

interface GroupSectionProps {
  config: GroupConfig
  sessions: SessionRecord[]
  projectsById: Map<string, ProjectRecord>
  workspaces: WorkspaceRecord[]
  activities: Record<string, WorkspaceActivityDetail>
  onNavigateToProject: (projectId: string) => void
  forceExpanded?: boolean
}

function GroupSection({
  config,
  sessions,
  projectsById,
  workspaces,
  activities,
  onNavigateToProject,
  forceExpanded
}: GroupSectionProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(config.defaultExpanded)

  const isExpanded = forceExpanded !== undefined ? forceExpanded : expanded

  if (sessions.length === 0) return null

  return (
    <div className="flex flex-col">
      {/* Group header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 px-4 py-2 hover:bg-surface-overlay/50 transition-colors duration-100 cursor-pointer group"
      >
        <ActivityIndicator detail={config.indicatorDetail} className="w-3 text-xs font-mono" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary flex-1 text-left">
          {config.label}
          <span className="font-normal text-text-muted ml-1.5">{sessions.length}</span>
          {config.tagline && (
            <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-text-muted opacity-60">
              {config.tagline}
            </span>
          )}
        </span>
        <span
          className={[
            'text-text-muted opacity-50 transition-transform duration-200',
            isExpanded ? 'rotate-90' : ''
          ].join(' ')}
        >
          <CaretRight size={11} weight="bold" />
        </span>
      </button>

      {/* Session rows */}
      {isExpanded && (
        <div className="divide-y divide-border-default/40">
          {sessions.map((session) => {
            const project = projectsById.get(session.projectId)
            return (
              <SessionRow
                key={session.id}
                session={session}
                projectName={project?.name ?? 'Unknown'}
                group={config.key}
                workspaces={workspaces}
                activities={activities}
                onClick={() => onNavigateToProject(session.projectId)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SessionsView
// ---------------------------------------------------------------------------

export interface SessionsViewProps {
  onNavigateToProject: (projectId: string) => void
  projects: ProjectRecord[]
  workspaces: WorkspaceRecord[]
  workspaceActivities: Record<string, WorkspaceActivityDetail>
}

export function SessionsView({
  onNavigateToProject,
  projects,
  workspaces,
  workspaceActivities
}: SessionsViewProps): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null)

  // Build a fast lookup from projectId → ProjectRecord
  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects]
  )

  // Load all sessions once on mount; filter archived in renderer
  useEffect(() => {
    let cancelled = false
    window.api.sessions
      .listAll()
      .then((list) => {
        if (!cancelled) setSessions(list)
      })
      .catch((err) => {
        console.error('[sessions-view] failed to load sessions', err)
        if (!cancelled) setSessions([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Filter archived sessions out entirely (Chunk A — DB stays untouched)
  const activeSessions = useMemo(
    () => (sessions ?? []).filter((s) => s.status !== 'archived'),
    [sessions]
  )

  // Derive groups — recomputes whenever activities or sessions change
  const grouped = useMemo<Record<GroupKey, SessionRecord[]>>(() => {
    const result: Record<GroupKey, SessionRecord[]> = {
      in_review: [],
      in_progress: [],
      done: [],
      waiting: []
    }
    for (const s of activeSessions) {
      const g = deriveGroup(s, workspaces, workspaceActivities)
      result[g].push(s)
    }
    return result
  }, [activeSessions, workspaces, workspaceActivities])

  const loading = sessions === null

  // Flat list used when a specific filter is active
  const filteredFlat = useMemo(() => {
    if (filter === 'all') return activeSessions
    return grouped[filter] ?? []
  }, [filter, activeSessions, grouped])

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Sessions</h1>

        {/* Filter chips */}
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => {
            const count =
              f.value === 'all' ? activeSessions.length : (grouped[f.value as GroupKey]?.length ?? 0)
            return (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={[
                  'px-3 py-1 rounded-md text-xs font-medium transition-colors duration-150 cursor-pointer flex items-center gap-1.5',
                  filter === f.value
                    ? 'bg-accent/15 text-text-primary border border-accent/30'
                    : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay border border-transparent'
                ].join(' ')}
              >
                {f.label}
                {!loading && count > 0 && (
                  <span
                    className={[
                      'text-[10px] font-semibold px-1 rounded',
                      filter === f.value ? 'text-accent' : 'text-text-muted'
                    ].join(' ')}
                  >
                    {count}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="bg-surface-raised border border-border-default rounded-lg py-3">
          <SessionListSkeleton />
        </div>
      ) : activeSessions.length === 0 ? (
        <div className="bg-surface-raised border border-border-default rounded-lg p-8 flex flex-col items-center gap-2">
          <p className="text-sm text-text-muted">No sessions found</p>
          <p className="text-xs text-text-muted">
            Start Claude Code in any project folder to create sessions.
          </p>
        </div>
      ) : filter !== 'all' ? (
        /* Single-filter flat view */
        <div className="bg-surface-raised border border-border-default rounded-lg overflow-hidden">
          {filteredFlat.length === 0 ? (
            <div className="p-8 flex flex-col items-center gap-2">
              <p className="text-sm text-text-muted">
                {GROUP_CONFIGS.find((c) => c.key === filter)?.emptyText ?? 'No sessions.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border-default/40">
              {filteredFlat.map((session) => {
                const project = projectsById.get(session.projectId)
                return (
                  <SessionRow
                    key={session.id}
                    session={session}
                    projectName={project?.name ?? 'Unknown'}
                    group={filter as GroupKey}
                    workspaces={workspaces}
                    activities={workspaceActivities}
                    onClick={() => onNavigateToProject(session.projectId)}
                  />
                )
              })}
            </div>
          )}
        </div>
      ) : (
        /* All groups view */
        <div className="bg-surface-raised border border-border-default rounded-lg overflow-hidden divide-y divide-border-default/50">
          {GROUP_CONFIGS.map((config) => (
            <GroupSection
              key={config.key}
              config={config}
              sessions={grouped[config.key]}
              projectsById={projectsById}
              workspaces={workspaces}
              activities={workspaceActivities}
              onNavigateToProject={onNavigateToProject}
            />
          ))}
        </div>
      )}
    </div>
  )
}
