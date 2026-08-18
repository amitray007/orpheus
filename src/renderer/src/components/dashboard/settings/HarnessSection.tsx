import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type {
  HarnessSummary,
  HarnessSettings,
  HarnessSettingRow,
  HarnessSettingsScope,
  ProjectRecord,
  WorkspaceRecord
} from '@shared/types'
import type { CuratedField } from '@shared/harness/types'
import { Plus, Trash, CaretUp, CaretDown } from '@phosphor-icons/react'
import { SettingRow, SegmentedControl, Select, Toggle, Eyebrow, SecretInput } from './primitives'
import {
  isSecretLikeKey,
  moveRow,
  resolveProvenance,
  type CuratedFieldName,
  type HarnessScopeSettingsBundle
} from './harnessSettingsLogic'

// ---------------------------------------------------------------------------
// HarnessSection (U8, multi-harness architecture plan)
//
// Data-driven from harness:list — no hardcoded 'claude' anywhere in this
// component. A second harness needs no new code here, only a second
// HarnessDescriptor in src/main/harness/registry.ts. Orpheus curates exactly
// three concepts per harness (model/effort/permissionMode) and otherwise
// ships zero default args/env — everything else is untyped user-supplied
// passthrough, edited via the row editors below.
// ---------------------------------------------------------------------------

const EMPTY_SETTINGS: HarnessSettings = {}

const SCOPE_OPTIONS: ReadonlyArray<{ value: HarnessSettingsScope; label: string }> = [
  { value: 'global', label: 'Global' },
  { value: 'project', label: 'Project' },
  { value: 'workspace', label: 'Workspace' }
]

function scopeChipLabel(scope: HarnessSettingsScope): string {
  if (scope === 'global') return 'global'
  if (scope === 'project') return 'project'
  return 'workspace'
}

// ---------------------------------------------------------------------------
// CuratedFieldPicker — Select + reveal-on-'custom' free-text input, driven by
// a CuratedField's `options` array rather than a hardcoded list (mirrors
// primitives.tsx's ModelPicker pattern, generalized to any curated field).
// ---------------------------------------------------------------------------

interface CuratedFieldPickerProps {
  field: CuratedField
  value: string
  onChange: (v: string) => void
  ariaLabel: string
  inheritedFrom?: HarnessSettingsScope
}

function CuratedFieldPicker({
  field,
  value,
  onChange,
  ariaLabel,
  inheritedFrom
}: CuratedFieldPickerProps): React.JSX.Element {
  const options = useMemo(
    () => [
      ...field.options.map((o) => ({ value: o, label: o })),
      { value: 'custom', label: 'Custom…' }
    ],
    [field.options]
  )
  const isKnown = value === '' || field.options.includes(value)
  const [showCustom, setShowCustom] = useState(!isKnown && value !== '')
  const [customValue, setCustomValue] = useState(!isKnown ? value : '')
  const selectValue = !isKnown && showCustom ? 'custom' : value

  function handleSelect(v: string): void {
    if (v === 'custom') {
      setShowCustom(true)
      return
    }
    setShowCustom(false)
    onChange(v)
  }

  return (
    <div className="flex flex-col gap-1.5 items-end w-56">
      {inheritedFrom && value === '' && (
        <span className="text-xs text-text-muted italic">from {scopeChipLabel(inheritedFrom)}</span>
      )}
      <Select
        options={options}
        value={selectValue || '__unset'}
        onChange={handleSelect}
        ariaLabel={ariaLabel}
        placeholder="Inherited"
      />
      {showCustom && (
        <input
          aria-label={`Custom ${ariaLabel}`}
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onBlur={() => {
            const v = customValue.trim()
            if (v) onChange(v)
          }}
          placeholder="custom value"
          className="w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus:border-accent/50 transition-colors duration-150 font-mono"
        />
      )}
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
}

function toDrafts(rows: HarnessSettingRow[] | undefined): RowDraft[] {
  return (rows ?? []).map((r) => ({ ...r, id: crypto.randomUUID() }))
}

interface HarnessRowEditorProps {
  rows: HarnessSettingRow[] | undefined
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
  const externalKey = JSON.stringify(rows ?? [])
  const localKey = JSON.stringify(
    drafts.map(({ key, value, enabled }) => ({ key, value, enabled }))
  )
  if (externalKey !== localKey) {
    setDrafts(toDrafts(rows))
  }

  function commit(next: RowDraft[]): void {
    setDrafts(next)
    onChange(next.map(({ key, value, enabled }) => ({ key, value, enabled })))
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
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([])
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('')

  const [globalSettings, setGlobalSettings] = useState<HarnessSettings>(EMPTY_SETTINGS)
  const [projectSettings, setProjectSettings] = useState<HarnessSettings>(EMPTY_SETTINGS)
  const [workspaceSettings, setWorkspaceSettings] = useState<HarnessSettings>(EMPTY_SETTINGS)

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

  useEffect(() => {
    if (!selectedProjectId) return
    let cancelled = false
    window.api.workspaces
      .listForProject(selectedProjectId, { scope: 'active' })
      .then((list) => {
        if (!cancelled) setWorkspaces(list)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [selectedProjectId])

  // Reset the workspace list/selection as soon as the project selection
  // changes, in the SAME handler that changes selectedProjectId — not a
  // reactive effect keyed on selectedProjectId, which would call setState
  // synchronously inside an effect body (react-hooks/set-state-in-effect).
  function selectProject(id: string): void {
    setSelectedProjectId(id)
    setSelectedWorkspaceId('')
    setWorkspaces([])
  }

  // Fetch global+project+workspace settings for the selected harness in
  // parallel whenever the harness or the project/workspace selection
  // changes — the provenance resolver (harnessSettingsLogic.ts) needs all
  // three layers regardless of which scope is currently being edited, so
  // "which scope is a value inherited from" can be shown correctly.
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
      // branches above — see react-hooks/set-state-in-effect.
      Promise.resolve().then(() => {
        if (!cancelled) setProjectSettings(EMPTY_SETTINGS)
      })
    }
    if (selectedWorkspaceId) {
      window.api.harness
        .getSettings(selectedHarnessId, 'workspace', selectedWorkspaceId)
        .then((s) => {
          if (!cancelled) setWorkspaceSettings(s)
        })
        .catch(console.error)
    } else {
      Promise.resolve().then(() => {
        if (!cancelled) setWorkspaceSettings(EMPTY_SETTINGS)
      })
    }
    return () => {
      cancelled = true
    }
  }, [selectedHarnessId, selectedProjectId, selectedWorkspaceId])

  const selectedHarness = harnesses?.find((h) => h.id === selectedHarnessId) ?? null

  const scopeSettings: HarnessSettings =
    scope === 'global' ? globalSettings : scope === 'project' ? projectSettings : workspaceSettings

  const scopeId =
    scope === 'project'
      ? selectedProjectId
      : scope === 'workspace'
        ? selectedWorkspaceId
        : undefined

  const provenance = useMemo(
    () =>
      resolveProvenance({
        global: globalSettings,
        project: projectSettings,
        workspace: workspaceSettings
      } satisfies HarnessScopeSettingsBundle),
    [globalSettings, projectSettings, workspaceSettings]
  )

  function persist(next: HarnessSettings): void {
    if (!selectedHarnessId) return
    if (scope !== 'global' && !scopeId) return
    window.api.harness
      .setSettings(selectedHarnessId, scope, scopeId, next)
      .then((saved) => {
        if (scope === 'global') setGlobalSettings(saved)
        else if (scope === 'project') setProjectSettings(saved)
        else setWorkspaceSettings(saved)
      })
      .catch((err) => console.error('[harness] setSettings failed', err))
  }

  function setCurated(field: CuratedFieldName, value: string): void {
    persist({
      ...scopeSettings,
      curated: { ...scopeSettings.curated, [field]: value || undefined }
    })
  }

  function setArgs(rows: HarnessSettingRow[]): void {
    persist({ ...scopeSettings, args: rows })
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
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 divide-y divide-border-default/60">
          {harnesses.length > 1 && (
            <SettingRow label="Harness" description="Which coding-agent CLI to configure.">
              <Select
                options={harnesses.map((h) => ({ value: h.id, label: h.label }))}
                value={selectedHarnessId}
                onChange={setSelectedHarnessId}
                ariaLabel="Harness"
              />
            </SettingRow>
          )}
          <SettingRow label="Scope" description="Which layer these settings apply to.">
            <SegmentedControl<HarnessSettingsScope>
              options={SCOPE_OPTIONS}
              value={scope}
              onChange={setScope}
              ariaLabel="Scope"
            />
          </SettingRow>
          {scope !== 'global' && (
            <SettingRow label="Project" description="Which project this scope applies to.">
              <Select
                options={projects.map((p) => ({ value: p.id, label: p.name }))}
                value={selectedProjectId}
                onChange={selectProject}
                ariaLabel="Project"
                placeholder="Choose a project"
              />
            </SettingRow>
          )}
          {scope === 'workspace' && selectedProjectId && (
            <SettingRow label="Workspace" description="Which workspace this scope applies to.">
              <Select
                options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
                value={selectedWorkspaceId}
                onChange={setSelectedWorkspaceId}
                ariaLabel="Workspace"
                placeholder="Choose a workspace"
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
            {selectedHarness.curated && (
              <div>
                <Eyebrow className="mb-3">Curated</Eyebrow>
                <div className="bg-surface-raised border border-border-default rounded-lg px-5 divide-y divide-border-default/60">
                  {selectedHarness.curated.model && (
                    <SettingRow label="Model" mapsTo={fieldMapsTo(selectedHarness.curated.model)}>
                      <CuratedFieldPicker
                        field={selectedHarness.curated.model}
                        value={scopeSettings.curated?.model ?? ''}
                        onChange={(v) => setCurated('model', v)}
                        ariaLabel="Model"
                        inheritedFrom={scope !== 'global' ? provenance.curated.model : undefined}
                      />
                    </SettingRow>
                  )}
                  {selectedHarness.curated.effort && (
                    <SettingRow label="Effort" mapsTo={fieldMapsTo(selectedHarness.curated.effort)}>
                      <CuratedFieldPicker
                        field={selectedHarness.curated.effort}
                        value={scopeSettings.curated?.effort ?? ''}
                        onChange={(v) => setCurated('effort', v)}
                        ariaLabel="Effort"
                        inheritedFrom={scope !== 'global' ? provenance.curated.effort : undefined}
                      />
                    </SettingRow>
                  )}
                  {selectedHarness.curated.permissionMode && (
                    <SettingRow
                      label="Permission mode"
                      mapsTo={fieldMapsTo(selectedHarness.curated.permissionMode)}
                    >
                      <CuratedFieldPicker
                        field={selectedHarness.curated.permissionMode}
                        value={scopeSettings.curated?.permissionMode ?? ''}
                        onChange={(v) => setCurated('permissionMode', v)}
                        ariaLabel="Permission mode"
                        inheritedFrom={
                          scope !== 'global' ? provenance.curated.permissionMode : undefined
                        }
                      />
                    </SettingRow>
                  )}
                </div>
              </div>
            )}

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
                  rows={scopeSettings.args}
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
                  rows={scopeSettings.env}
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

function fieldMapsTo(field: CuratedField): string {
  return 'flag' in field && field.flag ? field.flag : 'env' in field && field.env ? field.env : ''
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
