import { useEffect, useState } from 'react'
import type React from 'react'
import type {
  ClaudeGlobalSettings,
  ClaudePermissionMode,
  ClaudeEffort
} from '@shared/types'
import { SettingRow, SegmentedControl, Toggle, ModelPicker } from './primitives'

// ---------------------------------------------------------------------------
// GeneralSection — model, permission mode, effort, auto-memory, extended thinking
// ---------------------------------------------------------------------------

export function GeneralSection(): React.JSX.Element {
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
    // Optimistic update
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
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">General</h2>
          <p className="text-xs text-text-muted mt-1">
            Defaults applied when claude launches in any workspace.
          </p>
        </div>
        <p className="text-sm text-red-400">Failed to load settings: {error}</p>
      </div>
    )
  }

  if (!settings) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">General</h2>
          <p className="text-xs text-text-muted mt-1">
            Defaults applied when claude launches in any workspace.
          </p>
        </div>
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">General</h2>
        <p className="text-xs text-text-muted mt-1">
          Defaults applied when claude launches in any workspace. Changes save automatically.
        </p>
      </div>

      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Claude defaults
        </h3>
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
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Memory &amp; reasoning
        </h3>
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
