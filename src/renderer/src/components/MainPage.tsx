import { useState } from 'react'
import { Button } from './Button'
import type { ExistingProject } from '@shared/types'

function formatRelativeTime(ms: number | null): string {
  if (ms === null) return '—'
  const diff = Date.now() - ms
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} d ago`
}

interface MainPageProps {
  existingProjects?: ExistingProject[]
}

export function MainPage({ existingProjects = [] }: MainPageProps): React.JSX.Element {
  const [openingFolder, setOpeningFolder] = useState(false)

  async function handleOpenFolder(): Promise<void> {
    if (openingFolder) return
    setOpeningFolder(true)
    try {
      const path = await window.api.config.openFolder()
      if (path) {
        console.log('[orpheus] folder picked:', path)
      }
    } finally {
      setOpeningFolder(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center w-full h-full gap-0">
      <div className="flex flex-col items-center gap-2">
        {/* Wordmark */}
        <h1 className="text-5xl font-bold tracking-tight text-text-primary">
          Orpheus<span className="text-accent">.</span>
        </h1>

        {/* Tagline */}
        <p className="text-sm text-text-secondary">A Mac IDE built around Claude Code.</p>

        {/* CTAs */}
        <div className="flex gap-3 mt-8">
          <Button variant="primary" size="md" loading={openingFolder} onClick={handleOpenFolder}>
            + Add repository
          </Button>
          <Button variant="secondary" size="md" loading={openingFolder} onClick={handleOpenFolder}>
            Open folder…
          </Button>
        </div>
      </div>

      {/* Existing projects from Claude Code */}
      {existingProjects.length > 0 && (
        <div className="mt-12 w-full max-w-xl px-4">
          <p className="text-xs font-medium text-text-secondary uppercase tracking-widest mb-3">
            Found in Claude Code
          </p>
          <div className="flex flex-col max-h-64 overflow-y-auto rounded-lg border border-border-default divide-y divide-border-default">
            {existingProjects.map((project) => (
              <div
                key={project.encodedName}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-surface-raised transition-colors duration-100"
              >
                {/* Left: name + path */}
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm font-semibold text-text-primary truncate">
                    {project.name}
                  </span>
                  <span className="text-xs text-text-muted truncate">{project.path}</span>
                </div>

                {/* Middle: metadata */}
                <span className="text-xs text-text-muted shrink-0">
                  {project.sessionCount} session{project.sessionCount === 1 ? '' : 's'} ·{' '}
                  {formatRelativeTime(project.lastActivity)}
                </span>

                {/* Right: open button (stubbed — real wiring comes with project persistence) */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleOpenFolder}
                  className="shrink-0"
                >
                  Open
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
