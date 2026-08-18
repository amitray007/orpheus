import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type {
  HarnessSummary,
  HarnessSettings,
  HarnessSettingRow,
  HarnessSettingsScope,
  ProjectRecord
} from '@shared/types'
import {
  Plus,
  Trash,
  CaretUp,
  CaretDown,
  Question,
  ArrowCounterClockwise
} from '@phosphor-icons/react'
import { SettingRow, SegmentedControl, Select, Toggle, Eyebrow, SecretInput } from './primitives'
import { ProviderIcon, isKnownProviderIconId } from '@/components/ProviderIcon'
import {
  isSecretLikeKey,
  hasUnsavedChanges,
  moveRow,
  resolveProvenance,
  mergeDefaultArgs,
  draftsToStoredRows,
  type HarnessScopeSettingsBundle
} from './harnessSettingsLogic'

// ---------------------------------------------------------------------------
// HarnessSection (U8, multi-harness architecture plan)
//
// Data-driven from harness:list — no hardcoded 'claude' anywhere in this
// component. A second harness needs no new code here, only a second
// HarnessDescriptor in src/main/harness/registry.ts. This section ships
// zero-or-more default args (visibly-marked, user-editable rows — see
// mergeDefaultArgs) plus zero default env — everything else is untyped
// user-supplied passthrough, edited via the row editors below.
//
// NO CURATED MODEL/EFFORT UI HERE, DELIBERATELY: a descriptor may still
// declare `curated` (HarnessDescriptor.curated in src/main/harness/registry.ts
// — the flag/env/configFlag shape a harness expresses model/effort with,
// e.g. Claude's `--model`), and the launch path (buildCuratedArgs/
// buildCuratedEnv, src/main/harness/claude/curated.ts + launch.ts) still
// reads it. That knowledge just isn't rendered as a picker in THIS section
// anymore — a user who wants to pin a model adds `--model` as an ordinary
// arg row below, like any other flag. Quick actions (and later, per-harness
// UI) are expected to read `curated` directly rather than through a control
// here.
//
// SCOPE: global + project only. Workspace scope was removed deliberately —
// see HARNESS_SETTINGS_SCOPE in src/main/db/schema.ts.
// ---------------------------------------------------------------------------

const EMPTY_SETTINGS: HarnessSettings = {}

const SCOPE_OPTIONS: ReadonlyArray<{ value: HarnessSettingsScope; label: string }> = [
  { value: 'global', label: 'Global' },
  { value: 'project', label: 'Project' }
]

function scopeChipLabel(scope: HarnessSettingsScope): string {
  return scope === 'global' ? 'global' : 'project'
}

// ---------------------------------------------------------------------------
// Harness picker — a command list, not a special-cased single-harness UI.
// Reference: a preset picker where each row reads
// "[icon] [Name] ............ [the actual command it runs]" — see the
// redesign rationale in the task brief. Renders every harness from
// harness:list (today just Claude), each with its resolved command preview
// (binary + its own harness-provided default args, at descriptor defaults —
// the picker previews what a FRESH install of this harness would run, not
// the current scope's edited settings) so the row reads as "this is the
// command this harness runs," matching CliFlagsPreview's "claude <flags>"
// convention in primitives.tsx.
// ---------------------------------------------------------------------------

/** Builds the resolved command preview for a harness's OWN shipped defaults
 *  — binary followed by its enabled default args, flag+value pairs in
 *  order. Pure string assembly, no dependency on the currently-edited
 *  scope's settings (that's a live edited-command concern the args editor
 *  below already covers via HarnessRowEditor). */
function harnessCommandPreview(harness: HarnessSummary): string {
  const tokens: string[] = [harness.binary]
  for (const arg of harness.defaultArgs ?? []) {
    if (!arg.enabled) continue
    tokens.push(arg.key)
    if (arg.value) tokens.push(arg.value)
  }
  return tokens.join(' ')
}

interface HarnessPickerProps {
  harnesses: HarnessSummary[]
  selectedId: string
  onSelect: (id: string) => void
}

function HarnessPicker({ harnesses, selectedId, onSelect }: HarnessPickerProps): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Harness"
      className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/60 overflow-hidden"
    >
      {harnesses.map((harness) => {
        const selected = harness.id === selectedId
        return (
          <button
            key={harness.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(harness.id)}
            className={[
              'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors duration-150 cursor-pointer',
              selected ? 'bg-accent/10' : 'hover:bg-surface-overlay'
            ].join(' ')}
          >
            <span
              className={[
                'flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0',
                selected ? 'bg-accent/20 text-accent' : 'bg-surface-overlay text-text-muted'
              ].join(' ')}
            >
              {harness.icon && isKnownProviderIconId(harness.icon) ? (
                <ProviderIcon providerId={harness.icon} size={14} />
              ) : (
                <Question size={14} />
              )}
            </span>
            <span
              className={[
                'text-sm font-medium flex-shrink-0',
                selected ? 'text-text-primary' : 'text-text-secondary'
              ].join(' ')}
            >
              {harness.label}
            </span>
            <span className="flex-1 min-w-0 border-b border-dotted border-border-default/50 mx-1" />
            <span className="text-xs font-mono text-text-muted overflow-x-auto whitespace-nowrap flex-shrink-0">
              {harnessCommandPreview(harness)}
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// HarnessRowEditor — args/env editor for HarnessSettingRow[]: add, edit
// (key + value), remove, reorder (up/down), enable/disable toggle per row.
// Modeled on CustomEnvVarsEditor's two-input-per-row shape (primitives.tsx)
// plus a Toggle and reorder buttons, since no existing editor combines all
// three. `secretValues` (env only) renders the value input via SecretInput
// when the row's key looks secret-bearing.
//
// FULLY CONTROLLED — no internal draft state, no resync guard. The section
// below owns ALL draft rows (args + env) as the single source of truth while
// editing; this component just renders `rows` and reports every mutation
// straight up via `onChange`, including an in-progress blank row (a row with
// no key is a pending, uncommitted addition — see `addRow` in the section
// below). Nothing here decides what gets persisted; that's Save's job.
// This is deliberate: the previous version kept a second copy of the rows in
// local state and reconciled it against props on every render, which is what
// produced three bugs in a row (dead Add button, a React #301 crash, typed
// text disappearing mid-edit). A single owner removes the reconciliation
// entirely rather than tuning it again.
// ---------------------------------------------------------------------------

interface RowDraft extends HarnessSettingRow {
  id: string
  /** Display-only: this row currently matches a harness-provided default
   *  (see mergeDefaultArgs). Re-derived at save time (via draftsToStoredRows)
   *  rather than trusted as an edit signal. */
  fromDefault?: boolean
}

function toDrafts(rows: readonly (HarnessSettingRow & { fromDefault?: boolean })[]): RowDraft[] {
  return rows.map((r) => ({ ...r, id: crypto.randomUUID() }))
}

interface HarnessRowEditorProps {
  rows: readonly RowDraft[]
  onChange: (rows: RowDraft[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
  keyAriaLabel: string
  valueAriaLabel: string
  secretValues?: boolean
  addLabel: string
}

function HarnessRowEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  keyAriaLabel,
  valueAriaLabel,
  secretValues,
  addLabel
}: HarnessRowEditorProps): React.JSX.Element {
  function updateRow(idx: number, patch: Partial<HarnessSettingRow>): void {
    onChange(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))
  }

  function removeRow(idx: number): void {
    onChange(rows.filter((_, i) => i !== idx))
  }

  function addRow(): void {
    onChange([...rows, { id: crypto.randomUUID(), key: '', value: '', enabled: true }])
  }

  function move(idx: number, direction: 'up' | 'down'): void {
    onChange(moveRow(rows, idx, direction))
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, idx) => {
        const useSecretInput = secretValues && isSecretLikeKey(row.key)
        return (
          <div key={row.id} className="flex items-center gap-1.5">
            <div className="flex flex-col gap-0.5 flex-shrink-0">
              <button
                type="button"
                onClick={() => move(idx, 'up')}
                disabled={idx === 0}
                aria-label="Move up"
                className="w-4 h-2.5 flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <CaretUp size={9} weight="bold" />
              </button>
              <button
                type="button"
                onClick={() => move(idx, 'down')}
                disabled={idx === rows.length - 1}
                aria-label="Move down"
                className="w-4 h-2.5 flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <CaretDown size={9} weight="bold" />
              </button>
            </div>
            <Toggle
              value={row.enabled}
              onChange={(v) => updateRow(idx, { enabled: v })}
              ariaLabel={`Enable ${row.key || 'row'}`}
            />
            <input
              type="text"
              aria-label={keyAriaLabel}
              value={row.key}
              onChange={(e) => updateRow(idx, { key: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                if (e.key === 'Escape') removeRow(idx)
              }}
              placeholder={keyPlaceholder}
              className="w-40 px-2.5 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text"
            />
            {row.fromDefault && (
              <span
                title={`${row.key || 'This flag'} ships as a default for this harness`}
                className="text-[10px] leading-none font-medium text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-1 flex-shrink-0"
              >
                harness default
              </span>
            )}
            {useSecretInput ? (
              <SecretInput
                value={row.value ?? ''}
                onChange={(v) => updateRow(idx, { value: v })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                  if (e.key === 'Escape') removeRow(idx)
                }}
                placeholder={valuePlaceholder}
                ariaLabel={valueAriaLabel}
              />
            ) : (
              <input
                type="text"
                aria-label={valueAriaLabel}
                value={row.value ?? ''}
                onChange={(e) => updateRow(idx, { value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
                  if (e.key === 'Escape') removeRow(idx)
                }}
                placeholder={valuePlaceholder}
                className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text"
              />
            )}
            <button
              type="button"
              onClick={() => removeRow(idx)}
              className="text-text-muted hover:text-red-400 transition-colors flex-shrink-0"
              aria-label={row.fromDefault ? 'Reset to harness default' : 'Remove row'}
              title={
                row.fromDefault
                  ? 'Resets to this harness’s shipped default rather than deleting it permanently'
                  : undefined
              }
            >
              <Trash size={13} />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        onClick={addRow}
        className="self-start flex items-center gap-1.5 text-xs text-accent hover:opacity-80 transition-opacity"
      >
        <Plus size={12} weight="bold" />
        {addLabel}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// HarnessSection
// ---------------------------------------------------------------------------

export function HarnessSection(): React.JSX.Element | null {
  const [harnesses, setHarnesses] = useState<HarnessSummary[] | null>(null)
  const [selectedHarnessId, setSelectedHarnessId] = useState<string>('')
  const [scope, setScope] = useState<HarnessSettingsScope>('global')
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')

  const [globalSettings, setGlobalSettings] = useState<HarnessSettings>(EMPTY_SETTINGS)
  const [projectSettings, setProjectSettings] = useState<HarnessSettings>(EMPTY_SETTINGS)

  // Local draft state — the single source of truth WHILE EDITING. Seeded
  // from the loaded scope settings once per context change (see the effect
  // below) and otherwise mutated only by the editors and never resynced
  // from props; that resync was the bug (see HarnessRowEditor's header).
  const [draftArgs, setDraftArgs] = useState<RowDraft[]>([])
  const [draftEnv, setDraftEnv] = useState<RowDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.harness
      .list()
      .then((list) => {
        if (cancelled) return
        setHarnesses(list)
        if (list.length > 0) setSelectedHarnessId((prev) => prev || list[0].id)
      })
      .catch(console.error)
    window.api.projects
      .list()
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [])

  // Reset the project selection as soon as scope leaves 'project', in the
  // SAME handler that changes scope — not a reactive effect keyed on scope,
  // which would call setState synchronously inside an effect body
  // (react-hooks/set-state-in-effect).
  function selectScope(next: HarnessSettingsScope): void {
    setScope(next)
    if (next === 'global') setSelectedProjectId('')
  }

  const selectedHarness = harnesses?.find((h) => h.id === selectedHarnessId) ?? null

  const scopeId = scope === 'project' ? selectedProjectId : undefined

  // Fetch global+project settings for the selected harness in parallel
  // whenever the harness or the project selection changes — the provenance
  // resolver (harnessSettingsLogic.ts) needs both layers regardless of
  // which scope is currently being edited, so "which scope is a value
  // inherited from" can be shown correctly. NOT keyed on `scope` — flipping
  // the Global/Project segmented control re-reads settings already fetched
  // here, it doesn't need a fresh round trip.
  //
  // `loadedFetchKey` records which [harness, project] pair the MOST RECENT
  // successful fetch belongs to — the exact same pairing the fetch effect
  // below is keyed on (state, not a ref, so its change can itself trigger
  // the seed effect further down to re-run). The seed effect compares it
  // against the CURRENT [harness, project] pair to avoid seeding drafts from
  // stale, still-resident globalSettings/projectSettings — switching harness
  // OR project fires both effects in the same render, but this fetch
  // resolves asynchronously, later.
  const fetchKey = `${selectedHarnessId}::${selectedProjectId}`
  const [loadedFetchKey, setLoadedFetchKey] = useState<string>('')

  useEffect(() => {
    if (!selectedHarnessId) return
    let cancelled = false
    const fetchingKey = fetchKey

    const globalP = window.api.harness.getSettings(selectedHarnessId, 'global').then((g) => {
      if (!cancelled) setGlobalSettings(g)
      return g
    })
    const projectP = selectedProjectId
      ? window.api.harness
          .getSettings(selectedHarnessId, 'project', selectedProjectId)
          .then((p) => {
            if (!cancelled) setProjectSettings(p)
            return p
          })
      : // Deferred to a microtask (not a direct call in the effect body) so
        // this reset goes through the same async-callback shape as the fetch
        // branch above — see react-hooks/set-state-in-effect.
        Promise.resolve().then(() => {
          if (!cancelled) setProjectSettings(EMPTY_SETTINGS)
          return EMPTY_SETTINGS
        })

    Promise.all([globalP, projectP])
      .then(() => {
        if (!cancelled) setLoadedFetchKey(fetchingKey)
      })
      .catch(console.error)

    return () => {
      cancelled = true
    }
  }, [selectedHarnessId, selectedProjectId, fetchKey])

  const scopeSettings: HarnessSettings = scope === 'global' ? globalSettings : projectSettings

  // Re-seed drafts ONLY on a deliberate context change — switching harness
  // or scope (global/project) or, within project scope, switching which
  // project — never in response to `scopeSettings` changing on its own
  // (a save round-trip re-fetches and calls setGlobalSettings/
  // setProjectSettings too; reseeding then would discard whatever the user
  // typed after clicking Save but before the response landed, resurrecting
  // the exact resync-vs-edit fight explicit save was built to remove).
  //
  // Gated on `loadedFetchKey === fetchKey` so this effect's
  // fire-on-context-change doesn't seed from a PREVIOUS harness/project's
  // still-resident scopeSettings before the fetch above resolves — it waits
  // for `loadedFetchKey` to catch up (which re-runs this effect, since it's
  // a dependency) rather than seeding from stale data.
  useEffect(() => {
    if (!selectedHarnessId || loadedFetchKey !== fetchKey) return
    let cancelled = false
    Promise.resolve().then(() => {
      if (cancelled) return
      setDraftArgs(toDrafts(mergeDefaultArgs(selectedHarness?.defaultArgs, scopeSettings.args)))
      setDraftEnv(toDrafts(scopeSettings.env ?? []))
      setSaveError(null)
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHarnessId, scope, scopeId, loadedFetchKey, fetchKey])

  const provenance = useMemo(
    () =>
      resolveProvenance({
        global: globalSettings,
        project: projectSettings
      } satisfies HarnessScopeSettingsBundle),
    [globalSettings, projectSettings]
  )

  // Harness-provided defaultArgs merged with the scope's stored rows — see
  // mergeDefaultArgs's doc comment for the identity/precedence contract.
  // This is the LOADED shape — the baseline the dirty check and Discard
  // compare drafts against. It tracks `scopeSettings` reactively (unlike
  // drafts, which only reseed on a genuine context change above), so a save
  // round-trip's fresh response updates the baseline correctly without
  // touching whatever the user is mid-edit on.
  const loadedArgs = useMemo(
    () => toDrafts(mergeDefaultArgs(selectedHarness?.defaultArgs, scopeSettings.args)),
    [selectedHarness, scopeSettings.args]
  )
  const loadedEnv = useMemo(() => toDrafts(scopeSettings.env ?? []), [scopeSettings.env])

  const argsDirty = hasUnsavedChanges(loadedArgs, draftArgs)
  const envDirty = hasUnsavedChanges(loadedEnv, draftEnv)
  const isDirty = argsDirty || envDirty

  function discard(): void {
    setDraftArgs(loadedArgs)
    setDraftEnv(loadedEnv)
    setSaveError(null)
  }

  function save(): void {
    if (!selectedHarnessId) return
    if (scope === 'project' && !scopeId) return
    // Blank rows (an in-progress, never-named Add) must never persist — see
    // draftsToStoredRows / the addRow doc comment. Re-derive which args
    // still match the harness's own shipped defaults and drop those too, so
    // an untouched default isn't written into storage just because it was
    // displayed (draftsToStoredRows's contract).
    const namedArgs = draftArgs
      .filter((r) => r.key.trim() !== '')
      .map(({ key, value, enabled }) => ({ key, value, enabled }))
    const namedEnv = draftEnv
      .filter((r) => r.key.trim() !== '')
      .map(({ key, value, enabled }) => ({ key, value, enabled }))
    // Spread the existing settings — NOT a fresh { args, env } object — so
    // `curated` (still persisted, even though this UI no longer edits it;
    // see the file header) survives the round trip untouched. Both args and
    // env go in ONE setSettings call: they live in a single settings_json
    // blob, so two separate writes would race.
    const next: HarnessSettings = {
      ...scopeSettings,
      args: draftsToStoredRows(namedArgs, selectedHarness?.defaultArgs),
      env: namedEnv
    }
    setSaving(true)
    setSaveError(null)
    window.api.harness
      .setSettings(selectedHarnessId, scope, scopeId, next)
      .then((saved) => {
        if (scope === 'global') setGlobalSettings(saved)
        else setProjectSettings(saved)
      })
      .catch((err) => {
        console.error('[harness] setSettings failed', err)
        setSaveError(err instanceof Error ? err.message : 'Failed to save harness settings.')
      })
      .finally(() => setSaving(false))
  }

  if (!harnesses) return null

  const canEditScope = scope === 'global' || Boolean(scopeId)

  return (
    <section className="flex flex-col gap-6">
      <div>
        <Eyebrow className="mb-3">Harness</Eyebrow>
        <HarnessPicker
          harnesses={harnesses}
          selectedId={selectedHarnessId}
          onSelect={setSelectedHarnessId}
        />
      </div>

      <div>
        <Eyebrow className="mb-3">Scope</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 divide-y divide-border-default/60">
          <SettingRow label="Scope" description="Which layer these settings apply to.">
            <SegmentedControl<HarnessSettingsScope>
              options={SCOPE_OPTIONS}
              value={scope}
              onChange={selectScope}
              ariaLabel="Scope"
            />
          </SettingRow>
          {scope === 'project' && (
            <SettingRow label="Project" description="Which project this scope applies to.">
              <Select
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                value={selectedProjectId}
                onChange={setSelectedProjectId}
                ariaLabel="Project"
                placeholder="Choose a project"
              />
            </SettingRow>
          )}
        </div>
      </div>

      {!canEditScope ? (
        <p className="text-xs text-text-muted italic px-1">
          Choose a {scope} above to edit its settings.
        </p>
      ) : (
        selectedHarness && (
          <>
            <div>
              <Eyebrow className="mb-3">Arguments</Eyebrow>
              <div className="bg-surface-raised border border-border-default rounded-lg p-5">
                {scope !== 'global' && provenance.args.size > 0 && (
                  <InheritedRowsNote
                    scope={scope}
                    provenance={provenance.args}
                    rows={scopeSettings.args}
                  />
                )}
                <HarnessRowEditor
                  rows={draftArgs}
                  onChange={setDraftArgs}
                  keyPlaceholder="--flag"
                  valuePlaceholder="value (optional)"
                  keyAriaLabel="Argument flag"
                  valueAriaLabel="Argument value"
                  addLabel="Add argument"
                />
              </div>
            </div>

            <div>
              <Eyebrow className="mb-3">Environment</Eyebrow>
              <div className="bg-surface-raised border border-border-default rounded-lg p-5">
                {scope !== 'global' && provenance.env.size > 0 && (
                  <InheritedRowsNote
                    scope={scope}
                    provenance={provenance.env}
                    rows={scopeSettings.env}
                  />
                )}
                <HarnessRowEditor
                  rows={draftEnv}
                  onChange={setDraftEnv}
                  keyPlaceholder="ENV_VAR_NAME"
                  valuePlaceholder="value"
                  keyAriaLabel="Environment variable name"
                  valueAriaLabel="Environment variable value"
                  secretValues
                  addLabel="Add variable"
                />
              </div>
            </div>

            <SaveBar
              isDirty={isDirty}
              saving={saving}
              saveError={saveError}
              onSave={save}
              onDiscard={discard}
            />
          </>
        )
      )}
    </section>
  )
}

/** Explicit save/discard control for the args + env editors above. Sits at
 *  the bottom of the section rather than per-editor — one Save persists
 *  both rows in a single `setSettings` call (they share one `settings_json`
 *  blob; two separate writes would race). Disabled with no unsaved changes,
 *  so it never reads as "click to be safe" when there's nothing to persist. */
function SaveBar({
  isDirty,
  saving,
  saveError,
  onSave,
  onDiscard
}: {
  isDirty: boolean
  saving: boolean
  saveError: string | null
  onSave: () => void
  onDiscard: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      {saveError && (
        <p className="text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-md px-3 py-2">
          {saveError}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-text-muted italic">
          {isDirty ? 'Unsaved changes' : 'No changes to save'}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onDiscard}
            disabled={!isDirty || saving}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-overlay border border-border-default transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            <ArrowCounterClockwise size={12} weight="bold" />
            Discard
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={!isDirty || saving}
            className="text-xs px-3 py-1.5 rounded-md bg-accent text-white font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Small muted note listing which keys at the CURRENT scope are actually
 *  inherited from a lower scope (present in `provenance` at a different
 *  scope than the one being viewed, and not overridden by an own-scope row
 *  of the same key) — the "single most useful thing in the whole panel". */
function InheritedRowsNote({
  scope,
  provenance,
  rows
}: {
  scope: HarnessSettingsScope
  provenance: Map<string, HarnessSettingsScope>
  rows: HarnessSettingRow[] | undefined
}): React.JSX.Element | null {
  const ownKeys = new Set((rows ?? []).map((r) => r.key))
  const inherited = [...provenance.entries()].filter(
    ([key, fromScope]) => fromScope !== scope && !ownKeys.has(key)
  )
  if (inherited.length === 0) return null
  return (
    <p className="text-xs text-text-muted italic mb-3">
      Inherited:{' '}
      {inherited.map(([key, fromScope]) => `${key} (${scopeChipLabel(fromScope)})`).join(', ')}
    </p>
  )
}
