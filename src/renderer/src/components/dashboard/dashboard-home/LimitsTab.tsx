import { useState } from 'react'
import { CheckCircle, Gauge, WarningCircle } from '@phosphor-icons/react'
import type { ProviderUsageEntry, ProviderUsageLimit, ProviderUsageWindow } from '@shared/types'
import { ProviderIcon } from '@/components/ProviderIcon'
import { cn } from '@/lib/utils'
import { DashboardCard } from './DashboardCard'
import { SourceRefreshButton } from './SourceRefreshButton'
import { formatResetCountdown } from './dashboardHome.helpers'

const KNOWN_PROVIDER_ICON_IDS = new Set(['claude', 'codex', 'xai', 'antigravity'])

function providerOrder(provider: ProviderUsageEntry): number {
  const id = provider.providerId.toLowerCase()
  const label = provider.label.toLowerCase()
  if (id === 'claude' || label === 'claude') return 0
  if (id === 'codex' || label === 'codex') return 1
  if (id === 'cursor' || label === 'cursor') return 2
  if (id === 'xai' || id === 'grok' || label === 'grok') return 3
  if (
    id === 'github-copilot' ||
    id === 'copilot' ||
    label === 'github copilot' ||
    label === 'copilot'
  ) {
    return 4
  }
  if (id === 'antigravity' || label === 'antigravity') return 5
  return 6
}

function ProviderMark({
  providerId,
  size
}: {
  providerId: string
  size: number
}): React.JSX.Element {
  const iconProviderId = providerId === 'grok' ? 'xai' : providerId
  if (KNOWN_PROVIDER_ICON_IDS.has(iconProviderId)) {
    return <ProviderIcon providerId={iconProviderId} size={size} />
  }
  return <Gauge size={size} weight="bold" aria-hidden="true" />
}

function isStaleProvider(provider: ProviderUsageEntry): boolean {
  return provider.stale === true
}

function providerStateLabel(provider: ProviderUsageEntry): string {
  if (isStaleProvider(provider)) return 'Stale Snapshot'
  if (!provider.configured) return 'Not Configured'
  if (provider.unavailableReason === 'no-auth') return 'Sign In Required'
  if (provider.unavailableReason === 'not-connected') return 'Not Connected'
  if (provider.availability === 'available') return 'Usage Available'
  if (provider.availability === 'unsupported') return 'Usage Unsupported'
  return 'Usage Unavailable'
}

function formatDuration(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null
  if (minutes % (60 * 24 * 7) === 0) return `${minutes / (60 * 24 * 7)}w`
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function formatResetTimestamp(timestamp: string | null): string {
  if (!timestamp) return 'Not Reported'
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return 'Not Reported'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function fillClass(utilization: number | null): string {
  if (utilization !== null && utilization >= 90) {
    return 'bg-[color:var(--color-gh-closed)]'
  }
  if (utilization !== null && utilization >= 70) {
    return 'bg-[color:var(--color-severity-warning)]'
  }
  return 'bg-accent'
}

function UsageMeter({
  label,
  utilization,
  resetsAt,
  durationMinutes
}: ProviderUsageWindow): React.JSX.Element {
  const clamped = Math.min(100, Math.max(0, utilization ?? 0))
  const duration = formatDuration(durationMinutes)

  return (
    <div className="flex min-w-0 flex-col rounded-none border border-border-default bg-surface-overlay/35 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{label}</div>
          {duration ? (
            <div className="font-mono text-xs text-text-muted">{duration} window</div>
          ) : null}
        </div>
        <div className="shrink-0 font-mono text-lg font-semibold text-text-primary tabular-nums">
          {utilization === null ? '—' : `${Math.round(utilization)}%`}
        </div>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-overlay">
        <div
          className={cn('h-full rounded-full', fillClass(utilization))}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <div className="mt-auto grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 pt-3">
        <div className="text-xs text-text-muted">Resets</div>
        <div className="min-w-0 text-right leading-4">
          <div className="truncate font-mono text-xs text-text-secondary tabular-nums">
            {formatResetTimestamp(resetsAt)}
          </div>
          {resetsAt ? (
            <div className="truncate font-mono text-xs text-text-muted tabular-nums">
              in {formatResetCountdown(resetsAt)}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ModelLimitRow({ limit }: { limit: ProviderUsageLimit }): React.JSX.Element {
  const isPercent = limit.valueKind === undefined || limit.valueKind === 'percent'
  const utilization = limit.utilization
  const clamped = utilization === null ? null : Math.min(100, Math.max(0, utilization))
  const displayValue =
    limit.displayValue ?? (isPercent && utilization !== null ? `${Math.round(utilization)}%` : '—')
  const secondaryLabel = limit.modelName
    ? limit.label
    : isPercent
      ? 'Custom Limit'
      : {
          count: 'Count',
          currency: 'Currency',
          status: 'Status'
        }[limit.valueKind ?? 'status']

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 rounded-none border border-border-default bg-surface-overlay/25 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-text-primary">
          {limit.modelName || limit.label}
        </div>
        <div className="font-mono text-xs text-text-muted">{secondaryLabel}</div>
      </div>
      <div className="max-w-40 text-right leading-4">
        <div className="font-mono text-sm font-medium text-text-primary tabular-nums">
          {displayValue}
        </div>
        {limit.resetsAt ? (
          <div className="truncate font-mono text-xs text-text-muted tabular-nums">
            {formatResetTimestamp(limit.resetsAt)}
          </div>
        ) : null}
      </div>
      {clamped !== null ? (
        <div
          role="progressbar"
          aria-label={`${limit.modelName || limit.label} utilization`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={clamped}
          aria-valuetext={`${Math.round(clamped)}% used`}
          className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-overlay"
        >
          <div
            className={cn('h-full rounded-full', fillClass(limit.utilization))}
            style={{ width: `${clamped}%` }}
          />
        </div>
      ) : (
        <div className="col-span-2 h-1.5 rounded-full bg-surface-overlay/70" aria-hidden="true" />
      )}
    </div>
  )
}

function ProviderUnavailable({ provider }: { provider: ProviderUsageEntry }): React.JSX.Element {
  const reasonLabel = provider.unavailableReason
    ? {
        'no-auth': `Sign in to ${provider.label} to view usage.`,
        'not-connected': `${provider.label} is not connected.`,
        'cli-not-found': `${provider.label}'s local CLI could not be found.`,
        'protocol-unsupported': `${provider.label} does not expose usage through its local protocol.`,
        'usage-unsupported': `${provider.label} does not currently provide usage data to Orpheus.`,
        error: `${provider.label} usage could not be loaded.`
      }[provider.unavailableReason]
    : null
  const reason =
    reasonLabel ||
    (!provider.configured
      ? `${provider.label} is not configured.`
      : provider.availability === 'available'
        ? `${provider.label} has not reported a usage window yet.`
        : `Usage data is not available from ${provider.label}.`)

  return (
    <div className="flex items-start gap-3 border border-border-default bg-surface-overlay/25 p-4">
      <WarningCircle
        size={20}
        weight="duotone"
        className="mt-0.5 shrink-0 text-text-muted"
        aria-hidden="true"
      />
      <div className="min-w-0">
        <div className="text-sm font-medium text-text-primary">Usage Unavailable</div>
        <div className="mt-0.5 text-sm leading-relaxed text-text-muted">{reason}</div>
      </div>
    </div>
  )
}

function LimitsSkeleton(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex flex-col gap-4"
      aria-busy="true"
      aria-label="Loading Provider Limits"
    >
      <div className="grid grid-cols-1 gap-2 min-[620px]:grid-cols-2 min-[920px]:grid-cols-3">
        {[0, 1, 2].map((item) => (
          <div key={item} className="h-14 rounded-none bg-surface-overlay" />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,320px))] justify-start gap-3">
        {[0, 1].map((item) => (
          <div key={item} className="h-[120px] rounded-none bg-surface-overlay" />
        ))}
      </div>
    </div>
  )
}

function ProviderSelector({
  providers,
  selectedProviderId,
  onSelect
}: {
  providers: ProviderUsageEntry[]
  selectedProviderId: string | null
  onSelect: (providerId: string) => void
}): React.JSX.Element {
  return (
    <div
      role="list"
      aria-label="Usage providers"
      className="grid w-full grid-cols-1 gap-2 min-[620px]:grid-cols-2 min-[920px]:grid-cols-3"
    >
      {providers.map((provider) => {
        const active = provider.providerId === selectedProviderId
        return (
          <div key={provider.providerId} role="listitem" className="min-w-0">
            <button
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(provider.providerId)}
              className={cn(
                'flex w-full min-w-0 items-center gap-3 rounded-none border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,color,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.98] motion-reduce:transform-none',
                active
                  ? 'border-accent bg-accent/8 text-text-primary'
                  : 'border-border-default bg-surface-raised text-text-secondary hover:bg-surface-overlay'
              )}
            >
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-md border',
                  active
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border-default bg-surface-overlay text-text-muted'
                )}
                aria-hidden="true"
              >
                <ProviderMark providerId={provider.providerId} size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">{provider.label}</span>
                <span className="truncate font-mono text-xs text-text-muted">
                  {providerStateLabel(provider)}
                </span>
              </span>
              {provider.availability === 'available' && !isStaleProvider(provider) ? (
                <CheckCircle
                  size={13}
                  weight="fill"
                  className="shrink-0 text-[color:var(--color-gh-open)]"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          </div>
        )
      })}
    </div>
  )
}

function SelectedProviderCard({ provider }: { provider: ProviderUsageEntry }): React.JSX.Element {
  const visibleLimits = provider.limits
  const hasWindows = provider.windows.length > 0
  const hasLimits = visibleLimits.length > 0
  const hasNoUsage = !hasWindows && !hasLimits
  const hasBothGroups = hasWindows && hasLimits

  return (
    <DashboardCard
      title={
        <span className="inline-flex items-center gap-2">
          <span className="text-text-muted" aria-hidden="true">
            <ProviderMark providerId={provider.providerId} size={14} />
          </span>
          {provider.label}
        </span>
      }
      meta={
        isStaleProvider(provider)
          ? providerStateLabel(provider)
          : provider.identityLabel || providerStateLabel(provider)
      }
    >
      {provider.availability !== 'available' || hasNoUsage ? (
        <ProviderUnavailable provider={provider} />
      ) : (
        <div
          className={cn(
            'grid grid-cols-1 gap-3',
            hasBothGroups && 'min-[900px]:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]'
          )}
        >
          {hasWindows ? (
            <div>
              <div className="mb-2 text-xs font-semibold text-text-secondary">Current Windows</div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
                {provider.windows.map((window) => (
                  <UsageMeter key={window.id} {...window} />
                ))}
              </div>
            </div>
          ) : null}

          {hasLimits ? (
            <div
              className={cn(
                'border-t border-border-default pt-3',
                hasBothGroups &&
                  'min-[900px]:border-t-0 min-[900px]:border-l min-[900px]:pt-0 min-[900px]:pl-3'
              )}
            >
              <div className="mb-2 text-xs font-semibold text-text-secondary">
                Additional Limits
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-2">
                {visibleLimits.map((limit) => (
                  <ModelLimitRow key={`${limit.id}-${limit.modelName}`} limit={limit} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </DashboardCard>
  )
}

export function LimitsTab({
  providers,
  loading,
  refreshing = false,
  refreshError,
  onRefresh
}: {
  providers: ProviderUsageEntry[]
  loading: boolean
  refreshing?: boolean
  refreshError?: string | null
  onRefresh: () => void
}): React.JSX.Element {
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const orderedProviders = providers
    .filter((provider) => providerOrder(provider) < 6)
    .sort((left, right) => providerOrder(left) - providerOrder(right))
  const selected =
    orderedProviders.find((provider) => provider.providerId === selectedProviderId) ??
    orderedProviders[0]

  if (loading && orderedProviders.length === 0) {
    return <LimitsSkeleton />
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold text-text-primary">Provider Limits</div>
          <div className="mt-0.5 text-sm text-text-muted">
            Current windows and reset times reported by each provider.
          </div>
        </div>
        <SourceRefreshButton refreshing={refreshing} onRefresh={onRefresh} />
      </div>

      {refreshError ? (
        <div
          role="status"
          className="rounded-md border border-border-default bg-surface-overlay px-3 py-2 text-sm text-text-muted"
        >
          Refresh failed. Showing the last available usage snapshot.
        </div>
      ) : null}

      {orderedProviders.length === 0 ? (
        <DashboardCard title="Not Configured">
          <div className="border border-border-default bg-surface-overlay/25 p-4 text-sm text-text-muted">
            No supported provider usage sources were returned.
          </div>
        </DashboardCard>
      ) : (
        <>
          <ProviderSelector
            providers={orderedProviders}
            selectedProviderId={selected?.providerId ?? null}
            onSelect={setSelectedProviderId}
          />

          {selected ? <SelectedProviderCard provider={selected} /> : null}
        </>
      )}
    </div>
  )
}
