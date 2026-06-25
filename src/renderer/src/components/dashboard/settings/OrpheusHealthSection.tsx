import { useEffect, useState } from 'react'
import type React from 'react'
import type { HealthReport } from '@shared/types'
import { SectionTitle, Eyebrow } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'

type HooksStatus = { enabled: boolean; installed: number }

function StatusPill({ status }: { status: 'ok' | 'warn' | 'error' }): React.JSX.Element {
  const classes =
    status === 'ok'
      ? 'bg-green-500/15 text-green-400 border-green-500/20'
      : status === 'warn'
        ? 'bg-amber-500/15 text-amber-400 border-amber-500/20'
        : 'bg-red-500/15 text-red-400 border-red-500/20'
  const label = status === 'ok' ? 'OK' : status === 'warn' ? 'Warn' : 'Error'
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${classes}`}
    >
      {label}
    </span>
  )
}

export function OrpheusHealthSection(): React.JSX.Element {
  const [health, setHealth] = useState<HealthReport | null>(null)
  const [hooksStatus, setHooksStatus] = useState<HooksStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [togglingHooks, setTogglingHooks] = useState(false)

  async function fetchAll(): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const [h, hs] = await Promise.all([window.api.health.get(), window.api.hooks.getStatus()])
      setHealth(h)
      setHooksStatus(hs)
    } catch (err) {
      console.error('[health] fetch failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([window.api.health.get(), window.api.hooks.getStatus()])
      .then(([h, hs]) => {
        if (!cancelled) {
          setHealth(h)
          setHooksStatus(hs)
        }
      })
      .catch((err) => {
        console.error('[health] fetch failed', err)
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleToggleHooks(enabled: boolean): Promise<void> {
    setTogglingHooks(true)
    try {
      await window.api.hooks.setEnabled(enabled)
      await fetchAll()
    } catch (err) {
      console.error('[health] hooks toggle failed', err)
    } finally {
      setTogglingHooks(false)
    }
  }

  async function handleTestNotification(): Promise<void> {
    setTesting(true)
    try {
      await window.api.notifications.test()
    } catch (err) {
      console.error('[health] test notification failed', err)
    } finally {
      setTesting(false)
    }
  }

  if (error) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Health</SectionTitle>
          <p className="text-xs text-text-muted mt-1">System checks for Orpheus dependencies.</p>
        </div>
        <p className="text-sm text-red-400">Failed to load health data: {error}</p>
      </div>
    )
  }

  if (loading || !health || !hooksStatus) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <SectionTitle>Health</SectionTitle>
          <p className="text-xs text-text-muted mt-1">System checks for Orpheus dependencies.</p>
        </div>
        <SettingsSectionSkeleton groups={2} rowsPerGroup={3} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <SectionTitle>Health</SectionTitle>
        <p className="text-xs text-text-muted mt-1">System checks for Orpheus dependencies.</p>
      </div>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Checks</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/50">
          {/* Claude CLI */}
          <div className="px-5 py-3.5 flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm text-text-primary">Claude CLI</span>
              <span className="text-xs text-text-muted truncate">{health.claudeCli.detail}</span>
            </div>
            <StatusPill status={health.claudeCli.status} />
          </div>

          {/* Session registry */}
          <div className="px-5 py-3.5 flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm text-text-primary">Session registry</span>
              <span className="text-xs text-text-muted truncate">
                {health.sessionRegistry.detail}
              </span>
            </div>
            <StatusPill status={health.sessionRegistry.status} />
          </div>

          {/* Notifications */}
          <div className="px-5 py-3.5 flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 flex-1 min-w-0">
              <span className="text-sm text-text-primary">OS notifications</span>
              <span className="text-xs text-text-muted truncate">
                {health.notifications.detail}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={handleTestNotification}
                disabled={testing}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-overlay border border-border-default hover:border-border-hover text-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {testing ? 'Sending…' : 'Send test'}
              </button>
              <StatusPill status={health.notifications.status} />
            </div>
          </div>

          {/* Data dir */}
          <div className="px-5 py-3.5 flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="text-sm text-text-primary">Data directory</span>
              <span className="text-xs text-text-muted truncate">{health.dataDir.detail}</span>
            </div>
            <StatusPill status={health.dataDir.status} />
          </div>
        </div>
      </section>

      <section className="flex flex-col">
        <Eyebrow className="mb-3">Hooks integration</Eyebrow>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <div className="py-3.5 flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-sm text-text-primary">Enable hooks</span>
              <span className="text-xs text-text-muted max-w-xs">
                Off by default — Orpheus drives workspace status from Claude&apos;s session files;
                enable only if you want hook-based integrations.
              </span>
              <span className="text-xs text-text-muted mt-1">
                {hooksStatus.installed} installed
              </span>
            </div>
            <button
              type="button"
              onClick={() => handleToggleHooks(!hooksStatus.enabled)}
              disabled={togglingHooks}
              className={[
                'flex-shrink-0 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed',
                hooksStatus.enabled
                  ? 'bg-accent/15 border-accent/30 text-accent hover:bg-accent/25'
                  : 'bg-surface-overlay border-border-default hover:border-border-hover text-text-primary'
              ].join(' ')}
            >
              {togglingHooks ? 'Updating…' : hooksStatus.enabled ? 'Enabled' : 'Disabled'}
            </button>
          </div>
        </div>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={fetchAll}
          disabled={loading}
          className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-overlay border border-border-default hover:border-border-hover text-text-primary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Re-check
        </button>
      </div>
    </div>
  )
}
