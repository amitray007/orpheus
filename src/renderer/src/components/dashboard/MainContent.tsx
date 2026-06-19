import { ProjectView } from './ProjectView'
import { WorkspacesView } from './WorkspacesView'
import { SettingsView } from './SettingsView'
import { WorkspaceView } from './WorkspaceView'
import { Eyebrow } from './settings/primitives'
import type {
  GhPullRequest,
  GitStatus,
  ProjectRecord,
  SessionRecord,
  WorkspaceActivityDetail,
  WorkspaceRecord
} from '@shared/types'

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
  | { kind: 'settings' }

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
  workspaceActivities?: Record<string, WorkspaceActivityDetail>
  onResumedInWorkspace: (workspace: WorkspaceRecord) => void | Promise<void>
  // Workspaces view props
  projects?: ProjectRecord[]
  allWorkspaces?: WorkspaceRecord[]
  allSessions?: SessionRecord[]
  gitStatusByWorkspaceId?: Record<string, GitStatus | null>
  prByWorkspaceId?: Record<string, GhPullRequest | null>
  titleByWorkspaceId?: Record<string, string>
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
  workspaceActivities,
  onResumedInWorkspace,
  projects,
  allWorkspaces,
  allSessions,
  gitStatusByWorkspaceId,
  prByWorkspaceId,
  titleByWorkspaceId,
  fetchGithubAvatars = true
}: MainContentProps): React.JSX.Element {
  if (view.kind === 'settings') {
    return <SettingsView />
  }

  if (view.kind === 'sessions') {
    // Route key stays 'sessions' for back-compat with uiState serialisation;
    // the visible label and component are now "Workspaces".
    return (
      <WorkspacesView
        onNavigateToWorkspace={onSelectWorkspace}
        projects={projects ?? []}
        workspaces={allWorkspaces ?? []}
        workspaceActivities={workspaceActivities ?? {}}
        titleByWorkspaceId={titleByWorkspaceId ?? {}}
        sessions={allSessions ?? []}
        gitStatusByWorkspaceId={gitStatusByWorkspaceId}
        prByWorkspaceId={prByWorkspaceId}
      />
    )
  }

  if (view.kind === 'workspace') {
    if (!workspace || !project) {
      return (
        <div className="flex flex-col gap-6">
          <PlaceholderSection title="Workspace not found" />
        </div>
      )
    }
    // key forces React to unmount the old WorkspaceView and mount a fresh
    // one when the workspace changes — without this the useEffect with []
    // deps doesn't re-run and terminal:hide/mount never fires.
    // Seed initialDetail from the live activity map so re-mount after
    // navigation keeps the right glyph (tool / compacting / asking) instead
    // of falling back to the coarser status-derived value until the next
    // hook event lands.
    return (
      <WorkspaceView
        key={workspace.id}
        workspace={workspace}
        initialDetail={workspaceActivities?.[workspace.id]}
        pr={prByWorkspaceId?.[workspace.id] ?? null}
        onSelectWorkspace={onSelectWorkspace}
        allWorkspaces={allWorkspaces}
      />
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
      workspaceActivities={workspaceActivities}
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
