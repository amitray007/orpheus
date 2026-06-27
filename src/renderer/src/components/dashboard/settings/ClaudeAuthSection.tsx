import { useEffect, useState } from 'react'
import type React from 'react'
import { CaretDown, CaretRight, CheckCircle, XCircle, Spinner } from '@phosphor-icons/react'
import { SettingRow, SegmentedControl, SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import type { ClaudeAuthState, ClaudeAuthTestResult, ClaudeCloudProvider } from '@shared/types'

// ---------------------------------------------------------------------------
// TestConnectionButton — pings Anthropic /v1/models with the stored key
// ---------------------------------------------------------------------------

interface TestConnectionButtonProps {
  disabled: boolean
}

function TestConnectionButton({ disabled }: TestConnectionButtonProps): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'pending' | ClaudeAuthTestResult>('idle')

  async function run(): Promise<void> {
    setState('pending')
    try {
      const result = await window.api.claudeAuth.testConnection()
      setState(result)
    } catch (err) {
      setState({ ok: false, reason: err instanceof Error ? err.message : 'Unknown error' })
    }
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => {
          run().catch(() => {})
        }}
        disabled={disabled || state === 'pending'}
        className="text-xs px-2.5 py-1 rounded-md bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        Test connection
      </button>
      {state === 'pending' && (
        <span className="flex items-center gap-1.5 text-xs text-text-muted">
          <Spinner size={12} className="animate-spin" />
          Pinging…
        </span>
      )}
      {state !== 'idle' && state !== 'pending' && state.ok && (
        <span className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CheckCircle size={13} weight="fill" />
          Connected · {state.durationMs} ms
        </span>
      )}
      {state !== 'idle' && state !== 'pending' && !state.ok && (
        <span className="flex items-center gap-1.5 text-xs text-red-400" title={state.reason}>
          <XCircle size={13} weight="fill" />
          {state.status === 401 ? 'Key rejected' : state.reason}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ApiKeyInput — masked input with Save / Replace / Clear
// ---------------------------------------------------------------------------

interface ApiKeyInputProps {
  hasKey: boolean
  onSave: (key: string) => void
  onClear: () => void
}

function ApiKeyInput({ hasKey, onSave, onClear }: ApiKeyInputProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  if (hasKey && !editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-text-muted">•••• stored</span>
        <button
          type="button"
          onClick={() => {
            setValue('')
            setEditing(true)
          }}
          className="text-xs text-text-secondary hover:text-text-primary cursor-pointer transition-colors"
        >
          Replace
        </button>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-red-400 hover:text-red-300 cursor-pointer transition-colors"
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
        className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text"
      />
      <button
        type="button"
        onClick={() => {
          if (value) {
            onSave(value)
            setEditing(false)
            setValue('')
          }
        }}
        disabled={!value}
        className="text-xs text-accent hover:opacity-80 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
      >
        Save
      </button>
      {hasKey && (
        <button
          type="button"
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
  onSave: (url: string) => void
}

function BaseUrlInput({ value, onSave }: BaseUrlInputProps): React.JSX.Element {
  const [local, setLocal] = useState(value)

  // Sync when external value changes (e.g. after provider switch clears it)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- controlled input sync from prop; key= reset would require caller changes
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
      className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text"
    />
  )
}

// ---------------------------------------------------------------------------
// ProviderTextInput — plain text, saves on blur or Enter (mirrors BaseUrlInput)
// ---------------------------------------------------------------------------

interface ProviderTextInputProps {
  value: string
  placeholder: string
  onSave: (value: string) => void
}

function ProviderTextInput({
  value,
  placeholder,
  onSave
}: ProviderTextInputProps): React.JSX.Element {
  const [local, setLocal] = useState(value)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- controlled input sync from prop; key= reset would require caller changes
    setLocal(value)
  }, [value])

  return (
    <input
      type="text"
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
      placeholder={placeholder}
      className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono cursor-text"
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

  function applyPatch(patch: Parameters<typeof window.api.claudeAuth.update>[0]): void {
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
      <SectionTitle>Authentication</SectionTitle>
      <p className="text-xs text-text-muted mt-1">
        API key, auth token, base URL, and cloud provider selection. Stored locally in the Orpheus
        database (single-user macOS).
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
        <SettingsSectionSkeleton groups={2} rowsPerGroup={2} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      {header}

      {/* Provider selection */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Cloud provider</Eyebrow>
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

      {/* Credentials — shown for anthropic only; Foundry and Bedrock use provider-specific fields */}
      {state.cloudProvider === 'anthropic' && (
        <section className="flex flex-col">
          <Eyebrow className="mb-3">Credentials</Eyebrow>
          <div className="bg-surface-raised border border-border-default rounded-lg px-5">
            <SettingRow
              label="API key"
              description="Stored in the local Orpheus database."
              mapsTo="ANTHROPIC_API_KEY"
            >
              <ApiKeyInput
                hasKey={state.hasApiKey}
                onSave={(key) => applyPatch({ apiKey: key })}
                onClear={() => applyPatch({ apiKey: '' })}
              />
            </SettingRow>
            <SettingRow
              label="Verify"
              description="Hits Anthropic /v1/models with your stored key. No tokens are billed."
            >
              <TestConnectionButton disabled={!state.hasApiKey} />
            </SettingRow>
            <SettingRow
              label="Base URL override"
              description="Proxy or local model endpoint. Leave blank to use the provider default."
              mapsTo="ANTHROPIC_BASE_URL"
            >
              <BaseUrlInput value={state.baseUrl} onSave={(url) => applyPatch({ baseUrl: url })} />
            </SettingRow>
          </div>
        </section>
      )}

      {/* Provider-specific config (collapsible) */}
      <section className="flex flex-col">
        <button
          type="button"
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
          <div className="bg-surface-raised border border-border-default rounded-lg px-5">
            {state.cloudProvider === 'anthropic' && (
              <div className="py-4">
                <p className="text-xs text-text-muted italic">
                  No additional fields — API key and optional Base URL above are sufficient.
                </p>
              </div>
            )}
            {state.cloudProvider === 'foundry' && (
              <>
                <SettingRow
                  label="Resource"
                  description="Your Azure AI Foundry resource name. Sets ANTHROPIC_FOUNDRY_RESOURCE."
                  mapsTo="ANTHROPIC_FOUNDRY_RESOURCE"
                >
                  <ProviderTextInput
                    value={state.foundryResource}
                    placeholder="my-foundry-resource"
                    onSave={(v) => applyPatch({ foundryResource: v })}
                  />
                </SettingRow>
                <SettingRow
                  label="API key"
                  description="Foundry API key. Sets ANTHROPIC_FOUNDRY_API_KEY."
                  mapsTo="ANTHROPIC_FOUNDRY_API_KEY"
                >
                  <ApiKeyInput
                    hasKey={state.hasFoundryApiKey}
                    onSave={(key) => applyPatch({ foundryApiKey: key })}
                    onClear={() => applyPatch({ foundryApiKey: '' })}
                  />
                </SettingRow>
                <SettingRow
                  label="Base URL (optional)"
                  description="Foundry endpoint URL. Sets ANTHROPIC_FOUNDRY_BASE_URL."
                  mapsTo="ANTHROPIC_FOUNDRY_BASE_URL"
                >
                  <BaseUrlInput
                    value={state.foundryBaseUrl}
                    onSave={(url) => applyPatch({ foundryBaseUrl: url })}
                  />
                </SettingRow>
              </>
            )}
            {state.cloudProvider === 'bedrock' && (
              <>
                <SettingRow
                  label="AWS region"
                  description="Required for Bedrock. Example: us-east-1, eu-west-1."
                  mapsTo="AWS_REGION"
                >
                  <ProviderTextInput
                    value={state.awsRegion}
                    placeholder="us-east-1"
                    onSave={(v) => applyPatch({ awsRegion: v })}
                  />
                </SettingRow>
                <SettingRow
                  label="AWS bearer token (optional)"
                  description="Alternative to IAM credentials. Sets AWS_BEARER_TOKEN_BEDROCK."
                  mapsTo="AWS_BEARER_TOKEN_BEDROCK"
                >
                  <ApiKeyInput
                    hasKey={state.hasBedrockBearerToken}
                    onSave={(token) => applyPatch({ bedrockBearerToken: token })}
                    onClear={() => applyPatch({ bedrockBearerToken: '' })}
                  />
                </SettingRow>
              </>
            )}
            {state.cloudProvider === 'vertex' && (
              <>
                <SettingRow
                  label="GCP project ID"
                  description="Required for Vertex. Your Google Cloud project ID."
                  mapsTo="ANTHROPIC_VERTEX_PROJECT_ID"
                >
                  <ProviderTextInput
                    value={state.vertexProjectId}
                    placeholder="my-gcp-project"
                    onSave={(v) => applyPatch({ vertexProjectId: v })}
                  />
                </SettingRow>
                <SettingRow
                  label="Region"
                  description="Required for Vertex. Example: us-east5, global, europe-west1."
                  mapsTo="CLOUD_ML_REGION"
                >
                  <ProviderTextInput
                    value={state.vertexRegion}
                    placeholder="us-east5"
                    onSave={(v) => applyPatch({ vertexRegion: v })}
                  />
                </SettingRow>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
