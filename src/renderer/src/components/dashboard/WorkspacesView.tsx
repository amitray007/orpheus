import { useMemo } from 'react'
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
// Column config
// ---------------------------------------------------------------------------

interface ColumnConfig {
  key: GroupKey
  label: string
  indicatorDetail: WorkspaceActivityDetail
}

const COLUMN_CONFIGS: ColumnConfig[] = [
  { key: 'in_review', label: 'In Review', indicatorDetail: 'attention' },
  { key: 'in_progress', label: 'In Progress', indicatorDetail: 'thinking' },
  { key: 'done', label: 'Done', indicatorDetail: 'ready' },
  { key: 'waiting', label: 'Waiting', indicatorDetail: 'idle' }
]

// ---------------------------------------------------------------------------
// Workspace card
// ---------------------------------------------------------------------------

interface WorkspaceCardProps {
  workspace: WorkspaceRecord
  projectName: string
  session: SessionRecord | undefined
  activities: Record<string, WorkspaceActivityDetail>
  onClick: () => void
}

function WorkspaceCard({
  workspace,
  projectName,
  session,
  activities,
  onClick
}: WorkspaceCardProps): React.JSX.Element {
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
      className="w-full p-3 rounded-md bg-surface-raised border border-border-default/60 hover:bg-surface-overlay hover:border-border-default transition-colors duration-100 text-left cursor-pointer flex flex-col gap-1.5"
    >
      {/* Title row: glyph + name */}
      <span className="flex items-center gap-2 min-w-0">
        <span className="flex-shrink-0">
          <ActivityIndicator detail={effectiveActivity} />
        </span>
        <span
          className="text-sm font-medium text-text-primary truncate leading-snug"
          title={displayName}
        >
          {displayName}
        </span>
      </span>

      {/* Project chip */}
      <span className="self-start text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default text-text-secondary max-w-full truncate">
        {projectName}
      </span>

      {/* Preview snippet — two-line clamp with curly quotes */}
      {session?.lastMessagePreview && (
        <span className="text-[11px] text-text-muted italic line-clamp-2 leading-relaxed">
          &ldquo;{session.lastMessagePreview}&rdquo;
        </span>
      )}

      {/* Footer: model · msgs · time */}
      <span className="text-[11px] text-text-muted flex items-center gap-1 flex-wrap mt-0.5">
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
    </button>
  )
}

// ---------------------------------------------------------------------------
// Kanban column
// ---------------------------------------------------------------------------

interface KanbanColumnProps {
  config: ColumnConfig
  workspaces: WorkspaceRecord[]
  projectsById: Map<string, ProjectRecord>
  sessionsById: Map<string, SessionRecord>
  activities: Record<string, WorkspaceActivityDetail>
  onNavigateToWorkspace: (workspaceId: string, projectId: string) => void
}

function KanbanColumn({
  config,
  workspaces,
  projectsById,
  sessionsById,
  activities,
  onNavigateToWorkspace
}: KanbanColumnProps): React.JSX.Element {
  return (
    <div className="flex flex-col min-h-0 bg-surface-raised rounded-lg border border-border-default overflow-hidden">
      {/* Column header — sticky when the column body scrolls */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-border-default bg-surface-raised sticky top-0 z-10">
        <ActivityIndicator detail={config.indicatorDetail} className="flex-shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary leading-none flex items-baseline gap-1.5">
          {config.label}
          <span className="font-normal text-text-muted normal-case tracking-normal">
            · {workspaces.length}
          </span>
        </span>
      </div>

      {/* Column body — vertically scrollable */}
      <div className="flex-1 overflow-y-auto min-h-0 p-2 flex flex-col gap-2">
        {workspaces.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-8">
            <span className="text-xs text-text-muted">No workspaces</span>
          </div>
        ) : (
          workspaces.map((ws) => {
            const project = projectsById.get(ws.projectId)
            const session = ws.claudeSessionId
              ? sessionsById.get(ws.claudeSessionId)
              : undefined
            return (
              <WorkspaceCard
                key={ws.id}
                workspace={ws}
                projectName={project?.name ?? 'Unknown'}
                session={session}
                activities={activities}
                onClick={() => onNavigateToWorkspace(ws.id, ws.projectId)}
              />
            )
          })
        )}
      </div>
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

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      {/* Header */}
      <div className="flex-shrink-0">
        <h1 className="text-xl font-semibold text-text-primary">Workspaces</h1>
      </div>

      {/* Kanban board — 4 equal columns */}
      {activeWorkspaces.length === 0 ? (
        <div className="bg-surface-raised border border-border-default rounded-lg p-8 flex flex-col items-center gap-2">
          <p className="text-sm text-text-muted">No workspaces found</p>
          <p className="text-xs text-text-muted">
            Add a project and create a workspace to get started.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-3 flex-1 min-h-0">
          {COLUMN_CONFIGS.map((config) => (
            <KanbanColumn
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
