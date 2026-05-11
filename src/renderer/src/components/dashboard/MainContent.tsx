import { ProjectView } from './ProjectView'
import type { ProjectRecord } from '@shared/types'

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
// View union type (mirrors Dashboard.tsx)
// ---------------------------------------------------------------------------

export type View =
  | { kind: 'dashboard' }
  | { kind: 'project'; projectId: string }
  | { kind: 'sessions' }

// ---------------------------------------------------------------------------
// MainContent
// ---------------------------------------------------------------------------

interface MainContentProps {
  view: View
  project: ProjectRecord | undefined
  onProjectArchived: () => void
  onNavigateToProject: (id: string) => void
}

export function MainContent({
  view,
  project,
  onProjectArchived
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
    // SessionsView will be wired in commit 3
    return (
      <div className="flex flex-col gap-6">
        <PlaceholderSection title="Sessions" />
      </div>
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

  return <ProjectView project={project} onArchived={onProjectArchived} />
}
