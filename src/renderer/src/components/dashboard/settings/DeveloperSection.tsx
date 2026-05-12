import type React from 'react'

export function DeveloperSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Developer</h2>
        <p className="text-xs text-text-muted mt-1">
          Debug logging level, telemetry toggle, experimental feature flags, raw API body extras.
        </p>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">Coming in a future update</p>
        <p className="text-xs text-text-muted mt-2 max-w-md mx-auto">
          Will expose debug logging verbosity, telemetry opt-out, experimental feature flags for
          in-flight capabilities, and a raw API body extras field for advanced claude CLI
          pass-through options.
        </p>
      </div>
    </div>
  )
}
