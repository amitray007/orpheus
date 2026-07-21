import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { ArrowCounterClockwise, X } from '@phosphor-icons/react'
import {
  EFFORT_LADDER_ORDER,
  type ClaudeEffort,
  type ClaudeGlobalSettings,
  type ClaudePermissionMode,
  type ClaudeProjectSettings,
  type ClaudeProjectSettingsOverrides
} from '@shared/types'
import { Select, CliFlagsEditor, CustomEnvVarsEditor } from '../settings/primitives'
import { Overlay } from '@/components/ui/Overlay'
import { WorkspaceCreationSettings } from './WorkspaceCreationSettings'
import { useSelectableModels } from '@/lib/useSelectableModels'
import { buildModelSelectOptions, MODEL_CUSTOM_VALUE } from '@/lib/modelPickerOptions'
import { effortOptionsFor, resolveEffortLevelsForScope } from '@/lib/effortPickerOptions'

// ---------------------------------------------------------------------------
// Per-project settings drawer
//
// Layout mirrors WorkspaceDrawer: section header on top, stacked override
// fields (full-width label + full-width Select), hairline dividers. The drawer
// itself is a right-aligned overlay (the project view doesn't have a dedicated
// side panel slot like WorkspaceView does).
// ---------------------------------------------------------------------------

// Model options are data-driven (models:listSelectable — Claude always
// present, routed models gated on proxy/provider health; see
// buildModelSelectOptions) rather than a hardcoded CLAUDE_MODEL_OPTIONS
// slice — see the useSelectableModels() call below. MODEL_CUSTOM_VALUE is
// the shared 'Custom…' escape hatch (unit 01).
type ModelOption = string

const PERMISSION_OPTIONS = [
  { value: 'default', label: 'Use global' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' }
] as const

// Effort options are data-driven (model-routing unit 11) — the project's
// effective model's real effortLevels via resolveEffortLevelsForScope/
// effortOptionsFor (see the useMemo below), never a hardcoded ladder. A
// project has no single resolved model unless localOverrides.model is set
// (see resolveEffortLevelsForScope's own doc comment for why 'default'/"no
// override at this scope" resolves to the full ladder, the same fallback
// the footer chip's modelValue === '' case uses) — 'Use global' is a
// DIFFERENT concept from 'auto' and is prepended as `leading`, never
// collapsed into it.
type PermissionOption = (typeof PERMISSION_OPTIONS)[number]['value']
type EffortOption = string

// Stable fallback identity for the CLI flags editor's value/inheritedFlags
// props. A fresh `[]` literal allocated inline in JSX (`x ?? []`) gets a new
// reference every render, which defeats CliFlagsEditor's render-time
// prevValueRef sync guard (reference-compares first) and CliFlagsPreview's
// React.memo (shallow prop compare). Module-level singleton so the reference
// never changes across renders — see composed props below via useMemo.
const EMPTY_FLAGS: string[] = []

// Same stable-fallback rationale as EMPTY_FLAGS above, for CustomEnvVarsEditor's
// `value` prop — a fresh `{}` literal allocated inline every render would give
// the editor's `useEffect(() => setRows(recordToRows(value)), [value])` a new
// dependency identity every render, refiring the resync and destroying
// in-progress typing/focus. Module-level singleton so the reference is stable.
const EMPTY_ENV_VARS: Record<string, string> = {}

interface SettingsDrawerProps {
  projectId: string
  projectName: string
  open: boolean
  onClose: () => void
}

interface OverrideFieldProps<T extends string> {
  label: string
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  isOverridden: boolean
  ariaLabel: string
  description?: string
  /** Optional extra control rendered below the Select — e.g. the "Custom…"
   *  free-text fallback (see MODEL_CUSTOM / showCustomModel below). */
  children?: React.ReactNode
}

function OverrideField<T extends string>({
  label,
  options,
  value,
  onChange,
  isOverridden,
  ariaLabel,
  description,
  children
}: OverrideFieldProps<T>): React.JSX.Element {
  return (
    <div className="px-4 py-3 border-t border-border-default/30 first:border-t-0">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-sm font-medium text-text-secondary uppercase tracking-wider">
          {label}
        </label>
        {isOverridden && (
          <span
            className="w-1.5 h-1.5 rounded-full bg-accent/80"
            title="Overrides global default"
          />
        )}
      </div>
      {description && <p className="text-xs text-text-muted mb-2">{description}</p>}
      <Select options={options} value={value} onChange={onChange} ariaLabel={ariaLabel} />
      {children}
    </div>
  )
}

export function SettingsDrawer({
  projectId,
  projectName,
  open,
  onClose
}: SettingsDrawerProps): React.JSX.Element | null {
  const [settings, setSettings] = useState<ClaudeProjectSettings | null>(null)
  const [localOverrides, setLocalOverrides] = useState<ClaudeProjectSettingsOverrides>({})
  // Global settings, fetched alongside project settings — needed only to
  // render inherited CLI flags (muted) in the CliFlagsEditor preview.
  const [globalSettings, setGlobalSettings] = useState<ClaudeGlobalSettings | null>(null)
  // "Custom…" escape hatch (mirrors ModelPicker in settings/primitives.tsx):
  // an override whose model id isn't one of the hardcoded MODEL_OPTIONS must
  // still render AS that value, not silently collapse to 'default' —
  // collapsing was bug-prone because isOverridden stayed true (still showed
  // the override dot) while the Select displayed 'Use global', and the next
  // unrelated field edit would commit `model: undefined` and destroy it.
  const [showCustomModel, setShowCustomModel] = useState(false)
  const [customModelValue, setCustomModelValue] = useState('')

  // Data-driven model list (Claude always present; routed models gated on
  // proxy/provider health server-side) — refetches whenever the currently
  // selected model changes so an unavailable-but-selected routed model is
  // never silently dropped (see useSelectableModels' own doc comment).
  const { models: selectableModels, loading: selectableModelsLoading } = useSelectableModels(
    localOverrides.model
  )
  const modelOptions = useMemo(
    () => buildModelSelectOptions(selectableModels, { value: 'default', label: 'Use global' }),
    [selectableModels]
  )
  // Effort options: data-driven off the PROJECT's own effective model (model-
  // routing unit 11) — resolveEffortLevelsForScope returns the full ladder
  // when localOverrides.model is unset (no single project-scope model to
  // resolve; 'Use global' is prepended separately as `leading`, a distinct
  // concept from 'auto' — see EffortOption's own doc comment) OR while the
  // model list is still loading (`undefined`, treated the same as
  // "unresolved -> full ladder" here since this drawer has no separate
  // pending/non-interactive visual state the way the footer chip does).
  // `null` (the project's OWN explicit model genuinely has no reasoning
  // control, e.g. an image model) is the one case NOT folded into the full
  // ladder — showEffortField below hides the field entirely then, mirroring
  // the footer chip's own "hide, never fabricate" rule.
  const effortLevels = resolveEffortLevelsForScope(
    localOverrides.model,
    selectableModels,
    selectableModelsLoading
  )
  const showEffortField = effortLevels !== null
  const effortOptions = useMemo(
    () =>
      effortOptionsFor(effortLevels ?? [...EFFORT_LADDER_ORDER], {
        value: 'default',
        label: 'Use global'
      }),
    [effortLevels]
  )

  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.api.claudeProjectSettings
      .get(projectId)
      .then((s) => {
        if (cancelled) return
        setSettings(s)
        setLocalOverrides(s.overrides)
        const m = s.overrides.model
        const isCustom = m !== undefined && !selectableModels.some((o) => o.id === m)
        setShowCustomModel(isCustom)
        setCustomModelValue(isCustom ? m : '')
      })
      .catch((err) => console.error('[settings-drawer] failed to load', err))
    window.api.claudeSettings
      .get()
      .then((s) => {
        if (!cancelled) setGlobalSettings(s)
      })
      .catch((err) => console.error('[settings-drawer] failed to load global settings', err))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectableModels intentionally excluded: this effect only runs on open/projectId change (initial load), not every time the list refetches, to avoid fighting in-progress custom-model typing.
  }, [open, projectId])

  // Stable patch: uses functional setState so it doesn't close over
  // `localOverrides` — required for the memoized CliFlagsEditor onChange
  // (below) to stay stable across renders. Mirrors ClaudeDeveloperSection's
  // patch (~line 863); see the comment there for why stability matters for
  // memo. The undefined-clears-a-key semantics and the IPC call + error-path
  // refetch are unchanged from the previous non-memoized version.
  const patch = useCallback(
    (update: ClaudeProjectSettingsOverrides): void => {
      setLocalOverrides((prev) => {
        const next: ClaudeProjectSettingsOverrides = { ...prev }
        for (const [k, v] of Object.entries(update)) {
          if (v === undefined) delete next[k as keyof ClaudeProjectSettingsOverrides]
          else (next as Record<string, unknown>)[k] = v
        }
        return next
      })
      window.api.claudeProjectSettings.update(projectId, update).catch((err) => {
        console.error('[settings-drawer] update failed, refetching', err)
        window.api.claudeProjectSettings
          .get(projectId)
          .then((s) => {
            setSettings(s)
            setLocalOverrides(s.overrides)
          })
          .catch(console.error)
      })
    },
    [projectId]
  )

  function handleModel(v: ModelOption): void {
    // Guard: separator values start with '__sep' and should never be committed
    if (v.startsWith('__sep')) return
    // 'custom' is a picker-only sentinel (switches to the free-text input
    // below) — never a real model id, so never commit it as one.
    if (v === MODEL_CUSTOM_VALUE) {
      setShowCustomModel(true)
      return
    }
    setShowCustomModel(false)
    patch({ model: v === 'default' ? undefined : v })
  }
  function handleCustomModelBlur(): void {
    const v = customModelValue.trim()
    if (v) patch({ model: v })
  }
  function handlePermission(v: PermissionOption): void {
    patch({ permissionMode: v === 'default' ? undefined : (v as ClaudePermissionMode) })
  }
  function handleEffort(v: EffortOption): void {
    patch({ effort: v === 'default' ? undefined : (v as ClaudeEffort) })
  }

  function resetAll(): void {
    setShowCustomModel(false)
    setCustomModelValue('')
    patch({
      model: undefined,
      permissionMode: undefined,
      effort: undefined,
      customCliFlags: undefined,
      customEnvVars: undefined
    })
  }

  // Stable identities for CliFlagsEditor's props — see EMPTY_FLAGS comment.
  // Only change reference when the underlying data actually changes, so
  // CliFlagsEditor's prevValueRef sync and CliFlagsPreview's memo both work.
  // Must stay above the `if (!open) return null` below — Rules of Hooks.
  const cliFlagsValue = useMemo(
    () => localOverrides.customCliFlags ?? EMPTY_FLAGS,
    [localOverrides.customCliFlags]
  )
  const inheritedCliFlags = useMemo(
    () => globalSettings?.customCliFlags ?? EMPTY_FLAGS,
    [globalSettings?.customCliFlags]
  )
  const handleCliFlagsChange = useCallback(
    (v: string[]) => patch({ customCliFlags: v.length > 0 ? v : undefined }),
    [patch]
  )

  // Stable identity for CustomEnvVarsEditor's `value` prop — see
  // EMPTY_ENV_VARS comment.
  const envVarsValue = useMemo(
    () => localOverrides.customEnvVars ?? EMPTY_ENV_VARS,
    [localOverrides.customEnvVars]
  )
  const handleEnvVarsChange = useCallback(
    (v: Record<string, string>) =>
      patch({ customEnvVars: Object.keys(v).length > 0 ? v : undefined }),
    [patch]
  )

  if (!open) return null

  const modelValue: ModelOption =
    localOverrides.model !== undefined
      ? selectableModels.some((o) => o.id === localOverrides.model)
        ? localOverrides.model
        : MODEL_CUSTOM_VALUE
      : 'default'

  const permissionValue: PermissionOption =
    localOverrides.permissionMode !== undefined
      ? (localOverrides.permissionMode as PermissionOption)
      : 'default'

  const effortValue: EffortOption =
    localOverrides.effort !== undefined ? localOverrides.effort : 'default'

  const overrideCount =
    (localOverrides.model !== undefined ? 1 : 0) +
    (localOverrides.permissionMode !== undefined ? 1 : 0) +
    (localOverrides.effort !== undefined ? 1 : 0) +
    ((localOverrides.customCliFlags?.length ?? 0) > 0 ? 1 : 0) +
    (Object.keys(localOverrides.customEnvVars ?? {}).length > 0 ? 1 : 0)
  const hasAnyOverride = overrideCount > 0

  return (
    <Overlay
      open
      interactive
      onDismiss={onClose}
      className="fixed inset-0 z-40 flex"
      // The TopBar above this drawer has WebkitAppRegion: drag, which on
      // macOS captures clicks before they reach React. Explicitly mark the
      // whole drawer overlay as no-drag so the X (and any other interactive
      // element near the top) receives clicks normally.
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Backdrop is a flex sibling, not an absolute overlay, so it can't
          intercept clicks on the drawer body. */}
      <button
        type="button"
        aria-label="Close project settings"
        onClick={onClose}
        className="flex-1 bg-black/40 cursor-default"
      />
      <div
        className="w-[420px] max-w-[90vw] h-full bg-surface-base border-l border-border-default shadow-2xl flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-label={`Project settings — ${projectName}`}
      >
        {/* Header — matches WorkspaceDrawer */}
        <div className="h-8 flex items-center px-2 border-b border-border-default flex-shrink-0">
          <span className="text-sm font-medium text-text-muted px-1.5">Project Settings</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="ml-auto w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 cursor-pointer"
          >
            <X size={12} weight="bold" />
          </button>
        </div>

        {/* Body — single scrollable column */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <section className="flex flex-col">
            <header className="flex items-baseline justify-between px-4 pt-5 pb-3">
              <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
                {projectName}
              </span>
              {hasAnyOverride && (
                <span className="text-xs font-mono text-text-muted">
                  {overrideCount} override{overrideCount === 1 ? '' : 's'}
                </span>
              )}
            </header>

            <div className={!settings ? 'opacity-50 pointer-events-none' : ''}>
              <OverrideField
                label="Model"
                options={modelOptions}
                value={modelValue}
                onChange={handleModel}
                isOverridden={localOverrides.model !== undefined}
                ariaLabel="Project model override"
                description="Default model for new workspaces in this project — Claude or a connected routed provider."
              >
                {showCustomModel && (
                  <input
                    aria-label="Custom model ID"
                    value={customModelValue}
                    onChange={(e) => setCustomModelValue(e.target.value)}
                    onBlur={handleCustomModelBlur}
                    placeholder="model-id (e.g. claude-opus-4-7)"
                    className="mt-1.5 w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus:border-accent/50 transition-colors duration-150 font-mono"
                  />
                )}
              </OverrideField>
              <OverrideField
                label="Permission mode"
                options={PERMISSION_OPTIONS}
                value={permissionValue}
                onChange={handlePermission}
                isOverridden={localOverrides.permissionMode !== undefined}
                ariaLabel="Project permission mode override"
                description="How Claude handles tool permissions when this project's workspaces launch."
              />
              {showEffortField && (
                <OverrideField
                  label="Effort"
                  options={effortOptions}
                  value={effortValue}
                  onChange={handleEffort}
                  isOverridden={localOverrides.effort !== undefined}
                  ariaLabel="Project effort override"
                  description="Thinking depth Claude applies by default for this project."
                />
              )}
            </div>

            {hasAnyOverride && (
              <div className="px-4 py-4 mt-2">
                <button
                  type="button"
                  onClick={resetAll}
                  className="inline-flex items-center gap-1.5 text-sm text-text-muted hover:text-text-primary transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded px-1.5 py-1 -mx-1.5"
                >
                  <ArrowCounterClockwise size={11} weight="bold" />
                  Reset all overrides
                </button>
              </div>
            )}
          </section>

          <WorkspaceCreationSettings projectId={projectId} />

          <section className="flex flex-col mt-4 border-t border-border-default/40">
            <header className="px-4 pt-5 pb-2">
              <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
                Custom CLI flags
              </span>
            </header>
            <div className="px-4 pb-5">
              <CliFlagsEditor
                value={cliFlagsValue}
                onChange={handleCliFlagsChange}
                inheritedFlags={inheritedCliFlags}
                placeholder="--dangerously-load-development-channels server:loco"
              />
            </div>
          </section>

          <section className="flex flex-col mt-4 border-t border-border-default/40">
            <header className="px-4 pt-5 pb-2">
              <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
                Custom environment variables
              </span>
            </header>
            <div className="px-4 pb-5">
              <CustomEnvVarsEditor value={envVarsValue} onChange={handleEnvVarsChange} />
            </div>
          </section>

          <section className="flex flex-col mt-4 border-t border-border-default/40">
            <header className="px-4 pt-5 pb-2">
              <span className="text-xs font-semibold text-text-primary uppercase tracking-wider">
                More coming
              </span>
            </header>
            <p className="px-4 pb-5 text-xs text-text-muted">
              Hooks, tools, MCP servers, subagents, and slash commands at project scope will land in
              a follow-up — they currently live under global Settings.
            </p>
          </section>
        </div>
      </div>
    </Overlay>
  )
}
