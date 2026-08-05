/**
 * autolaunch.ts — decide HOW to launch the Orpheus app and what to tell the
 * user when that launch fails, kept separate from cli.ts's autoLaunch() so
 * the decision logic is directly unit-testable (see
 * scripts/verify-cli-autolaunch.ts) without spawning real processes.
 *
 * THE BUG THIS FIXES
 * -------------------
 * `orpheus tui` over SSH (Termius from a phone) used to hang ~15s then print
 * a misleading "Orpheus was launched but didn't come up in time." The root
 * cause: `open -a <App>` is a GUI/Aqua-session operation. An SSH login gets a
 * Background/StandardIO launchd bootstrap with NO Aqua session, so `open -a`
 * silently fails there — and the old code spawned it detached with
 * stdio:'ignore' + .unref(), discarding the exit code entirely, then polled
 * the full timeout waiting for a socket that was never going to appear.
 *
 * THE FIX, IN TWO PARTS
 * ----------------------
 * 1. Capture `open`'s exit code/stderr instead of discarding them. On
 *    failure, try `launchctl asuser <uid> open -a <App>` as a fallback — it
 *    routes into the user's actual GUI bootstrap session even when the
 *    spawning process (sshd) has none of its own. This still requires
 *    someone to be graphically logged in; an SSH-only Mac with nobody logged
 *    in graphically genuinely cannot start a GUI app, and that's reported
 *    accurately rather than papered over.
 * 2. If every launch attempt fails, fail FAST with a distinct, actionable
 *    error (AppNotRunningError#launchFailed) instead of burning the poll
 *    timeout on a hopeless wait.
 *
 * STRATEGY ORDER: plain `open -a` first, `launchctl asuser` second
 * -------------------------------------------------------------------
 * Both are attempted unconditionally (SSH detection via SSH_TTY/
 * SSH_CONNECTION is informational only, not a gate) because:
 *   - In a normal Terminal.app/local session, `open -a` succeeds immediately
 *     and `launchctl asuser` is never reached.
 *   - Over SSH, `open -a` fails fast (no Aqua session) and the code falls
 *     through to `launchctl asuser`, which succeeds when someone is
 *     graphically logged in.
 *   - Gating strictly on SSH_TTY/SSH_CONNECTION would be a heuristic that
 *     could be wrong (e.g. a launchd agent with no SSH env vars but still no
 *     GUI session); trying `open -a` first and falling back on failure is
 *     correct in strictly more cases and costs nothing extra when `open -a`
 *     already works.
 */

export type LaunchAttempt = {
  /** Human-readable label for this attempt, used in diagnostics only. */
  readonly label: string
  readonly command: string
  readonly args: readonly string[]
}

/**
 * Pure function: given the app name and the invoking process's uid, return
 * the ordered list of launch attempts to try. `uid` is nullable because
 * process.getuid() is undefined on non-POSIX platforms (not a concern for
 * this macOS-only CLI in practice, but keeps the function total).
 */
export function decideLaunchAttempts(appName: string, uid: number | null): LaunchAttempt[] {
  const attempts: LaunchAttempt[] = [
    { label: 'open -a (GUI session)', command: 'open', args: ['-a', appName] }
  ]
  if (uid != null) {
    attempts.push({
      label: 'launchctl asuser (SSH/no-GUI-session fallback)',
      command: 'launchctl',
      args: ['asuser', String(uid), 'open', '-a', appName]
    })
  }
  return attempts
}

export type LaunchAttemptResult = {
  readonly label: string
  readonly exitCode: number | null
  readonly stderr: string
}

/** True if every attempt in `results` failed (non-zero or null exit code). */
export function allAttemptsFailed(results: readonly LaunchAttemptResult[]): boolean {
  return results.length > 0 && results.every((r) => r.exitCode !== 0)
}

/**
 * Outcome of the whole auto-launch flow, folding together "did any spawn
 * attempt succeed" and "did the socket come up afterwards" into one of three
 * mutually exclusive kinds:
 *   - 'ready'        — socket became reachable; nothing more to do.
 *   - 'launchFailed'  — every spawn attempt itself failed (non-zero exit) —
 *                        distinct from a timeout: we KNOW the app was never
 *                        launched, so there's no point polling further.
 *   - 'timedOut'      — at least one spawn attempt reported success, but the
 *                        socket never came up within the deadline (the
 *                        genuine "cold Electron start is still starting up
 *                        but taking unusually long" case, or the app started
 *                        but failed after launch).
 */
export type LaunchOutcomeKind = 'ready' | 'launchFailed' | 'timedOut'

/**
 * Pure decision function: given whether any spawn attempt reported success
 * and whether the socket probe ultimately succeeded, classify the outcome.
 * Exported and tested directly (see scripts/verify-cli-autolaunch.ts) rather
 * than only reachable by driving the full async poll loop.
 */
export function classifyLaunchOutcome(input: {
  anyAttemptSucceeded: boolean
  probeSucceeded: boolean
}): LaunchOutcomeKind {
  if (input.probeSucceeded) return 'ready'
  if (!input.anyAttemptSucceeded) return 'launchFailed'
  return 'timedOut'
}

/**
 * Build the "every launch attempt failed" diagnostic message from the
 * per-attempt results — used for both the thrown error's message and (via
 * output.ts) what's ultimately shown to the user. Pure string formatting.
 */
export function formatLaunchFailureDetail(results: readonly LaunchAttemptResult[]): string {
  return results
    .map((r) => {
      const codePart = r.exitCode == null ? 'no exit code' : `exit ${r.exitCode}`
      const stderrPart = r.stderr.trim().length > 0 ? `: ${r.stderr.trim()}` : ''
      return `${r.label} (${codePart})${stderrPart}`
    })
    .join('; ')
}

// ---------------------------------------------------------------------------
// Poll-loop scheduling — stop burning a fixed sleep after an instant failure
// ---------------------------------------------------------------------------

/**
 * One step of the poll loop's scheduling decision, computed BEFORE each probe
 * so the caller knows whether it's even worth probing again. Pure function of
 * elapsed/deadline state — the actual probe (a real socket connect) stays in
 * cli.ts; this only decides the *shape* of the loop.
 *
 * The old loop always slept a fixed pollIntervalMs after EVERY probe attempt,
 * including one that resolved false almost immediately (e.g. ENOENT on a
 * missing socket file) — burning the full timeout in fixed-size chunks
 * regardless of how quickly failure was actually knowable. This models the
 * same "probe, then decide" step but leaves the interval as a genuine upper
 * bound on wait-per-probe rather than an unconditional sleep tacked on after
 * a probe that already returned.
 */
export function nextPollDelayMs(input: {
  probeSucceeded: boolean
  elapsedMsSinceProbeStart: number
  pollIntervalMs: number
}): number {
  if (input.probeSucceeded) return 0
  // The probe itself already consumed `elapsedMsSinceProbeStart` waiting on
  // the socket (probeSocket's own internal timeout/connect-or-error race).
  // Only sleep the REMAINDER of the interval, never the whole interval again
  // on top of time already spent — a probe that fails in under a millisecond
  // (ENOENT) still gets a bounded gap before retrying (avoid hammering), but
  // a probe that itself took the full interval to fail sleeps 0 extra.
  const remaining = input.pollIntervalMs - input.elapsedMsSinceProbeStart
  return remaining > 0 ? remaining : 0
}
