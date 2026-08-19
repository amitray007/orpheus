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
  CaretRight,
  Question,
  ArrowCounterClockwise,
  Rocket,
  Warning,
  EyeSlash
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
  composedCommandPreview,
  summarizeArgRows,
  summarizeEnvRows,
  buildCuratedOptionRows,
  draftRowsToOverlay,
  curatedOptionsRowsDirty,
  summarizeCuratedOptionRows,
  type HarnessScopeSettingsBundle,
  type CuratedOptionRowDraft
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
// CuratedOptionsEditor — the Models/Effort option-list editor (B3,
// support-multi-harness). Edits HarnessSettings.curatedOptions.model/.effort
// (an {add,hide,order} overlay onto CuratedField.options — see
// CuratedFieldOptionsOverlay's doc comment in src/main/harness/settings.ts)
// via draft rows built/persisted through buildCuratedOptionRows/
// draftRowsToOverlay (harnessSettingsLogic.ts), the same
// draft-rows-are-the-source-of-truth-until-Save shape HarnessRowEditor uses
// above.
//
// FULLY CONTROLLED, same discipline as HarnessRowEditor — no internal row
// state, every mutation reported straight up via onChange. The parent
// (HarnessSection) owns draftModelRows/draftEffortRows exactly like it owns
// draftArgs/draftEnv, which is what keeps the SEAM comment's "collapsing
// unmounts safely" invariant true for these sections too.
// ---------------------------------------------------------------------------

interface CuratedOptionsEditorProps {
  rows: readonly CuratedOptionRowDraft[]
  onChange: (rows: CuratedOptionRowDraft[]) => void
  addPlaceholder: string
  addAriaLabel: string
}

function CuratedOptionsEditor({
  rows,
  onChange,
  addPlaceholder,
  addAriaLabel
}: CuratedOptionsEditorProps): React.JSX.Element {
  const [newValue, setNewValue] = useState('')

  function toggleHidden(idx: number): void {
    onChange(rows.map((r, i) => (i === idx ? { ...r, hidden: !r.hidden } : r)))
  }

  function removeRow(idx: number): void {
    onChange(rows.filter((_, i) => i !== idx))
  }

  function move(idx: number, direction: 'up' | 'down'): void {
    onChange(moveRow(rows, idx, direction))
  }

  function addValue(): void {
    const trimmed = newValue.trim()
    if (!trimmed) return
    if (rows.some((r) => r.value === trimmed)) {
      // Already present (descriptor-known or previously added) — just clear
      // the input rather than creating a duplicate row.
      setNewValue('')
      return
    }
    onChange([...rows, { value: trimmed, custom: true, hidden: false, selected: false }])
    setNewValue('')
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, idx) => (
        <div key={row.value} className="flex items-center gap-1.5">
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
            value={!row.hidden}
            onChange={() => toggleHidden(idx)}
            ariaLabel={`Show ${row.value}`}
          />
          <span className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary font-mono truncate">
            {row.value}
          </span>
          {row.hidden && row.selected && (
            <span
              title="This value is hidden but stays visible because it's currently selected"
              className="text-[10px] leading-none font-medium text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-1 flex-shrink-0 flex items-center gap-1"
            >
              <EyeSlash size={10} weight="bold" />
              hidden, in use
            </span>
          )}
          {row.custom && (
            <span
              title={`"${row.value}" is not in this harness's known option list — it will be used as-is`}
              className="text-[10px] leading-none font-medium text-amber-400 bg-amber-400/10 border border-amber-400/20 rounded px-1.5 py-1 flex-shrink-0 flex items-center gap-1"
            >
              <Warning size={10} weight="bold" />
              custom
            </span>
          )}
          <button
            type="button"
            onClick={() => removeRow(idx)}
            className="text-text-muted hover:text-red-400 transition-colors flex-shrink-0"
            aria-label={`Remove ${row.value}`}
          >
            <Trash size={13} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <Plus size={12} weight="bold" className="text-text-muted flex-shrink-0 ml-[22px]" />
        <input
          type="text"
          aria-label={addAriaLabel}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addValue()
          }}
          placeholder={addPlaceholder}
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text"
        />
        <button
          type="button"
          onClick={addValue}
          disabled={!newValue.trim()}
          className="text-xs px-2.5 py-1.5 rounded-md text-accent hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >
          Add
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CollapsibleSection — shared shell for every settings panel below the
// Launch preview (Arguments, Environment, and B3's forthcoming Models/Effort
// sections). Renders an eyebrow-style header button with a populated summary
// line so the page reads as "here is what is configured" without expanding
// anything, then the panel body when open. Expansion is ephemeral UI state
// owned by the caller (HarnessSection keeps a Set of open section keys) —
// this component never persists it and never decides the default; that's
// the caller's call per-section (see the `openSections` seed effect below).
//
// SEAM FOR B3: a new section is just another entry in this pattern — pick a
// key, compute a summary string, decide a default-open rule, and render the
// body. Nothing about Save/dirty-detection routes through this component;
// each editor keeps reporting straight into the section's own draft state
// exactly as before, so a change inside a collapsed section still flows to
// isDirty/save() upstream. Collapsing DOES unmount the body (the
// `open && body` shape below, matching ClaudePermissionsSection), and that
// is safe for a specific reason worth stating rather than assuming:
// draftArgs/draftEnv live in HarnessSection (see their useState above), and
// HarnessRowEditor is fully controlled — it holds no state of its own. So
// unmounting the editor discards only rendered DOM, never a pending edit,
// and isDirty (derived from those parent-owned drafts) is unaffected by what
// happens to be rendered. If a future section's editor ever holds its own
// draft state, that reasoning breaks and the body must be hidden rather than
// unmounted.
// ---------------------------------------------------------------------------

interface CollapsibleSectionProps {
  title: string
  summary: string
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}

function CollapsibleSection({
  title,
  summary,
  open,
  onToggle,
  children
}: CollapsibleSectionProps): React.JSX.Element {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 mb-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
      >
        {open ? (
          <CaretDown size={12} weight="bold" className="text-text-secondary flex-shrink-0" />
        ) : (
          <CaretRight size={12} weight="bold" className="text-text-secondary flex-shrink-0" />
        )}
        <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          {title}
        </span>
        <span className="text-xs text-text-muted">{summary}</span>
      </button>
      {open && (
        <div className="bg-surface-raised border border-border-default rounded-lg p-5">
          {children}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// LaunchPreview — a proper panel for the composed command, surfacing what
// used to be buried inline in the harness picker (harnessCommandPreview,
// above, still covers the PICKER's per-harness-at-shipped-defaults preview;
// this is the separate, LIVE draft-args preview for whichever harness is
// currently selected in the editor below). Not collapsible — unlike
// Arguments/Environment, there's nothing to hide here; it's the single most
// useful "what will actually run" line on the page, so it stays visible.
// ---------------------------------------------------------------------------

function LaunchPreview({
  binary,
  argRows
}: {
  binary: string
  argRows: readonly { key: string; value?: string; enabled: boolean }[]
}): React.JSX.Element {
  return (
    <div>
      <Eyebrow className="mb-3">Launch</Eyebrow>
      <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4 flex items-center gap-2.5">
        <Rocket size={13} className="text-text-muted flex-shrink-0" />
        <p className="text-xs font-mono text-text-primary overflow-x-auto whitespace-nowrap">
          {composedCommandPreview(binary, argRows)}
        </p>
      </div>
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
  // Models/Effort option-list drafts (B3) — same seed-once-per-context-change,
  // parent-owned-source-of-truth discipline as draftArgs/draftEnv above (see
  // the SEAM comment on CollapsibleSection: these editors are fully
  // controlled, so unmounting a collapsed section never discards an edit).
  const [draftModelRows, setDraftModelRows] = useState<CuratedOptionRowDraft[]>([])
  const [draftEffortRows, setDraftEffortRows] = useState<CuratedOptionRowDraft[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Which collapsible sections (Arguments/Environment today; B3 adds
  // Models/Effort into the same set by key) are expanded. Purely ephemeral
  // UI state — never persisted, never round-tripped through settings — so a
  // plain useState is correct here, unlike draftArgs/draftEnv which are the
  // save pipeline's source of truth. Seeded with a sensible default once per
  // context change (see the effect below) and freely toggled by the user
  // afterward via toggleSection.
  const [openSections, setOpenSections] = useState<Set<string>>(new Set())

  function toggleSection(key: string): void {
    setOpenSections((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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
      const mergedArgs = mergeDefaultArgs(selectedHarness?.defaultArgs, scopeSettings.args)
      setDraftArgs(toDrafts(mergedArgs))
      setDraftEnv(toDrafts(scopeSettings.env ?? []))
      setDraftModelRows(
        buildCuratedOptionRows(
          selectedHarness?.curated?.model?.options ?? [],
          scopeSettings.curatedOptions?.model,
          scopeSettings.curated?.model
        )
      )
      setDraftEffortRows(
        buildCuratedOptionRows(
          selectedHarness?.curated?.effort?.options ?? [],
          scopeSettings.curatedOptions?.effort,
          scopeSettings.curated?.effort
        )
      )
      setSaveError(null)
      // Default expansion, computed once per genuine context change (same
      // cadence as the draft reseed above) rather than reactively — see
      // openSections' doc comment. Arguments starts expanded only when it
      // has at least one non-default row (a user override or an ad hoc
      // addition); an untouched, all-defaults args list and Environment
      // (which has no shipped defaults to hide) both start collapsed, since
      // the populated summary line already says what's configured.
      const hasNonDefaultArg = mergedArgs.some((r) => !r.fromDefault)
      setOpenSections(hasNonDefaultArg ? new Set(['args']) : new Set())
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

  // Same "reactive LOADED baseline, reseed-on-context-change DRAFT" split as
  // loadedArgs/loadedEnv above, applied to the Models/Effort option lists.
  const loadedModelRows = useMemo(
    () =>
      buildCuratedOptionRows(
        selectedHarness?.curated?.model?.options ?? [],
        scopeSettings.curatedOptions?.model,
        scopeSettings.curated?.model
      ),
    [selectedHarness, scopeSettings.curatedOptions?.model, scopeSettings.curated?.model]
  )
  const loadedEffortRows = useMemo(
    () =>
      buildCuratedOptionRows(
        selectedHarness?.curated?.effort?.options ?? [],
        scopeSettings.curatedOptions?.effort,
        scopeSettings.curated?.effort
      ),
    [selectedHarness, scopeSettings.curatedOptions?.effort, scopeSettings.curated?.effort]
  )

  const argsDirty = hasUnsavedChanges(loadedArgs, draftArgs)
  const envDirty = hasUnsavedChanges(loadedEnv, draftEnv)
  const modelRowsDirty = curatedOptionsRowsDirty(loadedModelRows, draftModelRows)
  const effortRowsDirty = curatedOptionsRowsDirty(loadedEffortRows, draftEffortRows)
  const isDirty = argsDirty || envDirty || modelRowsDirty || effortRowsDirty

  function discard(): void {
    setDraftArgs(loadedArgs)
    setDraftEnv(loadedEnv)
    setDraftModelRows(loadedModelRows)
    setDraftEffortRows(loadedEffortRows)
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
    // see the file header) survives the round trip untouched. Args, env, AND
    // curatedOptions go in ONE setSettings call: they live in a single
    // settings_json blob, so separate writes would race.
    const nextModelOverlay = draftRowsToOverlay(
      draftModelRows,
      selectedHarness?.curated?.model?.options ?? []
    )
    const nextEffortOverlay = draftRowsToOverlay(
      draftEffortRows,
      selectedHarness?.curated?.effort?.options ?? []
    )
    const nextCuratedOptions: HarnessSettings['curatedOptions'] =
      nextModelOverlay || nextEffortOverlay
        ? {
            ...(nextModelOverlay ? { model: nextModelOverlay } : {}),
            ...(nextEffortOverlay ? { effort: nextEffortOverlay } : {})
          }
        : undefined
    const next: HarnessSettings = {
      ...scopeSettings,
      args: draftsToStoredRows(namedArgs, selectedHarness?.defaultArgs),
      env: namedEnv,
      curatedOptions: nextCuratedOptions
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
            <LaunchPreview binary={selectedHarness.binary} argRows={draftArgs} />

            {/* CAPABILITY GATING: each section below only renders when the
                selected harness declares the concept it edits. Arguments/
                Environment are universal (every HarnessDescriptor has a
                binary and can take flags/env), so they're unconditional.
                B3's Models/Effort sections are the intended template for a
                gated one — e.g. `selectedHarness.curated?.model &&
                <CollapsibleSection ...>` — HarnessSummary.curated (already
                available here) is exactly the field to gate on: Claude
                declares both curated.model and curated.effort today, so
                nothing hides yet, but a harness descriptor that omits
                `curated` entirely (or omits just one field) would make the
                corresponding section not render at all rather than render
                empty. */}

            <CollapsibleSection
              title="Arguments"
              summary={summarizeArgRows(draftArgs)}
              open={openSections.has('args')}
              onToggle={() => toggleSection('args')}
            >
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
            </CollapsibleSection>

            <CollapsibleSection
              title="Environment"
              summary={summarizeEnvRows(draftEnv)}
              open={openSections.has('env')}
              onToggle={() => toggleSection('env')}
            >
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
            </CollapsibleSection>

            {selectedHarness.curated?.model && (
              <CollapsibleSection
                title="Models"
                summary={summarizeCuratedOptionRows(draftModelRows)}
                open={openSections.has('models')}
                onToggle={() => toggleSection('models')}
              >
                <CuratedOptionsEditor
                  rows={draftModelRows}
                  onChange={setDraftModelRows}
                  addPlaceholder="model id"
                  addAriaLabel="Add model"
                />
              </CollapsibleSection>
            )}

            {selectedHarness.curated?.effort && (
              <CollapsibleSection
                title="Effort"
                summary={summarizeCuratedOptionRows(draftEffortRows)}
                open={openSections.has('effort')}
                onToggle={() => toggleSection('effort')}
              >
                <CuratedOptionsEditor
                  rows={draftEffortRows}
                  onChange={setDraftEffortRows}
                  addPlaceholder="effort level"
                  addAriaLabel="Add effort level"
                />
              </CollapsibleSection>
            )}

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
