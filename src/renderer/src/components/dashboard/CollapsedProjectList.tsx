import type React from 'react'
import { memo } from 'react'
import { Plus } from '@phosphor-icons/react'
import type { ProjectRecord } from '@shared/types'
import { Identicon } from '../Identicon'

// ---------------------------------------------------------------------------
// Collapsed sidebar — identicon strip shown when the sidebar is narrow
// ---------------------------------------------------------------------------

interface CollapsedProjectListProps {
  projects: ProjectRecord[]
  projectsLoading: boolean
  fetchGithubAvatars: boolean
  /** Returns true when the given project should appear active (highlighted). */
  isProjectActive: (projectId: string) => boolean
  addingProject: boolean
  onSelectProject: (id: string) => void
  onAddProject: () => void
}

export const CollapsedProjectList = memo(function CollapsedProjectList({
  projects,
  projectsLoading,
  fetchGithubAvatars,
  isProjectActive,
  addingProject,
  onSelectProject,
  onAddProject
}: CollapsedProjectListProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 items-center overflow-y-auto flex-1 min-h-0 no-scrollbar">
      <div className="flex justify-center mb-1">
        <button
          type="button"
          aria-label="Add project"
          disabled={addingProject}
          className={[
            'p-1 rounded transition-colors duration-150',
            addingProject
              ? 'text-text-muted opacity-50 cursor-wait'
              : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
          ].join(' ')}
          onClick={onAddProject}
        >
          <Plus size={14} weight="bold" />
        </button>
      </div>
      {!projectsLoading &&
        projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectProject(p.id)}
            title={p.name}
            aria-label={p.name}
            className={[
              'p-1 rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
              isProjectActive(p.id) ? 'bg-accent/15' : 'hover:bg-surface-overlay'
            ].join(' ')}
          >
            <Identicon
              seed={p.path}
              size={22}
              avatarUrl={fetchGithubAvatars ? p.githubAvatarUrl : null}
            />
          </button>
        ))}
    </div>
  )
})
