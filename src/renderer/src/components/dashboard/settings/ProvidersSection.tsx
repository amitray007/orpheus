import { useEffect, useState } from 'react'
import type React from 'react'
import type { ProviderConfigSummary, ProviderDescriptorSummary } from '@shared/types'
import { SettingRow, Toggle, Eyebrow } from './primitives'
import { Plus, Trash } from '@phosphor-icons/react'

// ---------------------------------------------------------------------------
// ProvidersSection (model-routing unit 05, part E)
//
// Entirely data-driven from providers:descriptors — no per-provider
// hardcoded JSX. Each descriptor renders: an enable toggle (once configured),
// a connection dot (from providers:list's `connection` field, sourced from
// the routing-proxy's live auth-files), and — for apiKey/openaiCompatible
// providers only — an inline API-key list editor. OAuth-only providers
// (kimi, antigravity) get a read-only "Connect via CLI login" note; the
// actual connect-button flow is deferred to unit 06 (see oauthLoginFlag's
// doc comment in providers/types.ts) — this renders the seam, not the flow.
// ---------------------------------------------------------------------------

function healthDotClass(health: 'ok' | 'error' | 'unknown' | undefined): string {
  if (health === 'ok') return 'bg-green-500'
  if (health === 'error') return 'bg-red-500'
  return 'bg-zinc-500'
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••'
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}

interface KeyRowProps {
  providerId: string
  apiKeys: ProviderConfigSummary['apiKeys']
  onSave: (providerId: string, keys: ProviderConfigSummary['apiKeys']) => void
}

function ApiKeyListEditor({ providerId, apiKeys, onSave }: KeyRowProps): React.JSX.Element {
  const [draft, setDraft] = useState('')

  function addKey(): void {
    const trimmed = draft.trim()
    if (!trimmed) return
    onSave(providerId, [...apiKeys, { id: crypto.randomUUID(), apiKey: trimmed }])
    setDraft('')
  }

  function removeKey(id: string): void {
    onSave(
      providerId,
      apiKeys.filter((k) => k.id !== id)
    )
  }

  return (
    <div className="flex flex-col gap-2 pb-3">
      {apiKeys.map((k) => (
        <div key={k.id} className="flex items-center gap-2">
          <span className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-secondary font-mono truncate">
            {maskKey(k.apiKey)}
          </span>
          <button
            type="button"
            onClick={() => removeKey(k.id)}
            className="text-text-muted hover:text-red-400 transition-colors flex-shrink-0"
            aria-label={`Remove ${providerId} API key`}
          >
            <Trash size={13} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <input
          type="password"
          aria-label={`${providerId} API key`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addKey()
          }}
          placeholder="sk-..."
          className="flex-1 min-w-0 px-2.5 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text"
        />
        <button
          type="button"
          onClick={addKey}
          disabled={!draft.trim()}
          className="flex items-center gap-1.5 text-xs text-accent hover:opacity-80 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
        >
          <Plus size={12} weight="bold" />
          Add
        </button>
      </div>
    </div>
  )
}

export function ProvidersSection(): React.JSX.Element | null {
  const [descriptors, setDescriptors] = useState<ProviderDescriptorSummary[] | null>(null)
  const [configs, setConfigs] = useState<ProviderConfigSummary[]>([])

  useEffect(() => {
    let cancelled = false
    window.api.providers
      .descriptors()
      .then((d) => {
        if (!cancelled) setDescriptors(d)
      })
      .catch(console.error)
    window.api.providers
      .list()
      .then((c) => {
        if (!cancelled) setConfigs(c)
      })
      .catch(console.error)
    return () => {
      cancelled = true
    }
  }, [])

  function summaryFor(providerId: string): ProviderConfigSummary | null {
    return configs.find((c) => c.providerId === providerId) ?? null
  }

  function toggleEnabled(providerId: string, enabled: boolean): void {
    window.api.providers
      .setEnabled(providerId, enabled)
      .then(setConfigs)
      .catch((err) => console.error('[providers] setEnabled failed', err))
  }

  function saveApiKeys(providerId: string, keys: ProviderConfigSummary['apiKeys']): void {
    window.api.providers
      .setApiKeys(providerId, keys)
      .then(setConfigs)
      .catch((err) => console.error('[providers] setApiKeys failed', err))
  }

  if (!descriptors) return null

  return (
    <section className="flex flex-col">
      <Eyebrow className="mb-3">Providers</Eyebrow>
      <div className="bg-surface-raised border border-border-default rounded-lg px-5 divide-y divide-border-default/60">
        {descriptors.map((descriptor) => {
          const summary = summaryFor(descriptor.id)
          const hasKeyEditor =
            descriptor.authMethods.includes('apiKey') ||
            descriptor.authMethods.includes('openaiCompatible')
          const enabled = summary?.enabled ?? false

          return (
            <div key={descriptor.id} className="py-3">
              <SettingRow
                label={descriptor.label}
                description={
                  descriptor.authMethods.includes('oauth') && !hasKeyEditor
                    ? `Connect via CLI login (${descriptor.oauthLoginFlag ?? 'oauth'}) — managed outside this panel.`
                    : undefined
                }
              >
                <div className="flex items-center gap-3">
                  {summary?.connection && (
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${healthDotClass(summary.connection.health)}`}
                      title={`Connection: ${summary.connection.health}`}
                    />
                  )}
                  <Toggle
                    value={enabled}
                    onChange={(v) => toggleEnabled(descriptor.id, v)}
                    ariaLabel={`Enable ${descriptor.label}`}
                  />
                </div>
              </SettingRow>
              {enabled && hasKeyEditor && (
                <ApiKeyListEditor
                  providerId={descriptor.id}
                  apiKeys={summary?.apiKeys ?? []}
                  onSave={saveApiKeys}
                />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
