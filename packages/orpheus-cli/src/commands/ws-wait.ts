/**
 * commands/ws-wait.ts — `ws wait <id...>` command implementation (U11).
 *
 * Waits for one or more workspaces to reach a terminal activity state, then
 * exits with a code reflecting the aggregate outcome.
 *
 * TRANSPORT
 * ---------
 * Uses socket-client.ts subscribe() to open a long-lived POST /subscribe
 * connection to the running Orpheus app. The server keeps the connection open
 * and streams newline-delimited JSON frames; each frame carries:
 *   { id: string, reason: string, status: string }
 *
 * When all workspace ids have received a terminal reason, the server closes
 * the connection; the client's done promise resolves.
 *
 * EXIT REASON TAXONOMY
 * --------------------
 *   done              → exit code 0   (workspace reached idle; session finished)
 *   blocked-permission → exit code 10  (waiting for a permission decision)
 *   blocked-input     → exit code 11  (waiting for user input)
 *   timeout           → exit code 12  (wait duration elapsed with no terminal state)
 *   died              → exit code 13  (session file gone / process dead)
 *
 * MULTI-ID AGGREGATION
 * --------------------
 * When multiple ids are given, the aggregate exit code uses the HIGHEST priority
 * reason across all ids. Priority order (highest first):
 *   died > timeout > blocked-permission > blocked-input > done
 *
 * DURATION PARSING
 * ----------------
 * --timeout accepts:
 *   - Plain integers treated as milliseconds (e.g. --timeout 5000)
 *   - Duration strings with a single suffix:
 *       s / sec / secs / second / seconds  → multiply by 1000
 *       m / min / mins / minute / minutes  → multiply by 60 000
 *       h / hr / hrs / hour / hours        → multiply by 3 600 000
 * Default: 10m (600 000 ms).
 *
 * APP NOT RUNNING
 * ---------------
 * AppNotRunningError (socket absent / token missing) means the Orpheus app is
 * not running. A workspace cannot be in an active state without the app, so
 * ws wait exits with code 13 (died) rather than triggering auto-launch.
 * This is consistent with the reasoning: the session is certainly not live.
 * isRead: false is intentional — we do NOT trigger auto-launch for this command
 * (auto-launch is suppressed by catching AppNotRunningError early in the handler
 * and exiting with code 13 directly).
 */

import { registerCommand } from '../cli.js'
import { subscribe, AppNotRunningError } from '../socket-client.js'
import { printLines, printResult, printError } from '../output.js'

// ---------------------------------------------------------------------------
// Duration parser
// ---------------------------------------------------------------------------

/**
 * Parse a --timeout value string into milliseconds.
 * Accepts plain integers (as ms) or duration strings like '10m', '30s', '1h'.
 * Returns null if the string is invalid or results in a non-positive number.
 */
function parseDurationMs(input: string): number | null {
  const trimmed = input.trim()
  if (trimmed === '') return null

  // Pure integer → treat as milliseconds
  if (/^\d+$/.test(trimmed)) {
    const ms = parseInt(trimmed, 10)
    return ms > 0 ? ms : null
  }

  // Duration with suffix
  const match =
    /^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(
      trimmed
    )
  if (!match) return null

  const value = parseFloat(match[1]!)
  const unit = match[2]!.toLowerCase()

  let ms: number
  if (unit === 'ms') {
    ms = value
  } else if (
    unit === 's' ||
    unit === 'sec' ||
    unit === 'secs' ||
    unit === 'second' ||
    unit === 'seconds'
  ) {
    ms = value * 1_000
  } else if (
    unit === 'm' ||
    unit === 'min' ||
    unit === 'mins' ||
    unit === 'minute' ||
    unit === 'minutes'
  ) {
    ms = value * 60_000
  } else {
    // h / hr / hrs / hour / hours
    ms = value * 3_600_000
  }

  return ms > 0 ? ms : null
}

// ---------------------------------------------------------------------------
// Exit reason → exit code
// ---------------------------------------------------------------------------

type WaitReason = 'done' | 'blocked-permission' | 'blocked-input' | 'timeout' | 'died'

const REASON_TO_EXIT_CODE: Record<WaitReason, number> = {
  done: 0,
  'blocked-permission': 10,
  'blocked-input': 11,
  timeout: 12,
  died: 13
}

// Priority for aggregate: higher number = higher priority (determines the aggregate exit code)
const REASON_PRIORITY: Record<WaitReason, number> = {
  done: 0,
  'blocked-input': 1,
  'blocked-permission': 2,
  timeout: 3,
  died: 4
}

function isValidReason(r: string): r is WaitReason {
  return r in REASON_TO_EXIT_CODE
}

/**
 * Return the aggregate reason from a list of per-id reasons.
 * Highest-priority reason wins.
 */
function aggregateReason(reasons: WaitReason[]): WaitReason {
  if (reasons.length === 0) return 'done'
  let best: WaitReason = reasons[0]!
  for (const r of reasons) {
    if (REASON_PRIORITY[r] > REASON_PRIORITY[best]) {
      best = r
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

registerCommand('ws wait', {
  // NOT isRead — we use the socket. But we suppress auto-launch manually (see handler).
  flags: {
    timeout: 'string'
  },
  handler: async (ctx) => {
    const workspaceIds = ctx.positionals
    if (workspaceIds.length === 0) {
      printError('at least one workspace id is required: ws wait <id...>', { exitCode: 2 })
      return
    }

    // Parse --timeout (default: 10 minutes)
    const DEFAULT_TIMEOUT_MS = 10 * 60_000
    let timeoutMs = DEFAULT_TIMEOUT_MS
    if (typeof ctx.flags.timeout === 'string' && ctx.flags.timeout !== '') {
      const parsed = parseDurationMs(ctx.flags.timeout)
      if (parsed == null) {
        printError(
          `invalid --timeout value: "${ctx.flags.timeout}". ` +
            'Use a duration like 10m, 30s, 1h, or a plain number in milliseconds.',
          { exitCode: 2 }
        )
        return
      }
      timeoutMs = parsed
    }

    // Collected per-id results (resolved as frames arrive)
    const results = new Map<string, WaitReason>()

    // Client-side timeout: bound the total wait duration independently of the server.
    // If the server closes first, the client's timer is cleared. If the client times
    // out first (e.g. if the server doesn't close promptly), unresolved ids get 'timeout'.
    let clientTimeoutHandle: ReturnType<typeof setTimeout> | null = null
    let clientTimedOut = false

    const onEvent = (evt: unknown): void => {
      if (evt == null || typeof evt !== 'object' || !('id' in evt) || !('reason' in evt)) {
        return
      }
      const frame = evt as { id: unknown; reason: unknown; status?: unknown }
      const id = typeof frame.id === 'string' ? frame.id : null
      const reason = typeof frame.reason === 'string' ? frame.reason : null
      if (id == null || reason == null) return
      if (!workspaceIds.includes(id)) return
      const validReason: WaitReason = isValidReason(reason) ? reason : 'died'
      results.set(id, validReason)
    }

    let subscription: { close: () => void; done: Promise<void> } | null = null

    try {
      // subscribe() synchronously calls resolveToken(); if AppNotRunningError is thrown
      // it propagates here before the connection is opened.
      subscription = subscribe(
        { workspaceIds, timeoutMs },
        onEvent,
        { timeoutMs } // client-side timeout mirrors --timeout
      )
    } catch (err: unknown) {
      if (err instanceof AppNotRunningError) {
        // App is not running; session cannot be live → treat all as died
        if (ctx.jsonMode) {
          const resultsList = workspaceIds.map((id) => ({ id, reason: 'died' }))
          printResult({ results: resultsList, aggregate: 'died' }, () => {})
        } else {
          printLines(
            'error: Orpheus app is not running — session cannot be active (treating as died)'
          )
          for (const id of workspaceIds) {
            printLines(`  ${id}  died`)
          }
        }
        process.exitCode = 13
        return
      }
      printError(err)
      return
    }

    // Arm client-side timeout (defense-in-depth: fires if server doesn't close in time)
    clientTimeoutHandle = setTimeout(() => {
      clientTimedOut = true
      clientTimeoutHandle = null
      subscription?.close()
    }, timeoutMs)

    // Wait for server to close (or client to force-close via timeout)
    await subscription.done

    // Clear client timeout if server closed first
    if (clientTimeoutHandle != null) {
      clearTimeout(clientTimeoutHandle)
      clientTimeoutHandle = null
    }

    // Fill any ids that never received a frame (should not happen normally but
    // guards against unexpected server closes or filtered frames).
    for (const id of workspaceIds) {
      if (!results.has(id)) {
        results.set(id, clientTimedOut ? 'timeout' : 'died')
      }
    }

    // Compute aggregate reason and exit code
    const allReasons = workspaceIds.map((id) => results.get(id)!)
    const aggregate = aggregateReason(allReasons)
    const exitCode = REASON_TO_EXIT_CODE[aggregate]

    // Output
    const resultsList = workspaceIds.map((id) => ({ id, reason: results.get(id)! }))

    printResult({ results: resultsList, aggregate }, () => {
      // Pretty mode: print per-id outcome then summary
      for (const { id, reason } of resultsList) {
        printLines(`  ${id}  ${reason}`)
      }
      if (workspaceIds.length > 1) {
        printLines(`aggregate: ${aggregate}`)
      }
    })

    process.exitCode = exitCode
  }
})
