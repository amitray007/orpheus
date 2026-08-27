import { useCallback, useEffect, useMemo, useState } from 'react'
import type React from 'react'
import { ArrowCounterClockwise, X } from '@phosphor-icons/react'
import {
  EFFORT_LADDER_ORDER,
  type HarnessSettings,
  type HarnessSummary,
  type WorkspaceRecord
} from '@shared/types'
import { Select, CliFlagsEditor, CustomEnvVarsEditor } from '../settings/primitives'
import { HarnessPicker } from '@/components/HarnessPicker'
import { Overlay } from '@/components/ui/Overlay'
import { WorkspaceCreationSettings } from './WorkspaceCreationSettings'
import { useSelectableModels } from '@/lib/useSelectableModels'
import { buildModelSelectOptions, MODEL_CUSTOM_VALUE } from '@/lib/modelPickerOptions'
import { effortOptionsFor, resolveEffortLevelsForScope } from '@/lib/effortPickerOptions'
import {
  harnessesPresentInProject,
  resolveDrawerHarnessId,
  shouldShowProjectHarnessPicker,
  countProjectHarnessOverrides,
  applyProjectDrawerPatch,
  customCliFlagsToRows,
  rowsToCustomCliFlags,
  customEnvVarsToRows,
  rowsToCustomEnvVars,
  type ProjectDrawerFieldPatch
} from '@shared/harness/projectDrawerSettings'
import { CLAUDE_PERMISSION_MODE_ARG_KEY } from './claudePermissionModeArgKey'

// ---------------------------------------------------------------------------
// Per-project settings drawer
//
// Layout mirrors WorkspaceDrawer: section header on top, stacked override
// fields (full-width label + full-width Select), hairline dividers. The drawer
// itself is a right-aligned overlay (the project view doesn't have a dedicated
// side panel slot like WorkspaceView does).
//
// H1 (support-multi-harness) — the drawer's fields now edit harness_settings
// (project scope, via window.api.harness.getSettings/updateProjectDrawerSettings)
// instead of claude_project_settings, the storage the live launch emitter
// (composeClaudeHarnessLaunch, wired as every harness descriptor's
// composeLaunch) actually reads. claude_project_settings and its IPC still
// exist in main untouched; this drawer simply stops being the thing that
// writes to it.
//
// FIVE SURVIVING FIELDS, per the user's decision (see this unit's report for
// the full investigation and per-field findings that informed it):
//   - Model, Effort — curated.model/curated.effort (harness_settings).
//   - Custom CLI flags — an `args` row PER FLAG NAME, converted from/to the
//     familiar free-text list via customCliFlagsToRows/rowsToCustomCliFlags.
//     LOSSY in one direction only (string[] -> rows): see
//     customCliFlagsToRows' own header for the exact cases (a >2-token
//     entry, or two entries sharing a flag name) and why WARN-AND-CONVERT
//     was chosen over refusing to save.
//   - Custom environment variables — `env` rows, LOSSLESS both ways (no
//     lexing; Record<string,string> and HarnessSettingRow[] are already the
//     same shape).
//   - Custom shell before harness (RENAMED from "before Claude" — the field
//     is harness-agnostic: resources/harness-common.sh, sourced by every
//     harness's own wrapper script, reads ORPHEUS_PRE_LAUNCH_SNIPPET
//     directly) — a dedicated HarnessSettings.preLaunchSnippet field (see
//     that type's own doc comment in src/main/harness/settings.ts).
//
// REMOVED: Permission mode ("we follow global only" — still editable at
// Settings > Harness as a --permission-mode args row, so no capability is
// lost) and Source ~/.zshrc before Claude (no revival — this drawer no
// longer offers it at any scope).
// ---------------------------------------------------------------------------

// Model options are data-driven (models:listSelectable — Claude always
// present, routed models gated on proxy/provider health; see
// buildModelSelectOptions) rather than a hardcoded CLAUDE_MODEL_OPTIONS
// slice — see the useSelectableModels() call below. MODEL_CUSTOM_VALUE is
// the shared 'Custom…' escape hatch (unit 01).
type ModelOption = string

// Effort options are data-driven (model-routing unit 11) — the project's
// effective model's real effortLevels via resolveEffortLevelsForScope/
// effortOptionsFor (see the useMemo below), never a hardcoded ladder. A
// project has no single resolved model unless projectModel is set (see
// resolveEffortLevelsForScope's own doc comment for why 'default'/"no
// override at this scope" resolves to the full ladder, the same fallback
// the footer chip's modelValue === '' case uses) — 'Use global' is a
// DIFFERENT concept from 'auto' and is prepended as `leading`, never
// collapsed into it.
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
  /** This project's workspaces — used ONLY to compute which harness(es) the
   *  project actually runs (harnessesPresentInProject), for the drawer's
   *  own harness picker default and the override chip's honesty check.
   *  null/undefined (still loading) degrades to "no membership known yet",
   *  same as ProjectView's own workspaceCount === null loading state. */
  workspaces?: WorkspaceRecord[] | null
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

interface TextOverrideFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  isOverridden: boolean
  ariaLabel: string
  description?: string
  placeholder?: string
}

// Free-text analogue of OverrideField, for override values that aren't a
// fixed enum (preLaunchSnippet). An empty textarea clears the override back
// to "inherit global" — same undefined-clears semantics as the Select rows,
// just driven by blur (mirrors ClaudeToolsSection's global textarea) instead
// of onChange, so the override isn't rewritten on every keystroke.
function TextOverrideField({
  label,
  value,
  onChange,
  isOverridden,
  ariaLabel,
  description,
  placeholder
}: TextOverrideFieldProps): React.JSX.Element {
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
      <textarea
        aria-label={ariaLabel}
        defaultValue={value}
        key={value}
        onBlur={(e) => onChange(e.target.value.trim())}
        placeholder={placeholder}
        className="w-full min-h-[76px] px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 transition-colors duration-150 font-mono resize-y cursor-text"
      />
    </div>
  )
}

export function SettingsDrawer({
  projectId,
  projectName,
  open,
  onClose,
  workspaces
}: SettingsDrawerProps): React.JSX.Element | null {
  // Harness-aware state (H1) — every field in this drawer now lives here,
  // backed by harness_settings (project scope, plus global for the
  // CLI-flags "inherited" preview) for whichever harness is selected.
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([])
  const [selectedHarnessId, setSelectedHarnessId] = useState<string>('')
  const [harnessSettings, setHarnessSettingsState] = useState<HarnessSettings | null>(null)
  // Global-scope harness_settings for the selected harness — needed only to
  // render inherited CLI flags (muted) in the CliFlagsEditor preview, same
  // role globalSettings played pre-H1.
  const [globalHarnessSettings, setGlobalHarnessSettings] = useState<HarnessSettings | null>(null)
  // Lossy-conversion warnings from the most recent customCliFlagsToRows call
  // (see that function's own doc comment) — surfaced under the CLI flags
  // editor so a user whose free-text entry couldn't convert losslessly sees
  // exactly why, rather than silently getting different behavior.
  const [cliFlagsWarnings, setCliFlagsWarnings] = useState<string[]>([])

  // Which harness(es) this project's workspaces actually run — the input to
  // both the picker's default selection and the override chip's honesty
  // check (projectOverrideChipInfo, used by ProjectView/ProjectHeader).
  const harnessesInProject = useMemo(() => harnessesPresentInProject(workspaces), [workspaces])

  // Resolves the drawer's EDITING target: an explicit in-session pick wins,
  // else the project's own harness, else the first registered harness. See
  // resolveDrawerHarnessId's own doc comment for the full precedence.
  const harnessId = resolveDrawerHarnessId(harnesses, harnessesInProject, selectedHarnessId)
  const showHarnessPicker = shouldShowProjectHarnessPicker(harnesses)

  // "Custom…" escape hatch (mirrors ModelPicker in settings/primitives.tsx):
  // an override whose model id isn't one of the hardcoded MODEL_OPTIONS must
  // still render AS that value, not silently collapse to 'default' —
  // collapsing was bug-prone because isOverridden stayed true (still showed
  // the override dot) while the Select displayed 'Use global', and the next
  // unrelated field edit would commit `model: undefined` and destroy it.
  const [showCustomModel, setShowCustomModel] = useState(false)
  const [customModelValue, setCustomModelValue] = useState('')

  const projectModel = harnessSettings?.curated?.model
  const projectEffort = harnessSettings?.curated?.effort

  // Data-driven model list (Claude always present; routed models gated on
  // proxy/provider health server-side) — refetches whenever the currently
  // selected model changes so an unavailable-but-selected routed model is
  // never silently dropped (see useSelectableModels' own doc comment).
  // projectId applies this project's curatedOptions overlay; harnessId (H1)
  // is now passed through explicitly rather than omitted, so a non-Claude
  // harness's own model catalog (once one is registered) is what the picker
  // offers, instead of always falling back to Claude's.
  const { models: selectableModels, loading: selectableModelsLoading } = useSelectableModels(
    projectModel,
    true,
    harnessId,
    projectId,
    projectEffort
  )
  const modelOptions = useMemo(
    () => buildModelSelectOptions(selectableModels, { value: 'default', label: 'Use global' }),
    [selectableModels]
  )
  // Effort options: data-driven off the PROJECT's own effective model (model-
  // routing unit 11) — resolveEffortLevelsForScope returns the full ladder
  // when projectModel is unset (no single project-scope model to resolve;
  // 'Use global' is prepended separately as `leading`, a distinct concept
  // from 'auto' — see EffortOption's own doc comment) OR while the model
  // list is still loading (`undefined`, treated the same as "unresolved ->
  // full ladder" here since this drawer has no separate pending/
  // non-interactive visual state the way the footer chip does). `null` (the
  // project's OWN explicit model genuinely has no reasoning control, e.g.
  // an image model) is the one case NOT folded into the full ladder —
  // showEffortField below hides the field entirely then, mirroring the
  // footer chip's own "hide, never fabricate" rule.
  const effortLevels = resolveEffortLevelsForScope(
    projectModel,
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

  // Fetch the registered harness list once per open — static per-build data
  // (mirrors NewWorkspaceMenu.tsx's harnessesCache rationale: nothing to
  // invalidate mid-session), so no cache is needed at this call site's
  // scale (one drawer instance, opened occasionally, not a hot popover).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.api.harness
      .list()
      .then((list) => {
        if (!cancelled) setHarnesses(list)
      })
      .catch((err) => console.error('[settings-drawer] failed to load harnesses', err))
    return () => {
      cancelled = true
    }
  }, [open])

  // Fetch this project's harness_settings row (project scope) PLUS the
  // global-scope row (for the CLI-flags inherited-preview) whenever the
  // drawer is open and the EDITING target (harness) changes.
  useEffect(() => {
    if (!open || !harnessId) return
    let cancelled = false
    window.api.harness
      .getSettings(harnessId, 'project', projectId)
      .then((s) => {
        if (cancelled) return
        setHarnessSettingsState(s)
        const m = s.curated?.model
        const isCustom = m !== undefined && !selectableModels.some((o) => o.id === m)
        setShowCustomModel(isCustom)
        setCustomModelValue(isCustom ? m : '')
      })
      .catch((err) => console.error('[settings-drawer] failed to load harness settings', err))
    window.api.harness
      .getSettings(harnessId, 'global')
      .then((s) => {
        if (!cancelled) setGlobalHarnessSettings(s)
      })
      .catch((err) =>
        console.error('[settings-drawer] failed to load global harness settings', err)
      )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectableModels intentionally excluded: this effect only runs on open/harness/project change (initial load), not every time the list refetches, to avoid fighting in-progress custom-model typing.
  }, [open, harnessId, projectId])

  // Harness-aware patch for every field in this drawer — writes
  // harness_settings project scope via the drawer-specific IPC channel (see
  // this file's header) instead of claude_project_settings. Optimistically
  // updates local state via applyProjectDrawerPatch (src/shared/harness/
  // projectDrawerSettings.ts) — the SAME pure merge function the main-process
  // handler uses, so the optimistic update can never drift from what the
  // server-side write actually produces. Refetches on failure.
  const patchHarness = useCallback(
    (update: ProjectDrawerFieldPatch) => {
      setHarnessSettingsState((prev) =>
        applyProjectDrawerPatch(prev ?? {}, update, CLAUDE_PERMISSION_MODE_ARG_KEY)
      )
      window.api.harness.updateProjectDrawerSettings(harnessId, projectId, update).catch((err) => {
        console.error('[settings-drawer] harness update failed, refetching', err)
        window.api.harness
          .getSettings(harnessId, 'project', projectId)
          .then((s) => setHarnessSettingsState(s))
          .catch(console.error)
      })
    },
    [harnessId, projectId]
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
    patchHarness({ model: v === 'default' ? null : v })
  }
  function handleCustomModelBlur(): void {
    const v = customModelValue.trim()
    if (v) patchHarness({ model: v })
  }
  function handleEffort(v: EffortOption): void {
    patchHarness({ effort: v === 'default' ? null : v })
  }

  function resetAll(): void {
    setShowCustomModel(false)
    setCustomModelValue('')
    setCliFlagsWarnings([])
    patchHarness({
      model: null,
      effort: null,
      customCliFlags: [],
      customEnvVars: [],
      preLaunchSnippet: null
    })
  }

  // Stable identities for CliFlagsEditor's props — see EMPTY_FLAGS comment.
  // Only change reference when the underlying data actually changes, so
  // CliFlagsEditor's prevValueRef sync and CliFlagsPreview's memo both work.
  // Must stay above the `if (!open) return null` below — Rules of Hooks.
  // Extracted into plain locals (rather than accessing harnessSettings?.args
  // twice inside the useMemo body) so the memo's dependency is exactly the
  // array reference, not the whole settings object.
  const projectArgs = harnessSettings?.args
  const globalArgs = globalHarnessSettings?.args
  const projectEnv = harnessSettings?.env
  const cliFlagsValue = useMemo(
    () => (projectArgs ? rowsToCustomCliFlags(projectArgs) : EMPTY_FLAGS),
    [projectArgs]
  )
  const inheritedCliFlags = useMemo(
    () => (globalArgs ? rowsToCustomCliFlags(globalArgs) : EMPTY_FLAGS),
    [globalArgs]
  )
  const handleCliFlagsChange = useCallback(
    (v: string[]) => {
      const { rows, warnings } = customCliFlagsToRows(v)
      setCliFlagsWarnings(warnings)
      patchHarness({ customCliFlags: rows })
    },
    [patchHarness]
  )

  // Stable identity for CustomEnvVarsEditor's `value` prop — see
  // EMPTY_ENV_VARS comment.
  const envVarsValue = useMemo(
    () => (projectEnv ? rowsToCustomEnvVars(projectEnv) : EMPTY_ENV_VARS),
    [projectEnv]
  )
  const handleEnvVarsChange = useCallback(
    (v: Record<string, string>) => patchHarness({ customEnvVars: customEnvVarsToRows(v) }),
    [patchHarness]
  )

  function handlePreLaunchSnippet(v: string): void {
    patchHarness({ preLaunchSnippet: v === '' ? null : v })
  }

  if (!open) return null

  const modelValue: ModelOption =
    projectModel !== undefined
      ? selectableModels.some((o) => o.id === projectModel)
        ? projectModel
        : MODEL_CUSTOM_VALUE
      : 'default'

  const effortValue: EffortOption = projectEffort !== undefined ? projectEffort : 'default'

  // Harness-aware override count (H1) — every field in this drawer is now
  // counted from harness_settings via countProjectHarnessOverrides, which
  // covers model/effort/permissionMode; customCliFlags/customEnvVars/
  // preLaunchSnippet are counted here directly since they are outside that
  // function's three-field contract (see its own doc comment — it counts
  // exactly the fields the ORIGINAL, permission-mode-having drawer wrote).
  const baseOverrideCount = countProjectHarnessOverrides(
    harnessSettings ?? undefined,
    CLAUDE_PERMISSION_MODE_ARG_KEY
  )
  const cliFlagsOverridden = cliFlagsValue.length > 0
  const envVarsOverridden = Object.keys(envVarsValue).length > 0
  const preLaunchSnippetOverridden = Boolean(harnessSettings?.preLaunchSnippet)
  const overrideCount =
    baseOverrideCount +
    (cliFlagsOverridden ? 1 : 0) +
    (envVarsOverridden ? 1 : 0) +
    (preLaunchSnippetOverridden ? 1 : 0)
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

            {/* Harness picker (H1) — invisible with only Claude registered
                (shouldShowProjectHarnessPicker gates on harnesses.length > 1,
                same threshold as workspace creation's own picker). Every
                field below edits THIS harness's project-scope settings. */}
            {showHarnessPicker && (
              <div className="px-4 pb-3">
                <p className="text-xs text-text-muted mb-2">
                  Editing settings for this harness — this project may run others too.
                </p>
                <HarnessPicker
                  harnesses={harnesses}
                  selectedId={harnessId}
                  onSelect={setSelectedHarnessId}
                />
              </div>
            )}

            <div className={!harnessSettings ? 'opacity-50 pointer-events-none' : ''}>
              <OverrideField
                label="Model"
                options={modelOptions}
                value={modelValue}
                onChange={handleModel}
                isOverridden={projectModel !== undefined}
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
              {showEffortField && (
                <OverrideField
                  label="Effort"
                  options={effortOptions}
                  value={effortValue}
                  onChange={handleEffort}
                  isOverridden={projectEffort !== undefined}
                  ariaLabel="Project effort override"
                  description="Thinking depth Claude applies by default for this project."
                />
              )}
              <TextOverrideField
                label="Custom shell before harness"
                value={harnessSettings?.preLaunchSnippet ?? ''}
                onChange={handlePreLaunchSnippet}
                isOverridden={harnessSettings?.preLaunchSnippet !== undefined}
                ariaLabel="Project custom shell before harness override"
                description='Runs as you, in your shell, right before this project&#39;s harness starts. Example: eval "$(direnv export zsh)"'
                placeholder='eval "$(direnv export zsh)"'
              />
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
              {cliFlagsWarnings.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1">
                  {cliFlagsWarnings.map((w, i) => (
                    <li key={i} className="text-xs text-amber-500">
                      {w}
                    </li>
                  ))}
                </ul>
              )}
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
