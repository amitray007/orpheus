/**
 * output.ts — Output rendering for the Orpheus CLI.
 *
 * Two modes, selected by the --json flag:
 *   --json  : print stable JSON.stringify of the result object to stdout.
 *   default : human-readable output using the helpers below.
 *
 * Errors (and the app-not-running notice — see printNotice) always go to
 * stderr with a non-zero exit code. printNotice is the one exception to the
 * "error:"-prefixed styling below: the app simply not being open yet isn't a
 * user-caused failure, so it's worded as a calm notice instead — but the
 * exit code is still non-zero, same as every other failure to complete.
 *
 * EXIT CODES
 * ----------
 *   0  — success
 *   1  — general error (AppNotRunningError, CommandError, usage error, etc.)
 *   2  — usage / arg parsing error
 *   3  — data not found (OrpheusDataNotFoundError, project/workspace not found)
 *  10+ — reserved for ws wait exit codes (U11): 10 blocked, 11 timeout, 12 died, 13 etc.
 *         These codes are never emitted by output.ts; U11 sets process.exitCode directly.
 */

import { AppNotRunningError, CommandError } from './socket-client.js'
import { resolveAppName } from './paths.js'

// ---------------------------------------------------------------------------
// Internal state: json mode toggled once at startup by cli.ts
// ---------------------------------------------------------------------------

let _jsonMode = false

/** Call once at startup (after arg parsing) to enable JSON output mode. */
export function setJsonMode(enabled: boolean): void {
  _jsonMode = enabled
}

export function isJsonMode(): boolean {
  return _jsonMode
}

// ---------------------------------------------------------------------------
// Success output
// ---------------------------------------------------------------------------

/**
 * Print a result object.
 * In --json mode: JSON.stringify to stdout.
 * In pretty mode: delegates to the provided prettyFn, or falls back to
 * printJson if none is supplied.
 */
export function printResult(obj: unknown, prettyFn?: () => void): void {
  if (_jsonMode) {
    process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
  } else if (prettyFn != null) {
    prettyFn()
  } else {
    printJson(obj)
  }
}

/** Always pretty-prints JSON to stdout regardless of --json mode. */
export function printJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

/**
 * Replace ASCII control characters (0x00–0x1f, incl. newlines/tabs) and DEL
 * (0x7f) with a single space, collapsing runs. Done by char-code scan rather
 * than a control-char regex (which trips the no-control-regex lint rule) — a
 * stray newline/tab in a name must not corrupt a table row.
 */
function stripControlChars(value: string): string {
  let out = ''
  let inRun = false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const isControl = code <= 0x1f || code === 0x7f
    if (isControl) {
      if (!inRun) {
        out += ' '
        inRun = true
      }
    } else {
      out += value[i]
      inRun = false
    }
  }
  return out
}

/**
 * Sanitize and truncate a string for human-readable table/tree display.
 *
 * - Replaces control chars / newlines with a single space (defensive: a raw
 *   newline in a workspace name would otherwise split the table row across
 *   multiple lines and corrupt the layout).
 * - Truncates to `maxWidth` chars, appending a trailing '…' when the
 *   (sanitized) value was longer than `maxWidth`, so the visible result is
 *   at most `maxWidth` chars including the ellipsis.
 *
 * This is DISPLAY-ONLY. Never apply this to --json output — scripts consuming
 * --json must always get the full, untruncated value.
 */
export function truncateForDisplay(value: string, maxWidth: number): string {
  const sanitized = stripControlChars(value)
  if (sanitized.length <= maxWidth) return sanitized
  return sanitized.slice(0, Math.max(0, maxWidth - 1)) + '…'
}

/**
 * Print a two-column key/value table from an object.
 * Keys are left-padded to align the value column.
 *
 * Example:
 *   workspaceId  abc-123
 *   projectId    def-456
 *   cwd          /Users/me/code/foo
 */
export function printKeyValue(obj: Record<string, unknown>): void {
  const entries = Object.entries(obj)
  if (entries.length === 0) return
  const maxKeyLen = entries.reduce((m, [k]) => (k.length > m ? k.length : m), 0)
  for (const [key, value] of entries) {
    const padded = key.padEnd(maxKeyLen)
    const val = value === null || value === undefined ? '(none)' : String(value)
    process.stdout.write(`  ${padded}  ${val}\n`)
  }
}

/**
 * Print a table to stdout.
 *
 * @param rows    Array of row objects.
 * @param columns Array of { key, header, width? } descriptors.
 *                width is a minimum column width; the column expands to fit data.
 */
export type TableColumn<T> = {
  key: keyof T
  header: string
  width?: number
}

export function printTable<T extends Record<string, unknown>>(
  rows: T[],
  columns: TableColumn<T>[]
): void {
  if (rows.length === 0) {
    process.stdout.write('  (none)\n')
    return
  }

  // Compute column widths: max of header length, min width, and all cell values
  const widths: number[] = columns.map((col) => {
    const minW = col.width ?? col.header.length
    const dataMax = rows.reduce((m, r) => {
      const len = String(r[col.key] ?? '').length
      return len > m ? len : m
    }, 0)
    return Math.max(minW, col.header.length, dataMax)
  })

  // Header row
  const header = columns.map((col, i) => col.header.padEnd(widths[i]!)).join('  ')
  process.stdout.write(`  ${header}\n`)

  // Separator
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')
  process.stdout.write(`  ${sep}\n`)

  // Data rows
  for (const row of rows) {
    const line = columns.map((col, i) => String(row[col.key] ?? '').padEnd(widths[i]!)).join('  ')
    process.stdout.write(`  ${line}\n`)
  }
}

// ---------------------------------------------------------------------------
// Error output
// ---------------------------------------------------------------------------

/** Print a plain message to stdout (no prefix). */
export function printLines(...lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(line + '\n')
  }
}

/**
 * Emit an error, respecting --json mode.
 *
 * In --json mode: writes `{"error": "<msg>", "code": <exitCode>}` to stdout
 * (so tooling can reliably parse a single JSON document from stdout
 * regardless of success/failure) and sets process.exitCode.
 * In plain mode: writes `<prefix>: <msg>` to stderr and sets process.exitCode.
 */
function emitError(msg: string, exitCode: number, prefix: string): void {
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify({ error: msg, code: exitCode }) + '\n')
  } else {
    process.stderr.write(`${prefix}: ${msg}\n`)
  }
  process.exitCode = exitCode
}

/**
 * Print an informational notice — a situation that isn't a failure the user
 * caused, so it's worded calmly with no "error:" prefix and no scary
 * styling. Still sets a non-zero exit code: the command didn't do its work,
 * and scripts/agents driving `orpheus` must be able to tell.
 *
 * Stream/JSON behavior deliberately mirrors emitError (same stderr/stdout
 * split, same --json envelope shape, reuses its exact writer) so tooling
 * that already parses CLI output doesn't need a second code path — only the
 * plain-mode TEXT differs (no prefix, multi-line rather than single-line).
 */
function emitNotice(lines: string[], exitCode: number): void {
  const msg = lines.join('\n')
  if (isJsonMode()) {
    emitError(msg, exitCode, '')
  } else {
    process.stderr.write(msg + '\n')
    process.exitCode = exitCode
  }
}

/**
 * Print the "Orpheus isn't running" notice. Not routed through printError:
 * the app simply isn't open yet, which isn't something the user did wrong,
 * so it gets calm phrasing instead of error styling. Exit code stays
 * non-zero — the command still didn't complete.
 *
 * Distinguishes the two real cases via AppNotRunningError#timedOutAfterLaunch:
 * - false (default): socket/token absent — the app was never running, and
 *   the CLI never attempted to launch it (read commands skip auto-launch).
 * - true: the CLI DID launch the app (autoLaunch() in cli.ts) but the
 *   socket never came up within the timeout.
 * Both point at the same fix — open the app — via the exact `open -a`
 * command for the invoked variant (resolveAppName(), never hardcoded).
 */
export function printNotice(err: AppNotRunningError, opts?: { exitCode?: number }): void {
  const exitCode = opts?.exitCode ?? 1
  const appName = resolveAppName()
  const openCmd = `open -a "${appName}"`

  const lines = err.timedOutAfterLaunch
    ? [`Orpheus was launched but didn't come up in time. Try opening it directly:`, `  ${openCmd}`]
    : [`Orpheus isn't running. Start it with:`, `  ${openCmd}`]

  emitNotice(lines, exitCode)
}

/**
 * Print an error message and set an appropriate exit code. Respects --json
 * mode (see emitError).
 *
 * - AppNotRunningError → delegated to printNotice (not a user-caused error;
 *   see its doc comment) rather than handled here.
 * - CommandError       → exit 1, server error message.
 * - Usage errors       → exit 2.
 * - Data-not-found     → exit 3 (detected by message heuristic; callers can
 *                         also pass exitCode: 3 explicitly).
 * - Everything else    → exit 1.
 */
export function printError(err: unknown, opts?: { exitCode?: number; prefix?: string }): void {
  if (err instanceof AppNotRunningError) {
    printNotice(err, { exitCode: opts?.exitCode })
    return
  }

  const prefix = opts?.prefix ?? 'error'
  let msg: string
  const exitCode = opts?.exitCode ?? 1

  if (err instanceof CommandError) {
    msg = err.message
  } else if (err instanceof Error) {
    msg = err.message
  } else if (typeof err === 'string') {
    msg = err
  } else {
    msg = String(err)
  }

  emitError(msg, exitCode, prefix)
}

/** Print a usage/arg-parsing error (exit 2). Respects --json mode. */
export function printUsageError(msg: string): void {
  emitError(msg, 2, 'usage error')
}

/** Print a not-found error (exit 3). Respects --json mode. */
export function printNotFoundError(msg: string): void {
  emitError(msg, 3, 'not found')
}
