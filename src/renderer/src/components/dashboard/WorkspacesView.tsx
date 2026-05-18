import { useMemo, memo } from 'react'
import type {
  SessionRecord,
  WorkspaceRecord,
  WorkspaceActivityDetail,
  ProjectRecord,
  GitStatus,
  GhPullRequest
} from '@shared/types'
import { GitMerge } from '@phosphor-icons/react'
import { ActivityIndicator } from './ActivityIndicator'
import { PrChip } from '../github/PrChip'
import { resolveWorkspaceName } from './resolveWorkspaceName'
import { DotmSquare18 } from '../ui/dotm-square-18'

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

  // No live activity — if workspace was never activated (no claude session), it's just waiting.
  if (!ws.claudeSessionId) return 'waiting'

  // Workspace has run before — fall back to persisted status.
  if (ws.status === 'attention' || ws.status === 'awaiting_input') return 'in_review'
  if (ws.status === 'in_progress') return 'in_progress'
  return 'waiting'
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
  activityDetail: WorkspaceActivityDetail | undefined
  terminalTitle: string | null
  gitStatus: GitStatus | null
  pr: GhPullRequest | null
  onClick: () => void
}

const WorkspaceCard = memo(function WorkspaceCard({
  workspace,
  projectName,
  session,
  activityDetail,
  terminalTitle,
  gitStatus,
  pr,
  onClick
}: WorkspaceCardProps): React.JSX.Element {
  const sessionTitle = session?.title ?? null
  const dn = resolveWorkspaceName({ workspace, terminalTitle, sessionTitle })

  // Effective indicator: live activity wins; fall back to persisted status glyph
  const effectiveActivity: WorkspaceActivityDetail = activityDetail ?? fallbackActivity(workspace)

  const timestamp = workspace.lastOpenedAt ?? workspace.createdAt
  const branch = gitStatus?.branch ?? null
  const userPrompt = session?.lastUserMessagePreview ?? null

  return (
    <button
      onClick={onClick}
      className="w-full p-3 rounded-md bg-surface-raised border-2 border-dotted border-border-default/70 hover:bg-surface-overlay hover:border-accent/60 transition-colors duration-100 text-left cursor-pointer flex flex-col gap-1.5"
    >
      {/* Row 1: activity glyph + workspace title */}
      <span className="flex items-center gap-1.5 min-w-0">
        <span className="flex-shrink-0">
          <ActivityIndicator detail={effectiveActivity} />
        </span>
        <span
          className={[
            'text-sm font-medium truncate leading-snug',
            dn.muted ? 'text-text-muted italic font-normal' : 'text-text-primary'
          ].join(' ')}
          title={dn.text}
        >
          {dn.text}
        </span>
      </span>

      {/* Row 2: project name (left) + relative time (right) */}
      <span className="flex items-center justify-between gap-2 min-w-0">
        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-overlay border border-border-default text-text-secondary truncate min-w-0 max-w-[70%]">
          {projectName}
        </span>
        <span className="text-[11px] text-text-muted flex-shrink-0">{relativeTime(timestamp)}</span>
      </span>

      {/* Row 3: git branch + (when PR exists for this branch) PR chip on the right */}
      {(branch || pr) && (
        <span className="flex items-center gap-2 text-[11px] text-text-muted min-w-0">
          {branch && (
            <span className="flex items-center gap-1 min-w-0">
              <GitMerge size={11} className="flex-shrink-0 opacity-60" weight="bold" />
              <span className="truncate font-mono">{branch}</span>
            </span>
          )}
          {pr && (
            <span className="ml-auto flex-shrink-0">
              <PrChip pr={pr} variant="chip" />
            </span>
          )}
        </span>
      )}

      {/* Row 4: user prompt preview — up to 2 lines, italic, muted */}
      {userPrompt && (
        <span className="text-[11px] text-text-muted italic line-clamp-2 leading-relaxed">
          &ldquo;{userPrompt}&rdquo;
        </span>
      )}
    </button>
  )
})

// ---------------------------------------------------------------------------
// Kanban column
// ---------------------------------------------------------------------------

interface KanbanColumnProps {
  config: ColumnConfig
  workspaces: WorkspaceRecord[]
  projectsById: Map<string, ProjectRecord>
  sessionsById: Map<string, SessionRecord>
  activities: Record<string, WorkspaceActivityDetail>
  titleByWorkspaceId: Record<string, string>
  gitStatusByWorkspaceId: Record<string, GitStatus | null>
  prByWorkspaceId: Record<string, GhPullRequest | null>
  onNavigateToWorkspace: (workspaceId: string, projectId: string) => void
}

const KanbanColumn = memo(function KanbanColumn({
  config,
  workspaces,
  projectsById,
  sessionsById,
  activities,
  titleByWorkspaceId,
  gitStatusByWorkspaceId,
  prByWorkspaceId,
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
            const session = ws.claudeSessionId ? sessionsById.get(ws.claudeSessionId) : undefined
            return (
              <WorkspaceCard
                key={ws.id}
                workspace={ws}
                projectName={project?.name ?? 'Unknown'}
                session={session}
                activityDetail={activities[ws.id]}
                terminalTitle={titleByWorkspaceId[ws.id] ?? null}
                gitStatus={gitStatusByWorkspaceId[ws.id] ?? null}
                pr={prByWorkspaceId[ws.id] ?? null}
                onClick={() => onNavigateToWorkspace(ws.id, ws.projectId)}
              />
            )
          })
        )}
      </div>
    </div>
  )
})

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
  titleByWorkspaceId: Record<string, string>
  sessions: SessionRecord[] // for looking up session metadata via claudeSessionId
  gitStatusByWorkspaceId?: Record<string, GitStatus | null>
  prByWorkspaceId?: Record<string, GhPullRequest | null>
}

export function WorkspacesView({
  onNavigateToWorkspace,
  projects,
  workspaces,
  workspaceActivities,
  titleByWorkspaceId,
  sessions,
  gitStatusByWorkspaceId = {},
  prByWorkspaceId = {}
}: WorkspacesViewProps): React.JSX.Element {
  // Build fast lookups
  const projectsById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions])

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
      {/* Header — Sound Bars (DotmSquare18) in top-right signals "live activity tracking".
          Persistent-pulse approach: wiring a sessionsLoading bool down through
          MainContent → WorkspacesView is possible but hairy since the kanban also
          reacts to real-time IPC events (onActivityChanged), not just the initial fetch.
          A persistent, faint indicator communicates "always listening" semantics more
          accurately and avoids a loading flicker on every navigation. */}
      <div className="flex-shrink-0 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text-primary">Workspaces</h1>
        <span className="text-text-muted opacity-50" title="Live activity">
          <DotmSquare18 size={16} dotSize={2} speed={0.8} animated />
        </span>
      </div>

      {/* Kanban board — always render the 4-column shell; per-column "No workspaces"
          handles the empty case so the layout stays consistent. */}
      <div className="grid grid-cols-4 gap-3 flex-1 min-h-0">
        {COLUMN_CONFIGS.map((config) => (
          <KanbanColumn
            key={config.key}
            config={config}
            workspaces={grouped[config.key]}
            projectsById={projectsById}
            sessionsById={sessionsById}
            activities={workspaceActivities}
            titleByWorkspaceId={titleByWorkspaceId}
            gitStatusByWorkspaceId={gitStatusByWorkspaceId}
            prByWorkspaceId={prByWorkspaceId}
            onNavigateToWorkspace={onNavigateToWorkspace}
          />
        ))}
      </div>
    </div>
  )
}
