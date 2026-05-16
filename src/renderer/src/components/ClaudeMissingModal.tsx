import { useState } from 'react'
import { Button } from './Button'

interface ClaudeMissingModalProps {
  onRecheck: () => Promise<void>
}

export function ClaudeMissingModal({ onRecheck }: ClaudeMissingModalProps): React.JSX.Element {
  const [rechecking, setRechecking] = useState(false)

  async function handleRecheck(): Promise<void> {
    if (rechecking) return
    setRechecking(true)
    // Ensure the spinner stays visible for at least MIN_VISIBLE_MS — the
    // doctor IPC resolves almost instantly locally and the spinner would
    // otherwise just flash. Long enough to read the spinner; short enough
    // to still feel snappy.
    const MIN_VISIBLE_MS = 600
    const started = Date.now()
    try {
      await onRecheck()
    } finally {
      const elapsed = Date.now() - started
      if (elapsed < MIN_VISIBLE_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_VISIBLE_MS - elapsed))
      }
      setRechecking(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* Modal card — pointer-events-auto so clicks land here, not behind */}
      <div className="relative max-w-md w-full mx-4 bg-surface-overlay border border-border-default rounded-lg p-6 flex flex-col gap-4 pointer-events-auto">
        {/* Headline row: icon + title */}
        <div className="flex items-center gap-2">
          <span className="text-yellow-400 text-lg">⚠</span>
          <h2 className="text-lg font-semibold text-text-primary">Claude Code required</h2>
        </div>

        {/* Body */}
        <p className="text-sm text-text-secondary">
          Orpheus runs on the <code className="text-accent font-mono">claude</code> CLI. Install
          Claude Code to continue.
        </p>

        {/* Install command — canonical source: https://code.claude.com/docs/en/setup */}
        <pre className="bg-surface-raised border border-border-default rounded px-3 py-2 text-xs font-mono text-text-primary overflow-x-auto">
          curl -fsSL https://claude.ai/install.sh | bash
        </pre>

        {/* Action row */}
        <div className="flex items-center gap-3">
          <Button variant="primary" size="md" loading={rechecking} onClick={handleRecheck}>
            Re-check
          </Button>
          <a
            href="https://code.claude.com/docs/en/setup"
            target="_blank"
            rel="noreferrer"
            className="text-sm text-text-secondary hover:text-text-primary transition-colors duration-150 cursor-pointer"
          >
            Read docs ↗
          </a>
        </div>

        {/* Escape-hatch hint */}
        <p className="text-xs text-text-muted">Press ⌘Q to quit Orpheus.</p>
      </div>
    </div>
  )
}
