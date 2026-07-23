// ---------------------------------------------------------------------------
// src/main/routingProxy/oauth.ts
//
// In-app OAuth "Connect <provider>" flow for the managed CLIProxyAPI process
// (model-routing unit 07). Follows the Quotio pattern: hit the provider's
// auth-url route, open the browser, poll get-auth-status, and let the user
// cancel via DELETE — never the VibeProxy pattern of spawning `-codex-login`
// subprocesses or hand-editing credential JSON files.
//
// Verified against the pinned v7.2.92 CLIProxyAPI source
// (internal/api/server.go / internal/api/handlers/management/auth_files.go):
//
//   GET  /v0/management/{codex|anthropic|antigravity|kimi|xai}-auth-url
//        ?is_webui=true
//        -> 200 {"status":"ok","url":"<authURL>","state":"<state>"}
//        (device-style flows may also return "flow":"device", "user_code",
//        "expires_in")
//   GET  /v0/management/get-auth-status?state=<state>
//        -> {"status":"ok"} | {"status":"wait"} | {"status":"error","error":"…"}
//   DELETE /v0/management/oauth-session?state=<state>
//        -> cancels; aborts the server-side goroutine so credentials can't be
//           persisted after cancel.
//
// There is NO gemini-auth-url route — Gemini is API-key only (see
// providers/registry.ts's descriptor). Eligibility for a Connect button is
// derived structurally from a descriptor's authMethods, never from a
// hardcoded provider-id list — see eligibleOAuthProviderIds().
//
// is_webui=true is REQUIRED on every auth-url call: it starts CPA's
// temporary redirect forwarder on the provider's fixed local port (codex
// 1455, anthropic 54545, antigravity 51121). Without it, the OAuth
// provider's browser redirect has nowhere to land and login silently fails.
//
// Auth: Authorization: Bearer <managementSecret> (see lifecycle.ts) — same
// per-run secret used by authFiles.ts / cliproxy.ts.
//
// 5 failed auths against CLIProxyAPI's own auth endpoints ⇒ a 30-minute IP
// ban server-side. A 401 response is therefore NEVER retried — exactly one
// attempt, then fail immediately (see pollAuthStatus's single-fetch body and
// pollUntilSettled's dedicated 'unauthorized' short-circuit, which is
// distinct from the transient-error retry path).
//
// Deliberately NO `import { shell } from 'electron'` and no hard dependency
// on lifecycle.ts's live module state — every external effect (HTTP,
// isRunning(), getManagementSecret()) is passed in via OAuthDeps, defaulting
// to the real implementations (defaultOAuthDeps(), wired by manager.ts, the
// only real call site). This keeps the module importable under a plain
// `bun run` with zero Electron runtime present (scripts/verify-oauth.ts).
// ---------------------------------------------------------------------------

import type { ProviderDescriptor } from './providers/types'
import { PROVIDERS } from './providers/registry'
import { isRunning as lifecycleIsRunning, getManagementSecret } from './lifecycle'

// ---------------------------------------------------------------------------
// Eligibility — derived from descriptors, never a hardcoded provider list.
// ---------------------------------------------------------------------------

/** A provider is OAuth-connectable iff its descriptor declares 'oauth' in
 *  authMethods. Gemini fails this (apiKey-only, see registry.ts) and
 *  therefore never renders a Connect button. */
export function isOAuthEligible(descriptor: Pick<ProviderDescriptor, 'authMethods'>): boolean {
  return descriptor.authMethods.includes('oauth')
}

/** All provider ids the Settings UI may offer a "Connect" action for, drawn
 *  purely from PROVIDERS' own authMethods — adding/removing 'oauth' from a
 *  descriptor is the only thing that changes this list. */
export function eligibleOAuthProviderIds(): string[] {
  return PROVIDERS.filter(isOAuthEligible).map((p) => p.id)
}

// ---------------------------------------------------------------------------
// Deps — every external effect this module performs, injectable so the
// harness never touches the network, Electron, or lifecycle.ts's live
// process-supervision state.
// ---------------------------------------------------------------------------

export interface OAuthDeps {
  /** Returns the parsed JSON body AND the HTTP status (401 handling needs the
   *  status code, not just a thrown Error). */
  fetchJsonWithStatus: (
    url: string,
    init: { method?: string; headers: Record<string, string> }
  ) => Promise<{ status: number; body: unknown }>
  /** Whether the managed routing-proxy child process is currently running. */
  isRunning: () => boolean
  /** The live per-run management-API secret, or null if the proxy was never
   *  started this run (see lifecycle.ts's own doc comment). */
  getManagementSecret: () => string | null
}

async function realFetchJsonWithStatus(
  url: string,
  init: { method?: string; headers: Record<string, string> }
): ReturnType<OAuthDeps['fetchJsonWithStatus']> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    signal: AbortSignal.timeout(10_000)
  })
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

export function defaultOAuthDeps(): OAuthDeps {
  return {
    fetchJsonWithStatus: realFetchJsonWithStatus,
    isRunning: lifecycleIsRunning,
    getManagementSecret
  }
}

function authHeaders(managementSecret: string): Record<string, string> {
  return { Authorization: `Bearer ${managementSecret}` }
}

// ---------------------------------------------------------------------------
// startProviderLogin — GET /v0/management/<provider>-auth-url?is_webui=true
// ---------------------------------------------------------------------------

export interface StartLoginResult {
  url: string
  state: string
  flow?: 'device'
  userCode?: string
  expiresIn?: number
}

export class OAuthLoginRefusedError extends Error {}
export class OAuthUnauthorizedError extends Error {}

function parseStartLoginBody(body: unknown): StartLoginResult {
  const b = (body ?? {}) as Record<string, unknown>
  const url = typeof b.url === 'string' ? b.url : null
  const state = typeof b.state === 'string' ? b.state : null
  if (!url || !state) {
    throw new Error('Provider auth-url response missing url/state')
  }
  return {
    url,
    state,
    flow: b.flow === 'device' ? 'device' : undefined,
    userCode: typeof b.user_code === 'string' ? b.user_code : undefined,
    expiresIn: typeof b.expires_in === 'number' ? b.expires_in : undefined
  }
}

/**
 * Kick off a provider OAuth login: fetch the provider's auth-url, always
 * with is_webui=true, and return the url/state (+ device-flow fields if
 * present) so the caller can open it in the browser AND show it as a
 * visible fallback link/code in the UI.
 *
 * Refuses immediately (OAuthLoginRefusedError) if the provider isn't
 * OAuth-eligible, or the routing proxy isn't installed/running, or it has
 * no live management secret — never hangs waiting on a process that will
 * never answer.
 *
 * A 401 response fails immediately with exactly this one attempt — this
 * function performs a single fetch, no internal retry loop.
 */
export async function startProviderLogin(
  providerId: string,
  baseUrl: string,
  deps: OAuthDeps = defaultOAuthDeps()
): Promise<StartLoginResult> {
  const descriptor = PROVIDERS.find((p) => p.id === providerId)
  if (!descriptor || !isOAuthEligible(descriptor)) {
    throw new OAuthLoginRefusedError(`${providerId} does not support OAuth login`)
  }
  if (!deps.isRunning()) {
    throw new OAuthLoginRefusedError(
      'The routing proxy is not running — start it in Settings before connecting a provider.'
    )
  }
  const secret = deps.getManagementSecret()
  if (!secret) {
    throw new OAuthLoginRefusedError('The routing proxy has no active management session.')
  }

  const url = new URL(`/v0/management/${providerId}-auth-url`, baseUrl)
  url.searchParams.set('is_webui', 'true')

  const { status, body } = await deps.fetchJsonWithStatus(url.toString(), {
    headers: authHeaders(secret)
  })
  if (status === 401) {
    throw new OAuthUnauthorizedError(`Unauthorized starting ${providerId} login (401)`)
  }
  if (status < 200 || status >= 300) {
    throw new Error(`GET ${providerId}-auth-url -> HTTP ${status}`)
  }

  return parseStartLoginBody(body)
}

// ---------------------------------------------------------------------------
// pollAuthStatus — GET /v0/management/get-auth-status?state=<state>
// ---------------------------------------------------------------------------

export type AuthStatus = 'ok' | 'wait' | 'error'

export interface PollResult {
  status: AuthStatus
  error?: string
}

/** Single poll call — never retries internally; the caller's loop decides
 *  cadence/timeout/retry policy (see pollUntilSettled). A 401 throws
 *  OAuthUnauthorizedError; the caller must treat that as terminal, never
 *  call pollAuthStatus again for the same login attempt. */
export async function pollAuthStatus(
  state: string,
  baseUrl: string,
  deps: OAuthDeps = defaultOAuthDeps()
): Promise<PollResult> {
  const secret = deps.getManagementSecret()
  if (!secret) {
    throw new OAuthLoginRefusedError('The routing proxy has no active management session.')
  }
  const url = new URL('/v0/management/get-auth-status', baseUrl)
  url.searchParams.set('state', state)

  const { status, body } = await deps.fetchJsonWithStatus(url.toString(), {
    headers: authHeaders(secret)
  })
  if (status === 401) {
    throw new OAuthUnauthorizedError(`Unauthorized polling auth status (401)`)
  }
  if (status < 200 || status >= 300) {
    throw new Error(`GET get-auth-status -> HTTP ${status}`)
  }
  const b = (body ?? {}) as Record<string, unknown>
  const raw = typeof b.status === 'string' ? b.status : 'error'
  const parsed: AuthStatus = raw === 'ok' || raw === 'wait' ? raw : 'error'
  return {
    status: parsed,
    error: typeof b.error === 'string' ? b.error : undefined
  }
}

// ---------------------------------------------------------------------------
// pollUntilSettled — the timed/bounded/retry-tolerant poll loop.
//
// - Polls every intervalMs (default 2000).
// - Timeout: expiresInSec if provided by startProviderLogin (device flows —
//   callers pass CLIProxyAPI's own expires_in, e.g. 30 min), else
//   defaultTimeoutMs (5 min interactive default).
// - A 401 fails IMMEDIATELY — exactly one attempt at the endpoint, no retry,
//   because CLIProxyAPI bans the IP for 30 minutes after 5 failed auths.
// - Any OTHER error (network blip, transient 5xx, malformed body) is
//   tolerated up to maxTransientErrors consecutive times before the whole
//   poll fails — a single flaky response must not abort a login the user is
//   actively completing in the browser.
// ---------------------------------------------------------------------------

export interface PollUntilSettledOptions {
  intervalMs?: number
  /** Explicit deadline in ms from now. If omitted, derived from
   *  expiresInSec (device flows) or defaultTimeoutMs. */
  timeoutMs?: number
  expiresInSec?: number
  defaultTimeoutMs?: number
  maxTransientErrors?: number
  /** Injectable sleep so the harness runs with zero real wall-clock delay. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock (ms since epoch) so the harness can simulate timeout
   *  without waiting in real time. */
  now?: () => number
}

export type PollUntilSettledResult =
  | { outcome: 'ok' }
  | { outcome: 'error'; error: string }
  | { outcome: 'timeout' }
  | { outcome: 'unauthorized' }

const DEFAULT_INTERVAL_MS = 2000
const DEFAULT_TIMEOUT_MS = 5 * 60_000
const DEFAULT_MAX_TRANSIENT_ERRORS = 5

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** One poll attempt's outcome, from pollUntilSettled's point of view:
 *  either a terminal result (return it and stop), or 'continue' (still
 *  waiting — sleep and try again). Extracted from pollUntilSettled's loop
 *  body to keep the loop itself simple (sonarjs/cognitive-complexity). */
type AttemptOutcome = PollUntilSettledResult | { outcome: 'continue' }

async function attemptOnePoll(
  state: string,
  baseUrl: string,
  deps: OAuthDeps,
  maxTransientErrors: number,
  consecutiveTransientErrors: number
): Promise<{ outcome: AttemptOutcome; consecutiveTransientErrors: number }> {
  try {
    const result = await pollAuthStatus(state, baseUrl, deps)
    if (result.status === 'ok') return { outcome: { outcome: 'ok' }, consecutiveTransientErrors: 0 }
    if (result.status === 'error') {
      return {
        outcome: { outcome: 'error', error: result.error ?? 'Authentication failed' },
        consecutiveTransientErrors: 0
      }
    }
    // 'wait' — keep polling.
    return { outcome: { outcome: 'continue' }, consecutiveTransientErrors: 0 }
  } catch (err) {
    if (err instanceof OAuthUnauthorizedError) {
      // Exactly one attempt on a 401 — never retried, regardless of how
      // many transient errors preceded it.
      return { outcome: { outcome: 'unauthorized' }, consecutiveTransientErrors }
    }
    const next = consecutiveTransientErrors + 1
    if (next > maxTransientErrors) {
      return {
        outcome: {
          outcome: 'error',
          error: err instanceof Error ? err.message : 'Repeated transient errors polling status'
        },
        consecutiveTransientErrors: next
      }
    }
    return { outcome: { outcome: 'continue' }, consecutiveTransientErrors: next }
  }
}

/**
 * Poll get-auth-status on a fixed cadence until it resolves to ok/error or
 * the deadline passes. A 401 at any point fails the WHOLE poll immediately
 * with exactly the one attempt that produced it — see attemptOnePoll's
 * OAuthUnauthorizedError branch, which short-circuits before the
 * transient-error retry counter is ever consulted.
 */
export async function pollUntilSettled(
  state: string,
  baseUrl: string,
  deps: OAuthDeps = defaultOAuthDeps(),
  options: PollUntilSettledOptions = {}
): Promise<PollUntilSettledResult> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTransientErrors = options.maxTransientErrors ?? DEFAULT_MAX_TRANSIENT_ERRORS
  const sleep = options.sleep ?? realSleep
  const now = options.now ?? Date.now

  const timeoutMs =
    options.timeoutMs ?? (options.expiresInSec ? options.expiresInSec * 1000 : defaultTimeoutMs)
  const deadline = now() + timeoutMs

  let consecutiveTransientErrors = 0

  for (;;) {
    if (now() >= deadline) return { outcome: 'timeout' }

    const attempt = await attemptOnePoll(
      state,
      baseUrl,
      deps,
      maxTransientErrors,
      consecutiveTransientErrors
    )
    consecutiveTransientErrors = attempt.consecutiveTransientErrors
    if (attempt.outcome.outcome !== 'continue') return attempt.outcome

    if (now() + intervalMs >= deadline) return { outcome: 'timeout' }
    await sleep(intervalMs)
  }
}

// ---------------------------------------------------------------------------
// cancelProviderLogin — DELETE /v0/management/oauth-session?state=<state>
// ---------------------------------------------------------------------------

/** Cancel an in-flight login. Best-effort: swallow errors (the caller is
 *  abandoning the flow either way — e.g. the user closed the dialog). */
export async function cancelProviderLogin(
  state: string,
  baseUrl: string,
  deps: OAuthDeps = defaultOAuthDeps()
): Promise<void> {
  const secret = deps.getManagementSecret()
  if (!secret) return
  const url = new URL('/v0/management/oauth-session', baseUrl)
  url.searchParams.set('state', state)
  try {
    await deps.fetchJsonWithStatus(url.toString(), {
      method: 'DELETE',
      headers: authHeaders(secret)
    })
  } catch {
    // Best-effort cancel — nothing further to do.
  }
}
