import { lazy, Suspense, useState } from 'react'
import { ProjectView } from './ProjectView'
import { WorkspacesView } from './WorkspacesView'
import { WorkspaceView } from './WorkspaceView'
import { Eyebrow } from './settings/primitives'
import type { SectionId as SettingsSectionId } from './SettingsView'
import { getActivitySnapshot } from '@/lib/activityStore'
import { getPrSnapshot } from '@/lib/prStore'
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
// View union type
// ---------------------------------------------------------------------------

export type View =
  | { kind: 'project'; projectId: string }
  | { kind: 'sessions' }
  | { kind: 'workspace'; workspaceId: string; projectId: string }
  | { kind: 'settings'; section?: SettingsSectionId }

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

  if (view.kind === 'sessions') {
    // Route key stays 'sessions' for back-compat with uiState serialisation;
    // the visible label and component are now "Workspaces".
    return (
      <WorkspacesView
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
