import type React from 'react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// ClaudeToolsSection — MCP servers, bash limits, concurrency, browser integration
// ---------------------------------------------------------------------------

export function ClaudeToolsSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Tools</h2>
        <p className="text-xs text-text-muted mt-1">
          MCP server toggles (auto-discovered from .mcp.json), Bash limits, tool concurrency, and
          browser integration.
        </p>
      </div>

      {/* MCP servers */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          MCP servers
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-text-primary">Discovered servers</span>
            <ComingSoonChip />
          </div>
          <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
            <p className="text-xs text-text-muted">No .mcp.json detected in workspace</p>
            <p className="text-xs text-text-muted mt-1">
              Drop a .mcp.json in your project root — servers will appear here with per-server
              enable/disable toggles.
            </p>
          </div>
        </div>
      </section>

      {/* Bash limits */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Bash limits
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Bash timeout"
            description="Maximum seconds a single Bash command may run before it is killed."
          >
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 opacity-50 pointer-events-none">
                <input
                  disabled
                  placeholder="120"
                  className="w-20 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono text-right cursor-not-allowed"
                />
                <span className="text-xs text-text-muted">s</span>
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Bash max output"
            description="Maximum characters of stdout/stderr captured per command. Excess is truncated."
          >
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 opacity-50 pointer-events-none">
                <input
                  disabled
                  placeholder="25000"
                  className="w-20 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono text-right cursor-not-allowed"
                />
                <span className="text-xs text-text-muted">chars</span>
              </div>
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Concurrency & integrations */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Concurrency &amp; integrations
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Tool concurrency"
            description="How many tools Claude may run in parallel in a single turn."
          >
            <div className="flex items-center gap-2">
              <input
                disabled
                placeholder="4"
                className="w-16 px-3 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-muted placeholder-text-muted font-mono text-right opacity-50 cursor-not-allowed"
              />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Browser integration"
            description="Allow Claude to open and interact with URLs via an embedded headless browser."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>
    </div>
  )
}

function DisabledToggle(): React.JSX.Element {
  return (
    <div className="relative w-9 h-5 rounded-full bg-surface-overlay border border-border-default pointer-events-none opacity-50">
      <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm" />
    </div>
  )
}
