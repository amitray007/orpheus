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
import { DASHBOARD_CACHE_KEYS, readDashboardCache, writeDashboardCache } from './db/dashboardCache'
import { getClaudeGlobalSettings } from './claudeSettings'
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

// `claude setup-token`'s long-lived OAuth access token. Env-var auth (no
// interactive login, so neither the keychain item nor .credentials.json
// exists) is the third and last-resort token source — see
// resolveOAuthTokenFromEnv below.
const OAUTH_ENV_VAR_NAME = 'CLAUDE_CODE_OAUTH_TOKEN'
const OAUTH_TOKEN_PREFIX = 'sk-ant-oat'

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
 * Validate + resolve an OAuth access token from environment-style sources,
 * for the env-var-authenticated case (`claude setup-token`, no interactive
 * login — so neither the keychain item nor .credentials.json exists). A
 * PURE function: both sources are passed in as parameters rather than read
 * internally (process.env / getClaudeGlobalSettings()) so it's directly
 * unit-testable without mocking global state — see
 * scripts/verify-claude-usage-env-token.ts.
 *
 * Source order (first non-empty, validated value wins):
 *   1. `customEnvVars` — Orpheus's own Settings > Claude > Developer > Env
 *      Vars UI (`claude_global_settings.custom_env_vars`). This is the
 *      primary path in practice: it's how a user actually saves a
 *      `setup-token` value in Orpheus, and unlike process.env it survives
 *      an app relaunch without re-exporting anything.
 *   2. `processEnv` — the app's own process environment, for the case where
 *      Orpheus itself was launched with the var already set (e.g. from a
 *      shell profile). Lower priority than the Orpheus-configured value so
 *      an explicit in-app setting always wins over ambient environment.
 *
 * Validation: trims whitespace, requires non-empty, and requires the
 * `sk-ant-oat` prefix. An `sk-ant-api…` console API key (a DIFFERENT
 * credential class — not a valid bearer token for the usage endpoint) is
 * deliberately rejected so a misconfigured API key degrades to the honest
 * `{ unavailable: 'no-auth' }` rather than a misleading `'error'` state.
 * NEVER logs the token value.
 */
export function resolveOAuthTokenFromEnv(
  processEnv: Record<string, string | undefined>,
  customEnvVars: Record<string, string>
): string | null {
  const candidates = [customEnvVars[OAUTH_ENV_VAR_NAME], processEnv[OAUTH_ENV_VAR_NAME]]
  for (const candidate of candidates) {
    const trimmed = candidate?.trim()
    if (trimmed && trimmed.startsWith(OAUTH_TOKEN_PREFIX)) return trimmed
  }
  return null
}

/**
 * Resolve just the access token (the common case every caller wants).
 * Order: keychain / credentials.json (richest — refreshable) first, then
 * falls back to an env-sourced token (see resolveOAuthTokenFromEnv) for
 * env-var-authenticated setups that have neither. Returns null on total
 * failure. NEVER logs the token value.
 */
export async function readClaudeOAuthToken(): Promise<string | null> {
  const creds = await readClaudeOAuthCreds()
  if (creds?.accessToken) return creds.accessToken

  // No interactive-login credential found — try env-sourced auth. Global
  // settings only: usage is account-wide, not per-workspace, and there is
  // no workspace context at this call site (see providerUsage.ts).
  return resolveOAuthTokenFromEnv(process.env, getClaudeGlobalSettings().customEnvVars)
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
    percentKnown: typeof raw.percent === 'number',
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

/** Escape hatch to force the next getClaudeUsage() call to re-fetch instead
 *  of serving the TTL cache. Used by ipc/claudeSettings.ts's
 *  `claudeSettings:update` handler when a customEnvVars edit could have
 *  changed the env-sourced CLAUDE_CODE_OAUTH_TOKEN (see
 *  resolveOAuthTokenFromEnv) — without this, a cached `no-auth` result would
 *  keep the Dashboard usage card dark for up to USAGE_TTL_MS after the user
 *  pastes in a working token. Also available for test harnesses. */
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
export async function getClaudeUsage(force = false): Promise<ClaudeUsageResult> {
  const now = Date.now()
  if (!force && cachedResult && now - cachedResult.fetchedAt < USAGE_TTL_MS) {
    return cachedResult.value
  }

  if (inflight) return inflight

  const promise = fetchClaudeUsageFromNetwork().finally(() => {
    inflight = null
  })
  inflight = promise

  const value = await promise
  cachedResult = { value, fetchedAt: Date.now() }
  // Persist to disk (Dashboard D1) — but only a REAL usage payload, never
  // the `{ unavailable }` failure shape. Unlike github.ts's getMyOpenPrs/
  // getMyIssues, ClaudeUsageResult's discriminated union makes success vs.
  // failure unambiguous here, so we gate on the `unavailable` tag directly
  // rather than an empty-vs-error heuristic. We deliberately do NOT persist
  // `unavailable` results — doing so would let a transient auth/network
  // blip overwrite good cached usage data with "nothing to show", which is
  // strictly worse for the Dashboard's instant-paint goal than just serving
  // the last good value until the next successful fetch.
  if (!('unavailable' in value)) {
    writeDashboardCache(DASHBOARD_CACHE_KEYS.claudeUsage, value)
  }
  return value
}

/** Instant, disk-backed read of the last-persisted `getClaudeUsage()`
 *  result. Never throws; null means no successful usage fetch has ever been
 *  persisted yet (D2 wires this into the actual stale-while-revalidate read
 *  path — this unit only exposes the entry point). */
export function getCachedClaudeUsage(): { value: ClaudeUsage; fetchedAt: number } | null {
  return readDashboardCache<ClaudeUsage>(DASHBOARD_CACHE_KEYS.claudeUsage)
}
