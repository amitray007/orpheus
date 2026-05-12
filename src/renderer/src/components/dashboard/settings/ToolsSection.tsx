import type React from 'react'

export function ToolsSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Tools</h2>
        <p className="text-xs text-text-muted mt-1">
          MCP server toggles (auto-discovered from .mcp.json), bash command timeout, tool
          concurrency, browser integration.
        </p>
      </div>
      <div className="bg-surface-raised border border-border-default rounded-lg p-8 text-center">
        <p className="text-sm text-text-muted">Coming in a future update</p>
        <p className="text-xs text-text-muted mt-2 max-w-md mx-auto">
          Will list MCP servers auto-discovered from .mcp.json with per-server enable/disable
          toggles, bash command timeout configuration, tool concurrency limits, and browser
          integration settings.
        </p>
      </div>
    </div>
  )
}
