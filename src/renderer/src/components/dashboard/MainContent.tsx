import { ProjectView } from './ProjectView'
import { WorkspacesView } from './WorkspacesView'
import { SettingsView } from './SettingsView'
import { WorkspaceView } from './WorkspaceView'
import type {
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
      <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-2">
        {title}
      </h2>
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
  onRenameWorkspace: (workspaceId: string, projectId: string, newName: string) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void | Promise<void>
  workspaceActivities?: Record<string, WorkspaceActivityDetail>
  onResumedInWorkspace: (workspace: WorkspaceRecord) => void | Promise<void>
  // Workspaces view props
  projects?: ProjectRecord[]
  allWorkspaces?: WorkspaceRecord[]
  allSessions?: SessionRecord[]
  gitStatusByWorkspaceId?: Record<string, GitStatus | null>
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
  gitStatusByWorkspaceId
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
        sessions={allSessions ?? []}
        gitStatusByWorkspaceId={gitStatusByWorkspaceId}
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
    return (
      <WorkspaceView
        key={workspace.id}
        workspace={workspace}
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
    />
  )
}
