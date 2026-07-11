// ---------------------------------------------------------------------------
// src/main/claudeUsage.ts
//
// Dashboard "Usage" card data source — Claude Code's own OAuth usage/limits
// endpoint (undocumented; verified live against a real account). Reads the
// SAME OAuth access token `claude` itself uses (macOS keychain item
// "Claude Code-credentials", falling back to the on-disk credentials.json),
// then GETs `https://api.anthropic.com/api/oauth/usage`.
//
// SECRET DISCIPLINE (mirrors claudeAuth.ts's own rule): the access/refresh
// token is NEVER logged, not even at debug level, not even truncated. Every
// catch block below logs only the outcome/shape, never the token value or
// the raw Authorization header.
//
// RATE-LIMIT DISCIPLINE (the load-bearing constraint here — this is an
// internal endpoint we don't want to hammer): a single module-level
// TTL cache (~3 minutes) + inflight promise de-dup, same shape as
// src/main/github.ts's putWithEviction pattern but simpler (one fixed key,
// no per-branch/per-repo fanout — there's exactly one "current usage").
// Every call site (IPC handler) goes through `getClaudeUsage()`, so:
//   - A burst of renderer re-renders/navigations within the TTL all resolve
//     from cache without touching the network.
//   - A burst of CONCURRENT callers (e.g. two dashboard mounts racing) share
//     the same in-flight fetch promise instead of firing N requests.
//   - On 401/403 we attempt EXACTLY ONE token refresh + ONE retry, never a
//     retry loop — a still-failing retry just degrades to `{ unavailable:
//     'error' }` rather than hammering the endpoint further.
//
// Total contract: this module NEVER throws out of getClaudeUsage. Every
// failure mode (no token, network error, bad JSON, non-2xx after the single
// retry) resolves to a typed unavailable state so the renderer degrades
// gracefully instead of crashing the Dashboard.
// ---------------------------------------------------------------------------

import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type { ClaudeUsage, ClaudeUsageLimit, ClaudeUsageResult } from '../shared/types'

const execFile = promisify(childProcess.execFile)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_REFRESH_URL = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_BETA_HEADER = 'oauth-2025-04-20'
// Anthropic's own OAuth client id, used by `claude` itself for the
// refresh_token grant — required by the token endpoint alongside
// grant_type/refresh_token. Not a secret (it's a public OAuth client id, the
// counterpart to the user's own refresh token which IS secret and is never
// logged).
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const FETCH_TIMEOUT_MS = 8000

// ---------------------------------------------------------------------------
// Credential shape (subset we read) — tolerant of extra/missing fields since
// this mirrors claude's own on-disk/keychain format, which we don't own.
// ---------------------------------------------------------------------------
type ClaudeOAuthCreds = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
  }
}

function credentialsFilePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR
  if (configDir) return path.join(configDir, '.credentials.json')
  return path.join(os.homedir(), '.claude', '.credentials.json')
}

/** Read the on-disk credentials.json fallback. Returns null on any failure
 *  (missing file, bad JSON, missing field) — never throws. */
function readCredentialsFile(): ClaudeOAuthCreds | null {
  try {
    const raw = fs.readFileSync(credentialsFilePath(), 'utf8')
    return JSON.parse(raw) as ClaudeOAuthCreds
  } catch {
    return null
  }
}

/**
 * Read the full OAuth credential blob (access + refresh token + expiry).
 * Keychain first (this machine's actual storage), falling back to the
 * credentials.json file some setups use instead. NEVER logs token values —
 * only whether a read succeeded/failed. Returns null on any failure.
 */
async function readClaudeOAuthCreds(): Promise<ClaudeOAuthCreds['claudeAiOauth'] | null> {
  try {
    const { stdout } = await execFile('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-w'
    ])
    const parsed = JSON.parse(stdout.trim()) as ClaudeOAuthCreds
    if (parsed.claudeAiOauth?.accessToken) return parsed.claudeAiOauth
  } catch {
    // Keychain item missing/inaccessible — fall through to the file fallback.
  }

  const fileCreds = readCredentialsFile()
  if (fileCreds?.claudeAiOauth?.accessToken) return fileCreds.claudeAiOauth
  return null
}

/**
 * Resolve just the access token (the common case every caller wants).
 * Returns null on any failure — see readClaudeOAuthCreds. NEVER logs the
 * token value.
 */
export async function readClaudeOAuthToken(): Promise<string | null> {
  const creds = await readClaudeOAuthCreds()
  return creds?.accessToken ?? null
}

// ---------------------------------------------------------------------------
// Raw response shape (undocumented endpoint — every field optional/nullable
// so an unexpected shape degrades to nulls instead of throwing).
// ---------------------------------------------------------------------------
type RawUsageWindow = {
  utilization?: number | null
  resets_at?: string | null
}

type RawUsageLimit = {
  kind?: string
  group?: string
  percent?: number
  severity?: string
  resets_at?: string | null
  scope?: { model?: { display_name?: string | null } | null } | null
  is_active?: boolean
}

type RawExtraUsage = {
  is_enabled?: boolean
}

type RawUsageResponse = {
  five_hour?: RawUsageWindow | null
  seven_day?: RawUsageWindow | null
  limits?: RawUsageLimit[] | null
  extra_usage?: RawExtraUsage | null
}

function parseWindow(raw: RawUsageWindow | null | undefined): ClaudeUsage['fiveHour'] {
  return {
    utilization: typeof raw?.utilization === 'number' ? raw.utilization : null,
    resetsAt: typeof raw?.resets_at === 'string' ? raw.resets_at : null
  }
}

function parseLimit(raw: RawUsageLimit): ClaudeUsageLimit {
  return {
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    group: typeof raw.group === 'string' ? raw.group : '',
    percent: typeof raw.percent === 'number' ? raw.percent : 0,
    severity: typeof raw.severity === 'string' ? raw.severity : 'normal',
    resetsAt: typeof raw.resets_at === 'string' ? raw.resets_at : null,
    modelName:
      typeof raw.scope?.model?.display_name === 'string' ? raw.scope.model.display_name : null,
    isActive: raw.is_active === true
  }
}

/** Parse the raw HTTP JSON into our typed ClaudeUsage — tolerant of missing/
 *  extra fields since this is an undocumented endpoint we don't control. */
function parseUsageResponse(raw: RawUsageResponse): ClaudeUsage {
  return {
    fiveHour: parseWindow(raw.five_hour),
    sevenDay: parseWindow(raw.seven_day),
    limits: Array.isArray(raw.limits) ? raw.limits.map(parseLimit) : [],
    extraUsageEnabled: raw.extra_usage?.is_enabled === true
  }
}

// ---------------------------------------------------------------------------
// TTL cache + inflight de-dup — single fixed key (there's exactly one
// "current usage" for the signed-in account), unlike github.ts's per-
// cwd/branch keying. See file header for the rate-limit rationale.
// ---------------------------------------------------------------------------
const USAGE_TTL_MS = 3 * 60 * 1000

let cachedResult: { value: ClaudeUsageResult; fetchedAt: number } | null = null
let inflight: Promise<ClaudeUsageResult> | null = null

/** Test-only escape hatch so a future test harness can force a re-fetch;
 *  unused in production code paths. */
export function invalidateClaudeUsageCache(): void {
  cachedResult = null
}

async function fetchUsageOnce(accessToken: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * ONE refresh_token grant attempt. Returns the new access token on success,
 * null on any failure (missing refresh token, network error, non-2xx) — the
 * caller treats null as "give up, don't retry". NEVER logs token values.
 */
async function tryRefreshAccessToken(): Promise<string | null> {
  const creds = await readClaudeOAuthCreds()
  if (!creds?.refreshToken) return null

  try {
    const res = await fetch(TOKEN_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: OAUTH_CLIENT_ID
      })
    })
    if (!res.ok) return null
    const body = (await res.json()) as { access_token?: string }
    return typeof body.access_token === 'string' ? body.access_token : null
  } catch {
    return null
  }
}

/**
 * Fetch + parse usage from the network, with a single 401/403 -> refresh ->
 * retry-once escalation. Never throws — every failure mode resolves to
 * `{ unavailable: ... }`.
 */
async function fetchClaudeUsageFromNetwork(): Promise<ClaudeUsageResult> {
  const token = await readClaudeOAuthToken()
  if (!token) return { unavailable: 'no-auth' }

  try {
    let res = await fetchUsageOnce(token)

    if (res.status === 401 || res.status === 403) {
      // ONE refresh attempt, ONE retry — never loop. If refresh fails or the
      // retry still 401s, degrade to 'error' (not 'no-auth' — we DO have
      // stored credentials, they're just not working right now).
      const refreshed = await tryRefreshAccessToken()
      if (refreshed) {
        res = await fetchUsageOnce(refreshed)
      }
    }

    if (!res.ok) return { unavailable: 'error' }

    const json = (await res.json()) as RawUsageResponse
    return parseUsageResponse(json)
  } catch {
    // Network error, timeout/abort, or JSON parse failure.
    return { unavailable: 'error' }
  }
}

/**
 * Public entry point — TTL-cached (~3min) + inflight-deduped. Every IPC call
 * (`claude:usage`) goes through this function, so repeated dashboard opens/
 * renders within the TTL never touch the network, and concurrent callers
 * share one in-flight fetch. See file header for the full rate-limit
 * contract. Total — never throws.
 */
export async function getClaudeUsage(): Promise<ClaudeUsageResult> {
  const now = Date.now()
  if (cachedResult && now - cachedResult.fetchedAt < USAGE_TTL_MS) {
    return cachedResult.value
  }

  if (inflight) return inflight

  const promise = fetchClaudeUsageFromNetwork().finally(() => {
    inflight = null
  })
  inflight = promise

  const value = await promise
  cachedResult = { value, fetchedAt: Date.now() }
  return value
}
