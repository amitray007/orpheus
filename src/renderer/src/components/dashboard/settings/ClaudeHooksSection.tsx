import type React from 'react'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// ClaudeHooksSection — lifecycle event handlers
// ---------------------------------------------------------------------------

const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact'
]

export function ClaudeHooksSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Hooks</h2>
        <p className="text-xs text-text-muted mt-1">
          Lifecycle event handlers — run shell scripts or commands at key points in every Claude
          Code session.
        </p>
      </div>

      {/* What are hooks */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          What are hooks?
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <p className="text-sm text-text-secondary leading-relaxed">
            Hooks let you run arbitrary shell commands at lifecycle events — before a tool fires,
            after a session ends, when Claude stops, and more. They're defined in{' '}
            <code className="text-xs font-mono bg-surface-overlay px-1 py-0.5 rounded">
              ~/.claude/settings.json
            </code>{' '}
            and scoped per event type.
          </p>
          <p className="text-xs text-text-muted mt-2">
            Supported events: {HOOK_EVENTS.join(', ')}
          </p>
        </div>
      </section>

      {/* Configured hooks */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Configured hooks
          </h3>
          <ComingSoonChip />
        </div>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-6 text-center">
          <p className="text-xs text-text-muted">No hooks configured</p>
          <p className="text-xs text-text-muted mt-1">
            Hook UI editor is coming soon. Until then, edit{' '}
            <code className="font-mono bg-surface-overlay px-1 py-0.5 rounded">
              ~/.claude/settings.json
            </code>{' '}
            directly.
          </p>
          <button
            disabled
            className="mt-4 px-4 py-2 rounded-md text-xs font-medium bg-accent/10 text-accent border border-accent/20 opacity-50 cursor-not-allowed"
          >
            Add hook
          </button>
        </div>
      </section>

      {/* Power-user note */}
      <section className="flex flex-col gap-3">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Power-user tip
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <p className="text-xs text-text-muted leading-relaxed">
            You can configure hooks now by editing{' '}
            <code className="font-mono bg-surface-overlay px-1 py-0.5 rounded">
              ~/.claude/settings.json
            </code>{' '}
            directly. The GUI editor will surface and manage those definitions once it lands.
          </p>
        </div>
      </section>
    </div>
  )
}
