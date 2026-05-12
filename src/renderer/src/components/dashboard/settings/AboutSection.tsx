import type React from 'react'

export function AboutSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">About</h2>
        <p className="text-xs text-text-muted mt-1">
          Claude Code version, Orpheus version, key file paths, links to documentation.
        </p>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">Coming in a future update</p>
        <p className="text-xs text-text-muted mt-2 max-w-md mx-auto">
          Will display the installed Claude Code version, Orpheus app version, key file paths
          (SQLite database, config directory, log files), and links to documentation and release
          notes.
        </p>
      </div>
    </div>
  )
}
