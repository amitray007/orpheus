import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DASHBOARD_CACHE_KEYS, readDashboardCache, writeDashboardCache } from './db/dashboardCache'
import { getClaudeUsage } from './claudeUsage'
import { collectAntigravityUsage } from './providerUsage/antigravity'
import { collectCopilotUsage } from './providerUsage/copilot'
import { collectCursorUsage } from './providerUsage/cursor'
import { collectGrokUsage } from './providerUsage/grok'
import { markExpiredProviderUsageCache, strictFiniteNumber } from './providerUsage/parsers'
import { getUserShellPath } from './shellHelpers'
import type {
  ClaudeUsage,
  ProviderUsageEntry,
  ProviderUsageSnapshot,
  ProviderUsageUnavailableReason,
  ProviderUsageWindow
} from '../shared/types'

const USAGE_TTL_MS = 3 * 60 * 1000
const CODEX_TIMEOUT_MS = 7_000
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024

type ProviderDefinition = {
  providerId: 'claude' | 'codex' | 'cursor' | 'xai' | 'copilot' | 'antigravity'
  label: string
}

const PROVIDERS: readonly ProviderDefinition[] = [
  { providerId: 'claude', label: 'Claude' },
  { providerId: 'codex', label: 'Codex' },
  { providerId: 'cursor', label: 'Cursor' },
  { providerId: 'xai', label: 'Grok' },
  { providerId: 'copilot', label: 'GitHub Copilot' },
  { providerId: 'antigravity', label: 'Antigravity' }
]

type RawCodexWindow = {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

type RawCodexRateLimit = {
  limitId?: string | null
  limitName?: string | null
  primary?: RawCodexWindow | null
  secondary?: RawCodexWindow | null
}

type RawCodexRateLimitsResponse = {
  rateLimits?: RawCodexRateLimit
  rateLimitsByLimitId?: Record<string, RawCodexRateLimit> | null
}

type CodexReadResult =
  | { ok: true; value: RawCodexRateLimitsResponse }
  | { ok: false; reason: ProviderUsageUnavailableReason }

let cached: { value: ProviderUsageSnapshot; fetchedAt: number } | null = null
let inflight: Promise<ProviderUsageSnapshot> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function unavailableEntry(
  definition: ProviderDefinition,
  reason: ProviderUsageUnavailableReason,
  configured = false,
  availability: ProviderUsageEntry['availability'] = 'unavailable',
  identityLabel: string | null = null
): ProviderUsageEntry {
  return {
    ...definition,
    configured,
    enabled: configured,
    identityLabel,
    availability,
    unavailableReason: reason,
    windows: [],
    limits: []
  }
}

function readTextFileBounded(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CREDENTIAL_FILE_BYTES) return null
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function parseJsonFile(filePath: string): unknown {
  const text = readTextFileBounded(filePath)
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function readKeychainPassword(service: string, account?: string): Promise<string | null> {
  const args = ['find-generic-password', '-s', service]
  if (account) args.push('-a', account)
  args.push('-w')
  return new Promise((resolve) => {
    childProcess.execFile(
      'security',
      args,
      { timeout: 3_000, maxBuffer: MAX_CREDENTIAL_FILE_BYTES },
      (error, stdout) => {
        resolve(error ? null : trimmedString(stdout))
      }
    )
  })
}

function resetTimestamp(epoch: number | null | undefined): string | null {
  if (typeof epoch !== 'number' || !Number.isFinite(epoch)) return null
  const epochMs = epoch > 10_000_000_000 ? epoch : epoch * 1_000
  const date = new Date(epochMs)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function durationLabel(durationMinutes: number | null): string {
  if (durationMinutes === null) return 'Usage window'
  if (durationMinutes <= 6 * 60) return `Session · ${Math.round(durationMinutes / 60)}h`
  if (durationMinutes >= 6 * 24 * 60 && durationMinutes <= 8 * 24 * 60) {
    return `Weekly · ${Math.round(durationMinutes / (24 * 60))}d`
  }
  if (durationMinutes % (7 * 24 * 60) === 0) {
    const weeks = durationMinutes / (7 * 24 * 60)
    return `${weeks} week${weeks === 1 ? '' : 's'}`
  }
  if (durationMinutes % (24 * 60) === 0) {
    const days = durationMinutes / (24 * 60)
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (durationMinutes % 60 === 0) {
    const hours = durationMinutes / 60
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${durationMinutes} minutes`
}

function duplicatesPrimaryClaudeWindow(limit: ClaudeUsage['limits'][number]): boolean {
  if (limit.modelName !== null) return false
  const primaryWindowKeys = new Set(['session', 'fivehour', 'weekly', 'sevenday', 'weeklyall'])
  return [limit.kind, limit.group].some((value) =>
    primaryWindowKeys.has(value.toLowerCase().replace(/[^a-z0-9]/g, ''))
  )
}

async function collectClaude(force: boolean): Promise<ProviderUsageEntry> {
  const definition = PROVIDERS[0]
  const result = await getClaudeUsage(force)
  if ('unavailable' in result) {
    return unavailableEntry(definition, result.unavailable, result.unavailable !== 'no-auth')
  }

  const usage: ClaudeUsage = result
  const windows: ProviderUsageWindow[] = [
    {
      id: 'five-hour',
      label: 'Session · 5h',
      utilization:
        usage.fiveHour.utilization === null ? null : clampPercent(usage.fiveHour.utilization),
      resetsAt: usage.fiveHour.resetsAt,
      durationMinutes: 5 * 60
    },
    {
      id: 'seven-day',
      label: 'Weekly · 7d',
      utilization:
        usage.sevenDay.utilization === null ? null : clampPercent(usage.sevenDay.utilization),
      resetsAt: usage.sevenDay.resetsAt,
      durationMinutes: 7 * 24 * 60
    }
  ]
  return {
    ...definition,
    configured: true,
    enabled: true,
    identityLabel: null,
    availability: 'available',
    unavailableReason: null,
    windows,
    limits: usage.limits
      .filter((limit) => !duplicatesPrimaryClaudeWindow(limit))
      .map((limit, index) => ({
        id: `${limit.kind || 'limit'}-${limit.group || index}`,
        label: limit.group || limit.kind || 'Custom limit',
        utilization: limit.percentKnown ? clampPercent(limit.percent) : null,
        resetsAt: limit.resetsAt,
        modelName: limit.modelName,
        valueKind: 'percent'
      }))
  }
}

async function resolveCodexPath(): Promise<string> {
  try {
    return (await getUserShellPath()) || process.env['PATH'] || ''
  } catch {
    return process.env['PATH'] || ''
  }
}

async function readCodexRateLimits(): Promise<CodexReadResult> {
  const pathEnv = await resolveCodexPath()
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let outputBytes = 0
    let requestedRateLimits = false
    const child = childProcess.spawn('codex', ['app-server', '--stdio'], {
      cwd: os.homedir(),
      env: { ...process.env, PATH: pathEnv },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const finish = (result: CodexReadResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(result)
    }

    const timer = setTimeout(() => finish({ ok: false, reason: 'error' }), CODEX_TIMEOUT_MS)

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, reason: error.code === 'ENOENT' ? 'cli-not-found' : 'error' })
    })
    child.on('exit', () => {
      if (!settled) finish({ ok: false, reason: 'error' })
    })
    child.stdin.on('error', () => finish({ ok: false, reason: 'error' }))
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_RESPONSE_BYTES) finish({ ok: false, reason: 'error' })
    })
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_RESPONSE_BYTES) {
        finish({ ok: false, reason: 'error' })
        return
      }
      stdout += chunk.toString('utf8')
      let newline = stdout.indexOf('\n')
      while (newline !== -1) {
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        newline = stdout.indexOf('\n')
        if (!line) continue
        let message: { id?: number; result?: unknown; error?: { code?: number } }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        if (message.id === 1 && message.result !== undefined && !requestedRateLimits) {
          requestedRateLimits = true
          child.stdin.write(`${JSON.stringify({ method: 'account/rateLimits/read', id: 2 })}\n`)
        } else if (message.id === 2 && message.error) {
          finish({
            ok: false,
            reason: message.error.code === -32601 ? 'protocol-unsupported' : 'error'
          })
        } else if (message.id === 2 && message.result !== undefined) {
          finish({ ok: true, value: message.result as RawCodexRateLimitsResponse })
        }
      }
    })

    child.stdin.write(
      `${JSON.stringify({
        method: 'initialize',
        id: 1,
        params: {
          clientInfo: { name: 'orpheus', title: 'Orpheus', version: '1' },
          capabilities: { experimentalApi: true, requestAttestation: false }
        }
      })}\n`
    )
  })
}

function codexWindows(raw: RawCodexRateLimitsResponse): ProviderUsageWindow[] {
  const buckets =
    raw.rateLimitsByLimitId && Object.keys(raw.rateLimitsByLimitId).length > 0
      ? Object.entries(raw.rateLimitsByLimitId)
      : raw.rateLimits
        ? [[raw.rateLimits.limitId || 'codex', raw.rateLimits] as const]
        : []

  return buckets.flatMap(([bucketId, bucket]) => {
    const availableWindows = (['primary', 'secondary'] as const).flatMap((position) => {
      const value = bucket[position]
      const usedPercent = strictFiniteNumber(value?.usedPercent)
      return value && usedPercent !== null ? [{ position, value, usedPercent }] : []
    })
    const suppliedName = bucket.limitName?.trim() || null
    const bucketPrefix = suppliedName ?? (bucketId === 'codex' ? null : bucketId)
    return availableWindows.map(({ position, value: window, usedPercent }) => {
      const parsedDuration = strictFiniteNumber(window.windowDurationMins)
      const duration = parsedDuration !== null && parsedDuration > 0 ? parsedDuration : null
      const label = durationLabel(duration)
      return {
        id: `${bucketId}-${position}`,
        label: [bucketPrefix, label].filter((part): part is string => part !== null).join(' · '),
        utilization: clampPercent(usedPercent),
        resetsAt: resetTimestamp(window.resetsAt),
        durationMinutes: duration
      }
    })
  })
}

function codexAuthObjectHasAccessToken(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value['tokens'])) return false
  return trimmedString(value['tokens']['access_token']) !== null
}

async function hasCodexCredential(): Promise<boolean> {
  const configuredHome = trimmedString(process.env['CODEX_HOME'])
  const authPaths = configuredHome
    ? [path.join(configuredHome, 'auth.json')]
    : [
        path.join(os.homedir(), '.config', 'codex', 'auth.json'),
        path.join(os.homedir(), '.codex', 'auth.json')
      ]
  if (authPaths.some((authPath) => codexAuthObjectHasAccessToken(parseJsonFile(authPath)))) {
    return true
  }
  const keychain = await readKeychainPassword('Codex Auth')
  if (!keychain) return false
  try {
    return codexAuthObjectHasAccessToken(JSON.parse(keychain) as unknown)
  } catch {
    return false
  }
}

async function collectCodex(): Promise<ProviderUsageEntry> {
  const definition = PROVIDERS[1]
  const [configured, result] = await Promise.all([hasCodexCredential(), readCodexRateLimits()])
  if (!result.ok) {
    const reason = !configured ? 'no-auth' : result.reason
    return unavailableEntry(
      definition,
      reason,
      configured,
      reason === 'protocol-unsupported' ? 'unsupported' : 'unavailable'
    )
  }
  const windows = codexWindows(result.value)
  return windows.length > 0
    ? {
        ...definition,
        configured: true,
        enabled: true,
        identityLabel: null,
        availability: 'available',
        unavailableReason: null,
        windows,
        limits: []
      }
    : unavailableEntry(definition, 'error', true)
}

function normalizeCachedSnapshot(value: ProviderUsageSnapshot): ProviderUsageSnapshot {
  const providers = PROVIDERS.map((definition) => {
    const existing = value.providers.find(
      (provider) => provider.providerId === definition.providerId
    )
    if (!existing) return unavailableEntry(definition, 'no-auth')
    return {
      ...existing,
      providerId: definition.providerId,
      label: definition.label,
      windows: Array.isArray(existing.windows) ? existing.windows : [],
      limits: Array.isArray(existing.limits) ? existing.limits : []
    }
  })
  return { providers, fetchedAt: value.fetchedAt }
}

function readFixedCache(): { value: ProviderUsageSnapshot; fetchedAt: number } | null {
  const stored = readDashboardCache<ProviderUsageSnapshot>(DASHBOARD_CACHE_KEYS.providerUsage)
  if (!stored || !stored.value || !Array.isArray(stored.value.providers)) return null
  const cachedIds = new Set(stored.value.providers.map((provider) => provider.providerId))
  if (
    stored.value.providers.length !== PROVIDERS.length ||
    PROVIDERS.some((provider) => !cachedIds.has(provider.providerId))
  ) {
    return null
  }
  const value = normalizeCachedSnapshot(stored.value)
  return {
    ...stored,
    value: markExpiredProviderUsageCache(value, stored.fetchedAt, Date.now(), USAGE_TTL_MS)
  }
}

function retainLastGoodProvider(
  current: ProviderUsageEntry,
  previous: ProviderUsageEntry | undefined
): ProviderUsageEntry {
  if (
    current.availability !== 'unavailable' ||
    current.unavailableReason !== 'error' ||
    previous?.availability !== 'available'
  ) {
    return current
  }
  const knownIdentityChanged =
    current.identityLabel !== null &&
    previous.identityLabel !== null &&
    current.identityLabel !== previous.identityLabel
  if (knownIdentityChanged) return current
  return {
    ...previous,
    configured: current.configured,
    enabled: current.enabled,
    identityLabel: current.identityLabel ?? previous.identityLabel,
    stale: true
  }
}

async function fetchProviderUsage(force: boolean): Promise<ProviderUsageSnapshot> {
  const collectors = [
    () => collectClaude(force),
    collectCodex,
    collectCursorUsage,
    collectGrokUsage,
    collectCopilotUsage,
    collectAntigravityUsage
  ] as const
  const settled = await Promise.allSettled(
    collectors.map((collector) => Promise.resolve(collector()))
  )
  const providers = settled.map((result, index): ProviderUsageEntry => {
    if (result.status === 'fulfilled') return result.value
    return unavailableEntry(PROVIDERS[index], 'error')
  })
  return { providers, fetchedAt: Date.now() }
}

export async function getProviderUsage(force = false): Promise<ProviderUsageSnapshot> {
  const now = Date.now()
  if (!force && cached && now - cached.fetchedAt < USAGE_TTL_MS) return cached.value
  if (inflight) return inflight

  const promise = (async (): Promise<ProviderUsageSnapshot> => {
    const previous = cached?.value ?? readFixedCache()?.value ?? null
    const fresh = await fetchProviderUsage(force)
    const value = {
      ...fresh,
      providers: fresh.providers.map((provider) =>
        retainLastGoodProvider(
          provider,
          previous?.providers.find((candidate) => candidate.providerId === provider.providerId)
        )
      )
    }
    cached = { value, fetchedAt: Date.now() }
    writeDashboardCache(DASHBOARD_CACHE_KEYS.providerUsage, value)
    return value
  })().finally(() => {
    inflight = null
  })
  inflight = promise
  return promise
}

export function getCachedProviderUsage(): {
  value: ProviderUsageSnapshot
  fetchedAt: number
} | null {
  return readFixedCache()
}
