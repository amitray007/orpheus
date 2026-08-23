/**
 * statusMap.ts — pure rollout-event + lock-liveness → WorkspaceStatus mapping
 * for Codex.
 *
 * Codex's analogue to src/main/sessionStatusMap.ts, but built over an
 * entirely different data source. Claude's mapping (_mapFileStatus) reads a
 * single self-describing status field a live claude process writes to its
 * own session file (`busy`/`idle`/`waiting`/`shell`), where "the process
 * wrote this recently" and "the process is alive" are the same fact. Codex
 * has no such file — see statusState.ts's header for the two independent
 * signals this module combines instead:
 *
 *   1. TURN LIFECYCLE EVENTS — the last recognized turn-boundary event_msg
 *      line in the workspace's bound rollout file (see findLastCodexTaskEvent
 *      below), telling us whether a turn was IN FLIGHT the last time Codex
 *      wrote to disk, and (for a terminal event) WHEN that turn ended.
 *   2. LIVENESS — whether a `~/.codex/thread-writer-locks/<session-uuid>.lock`
 *      file still exists for that session id, telling us whether the Codex
 *      process that wrote (1) is STILL RUNNING right now.
 *
 * THE STUCK-INDICATOR FIX this module exists to encode: a crashed/killed
 * Codex process leaves whatever it last wrote on disk forever — if its last
 * write was `task_started`, the rollout alone says "still working" with no
 * way to ever un-say it. Liveness is the correction: the lock file is
 * REMOVED when the codex process exits (verified empirically — see the
 * task brief this module was built from), so "lock gone" is an
 * unconditional, cheap, always-available override. mapCodexStatus below
 * checks it FIRST and lets it win even over a fresh-looking `task_started` —
 * this ordering is the entire point of the function; do not reorder it to
 * check the lifecycle event first "for symmetry" with Claude's mapping,
 * which has no equivalent split-source liveness concern.
 *
 * LIFECYCLE EVENT VOCABULARY — verified against 80 real rollouts on this
 * machine: `task_started` (1053 occurrences), `task_complete` (1037),
 * `turn_aborted` (12 — a turn that ends WITHOUT a task_complete, e.g. the
 * user interrupted it or it errored out). `turn_started`/`turn_complete`
 * (0 occurrences in the same sample) are accepted as defensive aliases of
 * `task_started`/`task_complete` respectively, in case a future Codex
 * version renames the events — costs nothing beyond two extra string
 * literals and avoids a silent regression if the rename lands.
 *
 * task_complete/turn_complete/turn_aborted all collapse to the SAME
 * "terminal" bucket for this module's purposes — a turn that is not
 * currently in flight, full stop. We deliberately do not distinguish WHICH
 * terminal reason produced that state (clean completion vs. abort vs.
 * error); only "is a turn in flight right now" matters to the UI.
 *
 * NOT A DEPTH/BALANCE COUNTER. This is LAST-EVENT-WINS by file order
 * (rollouts are append-only/chronological), never a +1/-1 nesting counter.
 * Verified: 133 of 561 real rollouts have UNBALANCED started/completed
 * counts (more of one than the other, in either direction) — a counter
 * would drift on these files and could pin a workspace to "working" forever
 * purely from historical imbalance, which is exactly the stuck-indicator
 * failure this whole feature exists to prevent. findLastCodexTaskEvent scans
 * every recognized line and keeps only the LAST one seen; it never
 * accumulates a running tally.
 *
 * Deliberately electron/db-free (though NOT fs-free — see
 * readLockHeldSessionIds below, which needs a real `fs.readdirSync` against
 * a real directory to be worth testing at all) so it can be imported
 * directly by both statusState.ts (the impure reconciler) and
 * scripts/verify-codex-status.ts under plain `bun run`. `fs` alone doesn't
 * pull in electron (see usage.ts, which does the same in this same
 * directory) — it's `getDb()`/`orpheusNotify` (both electron-touching) that
 * make statusState.ts itself unimportable standalone, which is exactly why
 * readLockHeldSessionIds was relocated OUT of statusState.ts and into this
 * file: so the orphan-lock bug's regression test can call the real
 * function against a real temp directory instead of a reimplementation.
 * Matches sessionStatusMap.ts's own reason for existing as a standalone
 * leaf module.
 */

import * as fs from 'node:fs'
import type { WorkspaceStatus } from '../../../shared/types'

/** Which "bucket" a recognized lifecycle event falls into: a turn just
 *  started (`'started'`), or a turn just ended for any reason — clean
 *  completion, user-interrupted abort, or error (`'terminal'`). Collapsing
 *  every terminal reason to one bucket is deliberate — see this module's
 *  header ("terminal bucket" paragraph). */
export type CodexTaskEventKind = 'started' | 'terminal'

/**
 * The last turn-boundary event_msg found in a rollout file, or `null` when
 * the file has no such event yet (a fresh session that hasn't taken a turn,
 * or — see findLastCodexTaskEvent's own doc comment — no bound rollout file
 * was found at all, which is the CALLER's concern, not this type's).
 *
 * `atMs` is the terminal event's own "when did this happen" timestamp in
 * epoch milliseconds, used to compute idle duration for the ready/idle
 * split (see mapCodexStatus's doc comment). It is `null` for a `'started'`
 * event (irrelevant — a turn that just started isn't idle) and MAY be
 * `null` for a `'terminal'` event too, if the line carried no usable
 * timestamp of any kind (extremely defensive fallback; every terminal line
 * observed in practice carries at least the outer `timestamp` field — see
 * findLastCodexTaskEvent's doc comment for the field-preference order).
 */
export type CodexTaskEvent = { kind: CodexTaskEventKind; atMs: number | null } | null

/**
 * Maps Codex's signals (last turn-lifecycle event + its terminal timestamp,
 * thread-writer-lock liveness, and — for the ready/idle split — how long ago
 * this workspace's live session was last observed as "fresh": either a
 * terminal event's own timestamp, or the caller's first observation of this
 * live session, whichever is MORE RECENT — see statusState.ts's
 * reconcileOneWorkspace for that derivation) to the WorkspaceStatus the UI
 * drives off of.
 *
 * `idleDurationMs` applies to BOTH `taskEvent === null` (no turn ever taken
 * yet on this live session) and `taskEvent.kind === 'terminal'` (the last
 * turn ended) — this function treats them identically once both consult
 * idleDurationMs (see the TRUTH TABLE below for why). It is `null` only when
 * there is no measurable anchor at all: `taskEvent.kind === 'started'`
 * (irrelevant — a turn that just started isn't idle, handled by its own
 * earlier branch) or a terminal event whose timestamp was unusable (see
 * CodexTaskEvent's doc comment). An unmeasurable idle duration degrades to
 * plain `'idle'` rather than `'awaiting_input'` — it cannot honestly claim
 * "recently finished"/"recently observed alive", so it is not synthesized
 * as one. IMPORTANTLY, a fresh `taskEvent === null` case is NOT
 * automatically unmeasurable: the caller anchors it to when it first
 * observed this live session, which is itself a fresh, real timestamp — see
 * statusState.ts's `firstObservedLiveAtMs` for why this makes "freshly
 * launched, no turn yet, lock held" read as awaiting_input rather than idle.
 *
 * `staleThresholdMs` mirrors the SAME app setting Claude's own
 * driveStatusTransition (src/main/sessionState.ts) reads
 * (`staleAfterMinutes`, converted to ms) — passed in as a plain number so
 * this function stays pure; reading the setting and computing "now minus
 * event time" are statusState.ts's job, exactly as sessionState.ts computes
 * its own `idleDuration`/`threshold` inline rather than inside its pure
 * `_mapFileStatus` helper. The comparison here uses the SAME operator
 * Claude's does (`idleDurationMs >= staleThresholdMs -> idle`,
 * `< -> awaiting_input`) for consistency between the two harnesses' UI
 * behavior at the exact threshold boundary.
 *
 * TRUTH TABLE (deliberately spelled out rather than left to fall through an
 * if/else chain, since every branch here was individually verified by
 * scripts/verify-codex-status.ts):
 *
 *   lockHeld=false                              -> idle  (THE stuck-indicator
 *     fix, unconditional: the process that would act on any lifecycle
 *     event is gone; showing anything but idle would be a lie the UI can
 *     never correct on its own. Wins over EVERY other input, including a
 *     fresh-looking 'started' event.)
 *   lockHeld=true,  taskEvent={started, ...}     -> in_progress (a turn is
 *     genuinely in flight under a still-running process)
 *   lockHeld=true,  taskEvent=null OR {terminal, atMs},
 *     idleDurationMs === null                    -> idle  (no turn ever
 *     taken yet, OR a terminal event whose "how long ago" is unmeasurable —
 *     either way there is nothing honest to measure idleness from, so this
 *     degrades to idle rather than guessing)
 *   lockHeld=true,  taskEvent=null OR {terminal, atMs},
 *     idleDurationMs < staleThresholdMs           -> awaiting_input (process
 *     alive and RECENTLY OBSERVED as such — either it just finished a turn,
 *     or it has never taken a turn but we only just saw it come alive — same
 *     meaning as Claude's own awaiting_input/ready state; see this function's
 *     doc comment above on idleDurationMs for why the caller, not this
 *     branch, is what makes a "no event yet" case measurable at all: it
 *     anchors idleDurationMs to when the CALLER first observed this live
 *     session, not to any rollout timestamp)
 *   lockHeld=true,  taskEvent=null OR {terminal, atMs},
 *     idleDurationMs >= staleThresholdMs          -> idle  (process alive,
 *     but it has sat unobserved-as-fresh long enough to be stale, not fresh)
 *
 * The taskEvent=null and taskEvent={terminal,...} branches are IDENTICAL
 * once both consult idleDurationMs — merged into one shared idle-duration
 * check below. What differs between them is entirely upstream, in how the
 * CALLER derives idleDurationMs (statusState.ts): for a terminal event it is
 * anchored to max(the event's own timestamp, when we first observed this
 * live session); for no event at all there is no rollout timestamp to
 * anchor to, so it is simply "how long has this live session been observed
 * alive". This function does not need to know which case produced the
 * number it was handed — see statusState.ts's reconcileOneWorkspace for
 * that derivation.
 *
 * ATTENTION IS NOT IMPLEMENTED FOR CODEX, AND MUST NOT BE SYNTHESIZED HERE.
 * Codex's shipped native binary genuinely CONTAINS approval-request event
 * variants (`exec_approval_request`, `apply_patch_approval_request`,
 * `request_user_input`, `elicitation_request`, `collab_waiting_begin`/
 * `_end`) — the concept is real, not absent from the protocol; Codex has
 * approvals, and approved/denied/abort decisions genuinely happen. BUT
 * these are emitted only on Codex's LIVE event stream and are NEVER
 * persisted into the on-disk rollout `.jsonl` file this module's caller
 * tails. This was verified empirically, not just inferred from a binary
 * string table: across 17 real rollouts that ran with
 * `approval_policy = "on-request"` (approvals genuinely enabled) spanning
 * 2088 patch/exec actions — i.e. thousands of operations that would have
 * gone through the approval path if it were reachable from this data
 * source — there were ZERO approval-shaped records of any kind in the
 * rollout files. Since the rollout is our only read-only source, 'attention'
 * is not derivable from it — this is a limitation of the OBSERVATION
 * CHANNEL, not of Codex's protocol or feature set. Do not "fix" this into a
 * synthetic attention state guessed from indirect signals (e.g. treating a
 * long-idle in_progress as attention) — that would be fabricating a signal
 * this data source does not carry, exactly the mistake this comment exists
 * to head off. Nothing in this function's branches can produce 'attention';
 * keep it that way.
 */
export function mapCodexStatus(
  taskEvent: CodexTaskEvent,
  lockHeld: boolean,
  idleDurationMs: number | null,
  staleThresholdMs: number
): WorkspaceStatus {
  // Liveness veto — checked FIRST and wins unconditionally over every other
  // input. See this module's header for why this ordering is load-bearing.
  if (!lockHeld) return 'idle'

  if (taskEvent?.kind === 'started') return 'in_progress'

  // Either no turn has ever been taken (taskEvent === null) or the last
  // turn ended (taskEvent.kind === 'terminal') — both branches now consult
  // the SAME idleDurationMs and apply the SAME threshold comparison, per
  // this function's doc comment above on why they're identical once both
  // consult it. An unmeasurable idle duration (no usable anchor at all)
  // cannot honestly claim "just finished"/"just observed alive" — degrade
  // to idle rather than guessing.
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
 * idleDurationMs to feed mapCodexStatus, extracted here (rather than left
 * inline in statusState.ts's reconcileOneWorkspace) for the same reason
 * every other pure decision in this file lives here: so
 * scripts/verify-codex-status.ts can call the REAL function directly instead
 * of a reimplementation. statusState.ts becomes a thin shell around this:
 * hold the Map, call this each tick, write back the returned stamp.
 *
 * THE BUG THIS FIXES: `codex resume <id>` replays a saved transcript into
 * the terminal but appends NOTHING to the rollout file — so after an app
 * restart where the user continues an existing conversation, the process is
 * brand new (lock freshly held) but the rollout's last lifecycle event can
 * be arbitrarily old (hours). The OLD code measured idleDurationMs directly
 * from that stale rollout timestamp, so a genuinely-alive, freshly-resumed
 * session read as long-idle (grey) instead of awaiting_input (green).
 *
 * THE FIX: anchor idleDurationMs to `max(taskEvent's own timestamp, when we
 * first observed THIS live session)` rather than the rollout timestamp
 * alone. A resumed session's process is observed alive NOW (or moments ago),
 * so idleSinceMs collapses to that fresh observation regardless of how old
 * the last actual turn was.
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
 *     alive" (so a resumed session's stale rollout event can never, by
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
 * @param taskEvent - this tick's last recognized rollout lifecycle event.
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
  taskEvent: CodexTaskEvent,
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

  const eventAtMs = taskEvent?.kind === 'terminal' ? taskEvent.atMs : null
  const idleSinceMs =
    eventAtMs !== null
      ? Math.max(eventAtMs, stamp.firstObservedLiveAtMs)
      : stamp.firstObservedLiveAtMs

  return { nextStamp: stamp, idleDurationMs: nowMs - idleSinceMs }
}

/** Minimal shape of the rollout-line fields this parser actually reads. The
 *  `payload.started_at`/`completed_at` fields are epoch SECONDS (not ms —
 *  verified from a real task_complete payload sample), and the outer
 *  `timestamp` field is an ISO8601 string — see findLastCodexTaskEvent's
 *  doc comment for how these are combined/prioritized. */
type CodexRolloutTaskLine = {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    completed_at?: number
    started_at?: number
  }
}

// Event-type literals recognized as a turn STARTING. `turn_started` is a
// defensive alias for a rename that has not happened in practice (0
// occurrences across 80 real rollouts) — see this module's header.
const STARTED_EVENT_TYPES = new Set(['task_started', 'turn_started'])

// Event-type literals recognized as a turn ENDING, for ANY reason. All three
// collapse to the same 'terminal' CodexTaskEventKind — see this module's
// header for why "which terminal reason" is deliberately not distinguished.
// `turn_complete` is the same kind of defensive rename-alias as
// `turn_started` above (0 occurrences in practice); `turn_aborted` is a
// REAL, OCCURRING event (12 occurrences across 80 rollouts) and its
// recognition here is the fix for the "aborted turn stuck as working" gap —
// omitting it would leave a prior 'task_started' as the last recognized
// event forever once a turn aborts with no task_complete ever following.
const TERMINAL_EVENT_TYPES = new Set(['task_complete', 'turn_complete', 'turn_aborted'])

/**
 * Resolves a terminal event's own "when did this turn end" timestamp in
 * epoch milliseconds, or `null` if no usable timestamp is present on the
 * line at all.
 *
 * PREFERENCE ORDER: `payload.completed_at` (epoch SECONDS — converted via
 * `* 1000`) when present and numeric, since it is the more precise "when
 * this turn actually finished" (verified present on real task_complete
 * payloads). Falls back to the outer `timestamp` field (ISO8601, parsed via
 * `Date.parse`) when `completed_at` is missing or not a number — this is
 * the expected path for a `turn_aborted` line, which may not carry a
 * `completed_at` field at all (an aborted turn has no well-defined
 * "completion" instant in the same sense a clean task_complete does).
 * Returns `null` only if NEITHER field yields a finite timestamp (e.g. a
 * malformed/torn line that still happened to parse as valid JSON with a
 * recognized event type but no usable time field).
 */
function resolveTerminalTimestampMs(parsed: CodexRolloutTaskLine): number | null {
  const completedAtSec = parsed.payload?.completed_at
  if (typeof completedAtSec === 'number' && Number.isFinite(completedAtSec)) {
    return completedAtSec * 1000
  }
  if (typeof parsed.timestamp === 'string') {
    const parsedMs = Date.parse(parsed.timestamp)
    if (Number.isFinite(parsedMs)) return parsedMs
  }
  return null
}

/**
 * Scans every line of an already-read rollout file for `event_msg` records
 * whose payload type is a recognized turn-lifecycle event (see
 * STARTED_EVENT_TYPES/TERMINAL_EVENT_TYPES above), and returns the LAST one
 * found (last-line-wins — a file with task_started THEN task_complete must
 * return the terminal event, and a file with task_complete THEN
 * task_started must return the started event; keep iterating and
 * overwriting, never break/return early on the first match, and NEVER
 * accumulate a running +1/-1 balance — see this module's header for why a
 * depth counter is the wrong shape here). Returns `null` if the file
 * contains no such event.
 *
 * Mirrors usage.ts's findLastTokenCount/findLastTurnContextModel structure
 * exactly: trim each line, skip empty ones, JSON.parse in a try/catch that
 * `continue`s past a torn/malformed line (never throws — a truncated final
 * line from a process killed mid-write must not crash the whole scan, only
 * cost that one line).
 *
 * NO BOUND SESSION is NOT this function's concern. Given no rollout file at
 * all (a workspace that has never bound a Codex session, or whose bound id
 * can no longer be found on disk), the CALLER — statusState.ts's reconciler
 * — is responsible for that case; this parser only ever receives an array
 * of lines already read from a file that was already found to exist.
 */
export function findLastCodexTaskEvent(lines: string[]): CodexTaskEvent {
  let last: CodexTaskEvent = null
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    let parsed: CodexRolloutTaskLine
    try {
      parsed = JSON.parse(line) as CodexRolloutTaskLine
    } catch {
      continue
    }
    if (parsed.type !== 'event_msg') continue
    const payloadType = parsed.payload?.type
    if (typeof payloadType !== 'string') continue

    if (STARTED_EVENT_TYPES.has(payloadType)) {
      last = { kind: 'started', atMs: null }
    } else if (TERMINAL_EVENT_TYPES.has(payloadType)) {
      last = { kind: 'terminal', atMs: resolveTerminalTimestampMs(parsed) }
    }
  }
  return last
}

// ---------------------------------------------------------------------------
// Liveness — a non-blocking advisory-lock PROBE, not an existence check.
// (Relocated here, not in statusState.ts, so it can be exercised directly
// by scripts/verify-codex-status.ts under plain `bun run` — statusState.ts
// cannot be imported standalone, it transitively pulls in `electron` via
// getDb()/orpheusNotify and throws under bun/node; this is the exact same
// reason sessionStatusMap.ts was split out of sessionState.ts.)
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
// the orphan's rollout ended on a TERMINAL event (task_complete), so
// existence-only misread it as `awaiting_input`/'ready' instead of `idle` —
// a wrong ready/idle split, cosmetic, not a stuck spinner. The WORSE case
// this probe exists to prevent — a workspace pinned to `in_progress`
// forever — requires a crash mid-turn (last rollout event `task_started`,
// process gone before task_complete could be written). That combination is
// real and reachable (nothing about it depends on which event happened to
// be last) but had not been separately observed on the machine this was
// verified on. Do not describe orphans as theoretical (wrong — one exists
// on this machine right now) and do not imply a stuck spinner is currently
// happening in practice (overstated — the one observed orphan's actual
// consequence was the cosmetic case, not the pinned-working case).
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
//   - existence + rollout-age decay (a staleness THRESHOLD on how long ago
//     the last rollout line was written): rejected because it needs a
//     tunable threshold with no safe value — a live turn running one long,
//     silent tool call can append nothing to the rollout for minutes, and
//     any threshold aggressive enough to heal a crash quickly enough to
//     matter risks flipping a genuinely-still-working session to idle
//     mid-turn. The lock probe is a direct MEASUREMENT of live-process
//     state, not a guess extrapolated from elapsed time, so it has no
//     equivalent failure mode.
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
//     session_meta payload): dead end — verified field list
//     (base_instructions, cli_version, context_window, cwd, git,
//     history_mode, id, model_provider, originator, session_id, source,
//     thread_source, timestamp) contains no pid/process field anywhere.
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
// lock files in the directory), and never a subprocess. This REPLACES the
// prior one-readdir-for-everyone approach; per-workspace is the correct
// shape here since each workspace already needs its own probe against its
// own session id's lock path, and workspace count is bounded and typically
// small, unlike (hypothetically) every lock file Codex has ever created.
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
