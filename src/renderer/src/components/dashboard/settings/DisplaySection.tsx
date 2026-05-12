import type React from 'react'

export function DisplaySection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Display</h2>
        <p className="text-xs text-text-muted mt-1">
          Terminal theme override, claude output style, TUI mode (default / fullscreen), editor
          keybindings (normal / vim), accessibility toggles.
        </p>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">Coming in a future update</p>
        <p className="text-xs text-text-muted mt-2 max-w-md mx-auto">
          Will surface controls for terminal theme override, claude output style (Default /
          Explanatory / Proactive / Learning), TUI mode (default / fullscreen), and editor
          keybindings (normal / vim).
        </p>
      </div>
    </div>
  )
}
