import { useEffect, useState } from 'react'
import type React from 'react'
import type {
  RoutingProxyAssetInfo,
  RoutingProxyMaintenanceResult,
  RoutingProxySnapshot
} from '@shared/types'
import { SettingRow, Toggle, SectionTitle, Eyebrow } from './primitives'
import { ProvidersSection } from './ProvidersSection'
import { AliasesSection } from './AliasesSection'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { Warning, ArrowClockwise } from '@phosphor-icons/react'
import { ProviderIcon } from '../../ProviderIcon'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number | null): string {
  if (bytes === null) return ''
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function statusDotClass(status: RoutingProxySnapshot['status']): string {
  switch (status) {
    case 'running':
      return 'bg-green-500'
    case 'starting':
    case 'installing':
      return 'bg-amber-400 animate-pulse'
    case 'error':
      return 'bg-red-500'
    case 'stopped':
      return 'bg-zinc-400'
    default:
      return 'bg-zinc-500'
  }
}

function statusLabel(status: RoutingProxySnapshot['status']): string {
  switch (status) {
    case 'not_installed':
      return 'Not installed'
    case 'installing':
      return 'Installing…'
    case 'stopped':
      return 'Stopped'
    case 'starting':
      return 'Starting…'
    case 'running':
      return 'Running'
    case 'error':
      return 'Error'
    default:
      return status
  }
}

function healthDotClass(health: 'ok' | 'error' | 'unknown'): string {
  if (health === 'ok') return 'bg-green-500'
  if (health === 'error') return 'bg-red-500'
  return 'bg-zinc-400'
}

// ---------------------------------------------------------------------------
// Maintenance actions (model-routing unit 09-polish) — explicit "fix it now"
// escape hatches for a user who can't (or shouldn't have to) wait on a
// background refresh they can't see or trigger. THESE ARE ESCAPE HATCHES,
// NOT THE PRIMARY MECHANISM: boot hydration, the 30s refreshAuthFiles tick,
// the post-OAuth-connect refresh, and the alias-cache-population trigger
// already keep everything current on their own — a user needing to click
// one of these routinely is a sign something upstream is broken, not
// evidence the buttons are doing their job. Don't let a later change start
// relying on the user clicking these as if they were the normal flow.
// ---------------------------------------------------------------------------

interface MaintenanceActionProps {
  label: string
  description: string
  disabled?: boolean
  disabledReason?: string
  run: () => Promise<RoutingProxyMaintenanceResult>
}

function MaintenanceAction({
  label,
  description,
  disabled,
  disabledReason,
  run
}: MaintenanceActionProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<RoutingProxyMaintenanceResult | null>(null)

  async function handleClick(): Promise<void> {
    if (busy) return // non-re-entrant: ignore a click while already running
    setBusy(true)
    setResult(null)
    try {
      const r = await run()
      setResult(r)
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Failed.' })
    } finally {
      setBusy(false)
    }
  }

  const isDisabled = disabled || busy

  return (
    <div className="py-3">
      <SettingRow
        label={label}
        description={isDisabled && disabledReason ? disabledReason : description}
      >
        <button
          type="button"
          disabled={isDisabled}
          onClick={() => void handleClick()}
          className="px-3 py-1.5 rounded text-xs font-medium text-text-muted border border-border-default hover:text-text-secondary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
        >
          {busy && <ArrowClockwise size={11} weight="bold" className="animate-spin" />}
          {busy ? 'Working…' : label}
        </button>
      </SettingRow>
      {result && (
        <p className={`text-xs mt-1.5 ${result.ok ? 'text-text-muted' : 'text-red-400'}`}>
          {result.message}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OrpheusModelRoutingSection
// ---------------------------------------------------------------------------

export function OrpheusModelRoutingSection(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RoutingProxySnapshot | null>(null)
  const [assetInfo, setAssetInfo] = useState<RoutingProxyAssetInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateLatest, setUpdateLatest] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    let cancelled = false

    window.api.routingProxy
      .getState()
      .then((s) => {
        if (!cancelled) setSnapshot(s)
      })
      .catch(console.error)

    window.api.routingProxy
      .getAssetInfo()
      .then((info) => {
        if (!cancelled) setAssetInfo(info)
      })
      .catch(console.error)

    const off = window.api.routingProxy.onSnapshot((s) => {
      if (!cancelled) setSnapshot(s)
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  function toggleEnabled(v: boolean): void {
    if (!snapshot) return
    setSnapshot({ ...snapshot, enabled: v })
    setBusy(true)
    window.api.routingProxy
      .setEnabled(v)
      .then((s) => setSnapshot(s))
      .catch((err) => {
        console.error('[routingProxy] setEnabled failed', err)
        window.api.routingProxy
          .getState()
          .then((s) => setSnapshot(s))
          .catch(console.error)
      })
      .finally(() => setBusy(false))
  }

  async function handleInstall(): Promise<void> {
    setBusy(true)
    try {
      const s = await window.api.routingProxy.install()
      setSnapshot(s)
    } catch (err) {
      console.error('[routingProxy] install failed', err)
    } finally {
      setBusy(false)
    }
  }

  async function handleCheckUpdate(): Promise<void> {
    setCheckingUpdate(true)
    try {
      const result = await window.api.routingProxy.checkForUpdate()
      setUpdateLatest(result.available ? result.latest : null)
    } catch (err) {
      console.error('[routingProxy] update check failed', err)
    } finally {
      setCheckingUpdate(false)
    }
  }

  async function handleRefreshAuthFiles(): Promise<void> {
    try {
      const s = await window.api.routingProxy.refreshAuthFiles()
      setSnapshot(s)
    } catch (err) {
      console.error('[routingProxy] refresh auth files failed', err)
    }
  }

  // Restart (model-routing unit 09-polish) — a recovery tool for a wedged
  // process/stale in-proxy state/a config key that doesn't hot-reload.
  // Ordinary alias/provider edits do NOT need this — they already hot-reload
  // via config.yaml's fsnotify watch (see AliasesSection's own notice).
  // Non-re-entrant: `restarting` disables the control while manager.ts's own
  // restart() is in flight, and manager.ts's own re-entrancy guard backstops
  // this even if two clicks somehow race.
  async function handleRestart(): Promise<void> {
    if (restarting) return
    setRestarting(true)
    try {
      const s = await window.api.routingProxy.restart()
      setSnapshot(s)
    } catch (err) {
      console.error('[routingProxy] restart failed', err)
      window.api.routingProxy
        .getState()
        .then((s) => setSnapshot(s))
        .catch(console.error)
    } finally {
      setRestarting(false)
    }
  }

  if (!snapshot) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Model Routing</SectionTitle>
          <p className="text-xs text-text-muted mt-1">
            Route non-Claude models through a locally managed proxy.
          </p>
        </div>
        <SettingsSectionSkeleton groups={2} rowsPerGroup={2} />
      </div>
    )
  }

  // Gate the Install/Retry action on "is it actually installed?" — not on
  // `status === 'not_installed'`. Status can be 'error' for reasons that
  // have nothing to do with installation (e.g. the process started but
  // never became reachable) while a binary is on disk, or (the trap-state
  // bug) because a failed auto-install left status 'error' with no binary
  // at all. Either way, whenever the component isn't installed the Install
  // control must stay reachable — 'error' must never be a dead end.
  const canInstall = !snapshot.installedVersion && snapshot.status !== 'installing'
  const isInstalling = snapshot.status === 'installing'
  const isRunning = snapshot.status === 'running'
  const isRetry = snapshot.status === 'error'

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Model Routing</SectionTitle>
        <p className="text-xs text-text-muted mt-1">
          Route workspaces using a non-Claude model through a locally managed CLIProxyAPI process
          instead of a direct connection.
        </p>
      </div>

      {/* Third-party binary notice */}
      <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-3">
        <Warning size={16} weight="fill" className="text-amber-500 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-text-secondary leading-relaxed">
          Enabling this downloads and runs{' '}
          <span className="font-medium text-text-primary">CLIProxyAPI</span>, a third-party
          open-source binary, on your machine. Orpheus verifies its checksum before installing and
          manages its lifecycle, but the binary itself is not developed by Orpheus.
        </p>
      </div>

      {/* Enable toggle + status card */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Component</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Enable managed routing proxy"
            description="Off by default. When on, Orpheus installs (if needed) and runs the proxy so non-Claude model workspaces can route through it."
          >
            <Toggle
              value={snapshot.enabled}
              onChange={toggleEnabled}
              ariaLabel="Enable managed routing proxy"
            />
          </SettingRow>
        </div>
      </section>

      {/* Status card */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Status</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2.5">
              <span
                className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${statusDotClass(snapshot.status)}`}
              />
              <span className="text-sm font-medium text-text-primary">
                {statusLabel(snapshot.status)}
              </span>
            </div>
            <span className="text-xs text-text-muted">
              {snapshot.installedVersion
                ? `v${snapshot.installedVersion} installed`
                : 'Not installed'}{' '}
              &middot; pinned v{snapshot.pinnedVersion}
            </span>
          </div>

          {snapshot.installProgress && (
            <p className="text-xs text-text-muted">
              {snapshot.installProgress.phase === 'downloading' && 'Downloading…'}
              {snapshot.installProgress.phase === 'verifying' && 'Verifying checksum…'}
              {snapshot.installProgress.phase === 'extracting' && 'Extracting…'}
            </p>
          )}

          {snapshot.error && <p className="text-xs text-red-400">{snapshot.error}</p>}

          <div className="flex items-center gap-2 flex-wrap pt-1">
            {canInstall && (
              <button
                type="button"
                disabled={busy || isInstalling}
                onClick={() => void handleInstall()}
                className="px-3 py-1.5 rounded text-xs font-medium bg-accent text-black hover:bg-accent/90 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isRetry
                  ? 'Retry install'
                  : assetInfo?.sizeBytes
                    ? `Install (${formatBytes(assetInfo.sizeBytes)})`
                    : 'Install'}
              </button>
            )}
            <button
              type="button"
              disabled={checkingUpdate}
              onClick={() => void handleCheckUpdate()}
              className="px-3 py-1.5 rounded text-xs font-medium text-text-muted border border-border-default hover:text-text-secondary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {checkingUpdate ? 'Checking…' : 'Check for updates'}
            </button>
            {snapshot.installedVersion && (
              <button
                type="button"
                disabled={restarting}
                onClick={() => void handleRestart()}
                title="Restart the proxy — a recovery tool for a wedged process or stale state. Alias/provider edits already take effect without a restart."
                className="px-3 py-1.5 rounded text-xs font-medium text-text-muted border border-border-default hover:text-text-secondary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
              >
                <ArrowClockwise
                  size={11}
                  weight="bold"
                  className={restarting ? 'animate-spin' : ''}
                />
                {restarting ? 'Restarting…' : 'Restart'}
              </button>
            )}
            {updateLatest && (
              <span className="text-xs text-accent">
                v{updateLatest} available (reinstall to pick up unreleased pin bumps)
              </span>
            )}
          </div>
        </div>
      </section>

      {/* Providers — declarative, data-driven from providers:descriptors */}
      <ProvidersSection />

      {/* Model-name aliasing — declarative, data-driven from CLAUDE_MODEL_OPTIONS + aliases:listTargets */}
      <AliasesSection />

      {/* Connected accounts */}
      {isRunning && (
        <section className="flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <Eyebrow>Connected accounts</Eyebrow>
            <button
              type="button"
              onClick={() => void handleRefreshAuthFiles()}
              className="text-xs text-accent hover:underline cursor-pointer"
            >
              Refresh
            </button>
          </div>
          <div className="bg-surface-raised border border-border-default rounded-lg px-5">
            {snapshot.authFiles.length === 0 ? (
              <div className="py-4">
                <p className="text-xs text-text-muted">
                  No accounts connected yet. Connecting a provider is not yet available from this
                  panel.
                </p>
              </div>
            ) : (
              snapshot.authFiles.map((f) => (
                <SettingRow
                  key={`${f.provider}-${f.label}`}
                  label={f.provider}
                  description={f.label}
                  icon={<ProviderIcon providerId={f.provider} size={12} />}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`w-2 h-2 rounded-full ${healthDotClass(f.health)}`} />
                    <span className="text-xs text-text-muted capitalize">{f.health}</span>
                  </div>
                </SettingRow>
              ))
            )}
          </div>
          {snapshot.authFilesCheckedAt && (
            <p className="text-xs text-text-muted mt-1.5">
              Last checked {timeAgo(snapshot.authFilesCheckedAt)}
            </p>
          )}
        </section>
      )}

      {/* Maintenance (model-routing unit 09-polish) — explicit "fix it now"
          escape hatches. See MaintenanceAction's own doc comment: these are
          NOT the primary mechanism, the automatic paths already keep
          everything current on their own. */}
      <section className="flex flex-col">
        <Eyebrow className="mb-3">Maintenance</Eyebrow>
        <p className="text-xs text-text-muted mb-2">
          Escape hatches for a stuck state. Everything here also happens automatically — use these
          only if something looks stale.
        </p>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 divide-y divide-border-default/60">
          <MaintenanceAction
            label="Refresh models"
            description="Re-fetch the model list from every connected provider."
            disabled={!isRunning}
            disabledReason="Requires the proxy to be running."
            run={() => window.api.routingProxy.forceRefreshModels()}
          />
          <MaintenanceAction
            label="Refresh connections"
            description="Re-check which provider accounts are currently connected and healthy."
            disabled={!isRunning}
            disabledReason="Requires the proxy to be running."
            run={() => window.api.routingProxy.forceRefreshConnections()}
          />
          <MaintenanceAction
            label="Regenerate config"
            description="Rewrite config.yaml from current settings — useful if an edit doesn't seem to have taken effect."
            disabled={!snapshot.installedVersion}
            disabledReason="Requires the proxy to be installed."
            run={() => window.api.routingProxy.forceRegenerateConfig()}
          />
        </div>
      </section>
    </div>
  )
}
