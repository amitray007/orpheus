import { ProjectView } from './ProjectView'
import { SessionsView } from './SessionsView'
import { WorkspaceView } from './WorkspaceView'
import type { ProjectRecord, WorkspaceRecord } from '@shared/types'

// ---------------------------------------------------------------------------
// Dashboard home placeholder sections
// ---------------------------------------------------------------------------

function PlaceholderSection({ title }: { title: string }): React.JSX.Element {
  return (
    <section>
      <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-2">
        {title}
      </h2>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-sm text-text-muted text-center">
        Coming soon
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// View union type
// ---------------------------------------------------------------------------

export type View =
  | { kind: 'dashboard' }
  | { kind: 'project'; projectId: string }
  | { kind: 'sessions' }
  | { kind: 'workspace'; workspaceId: string; projectId: string }

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
  onNavigateToProject: (id: string) => void
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onAddWorkspace: (projectId: string) => void | Promise<void>
  onRenameWorkspace: (workspaceId: string, projectId: string, newName: string) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onUnarchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void | Promise<void>
}

export function MainContent({
  view,
  project,
  workspace,
  workspacesForProject,
  onRequestRemoveProject,
  onNavigateToProject,
  onSelectWorkspace,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onUnarchiveWorkspace,
  onToggleWorkspacePin
}: MainContentProps): React.JSX.Element {
  if (view.kind === 'dashboard') {
    return (
      <div className="flex flex-col gap-6">
        <PlaceholderSection title="Activity" />
        <PlaceholderSection title="Recent Projects" />
        <PlaceholderSection title="Recent Sessions" />
      </div>
    )
  }

  if (view.kind === 'sessions') {
    return <SessionsView onNavigateToProject={onNavigateToProject} />
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
    return <WorkspaceView key={workspace.id} workspace={workspace} />
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
      onUnarchiveWorkspace={onUnarchiveWorkspace}
      onToggleWorkspacePin={onToggleWorkspacePin}
    />
  )
}
