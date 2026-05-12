import { useEffect, useState } from 'react'
import type React from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import type { ClaudeGlobalSettings, ClaudeLogLevel } from '@shared/types'
import { SettingRow, Toggle, SegmentedControl } from './primitives'

// ---------------------------------------------------------------------------
// ClaudeDeveloperSection — debug logging, telemetry, experimental flags
// ---------------------------------------------------------------------------

const LOG_LEVEL_OPTIONS: ReadonlyArray<{ value: ClaudeLogLevel; label: string }> = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' }
]

export function ClaudeDeveloperSection(): React.JSX.Element {
  const [settings, setSettings] = useState<ClaudeGlobalSettings | null>(null)
  const [experimentalOpen, setExperimentalOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.claudeSettings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((err) => console.error('[developer-settings] load failed', err))
    return () => {
      cancelled = true
    }
  }, [])

  function patch(p: Partial<ClaudeGlobalSettings>): void {
    if (!settings) return
    setSettings({ ...settings, ...p })
    window.api.claudeSettings.update(p).catch((err) => {
      console.error('[developer-settings] update failed; refetching', err)
      window.api.claudeSettings
        .get()
        .then((s) => setSettings(s))
        .catch(console.error)
    })
  }

  if (!settings) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Developer</h2>
          <p className="text-xs text-text-muted mt-1">
            Debug logging, telemetry controls, error reporting, and experimental feature flags for
            power users.
          </p>
        </div>
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Developer</h2>
        <p className="text-xs text-text-muted mt-1">
          Debug logging, telemetry controls, error reporting, and experimental feature flags for
          power users. Changes save automatically.
        </p>
      </div>

      {/* Logging */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Logging
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Debug logging"
            description="Pass --debug to Claude at launch for verbose output. Applies on next workspace open."
          >
            <Toggle
              ariaLabel="Debug logging"
              value={settings.debugLogging}
              onChange={(v) => patch({ debugLogging: v })}
            />
          </SettingRow>
          <SettingRow
            label="Log level"
            description="Minimum severity level for log entries. Only active when Debug logging is enabled."
          >
            <SegmentedControl<ClaudeLogLevel>
              ariaLabel="Log level"
              options={LOG_LEVEL_OPTIONS}
              value={settings.logLevel}
              onChange={(v) => patch({ logLevel: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Privacy */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Privacy
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Disable telemetry"
            description="Opt out of anonymous usage statistics sent to Anthropic (DISABLE_TELEMETRY=1)."
          >
            <Toggle
              ariaLabel="Disable telemetry"
              value={settings.disableTelemetry}
              onChange={(v) => patch({ disableTelemetry: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable error reporting"
            description="Stop sending crash reports and stack traces to Anthropic (DISABLE_ERROR_REPORTING=1)."
          >
            <Toggle
              ariaLabel="Disable error reporting"
              value={settings.disableErrorReporting}
              onChange={(v) => patch({ disableErrorReporting: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable auto-updater"
            description="Prevent Orpheus from checking for or applying updates automatically (DISABLE_AUTOUPDATER=1)."
          >
            <Toggle
              ariaLabel="Disable auto-updater"
              value={settings.disableAutoupdater}
              onChange={(v) => patch({ disableAutoupdater: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Experimental features — collapsible */}
      <section className="flex flex-col">
        <button
          onClick={() => setExperimentalOpen((v) => !v)}
          className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-secondary mb-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded self-start"
        >
          {experimentalOpen ? (
            <CaretDown size={12} weight="bold" />
          ) : (
            <CaretRight size={12} weight="bold" />
          )}
          Experimental features
        </button>

        {experimentalOpen && (
          <div className="bg-surface-raised border border-border-default rounded-lg px-5">
            <SettingRow
              label="Agent teams"
              description="Run multiple Claude instances collaborating on the same task in parallel (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1)."
            >
              <Toggle
                ariaLabel="Agent teams"
                value={settings.experimentalAgentTeams}
                onChange={(v) => patch({ experimentalAgentTeams: v })}
              />
            </SettingRow>
            <SettingRow
              label="Forked subagents"
              description="Allow Claude to spawn isolated subagent processes for long-running subtasks. Stored in DB; no confirmed compose flag yet."
            >
              <Toggle
                ariaLabel="Forked subagents"
                value={settings.experimentalForkedSubagents}
                onChange={(v) => patch({ experimentalForkedSubagents: v })}
              />
            </SettingRow>
            <SettingRow
              label="Simple system prompt"
              description="Use a minimal system prompt without Orpheus-specific injections (settings.json: simpleSystemPrompt)."
            >
              <Toggle
                ariaLabel="Simple system prompt"
                value={settings.simpleSystemPrompt}
                onChange={(v) => patch({ simpleSystemPrompt: v })}
              />
            </SettingRow>
          </div>
        )}
      </section>
    </div>
  )
}
