import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import type { ProviderUsageEntry, ProviderUsageUnavailableReason } from '../../shared/types'
import {
  cursorPrimaryNeedsRestFallback,
  cursorSessionFromToken,
  cursorTokenExpirationMs,
  cursorTokenSubject,
  parseCursorFallbackUsage,
  parseCursorPlanName,
  parseCursorPrimaryUsage,
  type ParsedCursorUsage
} from './cursorParser'
import {
  fetchBoundedJson,
  isRecord,
  PROVIDER_RESPONSE_LIMIT_BYTES,
  readKeychainPassword,
  trimmedString,
  type JsonHttpResult,
  type KeychainReadResult
} from './runtime'

const CURSOR_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage'
const CURSOR_PLAN_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo'
const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/oauth/token'
const CURSOR_CREDITS_URL =
  'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance'
const CURSOR_REST_USAGE_URL = 'https://cursor.com/api/usage'
const CURSOR_USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const CURSOR_STRIPE_URL = 'https://cursor.com/api/auth/stripe'
const CURSOR_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB'
const CURSOR_ACCESS_TOKEN_KEY = 'cursorAuth/accessToken'
const CURSOR_REFRESH_TOKEN_KEY = 'cursorAuth/refreshToken'
const CURSOR_MEMBERSHIP_KEY = 'cursorAuth/stripeMembershipType'
const CURSOR_ACCESS_TOKEN_SERVICE = 'cursor-access-token'
const CURSOR_REFRESH_TOKEN_SERVICE = 'cursor-refresh-token'
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1_000
const MAX_CREDENTIAL_CHARS = 256 * 1024

type CursorAuthSource = 'sqlite' | 'keychain'

type CursorAuthState = {
  accessToken: string | null
  refreshToken: string | null
  source: CursorAuthSource
  stateDbPath: string
}

type CursorAuthLoadResult =
  | { kind: 'found'; state: CursorAuthState }
  | { kind: 'missing' }
  | { kind: 'unreadable' }

type CursorFetch = typeof fetchBoundedJson
type CursorKeychainRead = typeof readKeychainPassword

export type CursorCollectorDependencies = {
  homeDir?: string
  now?: () => number
  fetchJson?: CursorFetch
  readKeychain?: CursorKeychainRead
  writeKeychain?: (service: string, value: string) => Promise<boolean>
  stateDbPath?: string
}

function unavailableCursor(
  reason: ProviderUsageUnavailableReason,
  configured: boolean,
  identityLabel: string | null = null
): ProviderUsageEntry {
  return {
    providerId: 'cursor',
    label: 'Cursor',
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

function defaultCursorDbPath(homeDir: string): string {
  return path.join(
    homeDir,
    'Library',
    'Application Support',
    'Cursor',
    'User',
    'globalStorage',
    'state.vscdb'
  )
}

function readCursorSqliteState(stateDbPath: string): {
  values: Map<string, string>
  unreadable: boolean
} {
  if (!fs.existsSync(stateDbPath)) return { values: new Map(), unreadable: false }
  try {
    const db = new Database(stateDbPath, { readonly: true, fileMustExist: true })
    try {
      const rows = db
        .prepare('SELECT key, value FROM ItemTable WHERE key IN (?, ?, ?)')
        .all(CURSOR_ACCESS_TOKEN_KEY, CURSOR_REFRESH_TOKEN_KEY, CURSOR_MEMBERSHIP_KEY) as Array<{
        key?: unknown
        value?: unknown
      }>
      const values = new Map<string, string>()
      for (const row of rows) {
        const key = trimmedString(row.key)
        const value = credentialString(row.value)
        if (key && value) values.set(key, value)
      }
      return { values, unreadable: false }
    } finally {
      db.close()
    }
  } catch {
    return { values: new Map(), unreadable: true }
  }
}

function foundKeychainValue(result: KeychainReadResult): string | null {
  return result.kind === 'found' ? credentialString(result.value) : null
}

async function loadCursorAuthState({
  stateDbPath,
  readKeychain
}: {
  stateDbPath: string
  readKeychain: CursorKeychainRead
}): Promise<CursorAuthLoadResult> {
  const sqlite = readCursorSqliteState(stateDbPath)
  const [keychainAccess, keychainRefresh] = await Promise.all([
    readKeychain(CURSOR_ACCESS_TOKEN_SERVICE),
    readKeychain(CURSOR_REFRESH_TOKEN_SERVICE)
  ])

  const sqliteAccess = credentialString(sqlite.values.get(CURSOR_ACCESS_TOKEN_KEY))
  const sqliteRefresh = credentialString(sqlite.values.get(CURSOR_REFRESH_TOKEN_KEY))
  const keychainAccessToken = foundKeychainValue(keychainAccess)
  const keychainRefreshToken = foundKeychainValue(keychainRefresh)
  const hasSqliteAuth = sqliteAccess !== null || sqliteRefresh !== null
  const hasKeychainAuth = keychainAccessToken !== null || keychainRefreshToken !== null

  if (hasSqliteAuth) {
    const membership = sqlite.values.get(CURSOR_MEMBERSHIP_KEY)?.trim().toLowerCase()
    const sqliteSubject = cursorTokenSubject(sqliteAccess)
    const keychainSubject = cursorTokenSubject(keychainAccessToken)
    if (
      hasKeychainAuth &&
      membership === 'free' &&
      sqliteSubject !== null &&
      keychainSubject !== null &&
      sqliteSubject !== keychainSubject
    ) {
      return {
        kind: 'found',
        state: {
          accessToken: keychainAccessToken,
          refreshToken: keychainRefreshToken,
          source: 'keychain',
          stateDbPath
        }
      }
    }
    return {
      kind: 'found',
      state: {
        accessToken: sqliteAccess,
        refreshToken: sqliteRefresh,
        source: 'sqlite',
        stateDbPath
      }
    }
  }

  if (hasKeychainAuth) {
    return {
      kind: 'found',
      state: {
        accessToken: keychainAccessToken,
        refreshToken: keychainRefreshToken,
        source: 'keychain',
        stateDbPath
      }
    }
  }

  const keychainUnreadable =
    keychainAccess.kind === 'unreadable' || keychainRefresh.kind === 'unreadable'
  return sqlite.unreadable || keychainUnreadable ? { kind: 'unreadable' } : { kind: 'missing' }
}

function writeKeychainPassword(service: string, value: string): Promise<boolean> {
  if (!credentialString(value)) return Promise.resolve(false)
  return new Promise((resolve) => {
    childProcess.execFile(
      '/usr/bin/security',
      ['add-generic-password', '-U', '-s', service, '-w', value],
      { timeout: 3_000, maxBuffer: PROVIDER_RESPONSE_LIMIT_BYTES },
      (error) => resolve(!error)
    )
  })
}

function writeCursorSqliteAccessToken(stateDbPath: string, accessToken: string): boolean {
  try {
    const db = new Database(stateDbPath, { fileMustExist: true })
    try {
      db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
        CURSOR_ACCESS_TOKEN_KEY,
        accessToken
      )
      return true
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

async function persistCursorAccessToken(
  state: CursorAuthState,
  accessToken: string,
  writeKeychain: (service: string, value: string) => Promise<boolean>
): Promise<void> {
  if (state.source === 'sqlite') {
    writeCursorSqliteAccessToken(state.stateDbPath, accessToken)
    return
  }
  await writeKeychain(CURSOR_ACCESS_TOKEN_SERVICE, accessToken)
}

function connectHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1'
  }
}

async function refreshCursorAccessToken(
  state: CursorAuthState,
  fetchJson: CursorFetch,
  writeKeychain: (service: string, value: string) => Promise<boolean>
): Promise<string | null> {
  const refreshToken = credentialString(state.refreshToken)
  if (!refreshToken) return null
  const result = await fetchJson(
    CURSOR_REFRESH_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      redirect: 'error',
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CURSOR_CLIENT_ID,
        refresh_token: refreshToken
      })
    },
    15_000
  )
  if (result.kind !== 'ok' || !isRecord(result.value)) return null
  if (result.value['shouldLogout'] === true) return null
  const accessToken = credentialString(result.value['access_token'])
  if (!accessToken) return null
  state.accessToken = accessToken
  await persistCursorAccessToken(state, accessToken, writeKeychain)
  return accessToken
}

function cursorTokenNeedsRefresh(accessToken: string | null, now: number): boolean {
  const expiration = cursorTokenExpirationMs(accessToken)
  return expiration === null || expiration - now <= TOKEN_REFRESH_BUFFER_MS
}

async function fetchCursorPrimary(
  state: CursorAuthState,
  accessToken: string,
  fetchJson: CursorFetch,
  writeKeychain: (service: string, value: string) => Promise<boolean>
): Promise<{ result: JsonHttpResult; accessToken: string }> {
  let activeToken = accessToken
  let result = await fetchJson(
    CURSOR_USAGE_URL,
    {
      method: 'POST',
      headers: connectHeaders(activeToken),
      redirect: 'error',
      body: '{}'
    },
    10_000
  )
  if (result.kind === 'http' && (result.status === 401 || result.status === 403)) {
    const refreshed = await refreshCursorAccessToken(state, fetchJson, writeKeychain)
    if (refreshed) {
      activeToken = refreshed
      result = await fetchJson(
        CURSOR_USAGE_URL,
        {
          method: 'POST',
          headers: connectHeaders(activeToken),
          redirect: 'error',
          body: '{}'
        },
        10_000
      )
    }
  }
  return { result, accessToken: activeToken }
}

async function optionalCursorRequest(
  fetchJson: CursorFetch,
  url: string,
  init: Omit<RequestInit, 'signal'>
): Promise<unknown> {
  const result = await fetchJson(url, { ...init, redirect: 'error' }, 10_000)
  return result.kind === 'ok' ? result.value : null
}

function availableCursor(
  identityLabel: string | null,
  parsed: ParsedCursorUsage
): ProviderUsageEntry {
  return {
    providerId: 'cursor',
    label: 'Cursor',
    configured: true,
    enabled: true,
    identityLabel,
    availability: 'available',
    unavailableReason: null,
    ...parsed
  }
}

export async function collectCursorUsage(
  dependencies: CursorCollectorDependencies = {}
): Promise<ProviderUsageEntry> {
  const homeDir = dependencies.homeDir ?? os.homedir()
  const stateDbPath = dependencies.stateDbPath ?? defaultCursorDbPath(homeDir)
  const now = dependencies.now ?? Date.now
  const fetchJson = dependencies.fetchJson ?? fetchBoundedJson
  const readKeychain = dependencies.readKeychain ?? readKeychainPassword
  const writeKeychain = dependencies.writeKeychain ?? writeKeychainPassword
  const loaded = await loadCursorAuthState({ stateDbPath, readKeychain })
  if (loaded.kind === 'missing') return unavailableCursor('no-auth', false)
  if (loaded.kind === 'unreadable') return unavailableCursor('error', false)

  const state = loaded.state
  let accessToken = state.accessToken
  if (cursorTokenNeedsRefresh(accessToken, now())) {
    accessToken = (await refreshCursorAccessToken(state, fetchJson, writeKeychain)) ?? accessToken
  }
  if (!accessToken) return unavailableCursor('no-auth', true)

  const primaryFetch = await fetchCursorPrimary(state, accessToken, fetchJson, writeKeychain)
  accessToken = primaryFetch.accessToken
  if (primaryFetch.result.kind !== 'ok') {
    const noAuth =
      primaryFetch.result.kind === 'http' &&
      (primaryFetch.result.status === 401 || primaryFetch.result.status === 403)
    return unavailableCursor(noAuth ? 'no-auth' : 'error', true)
  }

  const planResponse = await optionalCursorRequest(fetchJson, CURSOR_PLAN_URL, {
    method: 'POST',
    headers: connectHeaders(accessToken),
    body: '{}'
  })
  const planName = parseCursorPlanName(planResponse)
  const planInfoUnavailable = planName === null

  if (cursorPrimaryNeedsRestFallback(primaryFetch.result.value, planName, planInfoUnavailable)) {
    const session = cursorSessionFromToken(accessToken)
    if (!session) return unavailableCursor('error', true, planName)
    const [summary, requestUsage] = await Promise.all([
      optionalCursorRequest(fetchJson, CURSOR_USAGE_SUMMARY_URL, {
        method: 'GET',
        headers: { Cookie: session.cookie }
      }),
      optionalCursorRequest(
        fetchJson,
        `${CURSOR_REST_USAGE_URL}?user=${encodeURIComponent(session.userId)}`,
        {
          method: 'GET',
          headers: { Cookie: session.cookie }
        }
      )
    ])
    const parsed = parseCursorFallbackUsage({ summary, requestUsage })
    return parsed ? availableCursor(planName, parsed) : unavailableCursor('error', true, planName)
  }

  const session = cursorSessionFromToken(accessToken)
  const [creditGrants, stripeBalance] = await Promise.all([
    optionalCursorRequest(fetchJson, CURSOR_CREDITS_URL, {
      method: 'POST',
      headers: connectHeaders(accessToken),
      body: '{}'
    }),
    session
      ? optionalCursorRequest(fetchJson, CURSOR_STRIPE_URL, {
          method: 'GET',
          headers: { Cookie: session.cookie }
        })
      : Promise.resolve(null)
  ])
  const parsed = parseCursorPrimaryUsage({
    usage: primaryFetch.result.value,
    planName,
    creditGrants,
    stripeBalance
  })
  return parsed ? availableCursor(planName, parsed) : unavailableCursor('error', true, planName)
}
