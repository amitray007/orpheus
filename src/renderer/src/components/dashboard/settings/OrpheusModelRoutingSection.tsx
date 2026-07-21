import { useEffect, useState } from 'react'
import type React from 'react'
import type { RoutingProxyAssetInfo, RoutingProxySnapshot } from '@shared/types'
import { SettingRow, Toggle, SectionTitle, Eyebrow } from './primitives'
import { ProvidersSection } from './ProvidersSection'
import { AliasesSection } from './AliasesSection'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { Warning } from '@phosphor-icons/react'

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
// OrpheusModelRoutingSection
// ---------------------------------------------------------------------------

export function OrpheusModelRoutingSection(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RoutingProxySnapshot | null>(null)
  const [assetInfo, setAssetInfo] = useState<RoutingProxyAssetInfo | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [updateLatest, setUpdateLatest] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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
    </div>
  )
}
