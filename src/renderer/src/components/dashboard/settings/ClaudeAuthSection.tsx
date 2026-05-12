import { useEffect, useState } from 'react'
import type React from 'react'
import { CaretDown, CaretRight } from '@phosphor-icons/react'
import { SettingRow, SegmentedControl } from './primitives'
import { ComingSoonChip } from './ClaudeGeneralSection'
import type { ClaudeAuthState, ClaudeCloudProvider } from '@shared/types'

// ---------------------------------------------------------------------------
// ApiKeyInput — masked input with Save / Replace / Clear
// ---------------------------------------------------------------------------

interface ApiKeyInputProps {
  hasKey: boolean
  encryptionAvailable: boolean
  onSave: (key: string) => void
  onClear: () => void
}

function ApiKeyInput({
  hasKey,
  encryptionAvailable,
  onSave,
  onClear
}: ApiKeyInputProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  // When hasKey flips to false (after a clear), exit editing state
  useEffect(() => {
    if (!hasKey) {
      setEditing(false)
      setValue('')
    }
  }, [hasKey])

  if (hasKey && !editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-text-muted">•••• stored</span>
        <button
          onClick={() => {
            setValue('')
            setEditing(true)
          }}
          disabled={!encryptionAvailable}
          className="text-xs text-text-secondary hover:text-text-primary cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Replace
        </button>
        <button
          onClick={onClear}
          disabled={!encryptionAvailable}
          className="text-xs text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          Clear
        </button>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value) {
            onSave(value)
            setEditing(false)
            setValue('')
          }
          if (e.key === 'Escape') {
            setEditing(false)
            setValue('')
          }
        }}
        placeholder="sk-ant-…"
        autoComplete="off"
        disabled={!encryptionAvailable}
        className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text disabled:opacity-50 disabled:cursor-not-allowed"
      />
      <button
        onClick={() => {
          if (value) {
            onSave(value)
            setEditing(false)
            setValue('')
          }
        }}
        disabled={!encryptionAvailable || !value}
        className="text-xs text-accent hover:opacity-80 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
      >
        Save
      </button>
      {hasKey && (
        <button
          onClick={() => {
            setEditing(false)
            setValue('')
          }}
          className="text-xs text-text-muted hover:text-text-primary cursor-pointer transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// BaseUrlInput — plain text, saves on blur
// ---------------------------------------------------------------------------

interface BaseUrlInputProps {
  value: string
  encryptionAvailable: boolean
  onSave: (url: string) => void
}

function BaseUrlInput({ value, encryptionAvailable, onSave }: BaseUrlInputProps): React.JSX.Element {
  const [local, setLocal] = useState(value)

  // Sync when external value changes (e.g. after provider switch clears it)
  useEffect(() => {
    setLocal(value)
  }, [value])

  return (
    <input
      type="url"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        const trimmed = local.trim()
        if (trimmed !== value) onSave(trimmed)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          setLocal(value)
          ;(e.currentTarget as HTMLInputElement).blur()
        }
      }}
      placeholder="https://…"
      disabled={!encryptionAvailable}
      className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text disabled:opacity-50 disabled:cursor-not-allowed"
    />
  )
}

// ---------------------------------------------------------------------------
// ClaudeAuthSection
// ---------------------------------------------------------------------------

const PROVIDER_OPTIONS: ReadonlyArray<{ value: ClaudeCloudProvider; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'bedrock', label: 'Bedrock' },
  { value: 'vertex', label: 'Vertex' },
  { value: 'foundry', label: 'Foundry' }
]

export function ClaudeAuthSection(): React.JSX.Element {
  const [state, setState] = useState<ClaudeAuthState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [providerOpen, setProviderOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api.claudeAuth
      .get()
      .then((s) => {
        if (!cancelled) setState(s)
      })
      .catch((err) => {
        console.error('[claudeAuth] failed to load', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  function applyPatch(
    patch: Parameters<typeof window.api.claudeAuth.update>[0]
  ): void {
    if (!state) return
    window.api.claudeAuth
      .update(patch)
      .then((next) => setState(next))
      .catch((err) => {
        console.error('[claudeAuth] update failed; refetching', err)
        window.api.claudeAuth.get().then(setState).catch(console.error)
      })
  }

  // ---------------------------------------------------------------------------
  // Render: header section
  // ---------------------------------------------------------------------------
  const header = (
    <div>
      <h2 className="text-base font-semibold text-text-primary">Authentication</h2>
      <p className="text-xs text-text-muted mt-1">
        API key (stored in macOS Keychain), base URL override for proxies, and cloud provider
        selection (Anthropic, Bedrock, Vertex, Foundry).
      </p>
    </div>
  )

  if (error) {
    return (
      <div className="flex flex-col gap-10 max-w-2xl">
        {header}
        <p className="text-sm text-red-400">Failed to load auth settings: {error}</p>
      </div>
    )
  }

  if (!state) {
    return (
      <div className="flex flex-col gap-10 max-w-2xl">
        {header}
        <p className="text-sm text-text-muted">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      {header}

      {/* Encryption-unavailable warning banner */}
      {!state.encryptionAvailable && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-md p-3 text-xs text-amber-300">
          Secret storage is unavailable on this system. API keys can&apos;t be saved securely.
          Inputs are disabled.
        </div>
      )}

      {/* Provider selection */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Cloud provider
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow label="Provider" description="Which cloud backend Claude Code connects to.">
            <SegmentedControl<ClaudeCloudProvider>
              options={PROVIDER_OPTIONS}
              value={state.cloudProvider}
              onChange={(v) => applyPatch({ cloudProvider: v })}
              ariaLabel="Cloud provider"
            />
          </SettingRow>
        </div>
      </section>

      {/* Credentials */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Credentials
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="API key"
            description="Stored securely in macOS Keychain — never written to disk in plaintext."
          >
            <ApiKeyInput
              hasKey={state.hasApiKey}
              encryptionAvailable={state.encryptionAvailable}
              onSave={(key) => applyPatch({ apiKey: key })}
              onClear={() => applyPatch({ apiKey: '' })}
            />
          </SettingRow>
          <SettingRow
            label="Base URL override"
            description="Proxy or local model endpoint. Leave blank to use the provider default."
          >
            <BaseUrlInput
              value={state.baseUrl}
              encryptionAvailable={state.encryptionAvailable}
              onSave={(url) => applyPatch({ baseUrl: url })}
            />
          </SettingRow>
        </div>
      </section>

      {/* Provider-specific config (collapsible) — deferred to follow-up */}
      <section className="flex flex-col">
        <button
          onClick={() => setProviderOpen((v) => !v)}
          className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-text-secondary mb-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
        >
          {providerOpen ? (
            <CaretDown size={12} weight="bold" />
          ) : (
            <CaretRight size={12} weight="bold" />
          )}
          Provider-specific config
        </button>
        {providerOpen && (
          <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-text-primary">
                Bedrock / Vertex / Foundry options
              </span>
              <ComingSoonChip />
            </div>
            <p className="text-xs text-text-muted italic">
              AWS region, GCP project ID, IAM role ARN, and other provider-specific fields will
              appear here once provider config is wired.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
