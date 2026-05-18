import { useEffect, useState } from 'react'
import type React from 'react'
import type { AppUiState, ClaudeStatusSnapshot } from '@shared/types'
import { SettingRow, Toggle, Select } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { ArrowSquareOut } from '@phosphor-icons/react'
import { BRAILLE_FRAMES, useAnimatedFrame } from '@/lib/braille'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.floor(diff / 1_000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

type Indicator = ClaudeStatusSnapshot['indicator']

function indicatorDotClass(indicator: Indicator): string {
  switch (indicator) {
    case 'none':
      return 'bg-green-500'
    case 'minor':
      return 'bg-amber-400'
    case 'major':
    case 'critical':
      return 'bg-red-500'
    case 'maintenance':
      return 'bg-blue-500'
    default:
      return 'bg-zinc-400'
  }
}

function componentStatusToIndicator(
  status: ClaudeStatusSnapshot['components'][number]['status']
): Indicator {
  switch (status) {
    case 'operational':
      return 'none'
    case 'degraded_performance':
      return 'minor'
    case 'partial_outage':
      return 'major'
    case 'major_outage':
      return 'critical'
    case 'under_maintenance':
      return 'maintenance'
    default:
      return 'none'
  }
}

function componentStatusLabel(
  status: ClaudeStatusSnapshot['components'][number]['status']
): string {
  switch (status) {
    case 'operational':
      return 'Operational'
    case 'degraded_performance':
      return 'Degraded performance'
    case 'partial_outage':
      return 'Partial outage'
    case 'major_outage':
      return 'Major outage'
    case 'under_maintenance':
      return 'Under maintenance'
    default:
      return status
  }
}

function impactLabel(impact: ClaudeStatusSnapshot['incidents'][number]['impact']): string {
  switch (impact) {
    case 'none':
      return 'None'
    case 'minor':
      return 'Minor'
    case 'major':
      return 'Major'
    case 'critical':
      return 'Critical'
    default:
      return impact
  }
}

// ---------------------------------------------------------------------------
// Components filtered from the displayed list (still fetched by the poller)
// ---------------------------------------------------------------------------

const HIDDEN_COMPONENT_NAMES = new Set(['Claude for Government', 'Claude Cowork'])

/**
 * Parse names like "Claude Console (platform.claude.com)" into a primary line
 * and an optional subtitle. Names without parens return subtitle=null.
 */
function parseComponentName(name: string): { primary: string; subtitle: string | null } {
  const m = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (!m) return { primary: name, subtitle: null }
  return { primary: m[1], subtitle: m[2] }
}

// ---------------------------------------------------------------------------
// OrpheusStatusSection
// ---------------------------------------------------------------------------

const POLL_INTERVAL_OPTIONS = [
  { value: '300', label: '5 minutes' },
  { value: '600', label: '10 minutes' },
  { value: '900', label: '15 minutes' },
  { value: '1800', label: '30 minutes' },
  { value: '3600', label: '1 hour' },
  { value: '7200', label: '2 hours' },
  { value: '10800', label: '3 hours' }
] as const

type PollIntervalValue = (typeof POLL_INTERVAL_OPTIONS)[number]['value']
const DEFAULT_POLL_INTERVAL: PollIntervalValue = '1800'

export function OrpheusStatusSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [snapshot, setSnapshot] = useState<ClaudeStatusSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [, setTick] = useState(0)
  const braille = useAnimatedFrame(BRAILLE_FRAMES, 80, snapshot?.isFetching ?? false)

  // Tick every 10 seconds to update relative timestamps
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false

    window.api.uiState
      .get()
      .then((s) => {
        if (!cancelled) setUiState(s)
      })
      .catch(console.error)

    window.api.status
      .get()
      .then((s) => {
        if (!cancelled) setSnapshot(s)
      })
      .catch(console.error)

    const off = window.api.status.onChange((s) => {
      if (!cancelled) setSnapshot(s)
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  function patch(p: Partial<AppUiState>): void {
    if (!uiState) return
    setUiState({ ...uiState, ...p })
    window.api.uiState.update(p).catch((err) => {
      console.error('[settings] uiState update failed; refetching to reconcile', err)
      window.api.uiState
        .get()
        .then((s) => setUiState(s))
        .catch(console.error)
    })
  }

  async function handleRefreshNow(): Promise<void> {
    setRefreshing(true)
    try {
      const s = await window.api.status.refresh()
      setSnapshot(s)
    } catch (err) {
      console.error('[status] refresh failed', err)
    } finally {
      setRefreshing(false)
    }
  }

  function handleOpenPage(): void {
    window.api.status.openPage().catch(console.error)
  }

  if (!uiState) {
    return (
      <div className="flex flex-col gap-6 max-w-2xl">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Claude Service Status</h2>
          <p className="text-xs text-text-muted mt-1">
            Live status of the Claude API and Claude Code service.
          </p>
        </div>
        <SettingsSectionSkeleton groups={3} rowsPerGroup={2} />
      </div>
    )
  }

  const pollIntervalStr = String(
    uiState.statusPollIntervalSec ?? Number(DEFAULT_POLL_INTERVAL)
  ) as PollIntervalValue
  const validPollInterval = POLL_INTERVAL_OPTIONS.some((o) => o.value === pollIntervalStr)
    ? pollIntervalStr
    : DEFAULT_POLL_INTERVAL

  const hasData =
    snapshot !== null &&
    snapshot.fetchedAt !== null &&
    snapshot.components.some((c) => !HIDDEN_COMPONENT_NAMES.has(c.name))
  const initialLoading = snapshot !== null && snapshot.isFetching && !hasData

  return (
    <div className="flex flex-col gap-10 max-w-2xl">
      <div>
        <h2 className="text-base font-semibold text-text-primary">Claude Service Status</h2>
        <p className="text-xs text-text-muted mt-1">
          Live status of the Claude API and Claude Code service.
        </p>
      </div>

      {/* Live snapshot */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Current status
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4 flex flex-col gap-4">
          {initialLoading ? (
            <div className="flex items-center justify-center gap-2 py-3">
              <span className="text-zinc-400 font-mono text-xs leading-none">{braille}</span>
              <span className="text-xs text-text-secondary">Claude APIs are being checked</span>
            </div>
          ) : snapshot ? (
            <>
              {/* Header */}
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2.5">
                  <span
                    className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${indicatorDotClass(snapshot.watchedIndicator)}`}
                  />
                  <span className="text-sm font-medium text-text-primary">
                    {snapshot.description}
                  </span>
                </div>
                <span className="text-xs text-text-muted flex-shrink-0 flex items-center gap-1.5">
                  {snapshot.isFetching ? (
                    <>
                      <span className="text-zinc-400 font-mono leading-none">{braille}</span>
                      <span>Checking now</span>
                    </>
                  ) : snapshot.fetchedAt !== null ? (
                    snapshot.fetchOk ? (
                      `Last checked ${timeAgo(snapshot.fetchedAt)}`
                    ) : (
                      `Stale · Last checked ${timeAgo(snapshot.fetchedAt)}`
                    )
                  ) : null}
                </span>
              </div>

              {/* Component rows (filtered, two-line) */}
              {snapshot.components.some((c) => !HIDDEN_COMPONENT_NAMES.has(c.name)) && (
                <div className="flex flex-col gap-1">
                  {snapshot.components
                    .filter((c) => !HIDDEN_COMPONENT_NAMES.has(c.name))
                    .map((c) => {
                      const ind = componentStatusToIndicator(c.status)
                      const { primary, subtitle } = parseComponentName(c.name)
                      return (
                        <div key={c.id} className="flex items-start gap-2 py-1">
                          <span
                            className={`w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ${indicatorDotClass(ind)}`}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-text-primary truncate leading-tight">
                              {primary}
                            </p>
                            {subtitle && (
                              <p className="text-[11px] text-text-muted truncate leading-tight">
                                {subtitle}
                              </p>
                            )}
                          </div>
                          <span
                            className={`text-xs flex-shrink-0 mt-0.5 ${ind === 'none' ? 'text-text-muted' : 'text-text-primary'}`}
                          >
                            {componentStatusLabel(c.status)}
                          </span>
                        </div>
                      )
                    })}
                </div>
              )}

              {/* Active incidents */}
              {snapshot.incidents.length > 0 && (
                <div className="flex flex-col gap-2 pt-2 border-t border-border-default/40">
                  <p className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                    Active incidents
                  </p>
                  {snapshot.incidents.map((inc) => (
                    <div key={inc.id} className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-text-primary">{inc.name}</span>
                        <span className="text-[10px] text-text-muted border border-border-default rounded px-1.5 py-0.5 leading-none">
                          {impactLabel(inc.impact)}
                        </span>
                      </div>
                      <span className="text-[11px] text-text-muted">
                        {inc.status} &middot; Updated {timeAgo(new Date(inc.updatedAt).getTime())}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-text-muted">Waiting for first status check...</p>
          )}

          {/* Footer row */}
          <div className="flex items-center justify-between gap-4 pt-2 border-t border-border-default/40">
            <button
              type="button"
              onClick={() => {
                void handleRefreshNow()
              }}
              disabled={refreshing}
              className="text-xs text-accent hover:underline cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none"
            >
              {refreshing ? 'Refreshing...' : 'Refresh now'}
            </button>
            <button
              type="button"
              onClick={handleOpenPage}
              className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors cursor-pointer focus-visible:outline-none"
            >
              View status page
              <ArrowSquareOut size={12} />
            </button>
          </div>
        </div>
      </section>

      {/* Polling preferences */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          Polling
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5">
          <SettingRow
            label="Check interval"
            description="How often Orpheus polls status.claude.com for live service health."
          >
            <Select
              options={POLL_INTERVAL_OPTIONS as unknown as { value: string; label: string }[]}
              value={validPollInterval}
              onChange={(v) => patch({ statusPollIntervalSec: parseInt(v, 10) })}
              ariaLabel="Status check interval"
            />
          </SettingRow>
          <SettingRow
            label="Mute status notifications"
            description="Suppress OS notifications when a watched component transitions to degraded or recovers."
          >
            <Toggle
              value={uiState.muteStatusNotifications ?? false}
              onChange={(v) => patch({ muteStatusNotifications: v })}
              ariaLabel="Mute status notifications"
            />
          </SettingRow>
        </div>
      </section>

      {/* Status page link */}
      <section className="flex flex-col">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary mb-3">
          External
        </h3>
        <div className="bg-surface-raised border border-border-default rounded-lg px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">status.claude.com</p>
              <p className="text-xs text-text-muted mt-0.5">
                Full incident history, maintenance windows, and RSS feed.
              </p>
            </div>
            <button
              type="button"
              onClick={handleOpenPage}
              className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-surface-overlay border border-border-default hover:border-border-hover text-text-primary transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              Open
              <ArrowSquareOut size={12} />
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
