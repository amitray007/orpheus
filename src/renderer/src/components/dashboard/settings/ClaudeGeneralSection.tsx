import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type { ClaudeGlobalSettings, ClaudePermissionMode, ClaudeEffort } from '@shared/types'
import {
  SettingRow,
  SegmentedControl,
  Toggle,
  ModelPicker,
  NumberInput,
  SectionTitle,
  Eyebrow
} from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { useSelectableModels } from '@/lib/useSelectableModels'
import { effortOptionsFor, resolveEffortLevelsForScope } from '@/lib/effortPickerOptions'

// ---------------------------------------------------------------------------
// ClaudeGeneralSection — model, permission mode, effort, auto-memory, extended thinking
// ---------------------------------------------------------------------------

export function ClaudeGeneralSection(): React.JSX.Element {
  const [settings, setSettings] = useState<ClaudeGlobalSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Data-driven effort options (model-routing unit 11) — the global scope's
  // effective model's real effortLevels via resolveEffortLevelsForScope,
  // never a hardcoded ladder. Unlike project/workspace scope, the global
  // model is ALWAYS a concrete value (schema.ts's model column is NOT NULL
  // with a real default — see validateModelKey's "must be a non-empty
  // string" rule), so there's no 'default'/"inherit" concept here at all;
  // this is the one scope with no `leading` option. Called unconditionally
  // (Rules of Hooks) even while `settings` is still null/loading — passing
  // undefined then resolves to the full ladder via resolveEffortLevelsForScope's
  // own "no single model" branch, harmless since the loading-state early
  // return below never reads it.
  const { models: selectableModels, loading: selectableModelsLoading } = useSelectableModels(
    settings?.model
  )
  const effortLevels = resolveEffortLevelsForScope(
    settings?.model,
    selectableModels,
    selectableModelsLoading
  )
  const showEffortRow = effortLevels !== null
  const effortOptions = useMemo(
    () => effortOptionsFor(effortLevels ?? []) as { value: ClaudeEffort; label: string }[],
    [effortLevels]
  )

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
          <SectionTitle>General</SectionTitle>
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
          <SectionTitle>General</SectionTitle>
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
        <SectionTitle>General</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Defaults applied when claude launches in any workspace. Changes save automatically.
        </p>
      </div>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Claude defaults</Eyebrow>
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
          {showEffortRow && (
            <SettingRow
              label="Effort"
              description="Trade-off between speed and thoroughness."
              mapsTo={['--effort', 'CLAUDE_CODE_EFFORT_LEVEL']}
            >
              <SegmentedControl<ClaudeEffort>
                ariaLabel="Effort level"
                options={effortOptions}
                value={settings.effort}
                onChange={(v) => patch({ effort: v })}
              />
            </SettingRow>
          )}
        </div>
      </section>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Memory &amp; reasoning</Eyebrow>
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
        <Eyebrow className="mb-3">Fallback &amp; overload</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Fallback model"
            description="Model used when the primary model is overloaded or unavailable. Accepts a model alias or full model ID."
            mapsTo="--fallback-model"
          >
            <input
              type="text"
              aria-label="Fallback model"
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
        <Eyebrow className="mb-3">Model behavior</Eyebrow>
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
            label="Low power mode"
            description="Reduce background CPU/battery usage by throttling non-essential Claude activity (CLAUDE_CODE_LOW_POWER_MODE=1)."
            mapsTo="CLAUDE_CODE_LOW_POWER_MODE"
          >
            <Toggle
              ariaLabel="Low power mode"
              value={settings.lowPowerMode}
              onChange={(v) => patch({ lowPowerMode: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable bundled skills"
            description="Prevent Claude from loading bundled skills and workflows (CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1). User, project, and plugin skills are not affected."
            mapsTo="CLAUDE_CODE_DISABLE_BUNDLED_SKILLS"
          >
            <Toggle
              ariaLabel="Disable bundled skills"
              value={settings.disableBundledSkills}
              onChange={(v) => patch({ disableBundledSkills: v })}
            />
          </SettingRow>
          <SettingRow
            label="Disable workflows"
            description="Prevent Claude from loading dynamic workflow commands (CLAUDE_CODE_DISABLE_WORKFLOWS=1)."
            mapsTo="CLAUDE_CODE_DISABLE_WORKFLOWS"
          >
            <Toggle
              ariaLabel="Disable workflows"
              value={settings.disableWorkflows}
              onChange={(v) => patch({ disableWorkflows: v })}
            />
          </SettingRow>
          <SettingRow
            label="Enable away summary"
            description="Show a one-line session recap when returning after being away (CLAUDE_CODE_ENABLE_AWAY_SUMMARY=1)."
            mapsTo="CLAUDE_CODE_ENABLE_AWAY_SUMMARY"
          >
            <Toggle
              ariaLabel="Enable away summary"
              value={settings.enableAwaySummary}
              onChange={(v) => patch({ enableAwaySummary: v })}
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
        <Eyebrow className="mb-3">Model capabilities</Eyebrow>
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
