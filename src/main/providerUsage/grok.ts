import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ProviderUsageEntry, ProviderUsageUnavailableReason } from '../../shared/types'
import { parseGrokUsage } from './parsers'
import {
  fetchBoundedJson,
  finiteNumber,
  isRecord,
  readBoundedText,
  trimmedString,
  type JsonHttpResult
} from './runtime'

const GROK_CREDITS_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
const GROK_SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings'
const GROK_REFRESH_URL = 'https://auth.x.ai/oauth2/token'
const GROK_TOKEN_AUTH_HEADER = 'xai-grok-cli'
const GROK_DEFAULT_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1_000
const MAX_GROK_AUTH_CANDIDATES = 8
const MAX_CREDENTIAL_CHARS = 256 * 1024

type GrokFetch = typeof fetchBoundedJson

type GrokAuthCandidate = {
  authPath: string
  entryKey: string
  entry: Record<string, unknown>
  token: string
  identityLabel: string | null
}

type GrokRefresh = {
  accessToken: string
  refreshToken: string | null
  idToken: string | null
  expiresAt: string
}

type GrokCandidateResult =
  | { kind: 'available'; entry: ProviderUsageEntry }
  | { kind: 'auth-failed' }
  | { kind: 'request-failed' }

type GrokAuthLoadResult =
  | { kind: 'found'; candidates: GrokAuthCandidate[] }
  | { kind: 'missing' }
  | { kind: 'invalid' }

export type GrokCollectorDependencies = {
  homeDir?: string
  grokHome?: string | null
  now?: () => number
  fetchJson?: GrokFetch
  authPath?: string
}

function unavailableGrok(
  reason: ProviderUsageUnavailableReason,
  configured: boolean,
  identityLabel: string | null = null
): ProviderUsageEntry {
  return {
    providerId: 'xai',
    label: 'Grok',
    configured,
    enabled: configured,
    identityLabel,
    availability: 'unavailable',
    unavailableReason: reason,
    windows: [],
    limits: []
  }
}

function credentialString(value: unknown): string | null {
  const trimmed = trimmedString(value)
  return trimmed && trimmed.length <= MAX_CREDENTIAL_CHARS ? trimmed : null
}

function jwtPayload(token: string): Record<string, unknown> | null {
  if (token.length > MAX_CREDENTIAL_CHARS) return null
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

export function grokTokenExpirationMs(token: string): number | null {
  const expiration = finiteNumber(jwtPayload(token)?.['exp'])
  return expiration === null ? null : expiration * 1_000
}

function entryExpirationMs(entry: Record<string, unknown>): number | null {
  const raw = trimmedString(entry['expires_at']) ?? trimmedString(entry['expires'])
  if (raw) {
    const parsed = new Date(raw).getTime()
    if (Number.isFinite(parsed)) return parsed
  }
  const numeric = finiteNumber(entry['expires_at']) ?? finiteNumber(entry['expires'])
  if (numeric === null) return null
  return numeric < 10_000_000_000 ? numeric * 1_000 : numeric
}

function refreshTokenForEntry(entry: Record<string, unknown>): string | null {
  return credentialString(entry['refresh_token']) ?? credentialString(entry['refresh'])
}

export function grokClientIdForEntry(entryKey: string, entry: Record<string, unknown>): string {
  const explicit = credentialString(entry['oidc_client_id'])
  if (explicit) return explicit
  const keyPart = entryKey.split('::').at(-1)?.trim()
  return keyPart || GROK_DEFAULT_CLIENT_ID
}

function candidateIdentity(entryKey: string): string | null {
  const prefix = entryKey.split('::')[0]?.trim() ?? ''
  return prefix.includes('@') ? prefix : null
}

function parseGrokAuthCandidates(authPath: string, value: unknown): GrokAuthCandidate[] {
  if (!isRecord(value)) return []
  const candidates: GrokAuthCandidate[] = []
  for (const [entryKey, rawEntry] of Object.entries(value)) {
    if (candidates.length >= MAX_GROK_AUTH_CANDIDATES || !isRecord(rawEntry)) continue
    const token = credentialString(rawEntry['key'])
    if (!token) continue
    candidates.push({
      authPath,
      entryKey,
      entry: rawEntry,
      token,
      identityLabel: candidateIdentity(entryKey)
    })
  }
  return candidates
}

export function countGrokAuthCandidates(value: unknown): number {
  return parseGrokAuthCandidates('', value).length
}

function loadGrokAuthCandidates(authPath: string): GrokAuthLoadResult {
  if (!fs.existsSync(authPath)) return { kind: 'missing' }
  const text = readBoundedText(authPath)
  if (!text) return { kind: 'invalid' }
  try {
    const candidates = parseGrokAuthCandidates(authPath, JSON.parse(text) as unknown)
    return candidates.length > 0 ? { kind: 'found', candidates } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

function tokenNeedsRefresh(candidate: GrokAuthCandidate, now: number): boolean {
  const entryExpiration = entryExpirationMs(candidate.entry)
  const tokenExpiration = grokTokenExpirationMs(candidate.token)
  return [entryExpiration, tokenExpiration].some(
    (expiration) => expiration !== null && expiration - now <= TOKEN_REFRESH_BUFFER_MS
  )
}

function tokenIsExpired(candidate: GrokAuthCandidate, now: number): boolean {
  const expiration = grokTokenExpirationMs(candidate.token) ?? entryExpirationMs(candidate.entry)
  return expiration !== null && now >= expiration
}

function formEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function refreshExpiry(value: Record<string, unknown>, accessToken: string, now: number): string {
  const expiresIn = finiteNumber(value['expires_in'])
  const expiration =
    expiresIn !== null && expiresIn > 0
      ? now + expiresIn * 1_000
      : (grokTokenExpirationMs(accessToken) ?? now + 60 * 60 * 1_000)
  return new Date(expiration).toISOString()
}

function parseGrokRefresh(value: unknown, now: number): GrokRefresh | null {
  if (!isRecord(value)) return null
  const accessToken = credentialString(value['access_token'])
  if (!accessToken) return null
  return {
    accessToken,
    refreshToken: credentialString(value['refresh_token']),
    idToken: credentialString(value['id_token']),
    expiresAt: refreshExpiry(value, accessToken, now)
  }
}

function writeFileAtomically(filePath: string, text: string): boolean {
  const directory = path.dirname(filePath)
  let originalMode: number
  try {
    originalMode = fs.statSync(filePath).mode & 0o777
  } catch {
    return false
  }
  const temporaryPath = path.join(
    directory,
    `.auth.json.orpheus-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, text, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.chmodSync(temporaryPath, originalMode)
    fs.renameSync(temporaryPath, filePath)
    return true
  } catch {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      fs.unlinkSync(temporaryPath)
    } catch {
      // Best-effort cleanup only.
    }
    return false
  }
}

function persistGrokRefresh(candidate: GrokAuthCandidate, refresh: GrokRefresh): boolean {
  const currentText = readBoundedText(candidate.authPath)
  if (!currentText) return false
  let current: unknown
  try {
    current = JSON.parse(currentText) as unknown
  } catch {
    return false
  }
  if (!isRecord(current)) return false
  const existing = current[candidate.entryKey]
  if (!isRecord(existing)) return false

  const updated: Record<string, unknown> = {
    ...existing,
    key: refresh.accessToken,
    expires_at: refresh.expiresAt
  }
  if (refresh.refreshToken) updated['refresh_token'] = refresh.refreshToken
  if (refresh.idToken) updated['id_token'] = refresh.idToken
  current[candidate.entryKey] = updated
  return writeFileAtomically(candidate.authPath, `${JSON.stringify(current, null, 2)}\n`)
}

async function refreshGrokToken(
  candidate: GrokAuthCandidate,
  fetchJson: GrokFetch,
  now: number
): Promise<string | null> {
  const refreshToken = refreshTokenForEntry(candidate.entry)
  if (!refreshToken) return null
  const clientId = grokClientIdForEntry(candidate.entryKey, candidate.entry)
  const result = await fetchJson(
    GROK_REFRESH_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirect: 'error',
      body:
        `grant_type=refresh_token&client_id=${formEncode(clientId)}` +
        `&refresh_token=${formEncode(refreshToken)}`
    },
    15_000
  )
  if (result.kind !== 'ok') return null
  const refreshed = parseGrokRefresh(result.value, now)
  if (!refreshed) return null

  candidate.token = refreshed.accessToken
  candidate.entry = {
    ...candidate.entry,
    key: refreshed.accessToken,
    expires_at: refreshed.expiresAt,
    ...(refreshed.refreshToken ? { refresh_token: refreshed.refreshToken } : {}),
    ...(refreshed.idToken ? { id_token: refreshed.idToken } : {})
  }
  persistGrokRefresh(candidate, refreshed)
  return refreshed.accessToken
}

function grokHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-XAI-Token-Auth': GROK_TOKEN_AUTH_HEADER,
    Accept: 'application/json',
    'User-Agent': 'Orpheus'
  }
}

async function fetchGrokCredits(
  candidate: GrokAuthCandidate,
  accessToken: string,
  fetchJson: GrokFetch,
  now: number
): Promise<{ result: JsonHttpResult; accessToken: string }> {
  let activeToken = accessToken
  let result = await fetchJson(
    GROK_CREDITS_URL,
    { method: 'GET', headers: grokHeaders(activeToken), redirect: 'error' },
    10_000
  )
  if (result.kind === 'http' && (result.status === 401 || result.status === 403)) {
    const refreshed = await refreshGrokToken(candidate, fetchJson, now)
    if (refreshed) {
      activeToken = refreshed
      result = await fetchJson(
        GROK_CREDITS_URL,
        { method: 'GET', headers: grokHeaders(activeToken), redirect: 'error' },
        10_000
      )
    }
  }
  return { result, accessToken: activeToken }
}

function planFromSettings(value: unknown): string | null {
  return isRecord(value) ? trimmedString(value['subscription_tier_display']) : null
}

async function collectGrokCandidate(
  candidate: GrokAuthCandidate,
  fetchJson: GrokFetch,
  now: number
): Promise<GrokCandidateResult> {
  let accessToken = candidate.token
  if (tokenNeedsRefresh(candidate, now)) {
    const refreshed = await refreshGrokToken(candidate, fetchJson, now)
    if (refreshed) accessToken = refreshed
    else if (tokenIsExpired(candidate, now)) return { kind: 'auth-failed' }
  }

  const credits = await fetchGrokCredits(candidate, accessToken, fetchJson, now)
  if (credits.result.kind !== 'ok') {
    const authFailed =
      credits.result.kind === 'http' &&
      (credits.result.status === 401 || credits.result.status === 403)
    return { kind: authFailed ? 'auth-failed' : 'request-failed' }
  }
  const parsed = parseGrokUsage(credits.result.value)
  if (!parsed) return { kind: 'request-failed' }

  const settings = await fetchJson(
    GROK_SETTINGS_URL,
    { method: 'GET', headers: grokHeaders(credits.accessToken), redirect: 'error' },
    10_000
  )
  const plan = settings.kind === 'ok' ? planFromSettings(settings.value) : null
  return {
    kind: 'available',
    entry: {
      providerId: 'xai',
      label: 'Grok',
      configured: true,
      enabled: true,
      identityLabel: candidate.identityLabel ?? plan,
      availability: 'available',
      unavailableReason: null,
      ...parsed
    }
  }
}

export async function collectGrokUsage(
  dependencies: GrokCollectorDependencies = {}
): Promise<ProviderUsageEntry> {
  const homeDir = dependencies.homeDir ?? os.homedir()
  const grokHome =
    dependencies.grokHome === undefined
      ? (trimmedString(process.env['GROK_HOME']) ?? path.join(homeDir, '.grok'))
      : (dependencies.grokHome ?? path.join(homeDir, '.grok'))
  const authPath = dependencies.authPath ?? path.join(grokHome, 'auth.json')
  const loaded = loadGrokAuthCandidates(authPath)
  if (loaded.kind === 'missing') return unavailableGrok('no-auth', false)
  if (loaded.kind === 'invalid') return unavailableGrok('error', true)

  const now = dependencies.now?.() ?? Date.now()
  const fetchJson = dependencies.fetchJson ?? fetchBoundedJson
  const candidates = loaded.candidates
  let sawRequestFailure = false
  for (const candidate of candidates) {
    const result = await collectGrokCandidate(candidate, fetchJson, now)
    if (result.kind === 'available') return result.entry
    if (result.kind === 'request-failed') sawRequestFailure = true
  }
  return unavailableGrok(
    sawRequestFailure ? 'error' : 'no-auth',
    true,
    candidates[0]?.identityLabel ?? null
  )
}
