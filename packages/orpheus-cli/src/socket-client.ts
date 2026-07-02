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
import { getCmdSockPath, getCmdTokenPath } from './paths.js'

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the Orpheus app is not running (socket absent or refused) or
 * when the auth token cannot be resolved. The CLI's auto-launch logic (U6)
 * catches this error class to trigger a fresh app launch.
 */
export class AppNotRunningError extends Error {
  constructor(reason?: string) {
    super(reason ?? 'Orpheus is not running (socket not found or token unavailable)')
    this.name = 'AppNotRunningError'
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

// ---------------------------------------------------------------------------
// Token resolution — resolved once per CLI process
// ---------------------------------------------------------------------------

let _cachedToken: string | null | undefined = undefined // undefined = not yet resolved

/**
 * Resolve the auth token, caching it for the lifetime of this CLI process.
 *
 * Resolution order:
 *   1. process.env.ORPHEUS_CMD_TOKEN (allows test scripts to inject a token)
 *   2. getCmdTokenPath() read from disk (written by startCommandServer)
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
    _cachedToken = envToken
    return _cachedToken
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
    const sockPath = getCmdSockPath()

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

      res.on('error', (err) => {
        settle(() => reject(err))
      })
    })

    req.setTimeout(timeoutMs, () => {
      settle(() => {
        req.destroy()
        reject(new Error(`request timed out after ${timeoutMs}ms`))
      })
    })

    req.on('error', (err: NodeJS.ErrnoException) => {
      settle(() => {
        if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
          reject(new AppNotRunningError(`cannot reach Orpheus socket at ${sockPath}: ${err.code}`))
        } else {
          reject(err)
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
    throw new CommandError('unauthorized: invalid or missing auth token')
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
 * @returns         { close, done } — call close() to tear down the connection;
 *                  done resolves when the server closes or the timeout fires.
 */
export function subscribe(
  payload: object,
  onEvent: (evt: unknown) => void,
  opts?: { timeoutMs?: number }
): { close: () => void; done: Promise<void> } {
  const token = resolveToken() // throws AppNotRunningError if unavailable

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS

  let reqRef: http.ClientRequest | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  function teardown(): void {
    if (timeoutHandle != null) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
    if (reqRef != null) {
      try {
        reqRef.destroy()
      } catch {
        /* ignore */
      }
      reqRef = null
    }
    resolveDone()
  }

  // Kick off the connection asynchronously (subscribe is not async itself so
  // the caller can get the close handle synchronously before the socket opens).
  process.nextTick(() => {
    const sockPath = getCmdSockPath()
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

      // Set up optional timeout once we have the response (connection is alive)
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          teardown()
        }, timeoutMs)
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

      res.on('error', () => {
        teardown()
      })
    })

    reqRef = req

    req.on('error', () => {
      teardown()
    })

    req.write(bodyStr)
    req.end()
  })

  return {
    close(): void {
      teardown()
    },
    done
  }
}
