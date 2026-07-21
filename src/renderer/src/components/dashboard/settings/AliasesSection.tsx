import { useEffect, useState } from 'react'
import type React from 'react'
import type { ModelAliasesState, ModelAliasSummary, ModelAliasTargetOption } from '@shared/types'
import { CLAUDE_MODEL_OPTIONS } from '@shared/types'
import { SettingRow, Select, Toggle, Eyebrow } from './primitives'
import { Info } from '@phosphor-icons/react'

// ---------------------------------------------------------------------------
// AliasesSection (model-routing unit 08)
//
// Data-driven, no per-model hardcoded JSX: every row is derived from
// CLAUDE_MODEL_OPTIONS (src/shared/types.ts) crossed with whatever aliases:list
// currently has stored, and every dropdown option comes from aliases:listTargets
// (the live cliproxy model cache, already filtered to enabled+healthy
// providers by the main process — see src/main/ipc/aliases.ts). This
// component never hardcodes a model id/provider id anywhere.
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

export function AliasesSection(): React.JSX.Element | null {
  const [state, setState] = useState<ModelAliasesState | null>(null)
  const [targets, setTargets] = useState<ModelAliasTargetOption[]>([])
  const [applyingDefaults, setApplyingDefaults] = useState(false)

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

  if (!state) return null

  const aliasByName = new Map(state.aliases.map((a) => [a.claudeName, a]))
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
        </>
      )}
    </section>
  )
}
