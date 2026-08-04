/**
 * socket-client.ts — CLI-side client for the Orpheus command socket.
 *
 * PROTOCOL OVERVIEW
 * -----------------
 * The Orpheus app runs a Unix-domain HTTP server at getCmdSockPath().
 * The client authenticates via a bearer token stored at getCmdTokenPath().
 *
 * Request:  POST /cmd  HTTP/1.1
 *           x-orpheus-token: <token>
 *           content-type: application/json
 *           Body: { action: string; args?: object; context?: { workspaceId?: string } }
 *
 * Response: { ok: true; data: unknown } | { ok: false; error: string }
 *           HTTP 200 for ok:true and domain errors (ok:false)
 *           HTTP 401 for bad/missing token
 *           HTTP 400 for unknown action or unparseable body
 *
 * SUBSCRIBE TRANSPORT (forward-compatible primitive — server side added in U11)
 * -----------------------------------------------------------------------------
 * subscribe() opens a long-lived POST /subscribe connection. The request body
 * contains a JSON payload (the subscription descriptor). The server keeps the
 * response open and streams newline-delimited JSON event frames; the client
 * invokes onEvent for each frame. The connection stays open until:
 *   - the server closes it (done promise resolves)
 *   - close() is called by the caller
 *   - opts.timeoutMs fires
 *
 * U11 must implement POST /subscribe on the server with this matching framing:
 *   - Accept the same x-orpheus-token header
 *   - Keep the response connection open with 200 OK
 *   - Stream newline-delimited JSON frames, each terminated with \n
 *   - Close the response when the subscription is complete or the client disconnects
 *
 * TOKEN RESOLUTION
 * ----------------
 * Resolved once per CLI process and cached in a module-level variable:
 *   1. process.env.ORPHEUS_CMD_TOKEN (internal/testing override)
 *   2. Read getCmdTokenPath() from disk (the file written by startCommandServer)
 * If neither source yields a token, AppNotRunningError is thrown.
 *
 * WORKSPACE CONTEXT AUTO-INJECTION
 * ---------------------------------
 * sendCommand() auto-injects context.workspaceId from process.env.ORPHEUS_WORKSPACE_ID
 * when the caller does not explicitly pass a context. This means commands issued
 * from within a workspace terminal (where ORPHEUS_WORKSPACE_ID is set) work
 * zero-config. An explicit context argument always takes priority.
 */

import * as http from 'node:http'
import * as fs from 'node:fs'
import { getCmdSockPath, getCmdTokenPath, ambientTokenOverrideIsTrusted } from './paths.js'

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the Orpheus app is not running (socket absent or refused) or
 * when the auth token cannot be resolved. The CLI's auto-launch logic (U6)
 * catches this error class to trigger a fresh app launch.
 *
 * `timedOutAfterLaunch` distinguishes the two cases output.ts's notice needs
 * to word differently: false/absent (default) means the socket/token was
 * never found — the app was simply never running. true means the CLI DID
 * launch the app (autoLaunch() in cli.ts) but the socket never came up
 * within the timeout — set only at that one throw site.
 */
export class AppNotRunningError extends Error {
  readonly timedOutAfterLaunch: boolean

  constructor(reason?: string, opts?: { timedOutAfterLaunch?: boolean }) {
    super(reason ?? 'Orpheus is not running (socket not found or token unavailable)')
    this.name = 'AppNotRunningError'
    this.timedOutAfterLaunch = opts?.timedOutAfterLaunch ?? false
  }
}

/**
 * Thrown when the server responds with { ok: false, error: string }.
 * The server error message is preserved in this.message.
 */
export class CommandError extends Error {
  constructor(serverMessage: string) {
    super(serverMessage)
    this.name = 'CommandError'
  }
}

/**
 * The /cmd transport failed after a request may have reached the server.
 * Mutating commands must not auto-retry this error because the first attempt
 * may already have applied.
 */
export class CommandTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandTransportError'
  }
}

// 'unavailable' is distinct from the generic 'transport' kind: it means the
// socket itself could not be reached at all (ENOENT/ECONNREFUSED — same
// signal rawPost()'s isUnavailableSocketCode() uses to decide AppNotRunningError
// for the /cmd path), as opposed to a transport failure on an otherwise-live
// socket (a response aborting mid-stream, a read error, etc). tui/entry.ts's
// reconnect loop uses this to tell "the app was never reachable in the first
// place" apart from "an established connection dropped" — see its own doc
// comment on attemptReconnect() for why that distinction matters.
export type SubscriptionErrorKind = 'auth' | 'http' | 'transport' | 'unavailable'

/**
 * A failure of the /subscribe HTTP stream itself, rather than a workspace wait
 * outcome. Keeping these failures typed prevents ws wait from fabricating a
 * per-workspace "died" result when authentication or transport failed before
 * the server could report any workspace state.
 */
export class SubscriptionError extends Error {
  readonly kind: SubscriptionErrorKind
  readonly statusCode: number | null

  constructor(kind: SubscriptionErrorKind, message: string, statusCode: number | null = null) {
    super(message)
    this.name = 'SubscriptionError'
    this.kind = kind
    this.statusCode = statusCode
  }
}

// ---------------------------------------------------------------------------
// Connection resolution — cached for the CLI process, invalidated on retry
// ---------------------------------------------------------------------------

let _cachedToken: string | null | undefined = undefined // undefined = not yet resolved
let _cachedSocketPath: string | undefined

/**
 * Clear all resolved command-server connection material.
 *
 * The top-level CLI calls this before its one auto-launch/reconnect retry so a
 * cached missing-token sentinel, stale token, or stale socket selection cannot
 * be reused. No token value is returned or logged.
 */
export function invalidateConnectionCache(): void {
  _cachedToken = undefined
  _cachedSocketPath = undefined
}

function resolveSocketPath(): string {
  if (_cachedSocketPath === undefined) {
    _cachedSocketPath = getCmdSockPath()
  }
  return _cachedSocketPath
}

/**
 * Resolve the auth token, caching it for the lifetime of this CLI process.
 *
 * Resolution order:
 *   1. process.env.ORPHEUS_CMD_TOKEN (allows test scripts to inject a token) —
 *      but ONLY when ambientTokenOverrideIsTrusted() says the invoked and
 *      ambient app variants agree (or ORPHEUS_FORCE_CROSS_VARIANT=1). A bare
 *      token string has no embedded variant to cross-check the way
 *      getCmdSockPath()'s path override does (see paths.ts's
 *      "CROSS-VARIANT TALK GUARD" and ambientTokenOverrideIsTrusted()'s doc
 *      comment) — ORPHEUS_CMD_SOCK/ORPHEUS_CMD_TOKEN are injected together
 *      as a matched pair, so an untrusted socket override implies an
 *      untrusted token override too, even though the token itself can't be
 *      inspected directly.
 *   2. getCmdTokenPath() read from disk (written by startCommandServer) —
 *      also the fallback when step 1's token is present but distrusted.
 *
 * Throws AppNotRunningError if no token is available from either source.
 */
export function resolveToken(): string {
  if (_cachedToken !== undefined) {
    if (_cachedToken === null) {
      throw new AppNotRunningError(
        'Orpheus auth token is unavailable (app not running or ORPHEUS_CMD_TOKEN not set)'
      )
    }
    return _cachedToken
  }

  // 1. Env-var override (primarily for tests and internal tooling)
  const envToken = process.env.ORPHEUS_CMD_TOKEN
  if (typeof envToken === 'string' && envToken.length > 0) {
    if (ambientTokenOverrideIsTrusted()) {
      _cachedToken = envToken
      return _cachedToken
    }
    // Untrusted: this token was very likely minted for a DIFFERENT app
    // instance's command server (see the doc comment above). Refuse it and
    // fall through to the invoked variant's own on-disk token. Warn
    // independently of getCmdSockPath()'s own check — ORPHEUS_CMD_SOCK and
    // ORPHEUS_CMD_TOKEN are injected together in practice, but nothing
    // guarantees a caller sets both, so this must not rely on the other
    // check having already fired.
    process.stderr.write(
      'orpheus: warning: ignoring inherited auth token — it was minted for a different ' +
        'app variant than this CLI is targeting. Set ORPHEUS_FORCE_CROSS_VARIANT=1 to override.\n'
    )
  }

  // 2. On-disk token file
  const tokenPath = getCmdTokenPath()
  let diskToken: string | null = null
  try {
    diskToken = fs.readFileSync(tokenPath, 'utf-8').trim()
  } catch {
    // File doesn't exist or can't be read — app not running
  }

  if (typeof diskToken === 'string' && diskToken.length > 0) {
    _cachedToken = diskToken
    return _cachedToken
  }

  // Neither source has a token — cache the null sentinel so subsequent calls
  // fail fast without re-reading the filesystem.
  _cachedToken = null
  throw new AppNotRunningError(
    'Orpheus auth token is unavailable (app not running or ORPHEUS_CMD_TOKEN not set)'
  )
}

// ---------------------------------------------------------------------------
// Low-level HTTP-over-Unix-socket helper
// ---------------------------------------------------------------------------

function isUnavailableSocketCode(code: string | undefined): boolean {
  return code === 'ENOENT' || code === 'ECONNREFUSED'
}

/**
 * Send a single POST request over the Unix domain socket and collect the full
 * response body. Rejects with AppNotRunningError on ENOENT/ECONNREFUSED.
 */
function rawPost(
  path: '/cmd' | '/subscribe',
  token: string,
  body: string,
  timeoutMs: number,
  onData?: (chunk: string) => void
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const sockPath = resolveSocketPath()

    const options: http.RequestOptions = {
      socketPath: sockPath,
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-orpheus-token': token
      }
    }

    let settled = false
    function settle(fn: () => void): void {
      if (settled) return
      settled = true
      fn()
    }

    const req = http.request(options, (res) => {
      const chunks: string[] = []
      res.setEncoding('utf-8')

      res.on('data', (chunk: string) => {
        if (onData != null) {
          // For streaming (subscribe), forward each chunk directly
          onData(chunk)
        } else {
          chunks.push(chunk)
        }
      })

      res.on('end', () => {
        settle(() =>
          resolve({
            statusCode: res.statusCode ?? 0,
            body: chunks.join('')
          })
        )
      })

      res.on('aborted', () => {
        settle(() =>
          reject(
            new CommandTransportError(
              'Orpheus command response was interrupted after the request was sent'
            )
          )
        )
      })

      res.on('error', (err: NodeJS.ErrnoException) => {
        settle(() =>
          reject(
            new CommandTransportError(
              `Orpheus command response failed after dispatch${
                err.code != null ? `: ${err.code}` : ''
              }`
            )
          )
        )
      })
    })

    req.setTimeout(timeoutMs, () => {
      settle(() => {
        req.destroy()
        reject(
          new CommandTransportError(
            `Orpheus command response timed out after ${timeoutMs}ms; the request may have applied`
          )
        )
      })
    })

    req.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (isUnavailableSocketCode(err.code)) {
          reject(new AppNotRunningError(`cannot reach Orpheus socket at ${sockPath}: ${err.code}`))
        } else {
          reject(
            new CommandTransportError(
              `Orpheus command transport failed after dispatch${
                err.code != null ? `: ${err.code}` : ''
              }`
            )
          )
        }
      })
    })

    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// sendCommand — the primary request/response primitive
// ---------------------------------------------------------------------------

// Slightly above the server's 30 s request timeout so a hung request rejects
// on the client before the server would close it.
const DEFAULT_TIMEOUT_MS = 35_000

/**
 * Send a command to the running Orpheus app and return the response data.
 *
 * - Resolves the auth token once (cached) and connects over the Unix socket.
 * - Auto-injects context.workspaceId from ORPHEUS_WORKSPACE_ID when the
 *   caller does not explicitly pass a context (zero-config inside a workspace).
 * - Throws AppNotRunningError if the socket is absent / refused.
 * - Throws CommandError if the server returns { ok: false, error }.
 */
export async function sendCommand(
  action: string,
  args?: object,
  context?: { workspaceId?: string }
): Promise<unknown> {
  const token = resolveToken() // throws AppNotRunningError if unavailable

  // Auto-inject workspaceId from the environment if the caller didn't provide one.
  const envWorkspaceId = process.env.ORPHEUS_WORKSPACE_ID
  const effectiveContext: { workspaceId?: string } | undefined =
    context != null
      ? context
      : typeof envWorkspaceId === 'string' && envWorkspaceId.length > 0
        ? { workspaceId: envWorkspaceId }
        : undefined

  const bodyObj: { action: string; args?: object; context?: { workspaceId?: string } } = { action }
  if (args != null) bodyObj.args = args
  if (effectiveContext != null) bodyObj.context = effectiveContext

  const bodyStr = JSON.stringify(bodyObj)

  const { statusCode, body } = await rawPost('/cmd', token, bodyStr, DEFAULT_TIMEOUT_MS)

  // 401 — bad or missing token
  if (statusCode === 401) {
    invalidateConnectionCache()
    throw new AppNotRunningError('Orpheus command authentication was rejected; reconnect required')
  }

  // Parse the ok-envelope
  let parsed: { ok: boolean; data?: unknown; error?: string }
  try {
    parsed = JSON.parse(body) as { ok: boolean; data?: unknown; error?: string }
  } catch {
    throw new Error(`unexpected non-JSON response from Orpheus (HTTP ${statusCode}): ${body}`)
  }

  if (parsed.ok) {
    return parsed.data
  }

  throw new CommandError(typeof parsed.error === 'string' ? parsed.error : 'unknown server error')
}

// ---------------------------------------------------------------------------
// subscribe — long-lived streaming primitive (server side added in U11)
// ---------------------------------------------------------------------------

// Default subscribe timeout: 5 minutes. Callers that need indefinite streaming
// should pass timeoutMs: 0 to disable the timeout.
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 5 * 60 * 1000

// Bound on how long CONNECTION ESTABLISHMENT (opening the Unix socket +
// receiving response headers with a 200 status) is allowed to take, applied
// REGARDLESS of what `opts.timeoutMs` the caller passed for the live-stream
// portion. See subscribe()'s "ESTABLISHMENT VS STREAM DEADLINE" doc comment
// for why this exists as a separate concern from the overall
// connect+stream deadline `timeoutMs` covers for positive values. 20s is
// generous for a Unix domain socket connect plus the app responding (both
// should normally complete in well under a second) while still catching a
// genuinely wedged connection (accepted the socket, never sent headers)
// promptly rather than hanging the caller's "connecting…" UI forever.
const CONNECTION_ESTABLISHMENT_TIMEOUT_MS = 20 * 1000

/**
 * Extract the server's `{ ok: false, error: "..." }` message from a
 * /subscribe error-response body, or undefined if the body isn't that shape
 * (blank, not JSON, or missing a string `error` field — the server always
 * sends this envelope for its own 4xx/429 responses, per commandServer.ts's
 * writeJsonResponse()/parseSubscribeRequestBody(), but a malformed or absent
 * body must not throw here; the caller falls back to a bare status message).
 *
 * Pure string parsing — exported so it's unit-testable without a live socket
 * or HTTP server. This is what used to be silently discarded: the transport
 * only ever surfaced `Orpheus subscription failed with HTTP ${statusCode}`,
 * which is why the /subscribe protocol-vs-stale-server mismatch that this
 * whole investigation started from took a Unix-socket proxy to diagnose
 * instead of just reading the error the server had already sent.
 */
export function extractSubscriptionErrorDetail(rawBody: string): string | undefined {
  const trimmed = rawBody.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (parsed == null || typeof parsed !== 'object') return undefined
  const error = (parsed as { error?: unknown }).error
  return typeof error === 'string' && error.length > 0 ? error : undefined
}

/**
 * Build the SubscriptionError for a non-200 /subscribe response, folding in
 * the server's own error message (see extractSubscriptionErrorDetail()) when
 * the body carries one. Pure function of (statusCode, rawBody) — exported
 * for unit testing; the 'auth'/'http' kind split and 401-specific copy match
 * subscribe()'s pre-existing behavior exactly, only the message detail is new.
 */
export function buildSubscriptionHttpError(statusCode: number, rawBody: string): SubscriptionError {
  const detail = extractSubscriptionErrorDetail(rawBody)
  if (statusCode === 401) {
    return new SubscriptionError(
      'auth',
      detail != null
        ? `Orpheus subscription authentication was rejected: ${detail}`
        : 'Orpheus subscription authentication was rejected',
      statusCode
    )
  }
  return new SubscriptionError(
    'http',
    detail != null
      ? `Orpheus subscription failed with HTTP ${statusCode}: ${detail}`
      : `Orpheus subscription failed with HTTP ${statusCode}`,
    statusCode
  )
}

/**
 * Open a long-lived streaming subscription to the Orpheus app.
 *
 * Transport: POST /subscribe — the server keeps the response open and emits
 * newline-delimited JSON event frames. Each complete \n-terminated line is
 * parsed as JSON and passed to onEvent. Partial lines (mid-frame) are buffered
 * across data chunks.
 *
 * SERVER SIDE ADDED IN U11 — this is the client primitive.
 * U11 must implement POST /subscribe on the command server with:
 *   - Same x-orpheus-token authentication
 *   - 200 OK with a streaming response body
 *   - Each event serialised as JSON followed by a newline (\n)
 *   - Graceful close when the subscription is done
 *
 * @param payload   The subscription descriptor sent as the JSON request body
 *                  (e.g. { action: 'subscribe', workspaceId: '...' }).
 * @param onEvent   Called for each newline-delimited JSON frame received.
 * @param opts      Optional: timeoutMs (0 = no timeout, default 5 min).
 * @returns         { close, done, timedOut } — call close() to tear down the
 *                  connection; done resolves when the server closes or the
 *                  timeout fires; timedOut identifies the latter case.
 *
 * ESTABLISHMENT VS STREAM DEADLINE (two different failure modes, one timer
 * used to cover both — this is the split that matters for `timeoutMs: 0`)
 * -----------------------------------------------------------------------
 * Before this split existed, a single `timeoutHandle` covered the ENTIRE
 * call from `subscribe()` to `teardown()` — both (a) "the Unix socket never
 * connects / the server never sends response headers" (an ESTABLISHMENT
 * failure — should always be bounded, regardless of the caller's desired
 * stream lifetime) and (b) "the live NDJSON stream itself should give up
 * after N ms" (a STREAM deadline — legitimately wants to be `0`/unbounded
 * for a long-lived TUI picker subscription). Passing `timeoutMs: 0` to get
 * (b) unbounded ALSO disabled (a) entirely (`if (timeoutMs > 0)` skipped
 * arming any timer) — so a server that accepted the socket but never sent
 * headers back left the caller stuck "connecting…" forever with no client-
 * side backstop either. Fixed by always arming
 * CONNECTION_ESTABLISHMENT_TIMEOUT_MS as a SEPARATE, always-on guard around
 * establishment only, cleared the instant a 200 response's headers are in
 * (regardless of `timeoutMs`), with the CALLER's `timeoutMs` behavior
 * unchanged after that point: `0` stays unbounded for the stream itself (the
 * actual fix for the 300s-death bug this whole change addresses), a
 * positive value keeps combining connect+stream into one deadline exactly
 * as before (the original `timeoutHandle` is simply never cleared early for
 * that case — same as today).
 */
export function subscribe(
  payload: object,
  onEvent: (evt: unknown) => void,
  opts?: { timeoutMs?: number }
): { close: () => void; done: Promise<void>; timedOut: () => boolean } {
  const token = resolveToken() // throws AppNotRunningError if unavailable

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS

  let reqRef: http.ClientRequest | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  // Separate establishment-only guard — see the "ESTABLISHMENT VS STREAM
  // DEADLINE" doc comment above. Only ever armed when `timeoutMs === 0`
  // (unbounded stream requested); for a positive `timeoutMs`, `timeoutHandle`
  // above already covers connect+stream as one deadline, unchanged from
  // before this split, so a second timer here would be redundant.
  let establishmentTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  let closed = false
  let resolveDone!: () => void
  let rejectDone!: (error: SubscriptionError) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  function clearEstablishmentTimeout(): void {
    if (establishmentTimeoutHandle != null) {
      clearTimeout(establishmentTimeoutHandle)
      establishmentTimeoutHandle = null
    }
  }

  function teardown(error?: SubscriptionError): void {
    if (closed) return
    closed = true
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
    clearEstablishmentTimeout()
    if (reqRef != null) {
      try {
        reqRef.destroy()
      } catch {
        /* ignore */
      }
      reqRef = null
    }
    if (error == null) {
      resolveDone()
    } else {
      rejectDone(error)
    }
  }

  // The deadline covers socket connection and response-header establishment,
  // not only an already-open response stream. A server that accepts the Unix
  // socket but never sends headers must still terminate at the caller's bound.
  // Unchanged for positive timeoutMs — this single timer still covers
  // connect+stream as one combined deadline exactly as before this fix.
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      teardown()
    }, timeoutMs)
  } else {
    // timeoutMs === 0 (unbounded stream requested): the stream itself must
    // stay unbounded, but ESTABLISHMENT still needs a real bound — see the
    // "ESTABLISHMENT VS STREAM DEADLINE" doc comment. Cleared as soon as a
    // 200 response's headers are confirmed, below.
    establishmentTimeoutHandle = setTimeout(() => {
      establishmentTimeoutHandle = null
      timedOut = true
      teardown(
        new SubscriptionError(
          'transport',
          `Orpheus subscription did not establish within ${CONNECTION_ESTABLISHMENT_TIMEOUT_MS}ms`
        )
      )
    }, CONNECTION_ESTABLISHMENT_TIMEOUT_MS)
  }

  // Kick off the connection asynchronously (subscribe is not async itself so
  // the caller can get the close handle synchronously before the socket opens).
  process.nextTick(() => {
    if (closed) return
    const sockPath = resolveSocketPath()
    const bodyStr = JSON.stringify(payload)

    const options: http.RequestOptions = {
      socketPath: sockPath,
      method: 'POST',
      path: '/subscribe',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(bodyStr),
        'x-orpheus-token': token
      }
    }

    const req = http.request(options, (res) => {
      res.setEncoding('utf-8')

      // Response headers are in — establishment is over (success OR a
      // non-200 error status; either way the connection DID establish,
      // it just may not have been accepted). Clear the establishment-only
      // guard now regardless of statusCode: a non-200 response gets its own
      // error handling below (still bounded, just via the error path, not
      // this timer), and a 200 response falls through to the unbounded
      // stream `timeoutMs === 0` requested.
      clearEstablishmentTimeout()

      const statusCode = res.statusCode ?? 0
      if (statusCode !== 200) {
        if (statusCode === 401) {
          invalidateConnectionCache()
        }
        // Collect the error body (small JSON envelope, not the NDJSON event
        // stream — that only starts once status 200 is confirmed above) so
        // the server's actual { ok: false, error } message reaches the
        // caller instead of being discarded. See
        // extractSubscriptionErrorDetail()'s doc comment for why this
        // mattered in practice. teardown() is idempotent (guarded by
        // `closed`), so if the body read is interrupted mid-flight the
        // fallback bare-status error below still wins the race safely.
        const errorChunks: string[] = []
        res.on('data', (chunk: string) => errorChunks.push(chunk))
        res.on('end', () => {
          teardown(buildSubscriptionHttpError(statusCode, errorChunks.join('')))
        })
        res.on('aborted', () => {
          teardown(buildSubscriptionHttpError(statusCode, errorChunks.join('')))
        })
        res.on('error', () => {
          teardown(buildSubscriptionHttpError(statusCode, errorChunks.join('')))
        })
        return
      }

      // Buffer for partial newline-delimited frames
      let lineBuf = ''

      res.on('data', (chunk: string) => {
        lineBuf += chunk
        // Process all complete newline-terminated frames
        let nl: number
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nl).trim()
          lineBuf = lineBuf.slice(nl + 1)
          if (line.length === 0) continue // skip blank lines
          try {
            const evt = JSON.parse(line) as unknown
            onEvent(evt)
          } catch {
            // Non-JSON frame — skip; could be a keepalive comment
          }
        }
      })

      res.on('end', () => {
        teardown()
      })

      res.on('aborted', () => {
        teardown(
          new SubscriptionError('transport', 'Orpheus subscription response was interrupted')
        )
      })

      res.on('error', (err: NodeJS.ErrnoException) => {
        teardown(
          new SubscriptionError(
            'transport',
            `Orpheus subscription response failed${err.code != null ? `: ${err.code}` : ''}`
          )
        )
      })
    })

    reqRef = req

    req.on('error', (err: NodeJS.ErrnoException) => {
      teardown(
        new SubscriptionError(
          isUnavailableSocketCode(err.code) ? 'unavailable' : 'transport',
          `cannot open Orpheus subscription${err.code != null ? `: ${err.code}` : ''}`
        )
      )
    })

    req.write(bodyStr)
    req.end()
  })

  return {
    close(): void {
      teardown()
    },
    done,
    timedOut(): boolean {
      return timedOut
    }
  }
}
