import { lazy, Suspense, useState } from 'react'
import { Kanban, ArrowLeft } from '@phosphor-icons/react'
import { DashboardView } from './DashboardView'
import { ProjectView } from './ProjectView'
import { WorkspacesView } from './WorkspacesView'
import { WorkspaceView } from './WorkspaceView'
import { ProjectsHome } from './ProjectsHome'
import { PanesView } from '../panes/PanesView'
import { Eyebrow } from './settings/primitives'
import type { SectionId as SettingsSectionId } from './SettingsView'
import { getActivitySnapshot } from '@/lib/activityStore'
import { getPrSnapshot } from '@/lib/prStore'
import { useUiState } from '@/lib/uiStateStore'
import { SessionListSkeleton } from '../Skeleton'
import type { ProjectRecord, SessionRecord, WorkspaceRecord } from '@shared/types'

const SettingsView = lazy(() => import('./SettingsView').then((m) => ({ default: m.SettingsView })))

// ---------------------------------------------------------------------------
// LRU keep-alive list — up to N workspace IDs remain mounted simultaneously.
// The front of the list is the active workspace; older entries stay mounted
// (but hidden) so switching back is instant (no effect teardown/rebuild).
// ---------------------------------------------------------------------------

const LRU_MAX = 3

function lruPush(list: string[], id: string): string[] {
  // Move id to front; drop duplicates; evict beyond LRU_MAX.
  const filtered = list.filter((x) => x !== id)
  return [id, ...filtered].slice(0, LRU_MAX)
}

// ---------------------------------------------------------------------------
// Fallback placeholder (used for error states only)
// ---------------------------------------------------------------------------

function PlaceholderSection({ title }: { title: string }): React.JSX.Element {
  return (
    <section>
      <Eyebrow className="mb-2">{title}</Eyebrow>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-sm text-text-muted text-center">
        Not found
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// ProjectsSurfaceHeaderBar — thin header bar shown above the Projects
// surface's `sessions` view ONLY when the optional Workspaces board (kanban)
// is enabled (AppUiState.showWorkspacesBoard). It flips between two small
// buttons depending on which side of the board toggle we're currently
// viewing:
//   - not viewing the board: a right-aligned "Workspaces" button (board
//     icon) that reveals the kanban.
//   - viewing the board: a left-aligned "Back" button that returns to the
//     calm ProjectsHome empty state.
// Kept deliberately tiny (h-9) and styled to match other small toolbar
// buttons in the app (see PanesView's toolbar buttons).
// ---------------------------------------------------------------------------

function ProjectsSurfaceHeaderBar({
  viewingBoard,
  onToggleBoard
}: {
  viewingBoard: boolean
  onToggleBoard: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-9 flex-shrink-0 items-center border-b border-border-default bg-surface-raised px-3">
      {viewingBoard ? (
        <button
          type="button"
          onClick={onToggleBoard}
          className="flex h-6 items-center gap-1.5 rounded-md border border-border-default bg-surface-raised px-2.5 text-[11.5px] font-medium text-text-primary hover:border-accent hover:bg-surface-overlay cursor-pointer"
        >
          <ArrowLeft size={13} weight="bold" />
          Back
        </button>
      ) : (
        <button
          type="button"
          onClick={onToggleBoard}
          className="ml-auto flex h-6 items-center gap-1.5 rounded-md border border-border-default bg-surface-raised px-2.5 text-[11.5px] font-medium text-text-primary hover:border-accent hover:bg-surface-overlay cursor-pointer"
        >
          <Kanban size={13} weight="bold" />
          Workspaces
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectsSurfaceSessionsView — the `sessions`-kind view body for the
// Projects surface. Renders the calm ProjectsHome empty state by default;
// the retained WorkspacesView kanban is reachable only when
// showWorkspacesBoard is enabled (Settings > Navigation), via the small
// "Workspaces" board button in the header bar above. This is a plain
// presentational switch — extracted out of MainContent's big view-kind
// if-chain to keep MainContent's cognitive complexity under the lint cap.
// ---------------------------------------------------------------------------

function ProjectsSurfaceSessionsView({
  showBoard,
  viewingBoard,
  setViewingBoard,
  onNavigateToWorkspace,
  projects,
  workspaces,
  sessions
}: {
  showBoard: boolean
  viewingBoard: boolean
  setViewingBoard: (v: boolean) => void
  onNavigateToWorkspace: (workspaceId: string, projectId: string) => void
  projects: ProjectRecord[]
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
}): React.JSX.Element {
  if (showBoard && viewingBoard) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <ProjectsSurfaceHeaderBar viewingBoard onToggleBoard={() => setViewingBoard(false)} />
        <div className="flex-1 min-h-0">
          <WorkspacesView
            onNavigateToWorkspace={onNavigateToWorkspace}
            projects={projects}
            workspaces={workspaces}
            sessions={sessions}
          />
        </div>
      </div>
    )
  }

  if (showBoard) {
    return (
      <div className="h-full flex flex-col min-h-0">
        <ProjectsSurfaceHeaderBar
          viewingBoard={false}
          onToggleBoard={() => setViewingBoard(true)}
        />
        <div className="flex-1 min-h-0">
          <ProjectsHome />
        </div>
      </div>
    )
  }

  // Board disabled entirely: no header bar, no way to reach the kanban.
  return <ProjectsHome />
}

// ---------------------------------------------------------------------------
// View union type
// ---------------------------------------------------------------------------

export type View =
  | { kind: 'project'; projectId: string }
  | { kind: 'sessions' }
  | { kind: 'workspace'; workspaceId: string; projectId: string }
  | { kind: 'settings'; section?: SettingsSectionId }
  | { kind: 'panes' }
  | { kind: 'dashboard' }

// ---------------------------------------------------------------------------
// MainContent
// ---------------------------------------------------------------------------

interface MainContentProps {
  view: View
  project: ProjectRecord | undefined
  workspace?: WorkspaceRecord | undefined
  // null = not yet fetched; [] = fetched, empty
  workspacesForProject: WorkspaceRecord[] | null
  onRequestRemoveProject: (project: ProjectRecord) => void
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onAddWorkspace: (projectId: string) => void | Promise<void>
  onRenameWorkspace: (
    workspaceId: string,
    projectId: string,
    newName: string
  ) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void | Promise<void>
  onResumedInWorkspace: (workspace: WorkspaceRecord) => void | Promise<void>
  // Workspaces view props
  projects?: ProjectRecord[]
  allWorkspaces?: WorkspaceRecord[]
  allSessions?: SessionRecord[]
  // Privacy (v37)
  fetchGithubAvatars?: boolean
}

export function MainContent({
  view,
  project,
  workspace,
  workspacesForProject,
  onRequestRemoveProject,
  onSelectWorkspace,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onToggleWorkspacePin,
  onResumedInWorkspace,
  projects,
  allWorkspaces,
  allSessions,
  fetchGithubAvatars = true
}: MainContentProps): React.JSX.Element {
  // Projects surface — optional Workspaces board (kanban), U3. showBoard is
  // the persisted setting (Settings > Navigation); viewingBoard is local,
  // in-session UI state for which side of the toggle the sessions view is
  // currently showing (only meaningful while showBoard is true). Navigating
  // away and back always resets to the empty state, matching the "board is
  // an opt-in side trip, not a new landing page" intent from the plan.
  const uiState = useUiState()
  const showWorkspacesBoard = uiState?.showWorkspacesBoard ?? false
  const [viewingBoard, setViewingBoard] = useState(false)

  // Combined state: LRU list of kept workspace IDs + a snapshot of each record.
  // Stored together so a single setState keeps them atomic.
  const [keptState, setKeptState] = useState<{
    ids: string[]
    records: Map<string, WorkspaceRecord>
  }>(() => {
    const records = new Map<string, WorkspaceRecord>()
    const ids: string[] = []
    if (view.kind === 'workspace' && workspace) {
      records.set(workspace.id, workspace)
      ids.push(workspace.id)
    }
    return { ids, records }
  })

  // Derive the current LRU state within this render.
  // When the active workspace changes we compute the next keptState immediately
  // (same render cycle) so WorkspaceView for the new workspace is mounted with
  // `active=true` on the very first render that shows it — no blank-screen frame.
  // React supports calling setState during render for this "derived state" pattern:
  // it bails out and re-renders synchronously with the new state if needed.
  let renderKeptState = keptState
  if (view.kind === 'workspace' && workspace) {
    const wsId = workspace.id
    if (keptState.ids[0] !== wsId || keptState.records.get(wsId) !== workspace) {
      const nextRecords = new Map(keptState.records)
      nextRecords.set(wsId, workspace)
      const nextIds = keptState.ids[0] === wsId ? keptState.ids : lruPush(keptState.ids, wsId)
      // Drop evicted ids from the record snapshot.
      const nextIdsSet = new Set(nextIds)
      for (const id of keptState.ids) {
        if (!nextIdsSet.has(id)) nextRecords.delete(id)
      }
      renderKeptState = { ids: nextIds, records: nextRecords }
      // Schedule the state update so React commits the new keptState.
      // This runs during the render phase which React allows for derived-state
      // updates (equivalent to getDerivedStateFromProps in class components).
      setKeptState(renderKeptState)
    }
  }

  if (view.kind === 'settings') {
    return (
      <Suspense fallback={null}>
        <SettingsView section={view.section} />
      </Suspense>
    )
  }

  // Placed early since Panes will own native surfaces.
  if (view.kind === 'panes') {
    return <PanesView />
  }

  if (view.kind === 'dashboard') {
    // This is a NEW overview surface, not the removed home page (see
    // CLAUDE.md) — it aggregates status and sends you to the right place,
    // it does not re-home project/workspace navigation.
    return <DashboardView />
  }

  if (view.kind === 'sessions') {
    // Route key stays 'sessions' for back-compat with uiState serialisation;
    // this is the Projects surface's resting view. By default it renders the
    // calm ProjectsHome empty state; the retained WorkspacesView kanban is
    // only reachable via the "Workspaces" board button when
    // showWorkspacesBoard is enabled (Settings > Navigation) — see U3.
    return (
      <ProjectsSurfaceSessionsView
        showBoard={showWorkspacesBoard}
        viewingBoard={viewingBoard}
        setViewingBoard={setViewingBoard}
        onNavigateToWorkspace={onSelectWorkspace}
        projects={projects ?? []}
        workspaces={allWorkspaces ?? []}
        sessions={allSessions ?? []}
      />
    )
  }

  if (view.kind === 'workspace') {
    if (!workspace || !project) {
      // Distinguish "still loading this project's workspaces" from "genuinely
      // absent". workspacesForProject === null means the lazy fetch for this
      // project hasn't resolved yet (e.g. navigating from a notification click
      // to a not-yet-opened project) — show a neutral loading frame rather than
      // a spurious "not found" flash. Once the list is fetched (non-null) and
      // the workspace is still missing (or the project row is missing), surface
      // the real not-found placeholder.
      const stillLoading = !!project && workspacesForProject === null
      if (stillLoading) {
        return (
          <div className="flex flex-col gap-6">
            <SessionListSkeleton />
          </div>
        )
      }
      return (
        <div className="flex flex-col gap-6">
          <PlaceholderSection title="Workspace not found" />
        </div>
      )
    }

    const activeId = workspace.id

    // Render ALL kept WorkspaceViews simultaneously. Only the active one is
    // visible; the others have display:none so they don't occupy layout space
    // and don't report a bogus 0×0 rect to the native resize path.
    // WorkspaceView drives terminal:hide / terminal:mount via the active prop
    // and suppresses its title-bar portal when inactive.
    return (
      <>
        {renderKeptState.ids.map((id) => {
          const ws = renderKeptState.records.get(id)
          if (!ws) return null
          const isActive = id === activeId
          return (
            <div key={id} style={isActive ? { display: 'contents' } : { display: 'none' }}>
              <WorkspaceView
                workspace={ws}
                active={isActive}
                initialDetail={getActivitySnapshot().get(id)}
                pr={getPrSnapshot().get(id) ?? null}
                onSelectWorkspace={onSelectWorkspace}
                allWorkspaces={allWorkspaces}
              />
            </div>
          )
        })}
      </>
    )
  }

  // project view
  if (!project) {
    return (
      <div className="flex flex-col gap-6">
        <PlaceholderSection title="Project not found" />
      </div>
    )
  }

  return (
    <ProjectView
      project={project}
      workspaces={workspacesForProject}
      onRequestRemove={() => onRequestRemoveProject(project)}
      onSelectWorkspace={(wsId) => onSelectWorkspace(wsId, project.id)}
      onAddWorkspace={onAddWorkspace}
      onRenameWorkspace={onRenameWorkspace}
      onArchiveWorkspace={onArchiveWorkspace}
      onToggleWorkspacePin={onToggleWorkspacePin}
      onResumedInWorkspace={onResumedInWorkspace}
      fetchGithubAvatars={fetchGithubAvatars}
    />
  )
}
