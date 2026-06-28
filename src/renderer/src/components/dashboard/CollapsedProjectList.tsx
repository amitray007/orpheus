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
  // Every entry in the collapsed rail renders inside an identical fixed-size
  // tile (TILE square, centered content, shrink-0) so heterogeneous content —
  // identicon SVG, GitHub avatar, the + glyph — always lays out predictably and
  // can never be squished by the overflowing flex column.
  const TILE =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'

  return (
    <div className="flex flex-col items-center gap-1 overflow-y-auto flex-1 min-h-0 no-scrollbar">
      <button
        type="button"
        aria-label="Add project"
        disabled={addingProject}
        className={[
          TILE,
          'mb-1',
          addingProject
            ? 'text-text-muted opacity-50 cursor-wait'
            : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
        onClick={onAddProject}
      >
        <Plus size={14} weight="bold" />
      </button>
      {!projectsLoading &&
        projects.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onSelectProject(p.id)}
            title={p.name}
            aria-label={p.name}
            className={[
              TILE,
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
