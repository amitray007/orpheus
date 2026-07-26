import type {
  ProviderUsageLimit,
  ProviderUsageSnapshot,
  ProviderUsageWindow
} from '../../shared/types'
import { booleanValue } from './runtime'

type ParsedProviderUsage = {
  windows: ProviderUsageWindow[]
  limits: ProviderUsageLimit[]
}

export type ParsedLocalCredential = {
  token: string
  identityLabel: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function strictFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Select only public github.com entries from Copilot apps.json/hosts.json. */
export function parsePublicGithubCredential(value: unknown): ParsedLocalCredential | null {
  if (!isRecord(value)) return null
  for (const [entryKey, rawEntry] of Object.entries(value)) {
    const isPublicGithubEntry = entryKey === 'github.com' || entryKey.startsWith('github.com:')
    if (!isPublicGithubEntry || !isRecord(rawEntry)) continue
    const token = typeof rawEntry['oauth_token'] === 'string' ? rawEntry['oauth_token'].trim() : ''
    if (!token) continue
    const user = typeof rawEntry['user'] === 'string' ? rawEntry['user'].trim() : ''
    const login = typeof rawEntry['login'] === 'string' ? rawEntry['login'].trim() : ''
    return { token, identityLabel: user || login || null }
  }
  return null
}

export function markExpiredProviderUsageCache(
  value: ProviderUsageSnapshot,
  fetchedAt: number,
  now: number,
  ttlMs: number
): ProviderUsageSnapshot {
  if (Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs) return value
  return {
    ...value,
    providers: value.providers.map((provider) =>
      provider.availability === 'available' ? { ...provider, stale: true } : provider
    )
  }
}

function copilotResetTimestamp(body: Record<string, unknown>): string | null {
  return isoTimestamp(body['quota_reset_date']) ?? isoTimestamp(body['limited_user_reset_date'])
}

function copilotBucket(
  id: string,
  label: string,
  raw: unknown,
  resetsAt: string | null
): ProviderUsageWindow | null {
  if (!isRecord(raw)) return null
  const entitlement = finiteNumber(raw['entitlement'])
  const remaining = finiteNumber(raw['remaining'])
  if (
    booleanValue(raw['unlimited']) === true ||
    entitlement === -1 ||
    remaining === -1 ||
    entitlement === 0
  ) {
    return null
  }

  const percentRemaining = finiteNumber(raw['percent_remaining'])
  const utilization =
    percentRemaining !== null
      ? clampPercent(100 - percentRemaining)
      : entitlement !== null && entitlement > 0 && remaining !== null
        ? clampPercent(100 - (remaining / entitlement) * 100)
        : null
  if (utilization === null) return null

  return {
    id,
    label,
    utilization,
    resetsAt,
    durationMinutes: 30 * 24 * 60
  }
}

function legacyCopilotBucket(
  id: string,
  label: string,
  remaining: unknown,
  total: unknown,
  resetsAt: string | null
): ProviderUsageWindow | null {
  const remainingCount = finiteNumber(remaining)
  const totalCount = finiteNumber(total)
  if (remainingCount === null || totalCount === null || totalCount <= 0) return null
  return {
    id,
    label,
    utilization: clampPercent(((totalCount - remainingCount) / totalCount) * 100),
    resetsAt,
    durationMinutes: 30 * 24 * 60
  }
}

/** Pure normalization for GitHub's `/copilot_internal/user` response. */
export function parseCopilotUsage(value: unknown): ParsedProviderUsage | null {
  if (!isRecord(value)) return null
  const resetsAt = copilotResetTimestamp(value)
  const snapshots = isRecord(value['quota_snapshots']) ? value['quota_snapshots'] : null
  const windows = snapshots
    ? [
        copilotBucket(
          'premium-interactions',
          'Credits · monthly',
          snapshots['premium_interactions'],
          resetsAt
        ),
        copilotBucket('chat', 'Chat · monthly', snapshots['chat'], resetsAt),
        copilotBucket('completions', 'Completions · monthly', snapshots['completions'], resetsAt)
      ].filter((entry): entry is ProviderUsageWindow => entry !== null)
    : []

  if (windows.length === 0) {
    const limited = isRecord(value['limited_user_quotas']) ? value['limited_user_quotas'] : null
    const monthly = isRecord(value['monthly_quotas']) ? value['monthly_quotas'] : null
    if (limited && monthly) {
      windows.push(
        ...[
          legacyCopilotBucket('chat', 'Chat · monthly', limited['chat'], monthly['chat'], resetsAt),
          legacyCopilotBucket(
            'completions',
            'Completions · monthly',
            limited['completions'],
            monthly['completions'],
            resetsAt
          )
        ].filter((entry): entry is ProviderUsageWindow => entry !== null)
      )
    }
  }

  const limits: ProviderUsageLimit[] = []
  const premium =
    snapshots && isRecord(snapshots['premium_interactions'])
      ? snapshots['premium_interactions']
      : null
  const hasCreditsMeter = windows.some((window) => window.id === 'premium-interactions')
  if (hasCreditsMeter && premium && booleanValue(premium['overage_permitted']) === true) {
    const overage = Math.max(0, finiteNumber(premium['overage_count']) ?? 0)
    limits.push({
      id: 'extra-usage',
      label: 'Extra Usage',
      utilization: null,
      resetsAt: null,
      modelName: null,
      valueKind: 'count',
      displayValue: `${overage}`
    })
  }

  if (windows.length === 0 && booleanValue(value['token_based_billing']) === true) {
    limits.push({
      id: 'organization-managed',
      label: 'Usage',
      utilization: null,
      resetsAt: null,
      modelName: null,
      valueKind: 'status',
      displayValue: 'Organization-managed'
    })
  }

  return windows.length > 0 || limits.length > 0 ? { windows, limits } : null
}

/** Pure normalization for Grok CLI's credits-format billing response. */
export function parseGrokUsage(value: unknown): ParsedProviderUsage | null {
  if (!isRecord(value) || !isRecord(value['config'])) return null
  const config = value['config']
  if (!isRecord(config['currentPeriod'])) return null
  const period = config['currentPeriod']
  const periodType = typeof period['type'] === 'string' ? period['type'].trim() : ''
  const startsAt = isoTimestamp(period['start'])
  const resetsAt = isoTimestamp(period['end'])
  if (!periodType || !startsAt || !resetsAt) return null
  const durationMinutes =
    (new Date(resetsAt).getTime() - new Date(startsAt).getTime()) / (60 * 1_000)
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null

  const rawPercent = config['creditUsagePercent']
  const usedPercent = rawPercent === undefined ? 0 : finiteNumber(rawPercent)
  if (usedPercent === null) return null

  let onDemandCap = 0
  if (config['onDemandCap'] !== undefined) {
    if (!isRecord(config['onDemandCap'])) return null
    const parsedCap = finiteNumber(config['onDemandCap']['val'] ?? 0)
    if (parsedCap === null) return null
    onDemandCap = parsedCap
  }

  const windows: ProviderUsageWindow[] =
    periodType === 'USAGE_PERIOD_TYPE_WEEKLY'
      ? [
          {
            id: 'weekly',
            label: 'Weekly · 7d',
            utilization: clampPercent(usedPercent),
            resetsAt,
            durationMinutes
          }
        ]
      : []
  const limits: ProviderUsageLimit[] = [
    {
      id: 'pay-as-you-go',
      label: 'Pay as you go',
      utilization: null,
      resetsAt: null,
      modelName: null,
      valueKind: 'status',
      displayValue: onDemandCap > 0 ? `${onDemandCap} credit cap` : 'Disabled'
    }
  ]
  return { windows, limits }
}
