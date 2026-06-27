import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { CaretDown, CaretRight, Trash, Plus } from '@phosphor-icons/react'
import type { ClaudeGlobalSettings, ClaudeLogLevel } from '@shared/types'
import {
  SettingRow,
  Toggle,
  SegmentedControl,
  NumberInput,
  SectionTitle,
  Eyebrow
} from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// CustomEnvVarsEditor — inline key/value editor for raw env vars
// ---------------------------------------------------------------------------

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

type EnvRow = { key: string; value: string }

function recordToRows(record: Record<string, string>): EnvRow[] {
  return Object.entries(record).map(([key, value]) => ({ key, value }))
}

function rowsToRecord(rows: EnvRow[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const { key, value } of rows) {
    if (key.trim()) result[key.trim()] = value
  }
  return result
}

interface CustomEnvVarsEditorProps {
  value: Record<string, string>
  onChange: (next: Record<string, string>) => void
}

function CustomEnvVarsEditor({ value, onChange }: CustomEnvVarsEditorProps): React.JSX.Element {
  const [rows, setRows] = useState<EnvRow[]>(() => recordToRows(value))

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- controlled input sync from prop; key= reset would require caller changes
    setRows(recordToRows(value))
  }, [value])

  function saveRows(next: EnvRow[]): void {
    setRows(next)
    onChange(rowsToRecord(next))
  }

  function updateRow(idx: number, field: 'key' | 'value', val: string): void {
    const next = rows.map((r, i) => (i === idx ? { ...r, [field]: val } : r))
    setRows(next)
  }

  function commitRow(idx: number): void {
    const row = rows[idx]
    if (!row) return
    if (!row.key.trim()) {
      const next = rows.filter((_, i) => i !== idx)
      saveRows(next)
      return
    }
    onChange(rowsToRecord(rows))
  }

  function removeRow(idx: number): void {
    saveRows(rows.filter((_, i) => i !== idx))
  }

  function addRow(): void {
    setRows((prev) => [...prev, { key: '', value: '' }])
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-text-muted italic">
          No custom variables. Click + Add to define one.
        </p>
        <button
          type="button"
          onClick={addRow}
          className="self-start flex items-center gap-1.5 text-xs text-accent hover:opacity-80 transition-opacity"
        >
          <Plus size={12} weight="bold" />
          Add
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, idx) => {
        const keyInvalid = row.key.trim() !== '' && !KEY_RE.test(row.key.trim())
        return (
          <div key={idx} className="flex items-center gap-2">
            <input
              type="text"
              aria-label="Environment variable name"
              value={row.key}
              onChange={(e) => updateRow(idx, 'key', e.target.value)}
              onBlur={() => commitRow(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  updateRow(idx, 'key', row.key)
                  ;(e.currentTarget as HTMLInputElement).blur()
                }
              }}
              placeholder="KEY_NAME"
              className={`w-40 px-2.5 py-1.5 rounded-md text-xs bg-surface-raised border text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text ${keyInvalid ? 'border-red-500/60' : 'border-border-default'}`}
            />
            <span className="text-xs text-text-muted">=</span>
            <input
              type="text"
              aria-label="Environment variable value"
              value={row.value}
              onChange={(e) => updateRow(idx, 'value', e.target.value)}
              onBlur={() => commitRow(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  updateRow(idx, 'value', row.value)
                  ;(e.currentTarget as HTMLInputElement).blur()
                }
              }}
              placeholder="value"
              className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text"
            />
            <button
              type="button"
              onClick={() => removeRow(idx)}
              className="text-text-muted hover:text-red-400 transition-colors flex-shrink-0"
              aria-label="Remove row"
            >
              <Trash size={13} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={addRow}
        className="self-start flex items-center gap-1.5 text-xs text-accent hover:opacity-80 transition-opacity mt-1"
      >
        <Plus size={12} weight="bold" />
        Add
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ExtraBodyJsonInput — textarea with JSON validation on blur
// ---------------------------------------------------------------------------

interface ExtraBodyJsonInputProps {
  value: string
  onChange: (v: string) => void
}

function ExtraBodyJsonInput({ value, onChange }: ExtraBodyJsonInputProps): React.JSX.Element {
  const [local, setLocal] = useState(value)
  const [jsonError, setJsonError] = useState<string | null>(null)

  // Sync when external value changes (e.g. initial load, revert after failed save)
  // React docs endorse this "update during render" pattern for derived state:
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const prevValueRef = useRef(value)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time comparison to avoid a sync effect
  if (prevValueRef.current !== value) {
    // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track previous value
    prevValueRef.current = value
    setLocal(value)
    setJsonError(null)
  }

  function commit(): void {
    const trimmed = local.trim()
    if (trimmed === '') {
      setJsonError(null)
      onChange('')
      return
    }
    try {
      JSON.parse(trimmed)
      setJsonError(null)
      onChange(trimmed)
    } catch {
      // Revert local state to last saved valid value and show inline error briefly
      setLocal(value)
      setJsonError('Invalid JSON — reverted to last saved value.')
    }
  }

  return (
    <div className="flex flex-col gap-1.5 w-64">
      <textarea
        aria-label="Extra body JSON"
        value={local}
        onChange={(e) => {
          setLocal(e.target.value)
          setJsonError(null)
        }}
        onBlur={commit}
        rows={3}
        placeholder='{"key": "value"}'
        className={`w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text resize-none ${jsonError ? 'border-red-500/60' : 'border-border-default'}`}
      />
      {jsonError && <p className="text-xs text-red-400">{jsonError}</p>}
    </div>
  )
}

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
          <SectionTitle>Developer</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Debug logging, telemetry controls, error reporting, and experimental feature flags for
            power users.
          </p>
        </div>
        <SettingsSectionSkeleton groups={3} rowsPerGroup={2} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Developer</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Debug logging, telemetry controls, error reporting, and experimental feature flags for
          power users. Changes save automatically.
        </p>
      </div>

      {/* Logging */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Logging</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Debug logging"
            description="Pass --debug to Claude at launch for verbose output. Applies on next workspace open."
            mapsTo="--debug"
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
            mapsTo="CLAUDE_CODE_DEBUG_LOG_LEVEL"
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
        <Eyebrow className="mb-3">Privacy</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Disable telemetry"
            description="Opt out of anonymous usage statistics sent to Anthropic (DISABLE_TELEMETRY=1)."
            mapsTo="DISABLE_TELEMETRY"
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
            mapsTo="DISABLE_ERROR_REPORTING"
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
            mapsTo="DISABLE_AUTOUPDATER"
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
          type="button"
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
              mapsTo="CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"
            >
              <Toggle
                ariaLabel="Agent teams"
                value={settings.experimentalAgentTeams}
                onChange={(v) => patch({ experimentalAgentTeams: v })}
              />
            </SettingRow>
            <SettingRow
              label="Forked subagents"
              description="Allow Claude to spawn isolated subagent processes for long-running subtasks (CLAUDE_CODE_FORK_SUBAGENT=1)."
              mapsTo="CLAUDE_CODE_FORK_SUBAGENT"
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
              mapsTo="simpleSystemPrompt"
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

      {/* Network */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Network</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="HTTP_PROXY"
            description="HTTP proxy for outbound requests from claude (HTTP_PROXY). Leave empty to use the system default."
            mapsTo="HTTP_PROXY"
          >
            <input
              type="text"
              aria-label="HTTP proxy"
              value={settings.httpProxy}
              onChange={(e) => patch({ httpProxy: e.target.value })}
              onBlur={(e) => patch({ httpProxy: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              placeholder="http://proxy.example.com:8080"
              className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono cursor-text"
            />
          </SettingRow>
          <SettingRow
            label="HTTPS_PROXY"
            description="HTTPS proxy for outbound requests from claude (HTTPS_PROXY). Leave empty to use the system default."
            mapsTo="HTTPS_PROXY"
          >
            <input
              type="text"
              aria-label="HTTPS proxy"
              value={settings.httpsProxy}
              onChange={(e) => patch({ httpsProxy: e.target.value })}
              onBlur={(e) => patch({ httpsProxy: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              placeholder="https://proxy.example.com:8080"
              className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono cursor-text"
            />
          </SettingRow>
          <SettingRow
            label="API timeout (ms)"
            description="Timeout in milliseconds for each API request to Anthropic (API_TIMEOUT_MS). Leave empty to use claude's default."
            mapsTo="API_TIMEOUT_MS"
          >
            <NumberInput
              value={settings.apiTimeoutMs}
              onChange={(v) => patch({ apiTimeoutMs: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Max retries"
            description="Number of times to retry a failed API request (CLAUDE_CODE_MAX_RETRIES). Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_MAX_RETRIES"
          >
            <NumberInput
              value={settings.maxRetries}
              onChange={(v) => patch({ maxRetries: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Enable fine-grained tool streaming"
            description="Stream tool results at a finer granularity for lower perceived latency (CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING=1)."
            mapsTo="CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING"
          >
            <Toggle
              ariaLabel="Enable fine-grained tool streaming"
              value={settings.enableFineGrainedToolStreaming}
              onChange={(v) => patch({ enableFineGrainedToolStreaming: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable nonstreaming fallback"
            description="Prevent Claude from falling back to non-streaming mode when streaming fails (CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK=1)."
            mapsTo="CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK"
          >
            <Toggle
              ariaLabel="Disable nonstreaming fallback"
              value={settings.disableNonstreamingFallback}
              onChange={(v) => patch({ disableNonstreamingFallback: v })}
            />
          </SettingRow>
          <SettingRow
            label="Proxy resolves hosts"
            description="Delegate hostname resolution to the proxy instead of resolving locally first (CLAUDE_CODE_PROXY_RESOLVES_HOSTS=1)."
            mapsTo="CLAUDE_CODE_PROXY_RESOLVES_HOSTS"
          >
            <Toggle
              ariaLabel="Proxy resolves hosts"
              value={settings.proxyResolvesHosts}
              onChange={(v) => patch({ proxyResolvesHosts: v })}
            />
          </SettingRow>
          <SettingRow
            label="Enable gateway model discovery"
            description="Allow Claude to discover available models through the gateway API (CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1)."
            mapsTo="CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"
          >
            <Toggle
              ariaLabel="Enable gateway model discovery"
              value={settings.enableGatewayModelDiscovery}
              onChange={(v) => patch({ enableGatewayModelDiscovery: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Privacy & background tasks */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Privacy &amp; background tasks</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Disable nonessential traffic"
            description="Bundles autoupdater, feedback, error reporting, and telemetry off in one toggle (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1)."
            mapsTo="CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
          >
            <Toggle
              ariaLabel="Disable nonessential traffic"
              value={settings.disableNonessentialTraffic}
              onChange={(v) => patch({ disableNonessentialTraffic: v })}
            />
          </SettingRow>
          <SettingRow
            label="Honor DO_NOT_TRACK"
            description="Respect the DO_NOT_TRACK signal to disable analytics and usage tracking (DO_NOT_TRACK=1)."
            mapsTo="DO_NOT_TRACK"
          >
            <Toggle
              ariaLabel="Honor DO_NOT_TRACK"
              value={settings.doNotTrack}
              onChange={(v) => patch({ doNotTrack: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable background tasks"
            description="Prevent Claude from running background processing tasks between turns (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1)."
            mapsTo="CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"
          >
            <Toggle
              ariaLabel="Disable background tasks"
              value={settings.disableBackgroundTasks}
              onChange={(v) => patch({ disableBackgroundTasks: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable agent view"
            description="Hide the real-time agent activity view during agentic sessions (CLAUDE_CODE_DISABLE_AGENT_VIEW=1)."
            mapsTo="CLAUDE_CODE_DISABLE_AGENT_VIEW"
          >
            <Toggle
              ariaLabel="Disable agent view"
              value={settings.disableAgentView}
              onChange={(v) => patch({ disableAgentView: v })}
            />
          </SettingRow>
          <SettingRow
            label="Auto background tasks"
            description="Allow Claude to automatically schedule background tasks without explicit user approval (CLAUDE_AUTO_BACKGROUND_TASKS=1)."
            mapsTo="CLAUDE_AUTO_BACKGROUND_TASKS"
          >
            <Toggle
              ariaLabel="Auto background tasks"
              value={settings.autoBackgroundTasks}
              onChange={(v) => patch({ autoBackgroundTasks: v })}
            />
          </SettingRow>
          <SettingRow
            label="Async agent stall timeout (ms)"
            description="Milliseconds before an unresponsive async agent is considered stalled (CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS). Leave empty to use claude's default."
            mapsTo="CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS"
          >
            <NumberInput
              value={settings.asyncAgentStallTimeoutMs}
              onChange={(v) => patch({ asyncAgentStallTimeoutMs: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Enable tasks"
            description="Enable Claude's task management system for tracking long-running work items (CLAUDE_CODE_ENABLE_TASKS=1)."
            mapsTo="CLAUDE_CODE_ENABLE_TASKS"
          >
            <Toggle
              ariaLabel="Enable tasks"
              value={settings.enableTasks}
              onChange={(v) => patch({ enableTasks: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable cron"
            description="Prevent Claude from creating or running scheduled (cron) tasks (CLAUDE_CODE_DISABLE_CRON=1)."
            mapsTo="CLAUDE_CODE_DISABLE_CRON"
          >
            <Toggle
              ariaLabel="Disable cron"
              value={settings.disableCron}
              onChange={(v) => patch({ disableCron: v })}
            />
          </SettingRow>
          <SettingRow
            label="Exit after stop delay (ms)"
            description="Milliseconds to wait after a stop signal before Claude exits (CLAUDE_CODE_EXIT_AFTER_STOP_DELAY). Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_EXIT_AFTER_STOP_DELAY"
          >
            <NumberInput
              value={settings.exitAfterStopDelay}
              onChange={(v) => patch({ exitAfterStopDelay: v })}
              placeholder="default"
            />
          </SettingRow>
          <SettingRow
            label="Disable feedback command"
            description="Remove the /feedback slash command from Claude's UI (DISABLE_FEEDBACK_COMMAND=1)."
            mapsTo="DISABLE_FEEDBACK_COMMAND"
          >
            <Toggle
              ariaLabel="Disable feedback command"
              value={settings.disableFeedbackCommand}
              onChange={(v) => patch({ disableFeedbackCommand: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable feedback survey"
            description="Prevent the periodic in-session feedback survey prompt from appearing (CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1)."
            mapsTo="CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY"
          >
            <Toggle
              ariaLabel="Disable feedback survey"
              value={settings.disableFeedbackSurvey}
              onChange={(v) => patch({ disableFeedbackSurvey: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Advanced */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Advanced</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Anthropic-Beta headers"
            description="Comma-separated values for the anthropic-beta header on every request (ANTHROPIC_BETAS). Example: prompt-caching-2024-07-31,messages-2023-12-15."
            mapsTo="ANTHROPIC_BETAS"
          >
            <input
              type="text"
              aria-label="Anthropic-Beta headers"
              value={settings.anthropicBetas}
              onChange={(e) => patch({ anthropicBetas: e.target.value })}
              onBlur={(e) => patch({ anthropicBetas: e.target.value.trim() })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              placeholder="prompt-caching-2024-07-31,messages-2023-12-15"
              className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono cursor-text"
            />
          </SettingRow>
          <SettingRow
            label="Extra body JSON"
            description="Raw JSON object merged into every API request body (CLAUDE_CODE_EXTRA_BODY). Must be valid JSON. Validated on save."
            mapsTo="CLAUDE_CODE_EXTRA_BODY"
          >
            <ExtraBodyJsonInput
              value={settings.extraBodyJson}
              onChange={(v) => patch({ extraBodyJson: v })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Custom environment variables */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Custom environment variables</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <p className="text-xs text-text-muted mb-4">
            Raw key/value pairs merged into the claude launch env. Power-user override — your keys
            win over any setting above. Validate against the{' '}
            <a
              href="https://code.claude.com/docs/en/env-vars"
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:opacity-80 transition-opacity underline underline-offset-2"
            >
              claude env-vars docs
            </a>
            .
          </p>
          <CustomEnvVarsEditor
            value={settings.customEnvVars}
            onChange={(next) => patch({ customEnvVars: next })}
          />
        </div>
      </section>
    </div>
  )
}
