import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type {
  HarnessSummary,
  HarnessSettings,
  HarnessSettingRow,
  HarnessSettingsScope,
  ProjectRecord
} from '@shared/types'
import { Plus, Trash, CaretUp, CaretDown, Question } from '@phosphor-icons/react'
import { SettingRow, SegmentedControl, Select, Toggle, Eyebrow, SecretInput } from './primitives'
import { ProviderIcon, isKnownProviderIconId } from '@/components/ProviderIcon'
import {
  isSecretLikeKey,
  shouldResyncDrafts,
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
// ---------------------------------------------------------------------------

interface RowDraft extends HarnessSettingRow {
  id: string
  /** Display-only: this row currently matches a harness-provided default
   *  (see mergeDefaultArgs). Never sent through onChange — the editor emits
   *  plain key/value/enabled, and the caller re-derives which rows are
   *  defaults (via draftsToStoredRows) rather than trusting a flag threaded
   *  back out through the UI. */
  fromDefault?: boolean
}

function toDrafts(rows: readonly (HarnessSettingRow & { fromDefault?: boolean })[]): RowDraft[] {
  return rows.map((r) => ({ ...r, id: crypto.randomUUID() }))
}

interface HarnessRowEditorProps {
  rows: readonly (HarnessSettingRow & { fromDefault?: boolean })[]
  onChange: (rows: HarnessSettingRow[]) => void
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
  const [drafts, setDrafts] = useState<RowDraft[]>(() => toDrafts(rows))

  // Render-time sync from external prop changes — never fights an
  // in-progress edit, only resyncs when the incoming value actually diverges
  // from local state (same discipline as CliFlagsEditor's prevValueRef).
  // Compared on the same key/value/enabled/fromDefault projection on both
  // sides (not raw `rows`, which may carry an `id` — synthesized fresh per
  // toDrafts call — that would never match and force a resync every render).
  //
  // PENDING ROWS ARE EXCLUDED FROM THE COMPARISON. `addRow` appends a blank
  // draft that deliberately has NOT been committed upward — a row with no key
  // is not a setting yet, and persisting it would write an empty flag. But a
  // blank draft makes local diverge from external, so comparing the raw lists
  // made this guard resync on the very next render and delete the new row
  // before the user could type in it. That is what made the Add buttons look
  // dead: the row appeared and vanished within one frame.
  //
  // Filtering un-keyed drafts out of `localKey` lets a pending row exist
  // locally without being mistaken for divergence, while a REAL external
  // change (another scope loaded, a default toggled) still resyncs — and
  // still discards the empty row, which is correct: it held nothing.
  if (shouldResyncDrafts(rows, drafts)) {
    setDrafts(toDrafts(rows))
  }

  function commit(next: RowDraft[]): void {
    setDrafts(next)
    // Un-keyed drafts are LOCAL-ONLY and must never travel upward. A row with
    // no key is not a setting yet; persisting one puts a blank row in storage
    // that comes straight back as an external row, which `shouldResyncDrafts`
    // then filters out of the local side — the two lists can never match, the
    // render-time resync never converges, and React aborts with #301
    // (too many re-renders). That is what crashed the settings page after
    // reordering a blank row: every commit path (move, toggle, remove) fed the
    // blank row into storage, not just the one the user was typing in.
    onChange(
      next
        .filter((r) => r.key.trim() !== '')
        .map(({ key, value, enabled }) => ({ key, value, enabled }))
    )
  }

  function updateRow(idx: number, patch: Partial<HarnessSettingRow>): void {
    const next = drafts.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    setDrafts(next)
  }

  function commitRow(idx: number): void {
    const row = drafts[idx]
    if (!row) return
    if (!row.key.trim()) {
      commit(drafts.filter((_, i) => i !== idx))
      return
    }
    commit(drafts)
  }

  function removeRow(idx: number): void {
    commit(drafts.filter((_, i) => i !== idx))
  }

  function addRow(): void {
    setDrafts((prev) => [...prev, { id: crypto.randomUUID(), key: '', value: '', enabled: true }])
  }

  function move(idx: number, direction: 'up' | 'down'): void {
    commit(moveRow(drafts, idx, direction))
  }

  return (
    <div className="flex flex-col gap-2">
      {drafts.map((row, idx) => {
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
                disabled={idx === drafts.length - 1}
                aria-label="Move down"
                className="w-4 h-2.5 flex items-center justify-center text-text-muted hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <CaretDown size={9} weight="bold" />
              </button>
            </div>
            <Toggle
              value={row.enabled}
              onChange={(v) => commit(drafts.map((r, i) => (i === idx ? { ...r, enabled: v } : r)))}
              ariaLabel={`Enable ${row.key || 'row'}`}
            />
            <input
              type="text"
              aria-label={keyAriaLabel}
              value={row.key}
              onChange={(e) => updateRow(idx, { key: e.target.value })}
              onBlur={() => commitRow(idx)}
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
                onBlur={() => commitRow(idx)}
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
                onBlur={() => commitRow(idx)}
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

  // Fetch global+project settings for the selected harness in parallel
  // whenever the harness or the project selection changes — the provenance
  // resolver (harnessSettingsLogic.ts) needs both layers regardless of
  // which scope is currently being edited, so "which scope is a value
  // inherited from" can be shown correctly.
  useEffect(() => {
    if (!selectedHarnessId) return
    let cancelled = false
    window.api.harness
      .getSettings(selectedHarnessId, 'global')
      .then((s) => {
        if (!cancelled) setGlobalSettings(s)
      })
      .catch(console.error)
    if (selectedProjectId) {
      window.api.harness
        .getSettings(selectedHarnessId, 'project', selectedProjectId)
        .then((s) => {
          if (!cancelled) setProjectSettings(s)
        })
        .catch(console.error)
    } else {
      // Deferred to a microtask (not a direct call in the effect body) so
      // this reset goes through the same async-callback shape as the fetch
      // branch above — see react-hooks/set-state-in-effect.
      Promise.resolve().then(() => {
        if (!cancelled) setProjectSettings(EMPTY_SETTINGS)
      })
    }
    return () => {
      cancelled = true
    }
  }, [selectedHarnessId, selectedProjectId])

  const selectedHarness = harnesses?.find((h) => h.id === selectedHarnessId) ?? null

  const scopeSettings: HarnessSettings = scope === 'global' ? globalSettings : projectSettings

  const scopeId = scope === 'project' ? selectedProjectId : undefined

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
  // Recomputed whenever the selected harness or scope's stored args change.
  const mergedArgs = useMemo(
    () => mergeDefaultArgs(selectedHarness?.defaultArgs, scopeSettings.args),
    [selectedHarness, scopeSettings.args]
  )

  function persist(next: HarnessSettings): void {
    if (!selectedHarnessId) return
    if (scope === 'project' && !scopeId) return
    window.api.harness
      .setSettings(selectedHarnessId, scope, scopeId, next)
      .then((saved) => {
        if (scope === 'global') setGlobalSettings(saved)
        else setProjectSettings(saved)
      })
      .catch((err) => console.error('[harness] setSettings failed', err))
  }

  function setArgs(rows: HarnessSettingRow[]): void {
    // Re-derive which rows still match the harness's own defaults and drop
    // those before persisting — see draftsToStoredRows: a default the user
    // never actually changed must not be written into storage just because
    // it was displayed.
    persist({ ...scopeSettings, args: draftsToStoredRows(rows, selectedHarness?.defaultArgs) })
  }

  function setEnv(rows: HarnessSettingRow[]): void {
    persist({ ...scopeSettings, env: rows })
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
                  rows={mergedArgs}
                  onChange={setArgs}
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
                  rows={scopeSettings.env ?? []}
                  onChange={setEnv}
                  keyPlaceholder="ENV_VAR_NAME"
                  valuePlaceholder="value"
                  keyAriaLabel="Environment variable name"
                  valueAriaLabel="Environment variable value"
                  secretValues
                  addLabel="Add variable"
                />
              </div>
            </div>
          </>
        )
      )}
    </section>
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
