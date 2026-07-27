import type { ProviderUsageLimit, ProviderUsageWindow } from '../../shared/types'
import { clampPercent, finiteNumber, isRecord, isoTimestamp, trimmedString } from './runtime'

const BILLING_PERIOD_MINUTES = 30 * 24 * 60

export type ParsedCursorUsage = {
  windows: ProviderUsageWindow[]
  limits: ProviderUsageLimit[]
}

type BillingCycle = {
  resetsAt: string | null
  durationMinutes: number | null
}

function normalizeEpochMs(value: unknown): number | null {
  const parsed = finiteNumber(value)
  if (parsed === null || parsed <= 0) return null
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed
}

function cycleFromPrimary(usage: Record<string, unknown>): BillingCycle {
  const start = normalizeEpochMs(usage['billingCycleStart'])
  const end = normalizeEpochMs(usage['billingCycleEnd'])
  if (end === null) return { resetsAt: null, durationMinutes: BILLING_PERIOD_MINUTES }
  return {
    resetsAt: new Date(end).toISOString(),
    durationMinutes:
      start !== null && end > start ? (end - start) / (60 * 1_000) : BILLING_PERIOD_MINUTES
  }
}

function cycleFromFallback(
  summary: Record<string, unknown> | null,
  requestUsage: Record<string, unknown> | null
): BillingCycle {
  const start = isoTimestamp(summary?.['billingCycleStart'])
  const end = isoTimestamp(summary?.['billingCycleEnd'])
  if (start && end) {
    const durationMinutes = (new Date(end).getTime() - new Date(start).getTime()) / (60 * 1_000)
    if (durationMinutes > 0) return { resetsAt: end, durationMinutes }
  }

  const requestStart = isoTimestamp(requestUsage?.['startOfMonth'])
  if (!requestStart) return { resetsAt: null, durationMinutes: BILLING_PERIOD_MINUTES }
  return {
    resetsAt: new Date(
      new Date(requestStart).getTime() + BILLING_PERIOD_MINUTES * 60 * 1_000
    ).toISOString(),
    durationMinutes: BILLING_PERIOD_MINUTES
  }
}

function titleCaseWords(value: string | null): string | null {
  if (!value) return null
  return value
    .split(/\s+/)
    .map((word) => (word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : word))
    .join(' ')
}

export function parseCursorPlanName(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value['planInfo'])) return null
  return titleCaseWords(trimmedString(value['planInfo']['planName']))
}

function jwtPayload(token: string): Record<string, unknown> | null {
  if (token.length > 256 * 1024) return null
  const encoded = token.split('.')[1]
  if (!encoded) return null
  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const value = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as unknown
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

export function cursorTokenSubject(token: string | null): string | null {
  const subject = token ? trimmedString(jwtPayload(token)?.['sub']) : null
  return subject
}

export function cursorTokenExpirationMs(token: string | null): number | null {
  const expiration = token ? finiteNumber(jwtPayload(token)?.['exp']) : null
  return expiration === null ? null : expiration * 1_000
}

export function cursorSessionFromToken(token: string): { userId: string; cookie: string } | null {
  const subject = cursorTokenSubject(token)
  if (!subject) return null
  const parts = subject.split('|')
  const userId = (parts.length > 1 ? parts[1] : parts[0]).trim()
  return userId ? { userId, cookie: `WorkosCursorSessionToken=${userId}%3A%3A${token}` } : null
}

type CursorPrimaryFacts = {
  enabled: boolean
  hasPlanUsage: boolean
  limit: number | null
  totalPercentUsed: number | null
  teamByShape: boolean
}

function primaryFacts(usage: Record<string, unknown>): CursorPrimaryFacts {
  const planUsage = isRecord(usage['planUsage']) ? usage['planUsage'] : null
  const spend = isRecord(usage['spendLimitUsage']) ? usage['spendLimitUsage'] : null
  const spendLimitType = trimmedString(spend?.['limitType'])?.toLowerCase()
  return {
    enabled: usage['enabled'] !== false,
    hasPlanUsage: planUsage !== null,
    limit: finiteNumber(planUsage?.['limit']),
    totalPercentUsed: finiteNumber(planUsage?.['totalPercentUsed']),
    teamByShape: spendLimitType === 'team' || (finiteNumber(spend?.['pooledLimit']) ?? 0) > 0
  }
}

export function cursorPrimaryNeedsRestFallback(
  value: unknown,
  planName: string | null,
  planInfoUnavailable: boolean
): boolean {
  if (!isRecord(value)) return false
  const facts = primaryFacts(value)
  if (!facts.enabled) return false
  const normalizedPlan = planName?.trim().toLowerCase() ?? ''
  const planUsageUnusable = !facts.hasPlanUsage || facts.limit === null
  if (planUsageUnusable && (normalizedPlan === 'enterprise' || normalizedPlan === 'team')) {
    return true
  }
  if (
    planUsageUnusable &&
    facts.totalPercentUsed === null &&
    normalizedPlan === '' &&
    planInfoUnavailable
  ) {
    return true
  }
  if (facts.teamByShape && facts.limit === null) return true
  return facts.hasPlanUsage && facts.limit === null && facts.totalPercentUsed === null
}

function percentWindow(
  id: string,
  label: string,
  utilization: number,
  cycle: BillingCycle
): ProviderUsageWindow {
  return {
    id,
    label,
    utilization: clampPercent(utilization),
    resetsAt: cycle.resetsAt,
    durationMinutes: cycle.durationMinutes
  }
}

function formatDollarsFromCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })
}

function currencyLimit(
  id: string,
  label: string,
  usedCents: number,
  limitCents: number | null,
  cycle: BillingCycle
): ProviderUsageLimit {
  const displayValue =
    limitCents !== null && limitCents > 0
      ? `${formatDollarsFromCents(usedCents)} / ${formatDollarsFromCents(limitCents)}`
      : formatDollarsFromCents(usedCents)
  return {
    id,
    label,
    utilization:
      limitCents !== null && limitCents > 0 ? clampPercent((usedCents / limitCents) * 100) : null,
    resetsAt: cycle.resetsAt,
    modelName: null,
    valueKind: 'currency',
    displayValue
  }
}

function positiveReportedOrInferred(
  bucket: Record<string, unknown>,
  limit: number,
  remaining: number
): number {
  const reported = [
    finiteNumber(bucket['individualUsed']),
    finiteNumber(bucket['pooledUsed']),
    finiteNumber(bucket['totalSpend']),
    finiteNumber(bucket['used'])
  ].filter((value): value is number => value !== null)
  const positive = reported.find((value) => value > 0)
  if (positive !== undefined) return positive
  const inferred = Math.max(0, limit - remaining)
  return inferred > 0 ? inferred : (reported[0] ?? 0)
}

function appendCredits(
  creditGrants: unknown,
  stripeBalance: unknown,
  limits: ProviderUsageLimit[]
): void {
  const grants = isRecord(creditGrants) ? creditGrants : null
  const hasGrants = grants?.['hasCreditGrants'] === true
  const grantTotal = hasGrants ? (finiteNumber(grants?.['totalCents']) ?? 0) : 0
  const grantUsed = hasGrants ? (finiteNumber(grants?.['usedCents']) ?? 0) : 0
  const stripe = isRecord(stripeBalance) ? finiteNumber(stripeBalance['customerBalance']) : null
  const prepaid = stripe !== null && stripe < 0 ? Math.abs(stripe) : 0
  const combined = (grantTotal > 0 ? grantTotal : 0) + prepaid
  if (combined <= 0) return

  limits.push({
    id: 'credits',
    label: 'Credits',
    utilization: null,
    resetsAt: null,
    modelName: null,
    valueKind: 'currency',
    displayValue: `${formatDollarsFromCents(Math.max(0, combined - grantUsed))} left`
  })
}

function appendOnDemand(
  bucketValue: unknown,
  cycle: BillingCycle,
  limits: ProviderUsageLimit[]
): boolean {
  if (!isRecord(bucketValue) || bucketValue['enabled'] === false) return false
  const limit =
    finiteNumber(bucketValue['individualLimit']) ??
    finiteNumber(bucketValue['pooledLimit']) ??
    finiteNumber(bucketValue['limit'])
  const remaining =
    finiteNumber(bucketValue['individualRemaining']) ??
    finiteNumber(bucketValue['pooledRemaining']) ??
    finiteNumber(bucketValue['remaining']) ??
    limit ??
    0
  const used = positiveReportedOrInferred(bucketValue, limit ?? 0, remaining)
  if ((limit ?? 0) <= 0 && used <= 0) return false
  limits.push(currencyLimit('on-demand', 'On-Demand', Math.max(0, used), limit, cycle))
  return true
}

export function parseCursorPrimaryUsage({
  usage,
  planName,
  creditGrants,
  stripeBalance
}: {
  usage: unknown
  planName: string | null
  creditGrants?: unknown
  stripeBalance?: unknown
}): ParsedCursorUsage | null {
  if (!isRecord(usage)) return null
  const facts = primaryFacts(usage)
  if (!facts.enabled || !isRecord(usage['planUsage'])) return null

  const planUsage = usage['planUsage']
  const cycle = cycleFromPrimary(usage)
  const windows: ProviderUsageWindow[] = []
  const limits: ProviderUsageLimit[] = []
  appendCredits(creditGrants, stripeBalance, limits)

  const normalizedPlan = planName?.toLowerCase() ?? ''
  const isTeam = normalizedPlan === 'team' || facts.teamByShape
  const limitCents = facts.limit
  const remainingCents = finiteNumber(planUsage['remaining']) ?? limitCents ?? 0
  const usedCents =
    finiteNumber(planUsage['totalSpend']) ?? Math.max(0, (limitCents ?? 0) - remainingCents)
  const computedPercent =
    limitCents !== null && limitCents > 0 ? (usedCents / limitCents) * 100 : null
  const totalPercent = isTeam ? computedPercent : (facts.totalPercentUsed ?? computedPercent)

  if (totalPercent !== null) {
    const label =
      isTeam && limitCents !== null
        ? `Total Usage · ${formatDollarsFromCents(usedCents)} / ${formatDollarsFromCents(limitCents)}`
        : 'Total Usage'
    windows.push(percentWindow('total-usage', label, totalPercent, cycle))
  }

  const auto = finiteNumber(planUsage['autoPercentUsed'])
  if (auto !== null) windows.push(percentWindow('auto-usage', 'Auto Usage', auto, cycle))
  const api = finiteNumber(planUsage['apiPercentUsed'])
  if (api !== null) windows.push(percentWindow('api-usage', 'API Usage', api, cycle))

  if (isRecord(usage['spendLimitUsage'])) {
    appendOnDemand(usage['spendLimitUsage'], cycle, limits)
  }
  return windows.length > 0 || limits.length > 0 ? { windows, limits } : null
}

function summaryDollarBucket(value: unknown): {
  used: number
  limit: number
} | null {
  if (!isRecord(value) || value['enabled'] === false) return null
  const limit = finiteNumber(value['limit'])
  if (limit === null || limit <= 0) return null
  const remaining = finiteNumber(value['remaining']) ?? limit
  return {
    used: Math.max(0, positiveReportedOrInferred(value, limit, remaining)),
    limit
  }
}

function appendRequestAllowance(
  requestRecord: Record<string, unknown> | null,
  cycle: BillingCycle,
  windows: ProviderUsageWindow[],
  limits: ProviderUsageLimit[]
): void {
  const requests = requestRecord && isRecord(requestRecord['gpt-4']) ? requestRecord['gpt-4'] : null
  const requestLimit = finiteNumber(requests?.['maxRequestUsage'])
  if (requestLimit === null || requestLimit <= 0) return

  const requestUsed = Math.max(
    0,
    finiteNumber(requests?.['numRequests']) ?? finiteNumber(requests?.['numRequestsTotal']) ?? 0
  )
  windows.push(
    percentWindow(
      'total-usage',
      `Total Usage · ${requestUsed} / ${requestLimit} requests`,
      (requestUsed / requestLimit) * 100,
      cycle
    )
  )
  limits.push({
    id: 'requests',
    label: 'Requests',
    utilization: clampPercent((requestUsed / requestLimit) * 100),
    resetsAt: cycle.resetsAt,
    modelName: null,
    valueKind: 'count',
    displayValue: `${requestUsed} / ${requestLimit}`
  })
}

function appendFallbackTotal(
  summaryRecord: Record<string, unknown> | null,
  individual: Record<string, unknown> | null,
  team: Record<string, unknown> | null,
  plan: Record<string, unknown> | null,
  cycle: BillingCycle,
  windows: ProviderUsageWindow[]
): void {
  const limitType = trimmedString(summaryRecord?.['limitType'])?.toLowerCase()
  const preferredDollar =
    limitType === 'team'
      ? summaryDollarBucket(team?.['pooled'])
      : (summaryDollarBucket(individual?.['overall']) ?? summaryDollarBucket(team?.['pooled']))
  const totalPercent = finiteNumber(plan?.['totalPercentUsed'])
  if (preferredDollar) {
    windows.push(
      percentWindow(
        'total-usage',
        `Total Usage · ${formatDollarsFromCents(preferredDollar.used)} / ${formatDollarsFromCents(preferredDollar.limit)}`,
        (preferredDollar.used / preferredDollar.limit) * 100,
        cycle
      )
    )
  } else if (totalPercent !== null) {
    windows.push(percentWindow('total-usage', 'Total Usage', totalPercent, cycle))
  }
}

export function parseCursorFallbackUsage({
  summary,
  requestUsage
}: {
  summary: unknown
  requestUsage: unknown
}): ParsedCursorUsage | null {
  const summaryRecord = isRecord(summary) ? summary : null
  const requestRecord = isRecord(requestUsage) ? requestUsage : null
  const cycle = cycleFromFallback(summaryRecord, requestRecord)
  const windows: ProviderUsageWindow[] = []
  const limits: ProviderUsageLimit[] = []
  appendRequestAllowance(requestRecord, cycle, windows, limits)

  const individual =
    summaryRecord && isRecord(summaryRecord['individualUsage'])
      ? summaryRecord['individualUsage']
      : null
  const team =
    summaryRecord && isRecord(summaryRecord['teamUsage']) ? summaryRecord['teamUsage'] : null
  const plan = individual && isRecord(individual['plan']) ? individual['plan'] : null

  if (windows.length === 0) {
    appendFallbackTotal(summaryRecord, individual, team, plan, cycle, windows)
  }

  const auto = finiteNumber(plan?.['autoPercentUsed'])
  if (auto !== null) windows.push(percentWindow('auto-usage', 'Auto Usage', auto, cycle))
  const api = finiteNumber(plan?.['apiPercentUsed'])
  if (api !== null) windows.push(percentWindow('api-usage', 'API Usage', api, cycle))

  if (!appendOnDemand(individual?.['onDemand'], cycle, limits)) {
    appendOnDemand(team?.['onDemand'], cycle, limits)
  }
  return windows.length > 0 || limits.length > 0 ? { windows, limits } : null
}
