import { useEffect } from 'react'
import { Button } from './Button'
import type { DoctorResult } from '@shared/types'

// ---------------------------------------------------------------------------
// ClaudeCodeCard
// ---------------------------------------------------------------------------

interface ClaudeCodeCardProps {
  doctor: DoctorResult
  onRecheck: () => void
}

function ClaudeCodeCard({ doctor, onRecheck }: ClaudeCodeCardProps): React.JSX.Element {
  return (
    <div className="flex-1 bg-surface-raised border border-border-default rounded-lg p-4 flex flex-col gap-3">
      {/* Icon + name */}
      <div>
        <div className="flex items-center gap-2">
          <span className="text-accent text-lg">◆</span>
          <span className="text-base font-semibold text-text-primary">Claude Code</span>
        </div>
        <p className="text-sm text-text-secondary mt-1">{"Anthropic's coding agent."}</p>
      </div>

      {/* Status row */}
      <div className="mt-2">
        {doctor.claudeInstalled ? (
          <p className="text-sm text-text-primary">
            <span className="text-accent">✓</span>{' '}
            <span>Connected · </span>
            <span className="text-text-secondary">v{doctor.claudeVersion}</span>
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-text-primary">
              <span className="text-yellow-400">⚠</span> Not installed
            </p>
            {/* TODO: verify the exact Claude Code install command — this is a placeholder.
                Real command at https://docs.claude.com/en/docs/claude-code/setup
                or https://claude.com/code/install */}
            <pre className="bg-surface-overlay border border-border-default rounded px-3 py-2 text-xs font-mono text-text-primary overflow-x-auto">
              curl -fsSL https://claude.ai/install.sh | sh
            </pre>
            <button
              onClick={onRecheck}
              className="text-xs text-accent hover:text-accent-hover text-left w-fit transition-colors duration-150"
            >
              Re-check
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// MoreProvidersCard
// ---------------------------------------------------------------------------

function MoreProvidersCard(): React.JSX.Element {
  return (
    <div className="flex-1 bg-surface-raised border border-border-default rounded-lg p-4 flex flex-col gap-3">
      {/* Icon + name */}
      <div>
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-lg">+</span>
          <span className="text-base font-semibold text-text-secondary">More providers</span>
        </div>
        <p className="text-sm text-text-muted mt-1">{"GitHub, agents, and more — coming soon."}</p>
      </div>

      {/* Provider docs link */}
      <a
        href="https://docs.claude.com/en/docs/claude-code"
        target="_blank"
        rel="noreferrer"
        className="text-xs text-text-secondary hover:text-text-primary mt-auto transition-colors duration-150"
      >
        Provider docs ↗
      </a>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Setup (top-level)
// ---------------------------------------------------------------------------

interface SetupProps {
  doctor: DoctorResult
  onFinish: () => void
  onRecheck: () => void
}

export function Setup({ doctor, onFinish, onRecheck }: SetupProps): React.JSX.Element {
  // Keyboard shortcut: ⌘↩ → finish setup (only when Claude is installed)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.metaKey && e.key === 'Enter' && doctor.claudeInstalled) {
        onFinish()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [doctor.claudeInstalled, onFinish])

  return (
    <div className="flex flex-col items-center w-full h-full px-6 pb-6">
      {/* Header */}
      <div className="flex flex-col items-center mt-16">
        <h1 className="text-4xl font-bold tracking-tight text-text-primary">
          Orpheus<span className="text-accent">.</span>
        </h1>
        <p className="text-sm text-text-secondary mt-2">{"Let's get you set up."}</p>
      </div>

      {/* Provider cards row */}
      <div className="mt-12 flex gap-4 w-full max-w-2xl">
        <ClaudeCodeCard doctor={doctor} onRecheck={onRecheck} />
        <MoreProvidersCard />
      </div>

      {/* Flex spacer */}
      <div className="flex-1" />

      {/* Finish setup button — bottom right */}
      <div className="mt-auto self-end">
        <Button
          variant="primary"
          size="md"
          disabled={!doctor.claudeInstalled}
          onClick={onFinish}
        >
          Finish setup<span className="ml-2 text-xs opacity-60">⌘↩</span>
        </Button>
      </div>
    </div>
  )
}
