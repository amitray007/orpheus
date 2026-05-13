import { useEffect, useState } from 'react'
import type React from 'react'
import type { ClaudeGlobalSettings, DiscoveredMcpServer } from '@shared/types'
import { SettingRow, Toggle, NumberInput } from './primitives'

// ---------------------------------------------------------------------------
// ClaudeToolsSection — MCP servers, bash limits, concurrency, browser integration
// ---------------------------------------------------------------------------

type McpGroup = { key: string; label: string; servers: DiscoveredMcpServer[] }

function groupServers(servers: DiscoveredMcpServer[]): McpGroup[] {
  const groups: McpGroup[] = []

  const userServers = servers.filter((s) => s.source === 'user')
  if (userServers.length > 0) {
    groups.push({ key: 'user', label: 'User · ~/.claude.json', servers: userServers })
  }

  const projectGroups = new Map<string, McpGroup>()
  for (const s of servers) {
    if (s.source !== 'project' || !s.projectId) continue
    let group = projectGroups.get(s.projectId)
    if (!group) {
      group = {
        key: `project:${s.projectId}`,
        label: `Project · ${s.projectName ?? s.projectId}`,
        servers: []
      }
      projectGroups.set(s.projectId, group)
    }
    group.servers.push(s)
  }
  for (const g of projectGroups.values()) groups.push(g)

  return groups
}

export function ClaudeToolsSection(): React.JSX.Element {
  const [settings, setSettings] = useState<ClaudeGlobalSettings | null>(null)
  const [servers, setServers] = useState<DiscoveredMcpServer[]>([])
  const [serversLoading, setServersLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.api.claudeSettings
      .get()
      .then((s) => { if (!cancelled) setSettings(s) })
      .catch((err) => console.error('[tools-settings] load failed', err))
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    window.api.mcp
      .listServers()
      .then((s) => { setServers(s); setServersLoading(false) })
      .catch((err) => { console.error('[tools-settings] mcp list failed', err); setServersLoading(false) })
  }, [])

  function patch(p: Partial<ClaudeGlobalSettings>): void {
    if (!settings) return
    setSettings({ ...settings, ...p })
    window.api.claudeSettings.update(p).catch((err) => {
      console.error('[tools-settings] update failed; refetching', err)
      window.api.claudeSettings
        .get()
        .then((s) => setSettings(s))
        .catch(console.error)
    })
  }

  function toggleMcpServer(name: string, enabled: boolean): void {
    if (!settings) return
    const disabled = new Set(settings.disabledMcpServers)
    if (enabled) disabled.delete(name)
    else disabled.add(name)
    patch({ disabledMcpServers: Array.from(disabled).sort() })
  }

  if (!settings) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Tools</h2>
          <p className="text-xs text-text-muted mt-1">
            MCP server toggles, Bash limits, tool concurrency, and browser integration.
          </p>
        </div>
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Tools</h2>
        <p className="text-xs text-text-muted mt-1">
          MCP server toggles (auto-discovered from ~/.claude.json and each project's .mcp.json),
          Bash limits, tool concurrency, and browser integration. Changes save automatically.
        </p>
      </div>

      {/* MCP servers */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          MCP servers (discovered)
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          {serversLoading ? (
            <McpSkeleton />
          ) : servers.length === 0 ? (
            <div className="rounded-md border border-dashed border-border-default/60 bg-surface-overlay px-4 py-6 text-center">
              <p className="text-xs text-text-muted">
                No MCP servers configured in ~/.claude.json or any project's .mcp.json
              </p>
              <p className="text-xs text-text-muted mt-1">
                Add servers to either file and they will appear here with per-server
                enable/disable toggles.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {groupServers(servers).map((group) => (
                <div key={group.key} className="flex flex-col">
                  <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">
                    {group.label}
                  </div>
                  {group.servers.map((s) => (
                    <div
                      key={`${group.key}:${s.name}`}
                      className="flex items-center justify-between py-2 border-b border-border-default/40 last:border-b-0"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm text-text-primary truncate">{s.name}</span>
                        <span className="text-[10px] uppercase tracking-wider text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 flex-shrink-0">
                          {s.transport}
                        </span>
                      </div>
                      <Toggle
                        ariaLabel={`${s.name} enabled`}
                        value={!settings.disabledMcpServers.includes(s.name)}
                        onChange={(enabled) => toggleMcpServer(s.name, enabled)}
                      />
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Bash limits */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Bash limits
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Bash default timeout (ms)"
            description="Default timeout in milliseconds for each Bash command. Leave empty to use claude's default (120000 ms)."
            mapsTo="BASH_DEFAULT_TIMEOUT_MS"
          >
            <NumberInput
              value={settings.bashDefaultTimeoutMs}
              onChange={(v) => patch({ bashDefaultTimeoutMs: v })}
              placeholder="120000"
            />
          </SettingRow>
          <SettingRow
            label="Bash max timeout (ms)"
            description="Maximum timeout a user may request for a single Bash command. Leave empty to use claude's default (600000 ms)."
            mapsTo="BASH_MAX_TIMEOUT_MS"
          >
            <NumberInput
              value={settings.bashMaxTimeoutMs}
              onChange={(v) => patch({ bashMaxTimeoutMs: v })}
              placeholder="600000"
            />
          </SettingRow>
          <SettingRow
            label="Bash max output length"
            description="Maximum characters of stdout/stderr captured per command. Leave empty to let claude auto-truncate."
            mapsTo="BASH_MAX_OUTPUT_LENGTH"
          >
            <NumberInput
              value={settings.bashMaxOutputLength}
              onChange={(v) => patch({ bashMaxOutputLength: v })}
              placeholder="auto-truncate"
            />
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
            description="How many tools Claude may run in parallel in a single turn. Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY"
          >
            <NumberInput
              value={settings.toolConcurrency}
              onChange={(v) => patch({ toolConcurrency: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Browser integration"
            description="Enable claude's Chrome browser integration for web browsing and interaction."
          >
            <Toggle
              ariaLabel="Browser integration enabled"
              value={settings.browserIntegration}
              onChange={(v) => patch({ browserIntegration: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* File operations */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          File operations
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Bash maintains project cwd"
            description="Each Bash command resets its working directory to the project root (CLAUDE_CODE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1)."
            mapsTo="CLAUDE_CODE_BASH_MAINTAIN_PROJECT_WORKING_DIR"
          >
            <Toggle
              ariaLabel="Bash maintains project cwd"
              value={settings.bashMaintainCwd}
              onChange={(v) => patch({ bashMaintainCwd: v })}
            />
          </SettingRow>
          <SettingRow
            label="Perforce mode"
            description="Enable Perforce VCS integration for source control operations (CLAUDE_CODE_PERFORCE_MODE=1)."
            mapsTo="CLAUDE_CODE_PERFORCE_MODE"
          >
            <Toggle
              ariaLabel="Perforce mode"
              value={settings.perforceMode}
              onChange={(v) => patch({ perforceMode: v })}
            />
          </SettingRow>
          <SettingRow
            label="Glob includes hidden files (override)"
            description="When enabled, sets CLAUDE_CODE_GLOB_HIDDEN=1. Note: claude's default already includes hidden files. To force-exclude them, use Custom env vars to set CLAUDE_CODE_GLOB_HIDDEN=0."
            mapsTo="CLAUDE_CODE_GLOB_HIDDEN"
          >
            <Toggle
              ariaLabel="Glob includes hidden files override"
              value={settings.globHidden}
              onChange={(v) => patch({ globHidden: v })}
            />
          </SettingRow>
          <SettingRow
            label="Glob ignores .gitignore (override)"
            description="When enabled, sets CLAUDE_CODE_GLOB_NO_IGNORE=1 so globs skip .gitignore patterns. To force-enable .gitignore respect, use Custom env vars to set CLAUDE_CODE_GLOB_NO_IGNORE=0."
            mapsTo="CLAUDE_CODE_GLOB_NO_IGNORE"
          >
            <Toggle
              ariaLabel="Glob ignores .gitignore override"
              value={settings.globNoIgnore}
              onChange={(v) => patch({ globNoIgnore: v })}
            />
          </SettingRow>
          <SettingRow
            label="Glob timeout (seconds)"
            description="Maximum seconds to spend on a single glob operation (CLAUDE_CODE_GLOB_TIMEOUT_SECONDS). Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_GLOB_TIMEOUT_SECONDS"
          >
            <NumberInput
              value={settings.globTimeoutSeconds}
              onChange={(v) => patch({ globTimeoutSeconds: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Disable file checkpointing"
            description="Prevent Claude from creating file snapshots before edits for potential rollback (CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING=1)."
            mapsTo="CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING"
          >
            <Toggle
              ariaLabel="Disable file checkpointing"
              value={settings.disableFileCheckpointing}
              onChange={(v) => patch({ disableFileCheckpointing: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable attachments"
            description="Prevent users from attaching files to Claude sessions (CLAUDE_CODE_DISABLE_ATTACHMENTS=1)."
            mapsTo="CLAUDE_CODE_DISABLE_ATTACHMENTS"
          >
            <Toggle
              ariaLabel="Disable attachments"
              value={settings.disableAttachments}
              onChange={(v) => patch({ disableAttachments: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Shell */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Shell
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Shell override"
            description="Use a specific shell binary instead of the default for Bash tool invocations (CLAUDE_CODE_SHELL)."
            mapsTo="CLAUDE_CODE_SHELL"
          >
            <input
              type="text"
              value={settings.shellOverride}
              onChange={(e) => patch({ shellOverride: e.target.value })}
              onBlur={(e) => patch({ shellOverride: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              placeholder="/bin/zsh"
              className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono cursor-text"
            />
          </SettingRow>
          <SettingRow
            label="Shell prefix"
            description="Prepend a command prefix to every Bash invocation, e.g. to lower process priority (CLAUDE_CODE_SHELL_PREFIX)."
            mapsTo="CLAUDE_CODE_SHELL_PREFIX"
          >
            <input
              type="text"
              value={settings.shellPrefix}
              onChange={(e) => patch({ shellPrefix: e.target.value })}
              onBlur={(e) => patch({ shellPrefix: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              placeholder="nice -n 19"
              className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono cursor-text"
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}

function McpSkeleton(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 animate-pulse">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center justify-between py-2">
          <div className="flex items-center gap-2">
            <div className="h-4 w-32 rounded bg-surface-overlay" />
            <div className="h-4 w-10 rounded bg-surface-overlay" />
          </div>
          <div className="h-5 w-9 rounded-full bg-surface-overlay" />
        </div>
      ))}
    </div>
  )
}
