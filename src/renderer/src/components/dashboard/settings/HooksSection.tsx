import type React from 'react'

export function HooksSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Hooks</h2>
        <p className="text-xs text-text-muted mt-1">
          Lifecycle event handlers — PreToolUse, PostToolUse, SessionStart, etc. Power-user JSON
          editor for hook definitions.
        </p>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">Coming in a future update</p>
        <p className="text-xs text-text-muted mt-2 max-w-md mx-auto">
          Will provide a power-user JSON editor for defining lifecycle event handlers (PreToolUse,
          PostToolUse, SessionStart, and more) that run shell commands or scripts at key points in
          every claude session.
        </p>
      </div>
    </div>
  )
}
