import { useEffect, useState } from 'react'
import type React from 'react'
import type {
  ClaudeGlobalSettings,
  ClaudePermissionMode,
  ClaudeEffort
} from '@shared/types'

// ---------------------------------------------------------------------------
// Form primitives (inline — small, single-use; extract later if reused)
// ---------------------------------------------------------------------------

interface SettingRowProps {
  label: string
  description?: string
  children: React.ReactNode
}
function SettingRow({ label, description, children }: SettingRowProps): React.JSX.Element {
  // Two-column row: label+description on the left, control on the right.
  // On narrow widths it stacks; min 480px wide it goes side-by-side.
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6 py-4 border-b border-border-default/40 last:border-b-0">
      <div className="flex flex-col gap-0.5 min-w-0 sm:max-w-sm">
        <label className="text-sm font-medium text-text-primary">{label}</label>
        {description && <p className="text-xs text-text-muted">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel
}: SegmentedControlProps<T>): React.JSX.Element {
  // Horizontal pill group; selected option highlighted with bg-accent/15 + text-text-primary.
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={[
            'px-3 py-1.5 text-xs font-medium rounded transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-accent/50',
            value === opt.value
              ? 'bg-accent/15 text-text-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

interface ToggleProps {
  value: boolean
  onChange: (v: boolean) => void
  ariaLabel: string
}
function Toggle({ value, onChange, ariaLabel }: ToggleProps): React.JSX.Element {
  // iOS-style switch: 36x20 track with 16x16 knob.
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      onClick={() => onChange(!value)}
      className={[
        'relative w-9 h-5 rounded-full transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-accent/50',
        value ? 'bg-accent' : 'bg-surface-overlay border border-border-default'
      ].join(' ')}
    >
      <span
        className={[
          'absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-150',
          value ? 'translate-x-[18px]' : 'translate-x-0.5'
        ].join(' ')}
      />
    </button>
  )
}

interface ModelPickerProps {
  value: string
  onChange: (v: string) => void
}
function ModelPicker({ value, onChange }: ModelPickerProps): React.JSX.Element {
  // Pre-defined aliases + a "Custom..." option that reveals a text input
  const aliases = [
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' }
  ]
  const isCustom = !aliases.some((a) => a.value === value)
  const [showCustom, setShowCustom] = useState(isCustom)
  const [customValue, setCustomValue] = useState(isCustom ? value : '')

  return (
    <div className="flex flex-col gap-1.5 items-end">
      <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5">
        {aliases.map((opt) => (
          <button
            key={opt.value}
            role="radio"
            aria-checked={!isCustom && value === opt.value}
            onClick={() => {
              setShowCustom(false)
              onChange(opt.value)
            }}
            className={[
              'px-3 py-1.5 text-xs font-medium rounded transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-accent/50',
              !isCustom && value === opt.value
                ? 'bg-accent/15 text-text-primary'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
            ].join(' ')}
          >
            {opt.label}
          </button>
        ))}
        <button
          role="radio"
          aria-checked={isCustom}
          onClick={() => setShowCustom(true)}
          className={[
            'px-3 py-1.5 text-xs font-medium rounded transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-accent/50',
            isCustom ? 'bg-accent/15 text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
          ].join(' ')}
        >
          Custom…
        </button>
      </div>
      {showCustom && (
        <input
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onBlur={() => {
            const v = customValue.trim()
            if (v) onChange(v)
          }}
          placeholder="model-id (e.g. claude-sonnet-4-6)"
          className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus:border-accent/50 transition-colors duration-150 font-mono"
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SettingsView
// ---------------------------------------------------------------------------

export function SettingsView(): React.JSX.Element {
  const [settings, setSettings] = useState<ClaudeGlobalSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.claudeSettings
      .get()
      .then((s) => {
        if (!cancelled) setSettings(s)
      })
      .catch((err) => {
        console.error('[settings] failed to load', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function patch(p: Partial<ClaudeGlobalSettings>): void {
    if (!settings) return
    // Optimistic
    setSettings({ ...settings, ...p })
    window.api.claudeSettings.update(p).catch((err) => {
      console.error('[settings] update failed; refetching to reconcile', err)
      window.api.claudeSettings
        .get()
        .then((s) => setSettings(s))
        .catch(console.error)
    })
  }

  if (error) {
    return (
      <div className="max-w-2xl">
        <p className="text-sm text-red-400">Failed to load settings: {error}</p>
      </div>
    )
  }

  if (!settings) {
    // Loading state
    return (
      <div className="flex flex-col gap-8 max-w-2xl">
        <h1 className="text-xl font-semibold text-text-primary">Settings</h1>
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold text-text-primary">Settings</h1>
        <p className="text-sm text-text-muted mt-1">
          Defaults applied when claude launches in any workspace. Changes save automatically.
        </p>
      </div>

      <section className="flex flex-col">
        <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Claude defaults
        </h2>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow label="Model" description="Which Claude model launches by default.">
            <ModelPicker value={settings.model} onChange={(v) => patch({ model: v })} />
          </SettingRow>
          <SettingRow
            label="Permission mode"
            description="How claude handles tool-use permission requests."
          >
            <SegmentedControl<ClaudePermissionMode>
              ariaLabel="Permission mode"
              options={[
                { value: 'default', label: 'Default' },
                { value: 'acceptEdits', label: 'Accept edits' },
                { value: 'plan', label: 'Plan' },
                { value: 'bypassPermissions', label: 'Bypass' }
              ]}
              value={settings.permissionMode}
              onChange={(v) => patch({ permissionMode: v })}
            />
          </SettingRow>
          <SettingRow label="Effort" description="Trade-off between speed and thoroughness.">
            <SegmentedControl<ClaudeEffort>
              ariaLabel="Effort level"
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Med' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'X-High' },
                { value: 'max', label: 'Max' }
              ]}
              value={settings.effort}
              onChange={(v) => patch({ effort: v })}
            />
          </SettingRow>
        </div>
      </section>

      <section className="flex flex-col">
        <h2 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Memory &amp; reasoning
        </h2>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Auto-load memory"
            description="Automatically include CLAUDE.md context files when claude starts."
          >
            <Toggle
              ariaLabel="Auto-load memory"
              value={settings.autoMemory}
              onChange={(v) => patch({ autoMemory: v })}
            />
          </SettingRow>
          <SettingRow
            label="Extended thinking"
            description="Always allow claude to think before responding. Slower but more thorough."
          >
            <Toggle
              ariaLabel="Extended thinking"
              value={settings.alwaysThinking}
              onChange={(v) => patch({ alwaysThinking: v })}
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}
