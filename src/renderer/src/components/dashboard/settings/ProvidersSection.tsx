import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { ProviderConfigSummary, ProviderDescriptorSummary } from '@shared/types'
import { SettingRow, Toggle, Eyebrow } from './primitives'
import { Plus, Trash, Link, Spinner, X, CheckCircle, WarningCircle } from '@phosphor-icons/react'

// ---------------------------------------------------------------------------
// ProvidersSection (model-routing unit 05, part E + unit 07 Connect flow)
//
// Entirely data-driven from providers:descriptors — no per-provider
// hardcoded JSX. Each descriptor renders: an enable toggle (once configured),
// a connection dot (from providers:list's `connection` field, sourced from
// the routing-proxy's live auth-files), and — for apiKey/openaiCompatible
// providers only — an inline API-key list editor. OAuth-eligible providers
// (any descriptor with 'oauth' in authMethods — codex/xai/kimi/antigravity;
// NOT gemini, which is apiKey-only, see providers/registry.ts) render a
// "Connect" button that drives the in-app OAuth flow via window.api.oauth.*
// (src/main/routingProxy/oauth.ts) instead of a terminal login.
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

// ---------------------------------------------------------------------------
// ConnectButton — the OAuth "Connect <provider>" flow (unit 07). Idle ->
// connecting (shows the auth url + device user_code as a visible fallback to
// the auto-opened browser, plus Cancel) -> connected/failed. Polls
// window.api.oauth.poll on a client-side 2s interval; each call is a single
// get-auth-status check (see oauth:poll's own doc comment in shared/ipc.ts)
// so this component owns the interval/timeout/cancel lifecycle, not main.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 2000
const DEFAULT_TIMEOUT_MS = 5 * 60_000

type ConnectPhase = 'idle' | 'connecting' | 'connected' | 'failed'

interface ConnectButtonProps {
  providerId: string
  label: string
  connected: boolean
  onConnected: () => void
}

function ConnectButton({
  providerId,
  label,
  connected,
  onConnected
}: ConnectButtonProps): React.JSX.Element {
  const [phase, setPhase] = useState<ConnectPhase>('idle')
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [userCode, setUserCode] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const stateRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const deadlineRef = useRef<number>(0)

  function stopPolling(): void {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => stopPolling, [])

  function poll(): void {
    const state = stateRef.current
    if (!state) return
    if (Date.now() >= deadlineRef.current) {
      stopPolling()
      setPhase('failed')
      setErrorMsg('Timed out waiting for the login to complete.')
      return
    }
    window.api.oauth
      .poll(state)
      .then((result) => {
        if (result.status === 'ok') {
          stopPolling()
          setPhase('connected')
          onConnected()
        } else if (result.status === 'error') {
          stopPolling()
          setPhase('failed')
          setErrorMsg(result.error ?? 'Authentication failed.')
        }
        // 'wait' — keep polling on the next interval tick.
      })
      .catch((err: unknown) => {
        stopPolling()
        setPhase('failed')
        setErrorMsg(err instanceof Error ? err.message : 'Failed to check login status.')
      })
  }

  function startConnect(): void {
    setPhase('connecting')
    setErrorMsg(null)
    setAuthUrl(null)
    setUserCode(null)
    window.api.oauth
      .start(providerId)
      .then((result) => {
        stateRef.current = result.state
        setAuthUrl(result.url)
        setUserCode(result.userCode ?? null)
        const timeoutMs = result.expiresIn ? result.expiresIn * 1000 : DEFAULT_TIMEOUT_MS
        deadlineRef.current = Date.now() + timeoutMs
        timerRef.current = setInterval(poll, POLL_INTERVAL_MS)
      })
      .catch((err: unknown) => {
        setPhase('failed')
        setErrorMsg(err instanceof Error ? err.message : 'Failed to start login.')
      })
  }

  function cancelConnect(): void {
    stopPolling()
    const state = stateRef.current
    stateRef.current = null
    setPhase('idle')
    setAuthUrl(null)
    setUserCode(null)
    if (state) window.api.oauth.cancel(state).catch(() => {})
  }

  if (connected) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
        <CheckCircle size={14} weight="fill" />
        Connected
      </span>
    )
  }

  if (phase === 'idle' || phase === 'connected') {
    return (
      <button
        type="button"
        onClick={startConnect}
        className="inline-flex items-center gap-1.5 text-xs text-accent hover:opacity-80 transition-opacity"
      >
        <Link size={13} weight="bold" />
        Connect
      </button>
    )
  }

  if (phase === 'connecting') {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          {authUrl && (
            <a
              href={authUrl}
              onClick={(e) => {
                e.preventDefault()
                window.api.oauth.start(providerId).catch(() => {})
              }}
              className="text-xs text-accent hover:opacity-80 transition-opacity truncate max-w-[220px]"
              title={authUrl}
            >
              Open sign-in link
            </a>
          )}
          <Spinner size={13} className="animate-spin text-text-muted" />
          <button
            type="button"
            onClick={cancelConnect}
            aria-label={`Cancel ${label} connect`}
            className="text-text-muted hover:text-red-400 transition-colors"
          >
            <X size={13} />
          </button>
        </div>
        {userCode && (
          <span className="text-xs font-mono text-text-secondary">Code: {userCode}</span>
        )}
      </div>
    )
  }

  // phase === 'failed'
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <span
          className="inline-flex items-center gap-1 text-xs text-red-400 max-w-[220px] truncate"
          title={errorMsg ?? undefined}
        >
          <WarningCircle size={13} />
          Failed
        </span>
        <button
          type="button"
          onClick={startConnect}
          className="text-xs text-accent hover:opacity-80 transition-opacity"
        >
          Retry
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

  /** Called after a successful OAuth connect. Ensures the provider's stored
   *  row is enabled — isProviderConnectedHealthy (models/selectable.ts) gates
   *  a routed model's availability on BOTH `enabled` AND connection health
   *  'ok', so a first-time connect (no row yet, or a row left disabled) must
   *  not leave newly connected models unselectable pending a manual toggle. */
  function onProviderConnected(providerId: string): void {
    window.api.providers
      .setEnabled(providerId, true)
      .then(setConfigs)
      .catch((err) => console.error('[providers] auto-enable after connect failed', err))
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
          const isOAuthEligible = descriptor.authMethods.includes('oauth')
          const enabled = summary?.enabled ?? false
          const isConnected = summary?.connection?.health === 'ok'

          return (
            <div key={descriptor.id} className="py-3">
              <SettingRow label={descriptor.label}>
                <div className="flex items-center gap-3">
                  {summary?.connection && (
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${healthDotClass(summary.connection.health)}`}
                      title={`Connection: ${summary.connection.health}`}
                    />
                  )}
                  {isOAuthEligible && (
                    <ConnectButton
                      providerId={descriptor.id}
                      label={descriptor.label}
                      connected={isConnected}
                      onConnected={() => onProviderConnected(descriptor.id)}
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
