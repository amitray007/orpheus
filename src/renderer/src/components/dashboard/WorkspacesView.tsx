import { useState, useMemo } from 'react'
import { CaretRight } from '@phosphor-icons/react'
import type {
  SessionRecord,
  WorkspaceRecord,
  WorkspaceActivityDetail,
  ProjectRecord
} from '@shared/types'
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

// Derive the basename from a posix-style path without importing path
function basename(cwdPath: string): string {
  const parts = cwdPath.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || cwdPath
}

// ---------------------------------------------------------------------------
// Group derivation — workspace-first.
// Live activity wins; persisted workspace.status is the fallback so
// workspaces are placed correctly before any live activity event fires.
// ---------------------------------------------------------------------------

type GroupKey = 'in_review' | 'in_progress' | 'done' | 'waiting'

function deriveGroup(
  ws: WorkspaceRecord,
  activities: Record<string, WorkspaceActivityDetail>
): GroupKey {
  // Live activity wins
  const a = activities[ws.id]
  if (a === 'attention' || a === 'asking') return 'in_review'
  if (a === 'thinking' || a === 'tool' || a === 'compacting') return 'in_progress'
  if (a === 'ready') return 'done'
  if (a === 'idle') return 'waiting'

  // Fall back to persisted status when no live activity is known
  if (ws.status === 'attention' || ws.status === 'awaiting_input') return 'in_review'
  if (ws.status === 'in_progress') return 'in_progress'
  return 'waiting' // idle (and any unexpected value) → Waiting
}

// Map persisted workspace status → a display activity for rows where no
// live event has fired yet (gives the ActivityIndicator something to show)
function fallbackActivity(ws: WorkspaceRecord): WorkspaceActivityDetail {
  if (ws.status === 'attention') return 'attention'
  if (ws.status === 'awaiting_input') return 'asking'
  if (ws.status === 'in_progress') return 'thinking'
  return 'idle'
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
    emptyText: 'No workspaces need your attention.',
    indicatorDetail: 'attention'
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    tagline: 'working',
    defaultExpanded: true,
    emptyText: 'No workspaces currently running.',
    indicatorDetail: 'thinking'
  },
  {
    key: 'done',
    label: 'Done',
    tagline: '',
    defaultExpanded: false,
    emptyText: 'No completed workspaces.',
    indicatorDetail: 'ready'
  },
  {
    key: 'waiting',
    label: 'Waiting',
    tagline: '',
    defaultExpanded: false,
    emptyText: 'No workspaces waiting.',
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
// Workspace row
// ---------------------------------------------------------------------------

interface WorkspaceRowProps {
  workspace: WorkspaceRecord
  projectName: string
  session: SessionRecord | undefined
  activities: Record<string, WorkspaceActivityDetail>
  onClick: () => void
}

function WorkspaceRow({
  workspace,
  projectName,
  session,
  activities,
  onClick
}: WorkspaceRowProps): React.JSX.Element {
  // Primary label: workspace name, with cwd basename as fallback
  const displayName =
    workspace.name.trim() !== '' ? workspace.name : basename(workspace.cwd)

  // Effective indicator: live activity wins; fall back to persisted status glyph
  const liveActivity = activities[workspace.id]
  const effectiveActivity: WorkspaceActivityDetail = liveActivity ?? fallbackActivity(workspace)

  // Subline metadata from attached session (if any)
  const model = session ? shortModel(session.model) : null
  const msgCount = session?.messageCount ?? null
  const timestamp = workspace.lastOpenedAt ?? workspace.createdAt

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
          <span className="text-sm text-text-primary truncate" title={displayName}>
            {displayName}
          </span>
          {/* Project chip */}
          <span className="flex-shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default text-text-secondary truncate max-w-[120px]">
            {projectName}
          </span>
        </span>

        {/* Subline: model · msgs · time (model/msgs omitted when no session attached) */}
        <span className="text-[11px] text-text-muted flex items-center gap-1.5 flex-wrap">
          {model !== null && (
            <>
              <span className="font-mono">{model}</span>
              <span className="opacity-30">·</span>
            </>
          )}
          {msgCount !== null && (
            <>
              <span>{msgCount} msgs</span>
              <span className="opacity-30">·</span>
            </>
          )}
          <span>{relativeTime(timestamp)}</span>
        </span>

        {/* Last-message preview snippet — italic curly quotes */}
        {session?.lastMessagePreview && (
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
  workspaces: WorkspaceRecord[]
  projectsById: Map<string, ProjectRecord>
  sessionsById: Map<string, SessionRecord>
  activities: Record<string, WorkspaceActivityDetail>
  onNavigateToWorkspace: (workspaceId: string, projectId: string) => void
  forceExpanded?: boolean
}

function GroupSection({
  config,
  workspaces,
  projectsById,
  sessionsById,
  activities,
  onNavigateToWorkspace,
  forceExpanded
}: GroupSectionProps): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(config.defaultExpanded)

  const isExpanded = forceExpanded !== undefined ? forceExpanded : expanded

  if (workspaces.length === 0) return null

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
          <span className="font-normal text-text-muted ml-1.5">{workspaces.length}</span>
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

      {/* Workspace rows */}
      {isExpanded && (
        <div className="divide-y divide-border-default/40">
          {workspaces.map((ws) => {
            const project = projectsById.get(ws.projectId)
            const session = ws.claudeSessionId
              ? sessionsById.get(ws.claudeSessionId)
              : undefined
            return (
              <WorkspaceRow
                key={ws.id}
                workspace={ws}
                projectName={project?.name ?? 'Unknown'}
                session={session}
                activities={activities}
                onClick={() => onNavigateToWorkspace(ws.id, ws.projectId)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// WorkspacesView
// (File was SessionsView.tsx — renamed to WorkspacesView.tsx in Chunk C;
// the route key remains 'sessions' for back-compat with uiState serialisation)
// ---------------------------------------------------------------------------

export interface WorkspacesViewProps {
  onNavigateToWorkspace: (workspaceId: string, projectId: string) => void
  projects: ProjectRecord[]
  workspaces: WorkspaceRecord[]
  workspaceActivities: Record<string, WorkspaceActivityDetail>
  sessions: SessionRecord[] // for looking up session metadata via claudeSessionId
}

export function WorkspacesView({
  onNavigateToWorkspace,
  projects,
  workspaces,
  workspaceActivities,
  sessions
}: WorkspacesViewProps): React.JSX.Element {
  const [filter, setFilter] = useState<Filter>('all')

  // Build fast lookups
  const projectsById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects]
  )
  const sessionsById = useMemo(
    () => new Map(sessions.map((s) => [s.id, s])),
    [sessions]
  )

  // Exclude archived workspaces from all views
  const activeWorkspaces = useMemo(
    () => workspaces.filter((w) => w.archivedAt === null),
    [workspaces]
  )

  // Derive groups — recomputes whenever activities or workspaces change
  const grouped = useMemo<Record<GroupKey, WorkspaceRecord[]>>(() => {
    const result: Record<GroupKey, WorkspaceRecord[]> = {
      in_review: [],
      in_progress: [],
      done: [],
      waiting: []
    }
    for (const ws of activeWorkspaces) {
      const g = deriveGroup(ws, workspaceActivities)
      result[g].push(ws)
    }
    return result
  }, [activeWorkspaces, workspaceActivities])

  // Flat list used when a specific filter chip is active
  const filteredFlat = useMemo(() => {
    if (filter === 'all') return activeWorkspaces
    return grouped[filter] ?? []
  }, [filter, activeWorkspaces, grouped])

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Workspaces</h1>

        {/* Filter chips */}
        <div className="flex items-center gap-1">
          {FILTERS.map((f) => {
            const count =
              f.value === 'all'
                ? activeWorkspaces.length
                : (grouped[f.value as GroupKey]?.length ?? 0)
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
                {count > 0 && (
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
      {activeWorkspaces.length === 0 ? (
        <div className="bg-surface-raised border border-border-default rounded-lg p-8 flex flex-col items-center gap-2">
          <p className="text-sm text-text-muted">No workspaces found</p>
          <p className="text-xs text-text-muted">
            Add a project and create a workspace to get started.
          </p>
        </div>
      ) : filter !== 'all' ? (
        /* Single-filter flat view */
        <div className="bg-surface-raised border border-border-default rounded-lg overflow-hidden">
          {filteredFlat.length === 0 ? (
            <div className="p-8 flex flex-col items-center gap-2">
              <p className="text-sm text-text-muted">
                {GROUP_CONFIGS.find((c) => c.key === filter)?.emptyText ?? 'No workspaces.'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-border-default/40">
              {filteredFlat.map((ws) => {
                const project = projectsById.get(ws.projectId)
                const session = ws.claudeSessionId
                  ? sessionsById.get(ws.claudeSessionId)
                  : undefined
                return (
                  <WorkspaceRow
                    key={ws.id}
                    workspace={ws}
                    projectName={project?.name ?? 'Unknown'}
                    session={session}
                    activities={workspaceActivities}
                    onClick={() => onNavigateToWorkspace(ws.id, ws.projectId)}
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
              workspaces={grouped[config.key]}
              projectsById={projectsById}
              sessionsById={sessionsById}
              activities={workspaceActivities}
              onNavigateToWorkspace={onNavigateToWorkspace}
            />
          ))}
        </div>
      )}
    </div>
  )
}
