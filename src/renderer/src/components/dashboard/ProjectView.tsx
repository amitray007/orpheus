import { useState } from 'react'
import { Folder, Archive } from '@phosphor-icons/react'
import type { ProjectRecord } from '@shared/types'

interface ProjectViewProps {
  project: ProjectRecord
  onArchived: () => void
}

export function ProjectView({ project, onArchived }: ProjectViewProps): React.JSX.Element {
  const [archiving, setArchiving] = useState(false)

  async function handleArchive(): Promise<void> {
    if (archiving) return
    setArchiving(true)
    try {
      await window.api.projects.archive(project.id)
      onArchived()
    } catch (err) {
      console.error('[project-view] archive failed', err)
      setArchiving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="mt-0.5 p-2 rounded-lg bg-surface-raised border border-border-default flex-shrink-0">
            <Folder size={20} weight="fill" className="text-accent" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-text-primary truncate">{project.name}</h1>
            <p className="text-xs text-text-muted mt-0.5 truncate" title={project.path}>
              {project.path}
            </p>
          </div>
        </div>

        <button
          onClick={handleArchive}
          disabled={archiving}
          className={[
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
            'border border-border-default transition-colors duration-150 flex-shrink-0',
            archiving
              ? 'opacity-40 cursor-wait text-text-muted'
              : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
          ].join(' ')}
        >
          <Archive size={14} weight="regular" />
          {archiving ? 'Archiving…' : 'Archive'}
        </button>
      </div>

      {/* Sessions section — placeholder until commit 3 wires the real list */}
      <section>
        <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Sessions
        </h2>
        <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-sm text-text-muted text-center">
          Loading sessions…
        </div>
      </section>
    </div>
  )
}
