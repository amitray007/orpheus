import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { ClaudeUsageResult, ClaudeUsageSnapshot } from '../shared/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const REFRESH_BUFFER_MS = 5 * 60 * 1000
const MIN_FETCH_INTERVAL_MS = 5 * 60 * 1000
const TOKEN_SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

// ---------------------------------------------------------------------------
// Module-scope cache
// ---------------------------------------------------------------------------

let cached: ClaudeUsageSnapshot | null = null
let rateLimitedUntilMs = 0

// ---------------------------------------------------------------------------
// Credentials file helpers
// ---------------------------------------------------------------------------

function credentialsPath(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR']
  if (configDir) return nodePath.join(configDir, '.credentials.json')
  return nodePath.join(os.homedir(), '.claude', '.credentials.json')
}

type CredentialsFile = {
  claudeAiOauth?: {
    accessToken?: string
    refreshToken?: string
    expiresAt?: number
    scopes?: string[]
  }
}

function readCredentials(): CredentialsFile | null {
  const p = credentialsPath()
  try {
    const raw = fs.readFileSync(p, 'utf-8')
    return JSON.parse(raw) as CredentialsFile
  } catch {
    return null
  }
}

function writeCredentials(data: CredentialsFile): void {
  const p = credentialsPath()
  // Minified JSON — Claude Code's keychain reader chokes on newlines
  fs.writeFileSync(p, JSON.stringify(data), 'utf-8')
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

type RefreshResponse = {
  access_token: string
  refresh_token?: string
  expires_in?: number
}

async function refreshToken(refreshTkn: string): Promise<{
  accessToken: string
  refreshToken: string
  expiresAt: number
} | null> {
  try {
    const res = await fetch('https://platform.claude.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshTkn,
        client_id: CLIENT_ID,
        scope: TOKEN_SCOPE
      })
    })

    if (!res.ok) {
      console.warn('[claudeUsage] token refresh failed with status', res.status)
      return null
    }

    const body = (await res.json()) as RefreshResponse
    const expiresIn = body.expires_in ?? 3600
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? refreshTkn,
      expiresAt: Date.now() + expiresIn * 1000
    }
  } catch (err) {
    console.warn('[claudeUsage] token refresh threw:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

type UsageBucketRaw = {
  utilization?: number
  resets_at?: string | number
}

type UsageApiResponse = {
  five_hour?: UsageBucketRaw
  seven_day?: UsageBucketRaw
  seven_day_sonnet?: UsageBucketRaw
  seven_day_omelette?: UsageBucketRaw
}

function normalizeBucket(raw: UsageBucketRaw | undefined): import('../shared/types').ClaudeUsageBucket | null {
  if (!raw) return null
  const utilization = typeof raw.utilization === 'number' ? raw.utilization : 0
  let resetsAt: string | null = null
  if (raw.resets_at !== undefined) {
    if (typeof raw.resets_at === 'number') {
      // Could be epoch seconds or epoch ms; distinguish by magnitude
      // Epoch ms for year 2024 is ~1.7e12; seconds is ~1.7e9
      const asMs = raw.resets_at > 1e11 ? raw.resets_at : raw.resets_at * 1000
      resetsAt = new Date(asMs).toISOString()
    } else {
      resetsAt = raw.resets_at
    }
  }
  return { utilization, resetsAt }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function getClaudeUsage(): Promise<ClaudeUsageResult> {
  const now = Date.now()

  // Serve from cache if fresh
  if (cached && now - cached.fetchedAt < MIN_FETCH_INTERVAL_MS) {
    if (cached.rateLimitedUntil && now < cached.rateLimitedUntil) {
      return {
        kind: 'rate_limited',
        retryAfterMs: cached.rateLimitedUntil - now,
        snapshot: cached
      }
    }
    return { kind: 'ok', snapshot: cached }
  }

  // Still rate-limited even after cache expiry
  if (rateLimitedUntilMs && now < rateLimitedUntilMs) {
    return {
      kind: 'rate_limited',
      retryAfterMs: rateLimitedUntilMs - now,
      snapshot: cached
    }
  }

  // Read credentials file
  const creds = readCredentials()
  if (!creds || !creds.claudeAiOauth) {
    return { kind: 'no_credentials' }
  }

  const oauth = creds.claudeAiOauth
  if (!oauth.accessToken) {
    return { kind: 'no_credentials' }
  }

  let accessToken = oauth.accessToken
  let needsWrite = false

  // Refresh if expiring soon
  if (oauth.expiresAt && now >= oauth.expiresAt - REFRESH_BUFFER_MS) {
    if (!oauth.refreshToken) {
      return { kind: 'auth_failed', message: 'Token expired and no refresh token available' }
    }
    const refreshed = await refreshToken(oauth.refreshToken)
    if (!refreshed) {
      return {
        kind: 'auth_failed',
        message: 'Token refresh failed — run `claude` to sign in again'
      }
    }
    accessToken = refreshed.accessToken
    needsWrite = true
    creds.claudeAiOauth = {
      ...oauth,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt
    }
  }

  // Write back updated tokens if refreshed
  if (needsWrite) {
    try {
      writeCredentials(creds)
    } catch (err) {
      console.warn('[claudeUsage] failed to write updated credentials:', err)
      // Non-fatal — continue with the refreshed token in memory
    }
  }

  // Fetch usage
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    if (res.status === 429) {
      const retryAfterSec = parseInt(res.headers.get('Retry-After') ?? '', 10)
      const backoffMs = !isNaN(retryAfterSec) ? retryAfterSec * 1000 : MIN_FETCH_INTERVAL_MS
      rateLimitedUntilMs = Date.now() + backoffMs
      const snapshot = cached
        ? { ...cached, rateLimitedUntil: rateLimitedUntilMs }
        : null
      if (snapshot) cached = snapshot
      return { kind: 'rate_limited', retryAfterMs: backoffMs, snapshot }
    }

    if (res.status === 401 || res.status === 400) {
      return {
        kind: 'auth_failed',
        message: 'Claude Code session expired — run `claude` to sign in again'
      }
    }

    if (!res.ok) {
      return { kind: 'error', message: `HTTP ${res.status}` }
    }

    const body = (await res.json()) as UsageApiResponse

    const snapshot: ClaudeUsageSnapshot = {
      fiveHour: normalizeBucket(body.five_hour),
      sevenDay: normalizeBucket(body.seven_day),
      sevenDaySonnet: normalizeBucket(body.seven_day_sonnet),
      sevenDayOpus: normalizeBucket(body.seven_day_omelette),
      fetchedAt: Date.now(),
      rateLimitedUntil: null
    }

    cached = snapshot
    rateLimitedUntilMs = 0

    return { kind: 'ok', snapshot }
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : 'Network error'
    }
  }
}
