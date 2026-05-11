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
  onProjectRemoved: () => void
  onNavigateToProject: (id: string) => void
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onWorkspaceArchived: (projectId: string) => void
  onWorkspaceCreated: (projectId: string, name: string, cwd: string) => Promise<void>
}

export function MainContent({
  view,
  project,
  workspace,
  onProjectRemoved,
  onNavigateToProject,
  onSelectWorkspace,
  onWorkspaceArchived,
  onWorkspaceCreated
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
    return (
      <WorkspaceView
        workspace={workspace}
        project={project}
        onArchive={() => onWorkspaceArchived(project.id)}
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
      onRemoved={onProjectRemoved}
      onSelectWorkspace={(wsId) => onSelectWorkspace(wsId, project.id)}
      onWorkspaceCreated={(name, cwd) => onWorkspaceCreated(project.id, name, cwd)}
    />
  )
}
