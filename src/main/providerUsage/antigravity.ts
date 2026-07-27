import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ProviderUsageEntry,
  ProviderUsageLimit,
  ProviderUsageWindow
} from '../../shared/types'
import {
  fetchBoundedJson,
  finiteNumber,
  isoTimestamp,
  isRecord,
  PROVIDER_RESPONSE_LIMIT_BYTES,
  readKeychainPassword,
  strictFiniteNumber,
  trimmedString,
  unknownArray,
  unwrapGoKeyring
} from './runtime'

const ANTIGRAVITY_DEFINITION = { providerId: 'antigravity', label: 'Antigravity' } as const
const LS_SERVICE = 'exa.language_server_pb.LanguageServerService'
const LS_METADATA = {
  ideName: 'antigravity',
  extensionName: 'antigravity',
  ideVersion: 'unknown',
  locale: 'en'
}
const CLOUD_CODE_BASES = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
] as const
const CLOUD_PATHS = {
  models: '/v1internal:fetchAvailableModels',
  load: '/v1internal:loadCodeAssist',
  quota: '/v1internal:retrieveUserQuota',
  summary: '/v1internal:retrieveUserQuotaSummary'
} as const
const REFRESH_BUFFER_MS = 60 * 1_000
const LOCAL_PROBE_BUDGET_MS = 12_000
const REMOTE_REQUEST_TIMEOUT_MS = 8_000
const CLI_REFRESH_TIMEOUT_MS = 15_000
const CLI_REFRESH_OUTPUT_LIMIT_BYTES = 64 * 1_024
const CLI_REFRESH_COOLDOWN_MS = 60_000
const AUTH_FAILED_KIND = 'auth-failed' as const

const MODEL_BLACKLIST = new Set([
  'MODEL_CHAT_20706',
  'MODEL_CHAT_23310',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
  'MODEL_GOOGLE_GEMINI_2_5_PRO',
  'MODEL_PLACEHOLDER_M19',
  'MODEL_PLACEHOLDER_M9',
  'MODEL_PLACEHOLDER_M12'
])

const SUMMARY_BUCKETS = [
  { id: 'gemini-5h', label: 'Session · 5h', durationMinutes: 5 * 60 },
  { id: 'gemini-weekly', label: 'Weekly · 7d', durationMinutes: 7 * 24 * 60 },
  { id: '3p-5h', label: 'Claude · 5h', durationMinutes: 5 * 60 },
  { id: '3p-weekly', label: 'Claude Weekly · 7d', durationMinutes: 7 * 24 * 60 }
] as const

export type AntigravityCredential = {
  accessToken: string | null
  refreshToken: string | null
  expiry: string | null
}

export type AntigravityModelConfig = {
  label: string
  modelId: string | null
  remainingFraction: number
  resetsAt: string | null
}

export type AntigravityParsedUsage = {
  windows: ProviderUsageWindow[]
  plan: string | null
  authoritative: boolean
}

export type LanguageServerOptions = {
  processName: string
  markers: string[]
  csrfFlag: string
  portFlag: string | null
}

type DiscoveredLanguageServer = {
  csrf: string
  ports: number[]
  extensionPort: number | null
}

type LocalJsonResponse = {
  status: number
  value: unknown
}

type StrategyResult = {
  windows: ProviderUsageWindow[]
  plan: string | null
  authoritative: boolean
}

type CloudOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: typeof AUTH_FAILED_KIND }
  | { kind: 'unavailable' }

type CloudProbe =
  | { kind: 'success'; result: StrategyResult }
  | { kind: typeof AUTH_FAILED_KIND }
  | { kind: 'unavailable' }

type AntigravityProbeOutcome =
  | { kind: 'success'; result: StrategyResult }
  | {
      kind: 'missing' | 'unreadable' | 'invalid' | 'auth-expired' | 'unavailable'
    }

type KeychainCredentialResult =
  | { kind: 'found'; credential: AntigravityCredential }
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'invalid' }

let cliRefreshInFlight: Promise<boolean> | null = null
let lastCliRefreshAttemptAt = 0

function unavailable(reason: 'no-auth' | 'error', configured: boolean): ProviderUsageEntry {
  return {
    ...ANTIGRAVITY_DEFINITION,
    configured,
    enabled: configured,
    identityLabel: null,
    availability: 'unavailable',
    unavailableReason: reason,
    windows: [],
    limits: []
  }
}

function firstString(object: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = trimmedString(object[key])
    if (value) return value
  }
  return null
}

function tokenFromObject(object: Record<string, unknown>, depth = 0): AntigravityCredential | null {
  if (depth > 6) return null
  const source = isRecord(object['token']) ? object['token'] : object
  const accessToken = firstString(source, [
    'access_token',
    'accessToken',
    'token',
    'id_token',
    'idToken',
    'bearerToken',
    'auth_token',
    'authToken'
  ])
  const refreshToken = firstString(source, ['refresh_token', 'refreshToken'])
  const rawExpiry = firstString(source, ['expiry', 'expires_at', 'expiresAt'])
  const expiry = isoTimestamp(rawExpiry)
  if (accessToken || refreshToken) {
    return { accessToken, refreshToken, expiry: expiry || null }
  }
  for (const key of ['tokens', 'oauth', 'oauth2', 'credentials', 'auth']) {
    if (!isRecord(object[key])) continue
    const nested = tokenFromObject(object[key], depth + 1)
    if (nested) return nested
  }
  return null
}

/** Pure decoder for Antigravity/agy's go-keyring-wrapped credential. */
export function parseAntigravityCredential(raw: string): AntigravityCredential | null {
  const normalized = raw.replace(/^\uFEFF/, '').trim()
  const unwrapped = unwrapGoKeyring(normalized)
    ?.replace(/^\uFEFF/, '')
    .trim()
  if (!unwrapped) return null
  try {
    const json = JSON.parse(unwrapped) as unknown
    if (isRecord(json)) return tokenFromObject(json)
    const stringToken = trimmedString(json)
    return stringToken ? { accessToken: stringToken, refreshToken: null, expiry: null } : null
  } catch {
    if (unwrapped.startsWith('{') || unwrapped.startsWith('[')) return null
  }
  if (unwrapped.startsWith('Bearer ')) {
    const accessToken = trimmedString(unwrapped.slice('Bearer '.length))
    return accessToken ? { accessToken, refreshToken: null, expiry: null } : null
  }
  return { accessToken: unwrapped, refreshToken: null, expiry: null }
}

function quotaWindow(
  id: string,
  label: string,
  durationMinutes: number,
  fraction: number,
  resetsAt: unknown
): ProviderUsageWindow {
  const clamped = Math.max(0, Math.min(1, fraction))
  return {
    id,
    label,
    utilization: Math.round((1 - clamped) * 100),
    resetsAt: isoTimestamp(resetsAt),
    durationMinutes
  }
}

function summaryGroups(value: unknown): unknown[] | null {
  if (!isRecord(value)) return null
  const response = isRecord(value['response']) ? value['response'] : null
  return unknownArray(response?.['groups']) ?? unknownArray(value['groups'])
}

/** Exact-bucket parser for authoritative Antigravity quota summaries. */
export function parseAntigravityQuotaSummary(value: unknown): AntigravityParsedUsage | null {
  const groups = summaryGroups(value)
  if (!groups) return null
  const buckets = groups.flatMap((group) =>
    isRecord(group) ? (unknownArray(group['buckets']) ?? []) : []
  )
  const byId = new Map<string, { fraction: number; resetsAt: unknown }>()
  for (const bucket of buckets) {
    if (!isRecord(bucket)) continue
    const id = trimmedString(bucket['bucketId'])
    if (!id || byId.has(id) || !SUMMARY_BUCKETS.some((spec) => spec.id === id)) continue
    const fraction = strictFiniteNumber(bucket['remainingFraction'])
    if (fraction === null) continue
    byId.set(id, { fraction, resetsAt: bucket['resetTime'] })
  }
  return {
    windows: SUMMARY_BUCKETS.flatMap((spec) => {
      const bucket = byId.get(spec.id)
      return bucket
        ? [quotaWindow(spec.id, spec.label, spec.durationMinutes, bucket.fraction, bucket.resetsAt)]
        : []
    }),
    plan: null,
    authoritative: true
  }
}

export function antigravityPlanLabel(value: unknown): string | null {
  const raw = trimmedString(value)
  if (!raw) return null
  if (raw.startsWith('Google AI ')) {
    return titleCase(raw.slice('Google AI '.length))
  }
  for (const keyword of ['Ultra', 'Pro', 'Free']) {
    if (raw.toLowerCase().includes(keyword.toLowerCase())) return keyword
  }
  return titleCase(raw)
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1).toLowerCase()}`)
    .join(' ')
}

function legacyConfig(
  labelValue: unknown,
  modelIdValue: unknown,
  quotaValue: unknown
): AntigravityModelConfig | null {
  const label = trimmedString(labelValue)
  if (!label) return null
  const quota = isRecord(quotaValue) ? quotaValue : null
  return {
    label,
    modelId: trimmedString(modelIdValue),
    remainingFraction: strictFiniteNumber(quota?.['remainingFraction']) ?? 0,
    resetsAt: isoTimestamp(quota?.['resetTime'])
  }
}

export function parseAntigravityUserStatus(value: unknown): {
  plan: string | null
  configs: AntigravityModelConfig[]
} | null {
  if (!isRecord(value) || !isRecord(value['userStatus'])) return null
  const status = value['userStatus']
  const userTier = isRecord(status['userTier']) ? status['userTier'] : null
  const planStatus = isRecord(status['planStatus']) ? status['planStatus'] : null
  const planInfo = planStatus && isRecord(planStatus['planInfo']) ? planStatus['planInfo'] : null
  const cascade = isRecord(status['cascadeModelConfigData'])
    ? status['cascadeModelConfigData']
    : null
  const rawConfigs =
    cascade && Array.isArray(cascade['clientModelConfigs']) ? cascade['clientModelConfigs'] : []
  return {
    plan: antigravityPlanLabel(userTier?.['name'] ?? planInfo?.['planName']),
    configs: rawConfigs.flatMap((raw) => {
      if (!isRecord(raw)) return []
      const alias = isRecord(raw['modelOrAlias']) ? raw['modelOrAlias'] : null
      const config = legacyConfig(raw['label'], alias?.['model'], raw['quotaInfo'])
      return config ? [config] : []
    })
  }
}

export function parseAntigravityCommandConfigs(value: unknown): AntigravityModelConfig[] | null {
  if (!isRecord(value) || !Array.isArray(value['clientModelConfigs'])) return null
  return value['clientModelConfigs'].flatMap((raw) => {
    if (!isRecord(raw)) return []
    const alias = isRecord(raw['modelOrAlias']) ? raw['modelOrAlias'] : null
    const config = legacyConfig(raw['label'], alias?.['model'], raw['quotaInfo'])
    return config ? [config] : []
  })
}

export function parseAntigravityCloudModels(value: unknown): AntigravityModelConfig[] {
  if (!isRecord(value) || !isRecord(value['models'])) return []
  return Object.entries(value['models']).flatMap(([key, raw]) => {
    if (!isRecord(raw) || raw['isInternal'] === true) return []
    const label = trimmedString(raw['displayName']) ?? trimmedString(raw['label'])
    const config = legacyConfig(label, trimmedString(raw['model']) ?? key, raw['quotaInfo'])
    return config ? [config] : []
  })
}

export function parseAntigravityQuotaBuckets(value: unknown): AntigravityModelConfig[] {
  if (!isRecord(value) || !Array.isArray(value['buckets'])) return []
  return value['buckets'].flatMap((raw) => {
    if (!isRecord(raw)) return []
    const id = trimmedString(raw['modelId'])
    if (!id) return []
    return [
      {
        label: id,
        modelId: id,
        remainingFraction: strictFiniteNumber(raw['remainingFraction']) ?? 0,
        resetsAt: isoTimestamp(raw['resetTime'])
      }
    ]
  })
}

export function parseAntigravityLoadCodeAssist(value: unknown): {
  plan: string | null
  project: string | null
} {
  if (!isRecord(value)) return { plan: null, project: null }
  const paidTier = isRecord(value['paidTier']) ? value['paidTier'] : null
  const currentTier = isRecord(value['currentTier']) ? value['currentTier'] : null
  return {
    plan: antigravityPlanLabel(paidTier?.['name'] ?? currentTier?.['name']),
    project: trimmedString(value['cloudaicompanionProject'])
  }
}

function normalizeModelLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '').trim()
}

/** Legacy per-model quotas collapse to two 5-hour pools, worst remaining fraction wins. */
export function buildAntigravityPoolWindows(
  configs: AntigravityModelConfig[]
): ProviderUsageWindow[] {
  const pools = new Map<'gemini-5h' | '3p-5h', { fraction: number; resetsAt: string | null }>()
  for (const config of configs) {
    const label = normalizeModelLabel(config.label)
    if (!label || (config.modelId && MODEL_BLACKLIST.has(config.modelId))) continue
    const pool = label.toLowerCase().includes('gemini') ? 'gemini-5h' : '3p-5h'
    const existing = pools.get(pool)
    if (!existing || config.remainingFraction < existing.fraction) {
      pools.set(pool, {
        fraction: config.remainingFraction,
        resetsAt: config.resetsAt
      })
    }
  }
  return (['gemini-5h', '3p-5h'] as const).flatMap((id) => {
    const pool = pools.get(id)
    if (!pool) return []
    return [
      quotaWindow(
        id,
        id === 'gemini-5h' ? 'Session · 5h' : 'Claude · 5h',
        5 * 60,
        pool.fraction,
        pool.resetsAt
      )
    ]
  })
}

function argv0(command: string): string {
  const trimmed = command.trimStart()
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]
    const end = trimmed.indexOf(quote, 1)
    if (end > 0) return trimmed.slice(1, end)
  }
  return trimmed.split(/\s+/, 1)[0] ?? ''
}

export function extractProcessFlag(command: string, flag: string): string | null {
  const parts = command.split(/\s+/).filter(Boolean)
  const withEquals = `${flag}=`
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === flag) return parts[index + 1] ?? null
    if (parts[index]?.startsWith(withEquals)) return parts[index]?.slice(withEquals.length) || null
  }
  return null
}

function commandMatchesProcess(command: string, processName: string): boolean {
  const processNameLower = processName.toLowerCase()
  const executableName = pathBasename(argv0(command)).toLowerCase()
  if (executableName === processNameLower) return true
  const commandLower = command.toLowerCase()
  if (processNameLower.length >= 8) {
    return (
      executableName.startsWith(`${processNameLower}_`) || commandLower.includes(processNameLower)
    )
  }
  return (
    commandLower.endsWith(`/${processNameLower}`) ||
    commandLower.includes(`/${processNameLower} `) ||
    commandLower.includes(`/${processNameLower}\t`)
  )
}

function pathBasename(value: string): string {
  const parts = value.split('/')
  return parts.at(-1) ?? value
}

function markerRank(command: string, markers: string[]): number | null {
  if (markers.length === 0) return 0
  const normalizedMarkers = markers.map((marker) => marker.trim().toLowerCase()).filter(Boolean)
  const flagValues = ['--ide_name', '--override_ide_name', '--app_data_dir']
    .map((flag) => extractProcessFlag(command, flag)?.toLowerCase() ?? null)
    .filter((value): value is string => value !== null)
  if (flagValues.length > 0) {
    return normalizedMarkers.some((marker) => flagValues.includes(marker)) ? 0 : null
  }
  const commandLower = command.toLowerCase()
  return normalizedMarkers.some((marker) => commandLower.includes(`/${marker}/`)) ? 1 : null
}

export function rankLanguageServerCandidates(
  psOutput: string,
  options: LanguageServerOptions
): Array<{ pid: number; command: string }> {
  const ranked: Array<{ rank: number; pid: number; command: string }> = []
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim()
    const match = /^(\d+)\s+(.+)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[2] ?? ''
    if (
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !commandMatchesProcess(command, options.processName)
    ) {
      continue
    }
    const rank = markerRank(command, options.markers)
    if (rank !== null) ranked.push({ rank, pid, command })
  }
  return ranked
    .sort((left, right) => left.rank - right.rank)
    .map(({ pid, command }) => ({ pid, command }))
}

export function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>()
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('LISTEN')) continue
    for (const token of line.split(/\s+/).reverse()) {
      const match = /:(\d+)$/.exec(token)
      const port = match ? Number(match[1]) : null
      if (port !== null && Number.isInteger(port) && port > 0 && port < 65_536) {
        ports.add(port)
        break
      }
    }
  }
  return [...ports].sort((left, right) => left - right)
}

function runProcess(executable: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    childProcess.execFile(
      executable,
      args,
      { timeout: 5_000, maxBuffer: PROVIDER_RESPONSE_LIMIT_BYTES },
      (error, stdout) => resolve(error ? null : stdout)
    )
  })
}

function isExecutableFile(filePath: string): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveAntigravityCliExecutable({
  pathValue = process.env['PATH'] ?? '',
  homeDirectory = os.homedir(),
  isExecutable = isExecutableFile
}: {
  pathValue?: string
  homeDirectory?: string
  isExecutable?: (candidate: string) => boolean
} = {}): string | null {
  const pathDirectories = pathValue
    .split(path.delimiter)
    .map((directory) => directory.trim())
    .filter((directory) => path.isAbsolute(directory))
  const homeDirectories = path.isAbsolute(homeDirectory)
    ? [path.join(homeDirectory, '.local', 'bin'), path.join(homeDirectory, 'bin')]
    : []
  const candidates = [...new Set([...pathDirectories, ...homeDirectories])].map((directory) =>
    path.join(directory, 'agy')
  )
  return candidates.find(isExecutable) ?? null
}

function executeAntigravityCliRefresh(executable: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = childProcess.execFile(
      executable,
      args,
      {
        env: { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' },
        timeout: CLI_REFRESH_TIMEOUT_MS,
        maxBuffer: CLI_REFRESH_OUTPUT_LIMIT_BYTES,
        killSignal: 'SIGKILL',
        shell: false,
        windowsHide: true
      },
      (error) => resolve(error === null)
    )
    child.stdin?.end()
  })
}

async function runAntigravityCliRefresh(executable: string, args: string[]): Promise<boolean> {
  if (cliRefreshInFlight) return cliRefreshInFlight
  if (Date.now() - lastCliRefreshAttemptAt < CLI_REFRESH_COOLDOWN_MS) return false
  lastCliRefreshAttemptAt = Date.now()
  const attempt = executeAntigravityCliRefresh(executable, args)
  cliRefreshInFlight = attempt
  try {
    return await attempt
  } finally {
    if (cliRefreshInFlight === attempt) cliRefreshInFlight = null
  }
}

async function discoverLanguageServer(
  options: LanguageServerOptions
): Promise<DiscoveredLanguageServer | null> {
  const psOutput = await runProcess('/bin/ps', ['-ax', '-o', 'pid=,command='])
  if (!psOutput) return null
  const candidates = rankLanguageServerCandidates(psOutput, options).slice(0, 10)
  const lsofPath = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate))
  for (const candidate of candidates) {
    const csrf = options.csrfFlag ? extractProcessFlag(candidate.command, options.csrfFlag) : ''
    if (csrf === null) continue
    const rawExtensionPort = options.portFlag
      ? finiteNumber(extractProcessFlag(candidate.command, options.portFlag))
      : null
    const extensionPort =
      rawExtensionPort !== null &&
      Number.isInteger(rawExtensionPort) &&
      rawExtensionPort > 0 &&
      rawExtensionPort < 65_536
        ? rawExtensionPort
        : null
    const lsofOutput = lsofPath
      ? await runProcess(lsofPath, ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', `${candidate.pid}`])
      : null
    const ports = lsofOutput ? parseListeningPorts(lsofOutput) : []
    if (ports.length > 0 || extensionPort !== null) return { csrf, ports, extensionPort }
  }
  return null
}

function loopbackJsonRequest(
  scheme: 'http' | 'https',
  port: number,
  csrf: string,
  method: string,
  timeoutMs: number
): Promise<LocalJsonResponse | null> {
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536 || !/^[A-Za-z]+$/.test(method)) {
    return Promise.resolve(null)
  }
  const body = Buffer.from(JSON.stringify({ metadata: LS_METADATA }), 'utf8')
  const transport = scheme === 'https' ? https : http
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: LocalJsonResponse | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = transport.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/${LS_SERVICE}/${method}`,
        method: 'POST',
        // SECURITY: This exception is confined to the hard-coded 127.0.0.1 target above. Antigravity's
        // local language server uses an ephemeral self-signed certificate, so it has no CA to validate.
        // codeql[js/disabling-certificate-validation]
        rejectUnauthorized: scheme === 'https' ? false : undefined,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': csrf
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        let total = 0
        response.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > PROVIDER_RESPONSE_LIMIT_BYTES) {
            request.destroy()
            finish(null)
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          if (settled) return
          const raw = Buffer.concat(chunks, total).toString('utf8')
          let value: unknown = null
          try {
            value = raw ? (JSON.parse(raw) as unknown) : null
          } catch {
            value = null
          }
          finish({ status: response.statusCode ?? 0, value })
        })
      }
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy()
      finish(null)
    })
    request.on('error', () => finish(null))
    request.end(body)
  })
}

async function probeLanguageServer(options: LanguageServerOptions): Promise<StrategyResult | null> {
  const discovered = await discoverLanguageServer(options)
  if (!discovered) return null
  const deadline = Date.now() + LOCAL_PROBE_BUDGET_MS
  const endpoints: Array<{ scheme: 'http' | 'https'; port: number }> = []
  for (const port of discovered.ports.slice(0, 8)) {
    endpoints.push({ scheme: 'https', port }, { scheme: 'http', port })
  }
  if (discovered.extensionPort) {
    endpoints.push({ scheme: 'http', port: discovered.extensionPort })
  }
  const uniqueEndpoints = endpoints.filter(
    (endpoint, index) =>
      endpoints.findIndex(
        (candidate) => candidate.scheme === endpoint.scheme && candidate.port === endpoint.port
      ) === index
  )

  for (const endpoint of uniqueEndpoints) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const result = await probeLanguageServerEndpoint(endpoint, discovered.csrf, deadline)
    if (result) return result
  }
  return null
}

async function probeLanguageServerEndpoint(
  endpoint: { scheme: 'http' | 'https'; port: number },
  csrf: string,
  deadline: number
): Promise<StrategyResult | null> {
  const call = (method: string): Promise<LocalJsonResponse | null> =>
    loopbackJsonRequest(
      endpoint.scheme,
      endpoint.port,
      csrf,
      method,
      Math.min(4_000, Math.max(250, deadline - Date.now()))
    )
  const summary = await call('RetrieveUserQuotaSummary')
  if (summary && summary.status >= 200 && summary.status < 300) {
    const parsed = parseAntigravityQuotaSummary(summary.value)
    if (parsed) {
      const status = await call('GetUserStatus')
      const plan =
        status && status.status >= 200 && status.status < 300
          ? (parseAntigravityUserStatus(status.value)?.plan ?? null)
          : null
      return { ...parsed, plan }
    }
  }

  const status = await call('GetUserStatus')
  if (!status || status.status < 200 || status.status >= 300) return null
  const parsed = parseAntigravityUserStatus(status.value)
  if (parsed) {
    const windows = buildAntigravityPoolWindows(parsed.configs)
    if (windows.length > 0) {
      return { windows, plan: parsed.plan, authoritative: false }
    }
  }

  const fallback = await call('GetCommandModelConfigs')
  if (!fallback || fallback.status < 200 || fallback.status >= 300) return null
  const configs = parseAntigravityCommandConfigs(fallback.value)
  const windows = configs ? buildAntigravityPoolWindows(configs) : []
  return windows.length > 0 ? { windows, plan: null, authoritative: false } : null
}

async function readAntigravityCredential(): Promise<KeychainCredentialResult> {
  const result = await readKeychainPassword('gemini', 'antigravity')
  if (result.kind === 'missing') return result
  if (result.kind === 'unreadable') return result
  const credential = parseAntigravityCredential(result.value)
  return credential ? { kind: 'found', credential } : { kind: 'invalid' }
}

function accessTokenUsable(credential: AntigravityCredential): boolean {
  if (!credential.accessToken) return false
  if (!credential.expiry) return true
  return new Date(credential.expiry).getTime() > Date.now() + REFRESH_BUFFER_MS
}

async function cloudCode(
  pathValue: (typeof CLOUD_PATHS)[keyof typeof CLOUD_PATHS],
  token: string,
  userAgent: 'antigravity' | 'agy',
  body: Record<string, string>
): Promise<CloudOutcome> {
  for (const base of CLOUD_CODE_BASES) {
    const result = await fetchBoundedJson(
      `${base}${pathValue}`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'User-Agent': userAgent
        },
        body: JSON.stringify(body)
      },
      REMOTE_REQUEST_TIMEOUT_MS
    )
    if (result.kind === 'http' && (result.status === 401 || result.status === 403)) {
      return { kind: AUTH_FAILED_KIND }
    }
    if (result.kind === 'ok') return { kind: 'ok', value: result.value }
  }
  return { kind: 'unavailable' }
}

async function loadCloudPlan(token: string): Promise<string | null> {
  const response = await cloudCode(CLOUD_PATHS.load, token, 'agy', {})
  return response.kind === 'ok' ? parseAntigravityLoadCodeAssist(response.value).plan : null
}

async function fetchCloudCode(token: string): Promise<CloudProbe> {
  const summary = await cloudCode(CLOUD_PATHS.summary, token, 'antigravity', {})
  if (summary.kind === AUTH_FAILED_KIND) return summary
  if (summary.kind === 'ok') {
    const parsed = parseAntigravityQuotaSummary(summary.value)
    if (parsed) {
      return {
        kind: 'success',
        result: { ...parsed, plan: await loadCloudPlan(token) }
      }
    }
  }

  const models = await cloudCode(CLOUD_PATHS.models, token, 'antigravity', {})
  if (models.kind === AUTH_FAILED_KIND) return models
  if (models.kind === 'ok') {
    const windows = buildAntigravityPoolWindows(parseAntigravityCloudModels(models.value))
    if (windows.length > 0) {
      return {
        kind: 'success',
        result: { windows, plan: await loadCloudPlan(token), authoritative: false }
      }
    }
  }

  const load = await cloudCode(CLOUD_PATHS.load, token, 'agy', {})
  if (load.kind === AUTH_FAILED_KIND) return load
  const loaded =
    load.kind === 'ok' ? parseAntigravityLoadCodeAssist(load.value) : { plan: null, project: null }
  let quota = await cloudCode(
    CLOUD_PATHS.quota,
    token,
    'agy',
    loaded.project ? { project: loaded.project } : {}
  )
  if (quota.kind === 'unavailable' && loaded.project) {
    quota = await cloudCode(CLOUD_PATHS.quota, token, 'agy', {})
  }
  if (quota.kind === AUTH_FAILED_KIND) return quota
  if (quota.kind === 'ok') {
    const windows = buildAntigravityPoolWindows(parseAntigravityQuotaBuckets(quota.value))
    if (windows.length > 0) {
      return {
        kind: 'success',
        result: { windows, plan: loaded.plan, authoritative: false }
      }
    }
  }
  return { kind: 'unavailable' }
}

async function tryCloudTokens(tokens: string[]): Promise<{
  result: StrategyResult | null
  sawAuthFailure: boolean
}> {
  let sawAuthFailure = false
  for (const token of tokens) {
    const result = await fetchCloudCode(token)
    if (result.kind === 'success') {
      return { result: result.result, sawAuthFailure }
    }
    if (result.kind === AUTH_FAILED_KIND) sawAuthFailure = true
  }
  return { result: null, sawAuthFailure }
}

export async function refreshAntigravityCloudWithCli({
  executable,
  runCli,
  rereadCredential,
  retryCloud
}: {
  executable: string
  runCli: (executable: string, args: string[]) => Promise<boolean>
  rereadCredential: () => Promise<AntigravityCredential | null>
  retryCloud: (accessToken: string) => Promise<CloudProbe>
}): Promise<AntigravityProbeOutcome> {
  const commandCompleted = await runCli(executable, ['models'])
  const credential = await rereadCredential()
  if (!credential || !accessTokenUsable(credential) || !credential.accessToken) {
    return commandCompleted ? { kind: 'auth-expired' } : { kind: 'unavailable' }
  }
  const retry = await retryCloud(credential.accessToken)
  if (retry.kind === 'success') return retry
  return retry.kind === AUTH_FAILED_KIND ? { kind: 'auth-expired' } : retry
}

async function refreshAndRetryCloudWithInstalledCli(): Promise<AntigravityProbeOutcome> {
  const executable = resolveAntigravityCliExecutable()
  if (!executable) return { kind: 'unavailable' }
  return refreshAntigravityCloudWithCli({
    executable,
    runCli: runAntigravityCliRefresh,
    rereadCredential: async () => {
      const reread = await readAntigravityCredential()
      return reread.kind === 'found' ? reread.credential : null
    },
    retryCloud: fetchCloudCode
  })
}

async function probeCloudCode(): Promise<AntigravityProbeOutcome> {
  const keychain = await readAntigravityCredential()
  if (keychain.kind !== 'found') return keychain
  const credential = keychain.credential
  const tokens: string[] = []
  if (accessTokenUsable(credential) && credential.accessToken) tokens.push(credential.accessToken)
  const hasCredentials = tokens.length > 0 || credential.refreshToken !== null
  const attempted = await tryCloudTokens(tokens)
  if (attempted.result) return { kind: 'success', result: attempted.result }

  if ((attempted.sawAuthFailure || tokens.length === 0) && credential.refreshToken) {
    return refreshAndRetryCloudWithInstalledCli()
  }
  if (attempted.sawAuthFailure) return { kind: 'auth-expired' }
  return hasCredentials ? { kind: 'unavailable' } : { kind: 'missing' }
}

function entryFromStrategy(result: StrategyResult): ProviderUsageEntry {
  const limits: ProviderUsageLimit[] =
    result.windows.length === 0
      ? [
          {
            id: 'quota-data',
            label: 'Usage',
            utilization: null,
            resetsAt: null,
            modelName: null,
            valueKind: 'status',
            displayValue: 'No quota data'
          }
        ]
      : []
  return {
    ...ANTIGRAVITY_DEFINITION,
    configured: true,
    enabled: true,
    identityLabel: result.plan,
    availability: 'available',
    unavailableReason: null,
    windows: result.windows,
    limits
  }
}

/** Local-language-server-first Antigravity collector with keychain-backed cloud fallback. */
export async function collectAntigravityUsage(): Promise<ProviderUsageEntry> {
  const app = await probeLanguageServer({
    processName: 'language_server',
    markers: ['antigravity', 'antigravity-ide'],
    csrfFlag: '--csrf_token',
    portFlag: '--extension_server_port'
  })
  if (app) return entryFromStrategy(app)
  const cli = await probeLanguageServer({
    processName: 'agy',
    markers: [],
    csrfFlag: '',
    portFlag: null
  })
  if (cli) return entryFromStrategy(cli)

  const cloud = await probeCloudCode()
  if (cloud.kind === 'success') return entryFromStrategy(cloud.result)
  if (cloud.kind === 'missing') return unavailable('no-auth', false)
  if (cloud.kind === 'auth-expired') return unavailable('no-auth', true)
  return unavailable('error', true)
}
