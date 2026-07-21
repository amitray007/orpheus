import { useEffect, useState } from 'react'
import type React from 'react'
import type { ModelAliasesState, ModelAliasSummary, ModelAliasTargetOption } from '@shared/types'
import { CLAUDE_MODEL_OPTIONS } from '@shared/types'
import { SettingRow, Select, Toggle, Eyebrow } from './primitives'
import { Info, Plus, Trash } from '@phosphor-icons/react'

// ---------------------------------------------------------------------------
// AliasesSection (model-routing unit 08, extended by unit 09-polish)
//
// Data-driven, no per-model hardcoded JSX: every AUTO row is derived from
// CLAUDE_MODEL_OPTIONS (src/shared/types.ts) crossed with whatever aliases:list
// currently has stored, and every dropdown option comes from aliases:listTargets
// (the live cliproxy model cache, already filtered to enabled+healthy
// providers by the main process — see src/main/ipc/aliases.ts). This
// component never hardcodes a model id/provider id anywhere.
//
// (unit 09-polish) CUSTOM rows — any stored alias whose claudeName is NOT one
// of the CLAUDE_MODEL_OPTIONS names (ModelAliasSummary.isCustom, computed
// server-side by ipc/aliases.ts) — render in a separate group below the auto
// rows, each removable via aliases:removeCustom. An "Add alias…" affordance
// lets a user type an arbitrary free-text name and pick a target the same
// way an auto row does. This is the manual escape hatch for a stamped-id
// variant the automatic date-stamp detection hasn't observed yet (see
// routingProxy/manager.ts's buildStampedVariantsByBareId), or for aliasing a
// non-Claude name some other tool requests — the name is NOT restricted to a
// "claude-*" shape.
//
// Off by default (master switch — mirrors the Model Routing / per-provider
// toggles' own "explicit opt-in" shape). The honest-labelling notice below
// is REQUIRED copy per this unit's spec: it must be unmistakable that an
// aliased name is NOT real Claude — it's a routed model answering to a
// Claude-shaped name so a pinned subagent doesn't fail outright.
// ---------------------------------------------------------------------------

const NOT_MAPPED = '__not_mapped__'

function targetOptionValue(t: ModelAliasTargetOption): string {
  return `${t.providerId}::${t.modelId}`
}

function parseTargetOptionValue(v: string): { providerId: string; modelId: string } | null {
  if (v === NOT_MAPPED) return null
  const idx = v.indexOf('::')
  if (idx < 0) return null
  return { providerId: v.slice(0, idx), modelId: v.slice(idx + 2) }
}

function rowValue(alias: ModelAliasSummary | undefined): string {
  if (!alias?.targetProviderId || !alias.targetModelId) return NOT_MAPPED
  return `${alias.targetProviderId}::${alias.targetModelId}`
}

// (unit 09-polish) Add-custom-alias inline form — free-text name + the same
// target picker an auto row uses. Kept as its own component so its draft
// state (name/target/error) doesn't leak into AliasesSection's render.
interface AddCustomAliasFormProps {
  targetOptions: Array<{ value: string; label: string }>
  onAdd: (claudeName: string, optionValue: string) => Promise<void>
}

function AddCustomAliasForm({ targetOptions, onAdd }: AddCustomAliasFormProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [target, setTarget] = useState(NOT_MAPPED)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  function reset(): void {
    setOpen(false)
    setName('')
    setTarget(NOT_MAPPED)
    setError(null)
  }

  async function submit(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Name is required.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onAdd(trimmed, target)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add alias.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-accent hover:opacity-80 transition-opacity self-start mt-3"
      >
        <Plus size={12} weight="bold" />
        Add alias…
      </button>
    )
  }

  return (
    <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4 mt-3 flex flex-col gap-3">
      <p className="text-xs text-text-muted leading-relaxed">
        Any name a tool might request — not limited to Claude model ids. Useful as a manual fallback
        when automatic date-stamp detection hasn&apos;t caught a variant yet.
      </p>
      <div className="flex items-center gap-2">
        <input
          type="text"
          aria-label="Alias name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') reset()
          }}
          placeholder="e.g. claude-opus-4-9-20261201"
          autoFocus
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-xs bg-surface-overlay border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono"
        />
        <div className="w-56 flex-shrink-0">
          <Select
            options={targetOptions}
            value={target}
            onChange={setTarget}
            ariaLabel="Target for new alias"
            placeholder="Not mapped"
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={submitting || !name.trim()}
          onClick={() => void submit()}
          className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-black hover:bg-accent/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={reset}
          className="px-3 py-1.5 rounded text-xs text-text-muted hover:text-text-secondary transition-colors cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

export function AliasesSection(): React.JSX.Element | null {
  const [state, setState] = useState<ModelAliasesState | null>(null)
  const [targets, setTargets] = useState<ModelAliasTargetOption[]>([])
  const [applyingDefaults, setApplyingDefaults] = useState(false)
  const [removingCustom, setRemovingCustom] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.aliases
      .list()
      .then((s) => {
        if (!cancelled) setState(s)
      })
      .catch(console.error)
    window.api.aliases
      .listTargets()
      .then((t) => {
        if (!cancelled) setTargets(t)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [])

  function toggleEnabled(v: boolean): void {
    if (!state) return
    setState({ ...state, enabled: v })
    window.api.aliases
      .setEnabled(v)
      .then(setState)
      .catch((err) => console.error('[aliases] setEnabled failed', err))
  }

  function setAlias(claudeName: string, optionValue: string): void {
    const parsed = parseTargetOptionValue(optionValue)
    window.api.aliases
      .setAlias(claudeName, parsed?.providerId ?? null, parsed?.modelId ?? null)
      .then(setState)
      .catch((err) => console.error('[aliases] setAlias failed', err))
  }

  function useDefaults(): void {
    setApplyingDefaults(true)
    window.api.aliases
      .useDefaults()
      .then(setState)
      .catch((err) => console.error('[aliases] useDefaults failed', err))
      .finally(() => setApplyingDefaults(false))
  }

  async function addCustomAlias(claudeName: string, optionValue: string): Promise<void> {
    const parsed = parseTargetOptionValue(optionValue)
    const next = await window.api.aliases.addCustom(
      claudeName,
      parsed?.providerId ?? null,
      parsed?.modelId ?? null
    )
    setState(next)
  }

  function removeCustomAlias(claudeName: string): void {
    setRemovingCustom(claudeName)
    window.api.aliases
      .removeCustom(claudeName)
      .then(setState)
      .catch((err) => console.error('[aliases] removeCustom failed', err))
      .finally(() => setRemovingCustom(null))
  }

  if (!state) return null

  const aliasByName = new Map(state.aliases.map((a) => [a.claudeName, a]))
  const customAliases = state.aliases.filter((a) => a.isCustom)
  const targetOptions = [
    { value: NOT_MAPPED, label: 'Not mapped' },
    ...targets.map((t) => ({
      value: targetOptionValue(t),
      label: `${t.modelId} · ${t.providerLabel}`
    }))
  ]

  return (
    <section className="flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <Eyebrow>Aliases</Eyebrow>
        {state.enabled && (
          <button
            type="button"
            disabled={applyingDefaults || targets.length === 0}
            onClick={useDefaults}
            className="text-xs text-accent hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            {applyingDefaults ? 'Applying…' : 'Use defaults'}
          </button>
        )}
      </div>

      <div className="bg-surface-raised border border-border-default rounded-lg px-5">
        <SettingRow
          label="Enable model-name aliasing"
          description="Off by default. When a subagent asks for a Claude model on a routed workspace, run it on the mapped model instead. These are not Claude models — an agent pinned to Sonnet will actually run on the model you choose here."
        >
          <Toggle
            value={state.enabled}
            onChange={toggleEnabled}
            ariaLabel="Enable model-name aliasing"
          />
        </SettingRow>
      </div>

      {state.enabled && (
        <>
          <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3 mt-3">
            <Info size={16} weight="fill" className="text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-xs text-text-secondary leading-relaxed">
              A subagent whose frontmatter pins a Claude model (e.g. <code>model: sonnet</code>)
              fails outright on a routed workspace — the proxy has no Claude backend to send it to.
              Mapping a Claude name here lets that request resolve on the proxy instead, so the
              subagent runs rather than erroring. It does not change what model the workspace itself
              uses, and it never sends Claude credentials through the proxy.
            </p>
          </div>

          <div className="bg-surface-raised border border-border-default rounded-lg px-5 divide-y divide-border-default/60 mt-3">
            {CLAUDE_MODEL_OPTIONS.map((opt) => {
              const alias = aliasByName.get(opt.value)
              return (
                <div key={opt.value} className="py-3">
                  <SettingRow label={opt.label} description={opt.value}>
                    <div className="w-56">
                      <Select
                        options={targetOptions}
                        value={rowValue(alias)}
                        onChange={(v) => setAlias(opt.value, v)}
                        ariaLabel={`Alias target for ${opt.label}`}
                        placeholder="Not mapped"
                      />
                    </div>
                  </SettingRow>
                </div>
              )
            })}
          </div>

          {targets.length === 0 && (
            <p className="text-xs text-text-muted mt-2">
              No routed models are currently available to alias to — connect and enable a provider
              first.
            </p>
          )}

          {/* Custom aliases (unit 09-polish) — user-added, arbitrary-name rows. */}
          {customAliases.length > 0 && (
            <>
              <Eyebrow className="mt-5 mb-3">Custom aliases</Eyebrow>
              <div className="bg-surface-raised border border-border-default rounded-lg px-5 divide-y divide-border-default/60">
                {customAliases.map((alias) => (
                  <div key={alias.claudeName} className="py-3">
                    <SettingRow label={alias.claudeName}>
                      <div className="flex items-center gap-2">
                        <div className="w-56">
                          <Select
                            options={targetOptions}
                            value={rowValue(alias)}
                            onChange={(v) => setAlias(alias.claudeName, v)}
                            ariaLabel={`Alias target for ${alias.claudeName}`}
                            placeholder="Not mapped"
                          />
                        </div>
                        <button
                          type="button"
                          disabled={removingCustom === alias.claudeName}
                          onClick={() => removeCustomAlias(alias.claudeName)}
                          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                          aria-label={`Remove ${alias.claudeName}`}
                        >
                          <Trash size={13} />
                        </button>
                      </div>
                    </SettingRow>
                  </div>
                ))}
              </div>
            </>
          )}

          <AddCustomAliasForm targetOptions={targetOptions} onAdd={addCustomAlias} />
        </>
      )}
    </section>
  )
}
