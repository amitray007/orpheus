import type React from 'react'
import { SettingRow } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'

// ---------------------------------------------------------------------------
// ClaudeDeveloperSection — debug logging, telemetry, experimental flags
// ---------------------------------------------------------------------------

export function ClaudeDeveloperSection(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Developer</h2>
        <p className="text-xs text-text-muted mt-1">
          Debug logging, telemetry controls, error reporting, and experimental feature flags for
          power users.
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
            description="Write verbose debug output to ~/Library/Logs/Orpheus/debug.log."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Log level"
            description="Minimum severity level for log entries written to disk."
          >
            <div className="flex items-center gap-2">
              <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5 opacity-50 pointer-events-none select-none">
                {(['Error', 'Warn', 'Info', 'Debug', 'Trace'] as const).map((l) => (
                  <span
                    key={l}
                    className={[
                      'px-2.5 py-1.5 text-xs font-medium rounded',
                      l === 'Warn' ? 'bg-accent/15 text-text-primary' : 'text-text-muted'
                    ].join(' ')}
                  >
                    {l}
                  </span>
                ))}
              </div>
              <ComingSoonChip />
            </div>
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
            description="Opt out of anonymous usage statistics sent to Anthropic."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Disable error reporting"
            description="Stop sending crash reports and stack traces to Anthropic."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Disable auto-updater"
            description="Prevent Orpheus from checking for or applying updates automatically."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
        </div>
      </section>

      {/* Experimental features */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Experimental features
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Agent teams"
            description="Run multiple Claude instances collaborating on the same task in parallel."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Forked subagents"
            description="Allow Claude to spawn isolated subagent processes for long-running subtasks."
          >
            <div className="flex items-center gap-2">
              <DisabledToggle />
              <ComingSoonChip />
            </div>
          </SettingRow>
          <SettingRow
            label="Simple system prompt"
            description="Use a minimal system prompt without Orpheus-specific injections."
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
