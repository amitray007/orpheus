import { useEffect, useState } from 'react'
import type React from 'react'
import type { ClaudeGlobalSettings, ClaudePermissionMode, ClaudeEffort } from '@shared/types'
import { SettingRow, SegmentedControl, Toggle, ModelPicker, NumberInput } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// ClaudeGeneralSection — model, permission mode, effort, auto-memory, extended thinking
// ---------------------------------------------------------------------------

export function ClaudeGeneralSection(): React.JSX.Element {
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
        <SettingsSectionSkeleton groups={2} rowsPerGroup={3} />
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
          <SettingRow
            label="Model"
            description="Which Claude model launches by default."
            mapsTo={['--model', 'ANTHROPIC_MODEL']}
          >
            <ModelPicker value={settings.model} onChange={(v) => patch({ model: v })} />
          </SettingRow>
          <SettingRow
            label="Permission mode"
            description="How claude handles tool-use permission requests."
            mapsTo="--permission-mode"
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
          <SettingRow
            label="Effort"
            description="Trade-off between speed and thoroughness."
            mapsTo={['--effort', 'CLAUDE_CODE_EFFORT_LEVEL']}
          >
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
            mapsTo="CLAUDE_CODE_DISABLE_AUTO_MEMORY"
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
            mapsTo="alwaysThinkingEnabled"
          >
            <Toggle
              ariaLabel="Extended thinking"
              value={settings.alwaysThinking}
              onChange={(v) => patch({ alwaysThinking: v })}
            />
          </SettingRow>
        </div>
      </section>

      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Fallback &amp; overload
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Fallback model"
            description="Model used when the primary model is overloaded or unavailable. Accepts a model alias or full model ID."
            mapsTo="--fallback-model"
          >
            <input
              type="text"
              value={settings.fallbackModel}
              onChange={(e) => patch({ fallbackModel: e.target.value })}
              onBlur={(e) => patch({ fallbackModel: e.target.value.trim() })}
              placeholder="(none — claude default)"
              className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono cursor-text"
            />
          </SettingRow>
        </div>
      </section>

      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Model behavior
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Disable extended thinking"
            description="Prevents Claude from using extended thinking even when effort is high (CLAUDE_CODE_DISABLE_THINKING=1)."
            mapsTo="CLAUDE_CODE_DISABLE_THINKING"
          >
            <Toggle
              ariaLabel="Disable extended thinking"
              value={settings.disableThinking}
              onChange={(v) => patch({ disableThinking: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable fast mode"
            description="Forces Claude to skip the fast-response optimization path (CLAUDE_CODE_DISABLE_FAST_MODE=1)."
            mapsTo="CLAUDE_CODE_DISABLE_FAST_MODE"
          >
            <Toggle
              ariaLabel="Disable fast mode"
              value={settings.disableFastMode}
              onChange={(v) => patch({ disableFastMode: v })}
            />
          </SettingRow>
          <SettingRow
            label="Max turns per session"
            description="Hard cap on the number of agentic turns per session (CLAUDE_CODE_MAX_TURNS). Leave empty to use claude's default."
            mapsTo="CLAUDE_CODE_MAX_TURNS"
          >
            <NumberInput
              value={settings.maxTurns}
              onChange={(v) => patch({ maxTurns: v })}
              placeholder="default"
            />
          </SettingRow>
        </div>
      </section>

      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Model capabilities
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Disable 1M context"
            description="Prevent Claude from using the 1-million-token extended context window (CLAUDE_CODE_DISABLE_1M_CONTEXT=1)."
            mapsTo="CLAUDE_CODE_DISABLE_1M_CONTEXT"
          >
            <Toggle
              ariaLabel="Disable 1M context"
              value={settings.disable1mContext}
              onChange={(v) => patch({ disable1mContext: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable adaptive thinking"
            description="Turn off adaptive thinking optimizations that adjust reasoning depth based on prompt complexity (CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1)."
            mapsTo="CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING"
          >
            <Toggle
              ariaLabel="Disable adaptive thinking"
              value={settings.disableAdaptiveThinking}
              onChange={(v) => patch({ disableAdaptiveThinking: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable legacy model remap"
            description="Stop Claude from automatically remapping legacy model identifiers to their current equivalents (CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP=1)."
            mapsTo="CLAUDE_CODE_DISABLE_LEGACY_MODEL_REMAP"
          >
            <Toggle
              ariaLabel="Disable legacy model remap"
              value={settings.disableLegacyModelRemap}
              onChange={(v) => patch({ disableLegacyModelRemap: v })}
            />
          </SettingRow>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ComingSoonChip — inline badge for placeholder controls
// ---------------------------------------------------------------------------

export function ComingSoonChip(): React.JSX.Element {
  return (
    <span className="text-xs font-medium uppercase tracking-wider text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 whitespace-nowrap">
      Coming soon
    </span>
  )
}
