/**
 * statusMap.ts — pure thread-DB-turn-status + lock-liveness → WorkspaceStatus
 * mapping for Codex.
 *
 * Codex's analogue to src/main/sessionStatusMap.ts, but built over Codex's
 * OWN state database (support-multi-harness, thread-DB migration) rather
 * than a hand-rolled scan of its append-only rollout `.jsonl` transcript.
 * Claude's mapping (_mapFileStatus) reads a single self-describing status
 * field a live claude process writes to its own session file
 * (`busy`/`idle`/`waiting`/`shell`), where "the process wrote this recently"
 * and "the process is alive" are the same fact. Codex has no such file, but
 * DOES maintain ~/.codex/thread_history_1.sqlite's `thread_turns` table —
 * itself a direct analogue of Claude's per-pid session registry, just keyed
 * by thread (== workspace's bound `claude_session_id`) instead of pid — see
 * ./threadDb.ts's header for the full schema/verification detail. This
 * module combines TWO independent signals, same shape as the prior
 * rollout-scanning design, but the FIRST signal's source changed:
 *
 *   1. LATEST TURN STATUS — threadDb.ts's getLatestTurn(threadId), Codex's
 *      OWN recorded status for the most recent turn of this thread:
 *      'inProgress' | 'completed' | 'failed' | 'interrupted'. This directly
 *      REPLACES the old findLastCodexTaskEvent rollout-line scan (deleted —
 *      Codex now hands us the conclusion it already computed, instead of
 *      this module re-deriving it from raw event lines).
 *   2. LIVENESS — whether a `~/.codex/thread-writer-locks/<session-uuid>.lock`
 *      file is currently HELD by a live process (isLockHeld below,
 *      UNCHANGED from the prior design). See "WHY LIVENESS IS STILL NEEDED"
 *      below for why the thread DB does NOT make this redundant.
 *
 * WHY LIVENESS IS STILL NEEDED — THE THREAD DB ALONE CANNOT TELL YOU THE
 * PROCESS IS ALIVE. thread_turns is written BY the codex process as a side
 * effect of running; nothing else updates it. A turn's row is inserted (or
 * updated to 'inProgress') when the turn starts, and updated again to
 * 'completed'/'failed'/'interrupted' when it ends — but if the process is
 * killed mid-turn (SIGKILL, OOM, crash, power loss), NOTHING ever performs
 * that second write. The row is left at 'inProgress' forever, with no way
 * for a read-only observer of the DB alone to ever un-say it — this is
 * EXACTLY the same stuck-indicator failure mode the lock-liveness probe was
 * originally built to fix for the rollout-JSONL design, and migrating the
 * status SOURCE to the thread DB does not change that: the new source is
 * still just "the last thing the process wrote before it (maybe) died",
 * same shape as the old one, just structured instead of a raw event log.
 * The lock file's removal-on-exit (verified empirically — see isLockHeld's
 * own doc comment below for the full mechanism and verification) remains
 * the ONLY signal in this system that answers "is the writer still running
 * RIGHT NOW", independent of what it last wrote. mapCodexStatus therefore
 * keeps the exact same liveness-checked-first structure as before: lockHeld
 * is checked FIRST and wins unconditionally over even a fresh-looking
 * 'inProgress' status — do not reorder this "for symmetry" with Claude's
 * mapping, which has no equivalent split-source liveness concern.
 *
 * THE STUCK-INDICATOR FIX this module still encodes, now against the new
 * source: a crashed/killed Codex process leaves whatever it last wrote to
 * thread_turns forever — if the last write was 'inProgress', the DB alone
 * says "still working" with no way to ever un-say it. Liveness is the
 * correction, unconditional and cheap, exactly as before.
 *
 * status VALUES — verified directly against a real thread_history_1.sqlite
 * on this machine (tens of thousands of rows): exactly four distinct
 * values, 'inProgress' | 'completed' | 'failed' | 'interrupted', no others
 * observed. 'completed' | 'failed' | 'interrupted' all collapse to the SAME
 * "terminal" bucket for this module's purposes — a turn that is not
 * currently in flight, full stop; this module does not distinguish WHICH
 * terminal reason produced that state (matches the prior design's own
 * "terminal bucket" framing for task_complete/turn_complete/turn_aborted).
 *
 * Deliberately electron/db-free (fs-free too, now — unlike the prior
 * version, this module no longer reads the rollout file directly; that
 * responsibility moved to threadDb.ts, which owns the real SQLite
 * connection) so it can be imported directly by both statusState.ts (the
 * impure reconciler) and scripts/verify-codex-status.ts under plain
 * `bun run`. isLockHeld below is the one remaining fs-touching export here
 * (a real fs.openSync/closeSync probe against a real lock file path,
 * unchanged from the prior design) — kept in this leaf module for the same
 * reason it always was: so its regression test can call the real function
 * against a real temp directory instead of a reimplementation.
 */

import * as fs from 'node:fs'
import type { WorkspaceStatus } from '../../../shared/types'
import type { CodexLatestTurn } from './threadDb'

/**
 * Maps Codex's signals (its own latest-turn status from thread_history_1
 * .sqlite, thread-writer-lock liveness, and — for the ready/idle split —
 * how long ago this workspace's live session was last observed as "fresh":
 * either the latest turn's own completion timestamp, or the caller's first
 * observation of this live session, whichever is MORE RECENT — see
 * statusState.ts's reconcileOneWorkspace for that derivation) to the
 * WorkspaceStatus the UI drives off of.
 *
 * `idleDurationMs` applies to BOTH `latestTurn === null` (no turn ever
 * recorded yet for this thread id — e.g. discovery just bound it and no
 * turn has completed) and `latestTurn.status !== 'inProgress'` (the last
 * turn ended, for any of the three terminal reasons) — this function treats
 * them identically once both consult idleDurationMs, exactly as the prior
 * design's taskEvent===null/terminal branches did. It is `null` only when
 * there is no measurable anchor at all: `latestTurn.status === 'inProgress'`
 * (irrelevant — a turn that's in flight isn't idle, handled by its own
 * earlier branch) or a terminal turn whose completedAtMs was unusable. An
 * unmeasurable idle duration degrades to plain `'idle'` rather than
 * `'awaiting_input'` — it cannot honestly claim "recently finished"/
 * "recently observed alive", so it is not synthesized as one.
 *
 * `staleThresholdMs` mirrors the SAME app setting Claude's own
 * driveStatusTransition (src/main/sessionState.ts) reads
 * (`staleAfterMinutes`, converted to ms) — passed in as a plain number so
 * this function stays pure; reading the setting and computing "now minus
 * event time" are statusState.ts's job. The comparison here uses the SAME
 * operator Claude's does (`idleDurationMs >= staleThresholdMs -> idle`,
 * `< -> awaiting_input`) for consistency between the two harnesses' UI
 * behavior at the exact threshold boundary.
 *
 * TRUTH TABLE (deliberately spelled out rather than left to fall through an
 * if/else chain, since every branch here is individually verified by
 * scripts/verify-codex-status.ts):
 *
 *   lockHeld=false                                -> idle  (THE
 *     stuck-indicator fix, unconditional: the process that would act on any
 *     turn status is gone; showing anything but idle would be a lie the UI
 *     can never correct on its own. Wins over EVERY other input, including
 *     a fresh-looking 'inProgress' status.)
 *   lockHeld=true,  latestTurn.status='inProgress' -> in_progress (a turn is
 *     genuinely in flight under a still-running process)
 *   lockHeld=true,  latestTurn=null OR terminal status,
 *     idleDurationMs === null                      -> idle  (no turn ever
 *     recorded yet, OR a terminal turn whose "how long ago" is unmeasurable
 *     — either way there is nothing honest to measure idleness from, so
 *     this degrades to idle rather than guessing)
 *   lockHeld=true,  latestTurn=null OR terminal status,
 *     idleDurationMs < staleThresholdMs             -> awaiting_input
 *     (process alive and RECENTLY OBSERVED as such — either it just
 *     finished a turn, or it has never taken a turn but we only just saw it
 *     come alive)
 *   lockHeld=true,  latestTurn=null OR terminal status,
 *     idleDurationMs >= staleThresholdMs            -> idle  (process alive,
 *     but it has sat unobserved-as-fresh long enough to be stale, not fresh)
 *
 * ATTENTION IS NOT IMPLEMENTED FOR CODEX, AND MUST NOT BE SYNTHESIZED HERE.
 * Codex's shipped native binary genuinely CONTAINS approval-request event
 * variants — the concept is real, Codex has approvals, and approved/
 * denied/abort decisions genuinely happen. BUT these are emitted only on
 * Codex's LIVE event stream and are NOT recorded as a distinct thread_turns
 * status either (only the four verified values exist) — the thread DB
 * migration does not change this: 'attention' is not derivable from any
 * currently-read-only Codex data source. Do not "fix" this into a synthetic
 * attention state guessed from indirect signals (e.g. treating a long-idle
 * in_progress as attention) — that would be fabricating a signal this data
 * source does not carry. Nothing in this function's branches can produce
 * 'attention'; keep it that way.
 */
export function mapCodexStatus(
  latestTurn: CodexLatestTurn | null,
  lockHeld: boolean,
  idleDurationMs: number | null,
  staleThresholdMs: number
): WorkspaceStatus {
  // Liveness veto — checked FIRST and wins unconditionally over every other
  // input. See this module's header for why this ordering is load-bearing.
  if (!lockHeld) return 'idle'

  if (latestTurn?.status === 'inProgress') return 'in_progress'

  // Either no turn has ever been recorded (latestTurn === null) or the last
  // turn ended for any of the three terminal reasons ('completed' |
  // 'failed' | 'interrupted') — both branches now consult the SAME
  // idleDurationMs and apply the SAME threshold comparison, per this
  // function's doc comment above. An unmeasurable idle duration (no usable
  // anchor at all) cannot honestly claim "just finished"/"just observed
  // alive" — degrade to idle rather than guessing.
  if (idleDurationMs === null) return 'idle'

  return idleDurationMs >= staleThresholdMs ? 'idle' : 'awaiting_input'
}

/**
 * One workspace's tracked "when did we first see this specific live session"
 * stamp — statusState.ts holds a `Map<string, LiveObservationStamp>` keyed by
 * workspace id (impure state; see that file's header for why it can't live
 * here) and hands the CURRENT stamp (or `undefined` if none yet) to
 * deriveLiveObservationStamp below on every reconcile tick.
 */
export interface LiveObservationStamp {
  sessionId: string
  firstObservedLiveAtMs: number
}

/**
 * THE CORE OF THE AGE-ANCHORING FIX (support-multi-harness) — pure decision
 * logic for updating a workspace's live-observation stamp and deriving the
 * idleDurationMs to feed mapCodexStatus. UNCHANGED by the thread-DB
 * migration — the bug this fixes, and the reasoning behind the fix, are
 * about `codex resume`'s effect on WHEN a live session's own timestamp
 * appears fresh, which is orthogonal to which data source supplies that
 * timestamp. Extracted here (rather than left inline in statusState.ts's
 * reconcileOneWorkspace) for the same reason every other pure decision in
 * this file lives here: so scripts/verify-codex-status.ts can call the REAL
 * function directly instead of a reimplementation. statusState.ts becomes a
 * thin shell around this: hold the Map, call this each tick, write back the
 * returned stamp.
 *
 * THE BUG THIS FIXES: `codex resume <id>` replays a saved transcript into
 * the terminal but appends NOTHING new until the user's next turn — so
 * after an app restart where the user continues an existing conversation,
 * the process is brand new (lock freshly held) but the thread's last
 * recorded turn can be arbitrarily old (hours). Measuring idleDurationMs
 * directly from that stale turn timestamp would misread a genuinely-alive,
 * freshly-resumed session as long-idle (grey) instead of awaiting_input
 * (green).
 *
 * THE FIX: anchor idleDurationMs to `max(latest turn's own completion
 * timestamp, when we first observed THIS live session)` rather than the
 * turn timestamp alone. A resumed session's process is observed alive NOW
 * (or moments ago), so idleSinceMs collapses to that fresh observation
 * regardless of how old the last actual turn was.
 *
 * WHY ANCHORED TO "FIRST TIME WE SAW THIS SESSION'S LOCK HELD" AND NOT "APP
 * BOOT TIME" OR "EVERY TICK" — this is the crux of the fix, and a future
 * reader might be tempted to simplify it away, so the reasoning is spelled
 * out here:
 *   - NOT app boot time: Orpheus can run for days across many resumes/closes
 *     of the SAME workspace. Anchoring to boot would make every session
 *     look "freshly observed" for the app's entire uptime, defeating the
 *     stale-after-threshold entirely for any session that happens to still
 *     be alive when boot happened to occur — the age gate would never fire.
 *   - NOT every tick (i.e. NOT re-stamping firstObservedLiveAtMs = Date.now()
 *     on every reconcile pass): that would make idleDurationMs permanently
 *     ~0 for any session whose lock stays held, so a workspace left running
 *     untouched for hours would NEVER cross staleAfterMinutes and would stay
 *     "awaiting_input" (green) forever — exactly the failure mode
 *     staleAfterMinutes exists to prevent, and the opposite bug from the one
 *     being fixed here.
 *   - The correct anchor is "first observation of THIS PARTICULAR live
 *     session" — set once when lockHeld transitions from not-held (or a
 *     different session id) to held for this session, then held FIXED for
 *     the remainder of that liveness window. This lets idleDurationMs grow
 *     normally tick over tick (so staleness still works for a truly
 *     long-idle live session), while still being anchored to a point no
 *     older than "when we actually confirmed this specific process is
 *     alive" (so a resumed session's stale turn timestamp can never, by
 *     itself, force a long idle reading).
 *
 * RESET RULES (both implemented below):
 *   - Session id changes for this workspace (re-bound to a different Codex
 *     session) — the old stamp must not be reused; start fresh.
 *   - Lock becomes unheld (process exited) — clear the stamp entirely, so a
 *     LATER re-acquire (new codex process launched again) starts fresh
 *     rather than inheriting a stale timestamp from a previous liveness
 *     window that has nothing to do with the new process.
 *
 * @param prevStamp - the workspace's current stamp, or `undefined` if none
 *   tracked yet (never observed live before, or previously cleared).
 * @param sessionId - the workspace's CURRENT bound session id (`claude_session_id`).
 * @param lockHeld - this tick's liveness probe result for that session id.
 * @param latestTurn - this tick's latest recorded turn from thread_history_1.sqlite.
 * @param nowMs - injected rather than read via Date.now() internally, so
 *   this stays pure/directly testable — mirrors every other impure-input
 *   convention in this file (see mapCodexStatus's own staleThresholdMs
 *   parameter).
 * @returns `nextStamp` (the stamp to store for next tick — `null` when the
 *   lock is not held, meaning "clear any existing stamp") and
 *   `idleDurationMs` (ready to hand straight to mapCodexStatus).
 */
export function deriveLiveObservationStamp(
  prevStamp: LiveObservationStamp | undefined,
  sessionId: string,
  lockHeld: boolean,
  latestTurn: CodexLatestTurn | null,
  nowMs: number
): { nextStamp: LiveObservationStamp | null; idleDurationMs: number | null } {
  if (!lockHeld) {
    // Process gone — no live-observation window to anchor to. Clearing here
    // (returning null) is what makes a LATER re-acquire start fresh rather
    // than silently reusing a stamp from an unrelated previous window.
    return { nextStamp: null, idleDurationMs: null }
  }

  const stamp: LiveObservationStamp =
    prevStamp && prevStamp.sessionId === sessionId
      ? prevStamp // same live session already being tracked — keep the ORIGINAL first-observed time
      : { sessionId, firstObservedLiveAtMs: nowMs } // newly-live session (or a rebind) — stamp fresh, now

  const eventAtMs =
    latestTurn && latestTurn.status !== 'inProgress' ? latestTurn.completedAtMs : null
  const idleSinceMs =
    eventAtMs !== null
      ? Math.max(eventAtMs, stamp.firstObservedLiveAtMs)
      : stamp.firstObservedLiveAtMs

  return { nextStamp: stamp, idleDurationMs: nowMs - idleSinceMs }
}

// ---------------------------------------------------------------------------
// Liveness — a non-blocking advisory-lock PROBE, not an existence check.
// UNCHANGED by the thread-DB migration — see this file's header, "WHY
// LIVENESS IS STILL NEEDED", for why this remains load-bearing rather than
// becoming redundant once status reads from Codex's own DB.
//
// EXISTENCE IS NOT THE SAME AS HELD, and an earlier version of this
// function got that wrong: it answered "does a file with this name exist in
// the locks dir", not "does a live process still hold this lock". A lock
// file is created when a codex process acquires the thread-writer lock and
// removed when that process exits CLEANLY — but a process killed by
// SIGKILL, an OOM kill, a panic, or a power loss never runs its own
// cleanup, and the lock file is left behind, unheld, forever.
//
// THIS IS NOT THEORETICAL — an orphan of exactly this shape was found on a
// real dev machine (a lock file with no process holding it, confirmed via
// both `lsof` and this function's own probe). ITS ACTUAL OBSERVED IMPACT:
// the orphan's thread ended on a TERMINAL status ('completed'), so
// existence-only misread it as `awaiting_input`/'ready' instead of `idle` —
// a wrong ready/idle split, cosmetic, not a stuck spinner. The WORSE case
// this probe exists to prevent — a workspace pinned to `in_progress`
// forever — requires a crash mid-turn (latest turn status 'inProgress',
// process gone before it could be marked complete). That combination is
// real and reachable but had not been separately observed on the machine
// this was verified on. Do not describe orphans as theoretical (wrong — one
// exists on this machine right now) and do not imply a stuck spinner is
// currently happening in practice (overstated — the one observed orphan's
// actual consequence was the cosmetic case, not the pinned-working case).
//
// THE PROBE: a non-blocking exclusive-lock open on the lock file itself.
// BSD/darwin's open(2) accepts O_EXLOCK/O_SHLOCK as flag bits alongside the
// usual O_RDONLY etc — this is NOT the same thing as a standalone flock()
// function call (which node:fs indeed has no binding for); it piggybacks on
// the plain openSync() call every read already needs. Attempting to open
// the SAME file a live codex process holds exclusively fails immediately
// (non-blocking) with EAGAIN/EWOULDBLOCK; opening a file nothing holds
// succeeds (this process becomes a second, harmless reader — closed
// immediately below); a missing file (clean exit already removed it) is
// ENOENT. This is per-open-file-description locking, so a second probe
// from a DIFFERENT process (or a different open() call, even in the same
// process) genuinely contends with a live holder's lock — it is not
// self-invisible the way some POSIX lock semantics can be for same-process
// callers. Verified against real held/orphaned/missing files with `lsof`
// as independent ground truth, and re-verified inside Electron's own node
// runtime (not just system node) via ELECTRON_RUN_AS_NODE — identical
// results in both.
//
// fs.constants.O_EXLOCK / O_SHLOCK ARE UNDEFINED on this Node version —
// confirmed directly (`'O_EXLOCK' in fs.constants` is false). The numeric
// darwin flag bits are used instead: O_EXLOCK = 0x20, O_NONBLOCK = 0x4 (see
// <sys/fcntl.h> on macOS — these are stable ABI values, not Node-version-
// dependent). DARWIN-ONLY, which is fine: Orpheus is macOS-only end to end
// (see CLAUDE.md — "source-available macOS Electron app").
//
// WHY THIS BEATS THE ALTERNATIVES THAT WERE CONSIDERED AND REJECTED:
//   - existence + turn-age decay (a staleness THRESHOLD on how long ago the
//     last turn was written): rejected because it needs a tunable threshold
//     with no safe value — a live turn running one long, silent tool call
//     can go minutes without updating the DB, and any threshold aggressive
//     enough to heal a crash quickly enough to matter risks flipping a
//     genuinely-still-working session to idle mid-turn. The lock probe is a
//     direct MEASUREMENT of live-process state, not a guess extrapolated
//     from elapsed time, so it has no equivalent failure mode.
//   - pid-tracking (record the pid Orpheus itself spawned, check it with
//     process.kill(pid, 0) — Claude's own mechanism): rejected, and not
//     merely because it was harder to wire — it is strictly LESS correct
//     than the probe even where it CAN be wired, because it can't cover: a
//     session started by an older Orpheus build (pid never recorded), an
//     Orpheus restart that loses whatever in-memory pid map it had, or a
//     user manually launching `codex` inside the terminal pane outside
//     Orpheus's own spawn path entirely. The lock probe covers all three
//     for free, because it asks the OS about the lock directly rather than
//     trusting Orpheus's own bookkeeping to have seen every process that
//     could hold it.
//   - a native flock/advisory-lock npm dependency: rejected — the numeric
//     flag-bit approach above achieves the same probe with zero new
//     dependencies, since Node's `fs.openSync` passes numeric open() flags
//     straight through to the OS call.
//   - reading a pid out of the lock file itself: dead end regardless of the
//     above — every lock file is zero bytes, no pid or any other content.
//   - reading a pid out of Codex's own on-disk artifacts (the rollout's
//     session_meta payload, or the thread DB itself): dead end — verified
//     field lists contain no pid/process field anywhere, in either source.
//   - lock mtime as a liveness heartbeat: dead end — verified a live
//     session's lock mtime is stamped once at creation and never touched
//     again for the life of the session, so an mtime-freshness window would
//     misclassify every live-but-quiet session as dead.
//   - a tmux pane_pid lookup: rejected on cost — requires a subprocess per
//     tick, which this whole design exists to avoid.
//
// FORWARD-COMPATIBILITY NOTE: if a future Codex version moves to fcntl
// range locks (which do not interact with BSD flock semantics on darwin),
// this probe would degrade to existence-equivalent behavior — i.e. no
// worse than before this fix, never worse than that. Worth knowing if a
// future reader is debugging why the probe stopped distinguishing held
// from orphaned on a newer Codex build.
//
// COST: one openSync+closeSync (or one openSync+immediate-catch) per BOUND
// Codex workspace per tick — O(number of bound workspaces), not O(number of
// lock files in the directory), and never a subprocess.
/**
 * Probes whether `lockFilePath` is currently held by a live process, via a
 * non-blocking exclusive-open attempt (see this section's header comment
 * above for the full mechanism and verification). Returns:
 *   - `true` if the open fails with EAGAIN/EWOULDBLOCK/EACCES (a live
 *     process holds the lock),
 *   - `false` if the open SUCCEEDS (nothing holds the lock — an orphan, or
 *     a lock that was never truly exclusive) — the fd is closed immediately
 *     since this call only exists to test held-ness, not to hold anything
 *     itself,
 *   - `false` if the file doesn't exist (ENOENT — a clean exit already
 *     removed it, or the session never had a lock file at all),
 *   - `true` for any OTHER/unexpected errno — failing TOWARD "held" (and
 *     therefore toward mapCodexStatus's `in_progress`/no-change branches
 *     rather than a demotion to idle) is the safer default: a brief false
 *     "still working" self-corrects on the very next tick once whatever
 *     transient condition caused the odd errno clears, whereas a false
 *     "idle" flap on a genuinely live, busy session is a visible glitch a
 *     user could see mid-turn.
 */
export function isLockHeld(lockFilePath: string): boolean {
  // Darwin open(2) flag bits — see this section's header comment for why
  // the numeric values are required (fs.constants.O_EXLOCK/O_SHLOCK are
  // undefined on this Node) and why darwin-only is acceptable (Orpheus is
  // macOS-only).
  const O_EXLOCK = 0x20
  const O_NONBLOCK = 0x4

  let fd: number
  try {
    fd = fs.openSync(lockFilePath, fs.constants.O_RDONLY | O_EXLOCK | O_NONBLOCK)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return false
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK' || code === 'EACCES') return true
    // Unexpected errno — assume held (see this function's own doc comment
    // on why failing toward "held" is the safer default here).
    return true
  }
  // The open succeeded, meaning nothing held an exclusive lock on this
  // file — this process just became a harmless second reader. Close
  // immediately; this call's only purpose was the probe itself.
  fs.closeSync(fd)
  return false
}

/**
 * One workspace row, broad enough to describe EITHER a bound or an unbound
 * Codex workspace — unlike statusState.ts's own CodexWorkspaceRow (whose
 * `claude_session_id: string` is deliberately non-nullable, because its own
 * SQL already filters `IS NOT NULL`). Shared here, rather than duplicated in
 * statusState.ts, so this file and its test (scripts/verify-codex-status.ts)
 * agree on exactly one row shape for the unbound-selection logic below.
 * UNCHANGED by the thread-DB migration — late-binding discovery is still
 * driven off the same claude_session_id column, regardless of which source
 * subsequently reads status/prompt data for it.
 */
export interface CodexWorkspaceRowMaybeUnbound {
  id: string
  claude_session_id: string | null
}

/**
 * Late-binding re-arm (support-multi-harness) — selects the ids of every
 * UNBOUND Codex workspace row (claude_session_id === null) from a mixed
 * array that may also contain bound rows, preserving input order.
 *
 * Relocated to this electron/db-free leaf (rather than defined inline in
 * statusState.ts, which imports getDb()/orpheusNotify and therefore cannot
 * be imported under plain `bun run`) for the same reason every other pure
 * decision in this file lives here: so scripts/verify-codex-status.ts can
 * call the REAL function directly, against a fabricated mixed row array,
 * instead of a reimplementation of it. statusState.ts's own
 * loadUnboundCodexWorkspaceRows query is already scoped to
 * `claude_session_id IS NULL` in SQL, so every row it hands this function is
 * unbound by construction — this function is written to accept a broader,
 * mixed set anyway (rather than assuming its caller's filter) specifically
 * so it stays meaningfully testable on its own, and so a future caller with
 * a less-filtered query can't silently include a bound row by accident.
 */
export function selectUnboundCodexWorkspaceIds(
  rows: readonly CodexWorkspaceRowMaybeUnbound[]
): string[] {
  return rows.filter((row) => row.claude_session_id === null).map((row) => row.id)
}
