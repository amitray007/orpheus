import type React from 'react'

export function MemorySection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Memory &amp; Context</h2>
        <p className="text-xs text-text-muted mt-1">
          Auto-load CLAUDE.md behavior, context compaction threshold, max output and context token
          limits.
        </p>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">Coming in a future update</p>
        <p className="text-xs text-text-muted mt-2 max-w-md mx-auto">
          Will expose fine-grained controls for CLAUDE.md auto-load behavior per workspace,
          context compaction thresholds, and max output and context token limits to tune cost vs.
          capability.
        </p>
      </div>
    </div>
  )
}
