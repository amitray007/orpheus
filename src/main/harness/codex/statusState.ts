/**
 * statusState.ts — Codex's status-reconciliation service.
 *
 * Codex's analogue to src/main/sessionState.ts (DO NOT MODIFY that file —
 * this module exists specifically so Claude's byte-identical behavior never
 * has to change to accommodate a second harness). Read that file's header
 * first: this module mirrors its SHAPE (module-level maps, single-flight
 * reconcile, self-rescheduling interval backstop, start/stop lifecycle) but
 * NOT its exact mechanism, because Codex's data source is structurally
 * different from Claude's:
 *
 *   Claude: one self-describing status field, written by a live process to
 *   its own ~/.claude/sessions/<pid>.json — "recently written" and "process
 *   alive" collapse to the same fact, so a pid-liveness check
 *   (process.kill(pid, 0)) is enough on its own.
 *
 *   Codex: TWO independent signals that must be combined (see
 *   statusMap.ts's header and mapCodexStatus's truth table), plus a THIRD
 *   derived value for the ready/idle split:
 *     1. the last recognized turn-lifecycle event_msg line in the
 *        workspace's bound rollout file (what Codex last WROTE) —
 *        task_started/task_complete, with turn_aborted as a real third
 *        terminal marker and turn_started/turn_complete as defensive
 *        rename-aliases (see statusMap.ts's header for verified counts),
 *     2. whether a ~/.codex/thread-writer-locks/<session-uuid>.lock file is
 *        currently HELD by a live process (whether the WRITER is still
 *        alive) — a non-blocking advisory-lock probe (isLockHeld,
 *        statusMap.ts), NOT a directory-existence check; a lock file can
 *        outlive the process that created it when that process is killed
 *        rather than exiting cleanly, and existence-only was found to
 *        misreport exactly that orphaned case as still held — see
 *        isLockHeld's own doc comment for the full mechanism and why it was
 *        chosen over the alternatives that were tried and rejected, and
 *     3. HOW LONG AGO this workspace's live session was last observed
 *        "fresh" (idleDurationMs) — NOT simply the rollout event's own
 *        timestamp vs. Date.now(). `codex resume <id>` replays a saved
 *        transcript into the terminal but appends NOTHING to the rollout
 *        file, so a freshly-resumed process can be alive right now while the
 *        rollout's last event is hours old — measuring idleDurationMs
 *        directly from that stale event would misreport a genuinely-alive
 *        session as long-idle (the exact bug the age-anchoring fix,
 *        support-multi-harness, corrects). Instead idleDurationMs is derived
 *        by deriveLiveObservationStamp (statusMap.ts, PURE — see
 *        reconcileOneWorkspace below and that function's own doc comment)
 *        as `Date.now() - max(the rollout event's own timestamp, when THIS
 *        live session was FIRST observed lock-held)`, compared against the
 *        same staleAfterMinutes app setting Claude's own
 *        driveStatusTransition reads, to decide awaiting_input ("just
 *        finished, or just observed alive") vs. idle ("stale a while now").
 *   Neither of the first two signals alone is trustworthy: the rollout
 *   alone can say "task_started" forever after a crash (the stuck-indicator
 *   bug this whole feature exists to fix); pid-liveness has no equivalent
 *   here at all, since Orpheus never captured Codex's own pid the way it
 *   captures claude's.
 *
 * ATTENTION IS NOT PRODUCED BY THIS SERVICE. See statusMap.ts's
 * mapCodexStatus doc comment for the full, verified explanation of why —
 * short version: Codex's approval-request events are real but never
 * persisted to the rollout this service reads, so 'attention' cannot be
 * honestly derived here. Read that comment before touching anything in
 * this file that looks like it could synthesize one.
 *
 * THIS MODULE SATISFIES THE SAME 7 STABILITY PROPERTIES sessionState.ts
 * does, each called out at its point of implementation below:
 *   1. Authoritative source — mapCodexStatus's contract (rollout event +
 *      lock liveness + idle duration vs. stale threshold), delegated to
 *      verbatim, never re-decided here. This module computes the IMPURE
 *      inputs (Date.now(), getAppUiState()) and hands them to the pure
 *      function; it never decides the mapping itself.
 *   2. Liveness — a non-blocking advisory-lock probe (isLockHeld,
 *      statusMap.ts) against each BOUND workspace's own lock file path, one
 *      openSync/closeSync pair per workspace per tick — never a subprocess,
 *      never a directory listing (an earlier version used a single
 *      per-tick readdir + existence check across the whole locks dir; that
 *      was CHEAPER but WRONG — it could not distinguish a live lock from
 *      one orphaned by a crashed process, see isLockHeld's own doc comment
 *      for the full story). Cost is O(number of BOUND Codex workspaces),
 *      not O(number of lock files Codex has ever created).
 *   3. Watch + backstop — fs.watch on the ONE locks dir, plus a fixed-
 *      interval reconcile that is the PRIMARY turn-completion signal here
 *      (see the interval comment below for why this differs from Claude's
 *      watcher-is-primary shape).
 *   4. Single-flight — its own small reconcileRunning/dirty guard, a
 *      deliberate duplication of sessionState.ts's pattern rather than a
 *      shared extraction (see the guard's own comment for why).
 *   5. Torn-read tolerance — delegates per-line parsing to
 *      findLastCodexTaskEvent (already try/catch-per-line), and this
 *      module's own file-read wrapper degrades to a null event on any
 *      read error.
 *   6. Freshness/dedupe — lastDrivenStatus Map, only calls setStatusFromFile
 *      when the computed status actually changed for that workspace.
 *   7. Pure mapping — every decision routes through mapCodexStatus/
 *      findLastCodexTaskEvent/deriveLiveObservationStamp (statusMap.ts); no
 *      decision logic is duplicated here. This module holds only the
 *      impure liveObservationStamps Map and Date.now() and hands both to
 *      deriveLiveObservationStamp, exactly as it hands mapCodexStatus its
 *      own impure inputs — see property 1 above.
 *
 * ADDITIONAL RESPONSIBILITY (support-multi-harness) — LATE SESSION-BINDING
 * RE-ARM, folded into the SAME ~3s reconcile cadence above rather than a
 * new watcher/schedule of its own. session.ts's scheduleCodexSessionDiscovery
 * only retries binding a workspace's Codex session for a short, BOUNDED
 * window after launch (1.5s/4s/10s) — if the user's first prompt lands
 * later than that (or Codex is slow to flush its rollout's session_meta
 * line), that workspace's `claude_session_id` stays NULL forever, which
 * means it can never enter loadCodexWorkspaceRows' result set above (that
 * query filters `claude_session_id IS NOT NULL`) and therefore never gets a
 * status, a title, or usage data. Each reconcile() call now ALSO queries
 * every STILL-UNBOUND Codex workspace (loadUnboundCodexWorkspaceRows, the
 * mirror-image query: `claude_session_id IS NULL`), filters to the truly
 * unbound ids via selectUnboundCodexWorkspaceIds (statusMap.ts, pure and
 * independently testable), and for each one calls discoverAndBindCodexSession
 * again (retryLateBinding below) — piggybacking on the EXACT SAME discovery
 * function session.ts's own bounded retries call, not a second
 * implementation of it.
 *
 * WHY PIGGYBACK RATHER THAN GIVE LATE-BINDING ITS OWN INDEFINITE POLL: this
 * reconcile loop already exists, already runs indefinitely for the lifetime
 * of the app (start/stop wired into the same app-quit path as everything
 * else here), already has its own single-flight guard (property 4) and
 * fixed ~3s cadence, and already tolerates a missing/torn read without
 * crashing (property 5). Reusing it for late-binding retry costs one extra
 * cheap DB query and a filesystem scan per unbound workspace per tick —
 * bounded by the (small, transient) count of workspaces still waiting on
 * their first prompt — and gets single-flight/backstop/lifecycle discipline
 * for free. A dedicated indefinite-poll watcher for this one concern would
 * duplicate all of that machinery for no benefit.
 *
 * Once a late bind succeeds, retryLateBinding also calls
 * scheduleCodexTitleGeneration (./titleGeneration) for that workspace —
 * titleGeneration's own scheduler is otherwise ONLY ever invoked once, from
 * launch.ts at initial launch time (no other call site exists in this
 * codebase — grepped to confirm), so a workspace that was still unbound at
 * launch would otherwise never get a chance at a generated title at all.
 * Re-arming it here is safe to call redundantly across multiple retry
 * sources — see titleGeneration.ts's own early-return guards (`ws.lastTitle`
 * set after a first success, `hasCodexTitleGenerationRun` set after a first
 * attempt regardless of outcome) — worst case a second, redundant set of
 * scheduled timers all early-return once the first attempt completes.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getDb } from '../../db'
import { getWorkspace } from '../../workspaces'
import { setStatusFromFile } from '../../orpheusNotify'
import { logDiagMain } from '../../diagnostics'
import { DIAG_EVENTS } from '../../../shared/diagEvents'
import type { WorkspaceStatus } from '../../../shared/types'
import { getAppUiState } from '../../uiState'
import { UI_STATE_DEFAULTS } from '../../../shared/uiStateDefaults'
import {
  codexHomeDir,
  codexSessionsRoot,
  findCodexRolloutFileById,
  discoverAndBindCodexSession
} from './session'
import { scheduleCodexTitleGeneration } from './titleGeneration'
import {
  mapCodexStatus,
  findLastCodexTaskEvent,
  isLockHeld,
  selectUnboundCodexWorkspaceIds,
  deriveLiveObservationStamp,
  type CodexWorkspaceRowMaybeUnbound,
  type LiveObservationStamp
} from './statusMap'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HARNESS_ID = 'codex-cli'

function locksDir(): string {
  return path.join(codexHomeDir(), 'thread-writer-locks')
}

// PROPERTY 3 (watch + backstop) — INTERVAL IS PRIMARY HERE, unlike
// sessionState.ts where the interval only backstops a watcher that
// otherwise carries the whole reconcile cadence. Claude's watcher observes
// ~/.claude/sessions/<pid>.json directly, and THAT file is rewritten on
// every status transition (busy -> idle, idle -> waiting, etc.) — so
// watching it catches a turn's completion the instant it's written.
// Codex's locks dir only changes on session START/EXIT (lock file created/
// removed) — it is NOT rewritten mid-session on every task_complete, so
// watching it alone would never notice an ordinary turn finishing while the
// process stays alive. The fixed interval below is therefore the PRIMARY
// signal for "did a turn just complete", not merely a gap-filler; the
// locks-dir watch still earns its keep by triggering an IMMEDIATE reconcile
// the instant a session starts or exits, which is faster than waiting for
// the next tick to notice a workspace's very first observable status.
//
// 3000ms chosen as a middle point in the brief's 2-5s range: fast enough
// that a turn completing mid-session reads as done within ~1.5s on average
// (well under the loading-overlay's 10s fallback — see Part 4 of this
// unit's task brief / index.ts's handlePostMountOverlay), without polling
// so often that reading N bound workspaces' rollout files every tick
// becomes a measurable cost at realistic workspace counts.
const RECONCILE_INTERVAL_MS = 3000

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Last status actually driven via setStatusFromFile, per workspaceId —
 *  PROPERTY 6 (freshness/dedupe): only re-drive on an actual change. */
const lastDrivenStatus = new Map<string, WorkspaceStatus>()

/** Workspaces for which at least one reconcile pass has computed and driven
 *  (or confirmed unchanged) a status — see hasObservedCodexStatus below.
 *  Membership means "there is now something for the loading overlay to stop
 *  waiting on", regardless of what that status actually is (an 'idle'
 *  observation is still a real observation). */
const observedWorkspaces = new Set<string>()

/**
 * Per-workspace "when did we first observe THIS live session as lock-held"
 * stamp — the age-anchoring fix (support-multi-harness). See
 * deriveLiveObservationStamp's doc comment (statusMap.ts) for the full
 * reasoning on why this is anchored to first-observation-of-this-session
 * rather than app boot time or re-stamped every tick, and for the reset
 * rules (session id change, lock released) this Map's writes below
 * implement. This module only holds the impure Map; the actual
 * derive/update decision is the pure, independently-testable
 * deriveLiveObservationStamp helper — this module never decides the
 * mapping itself, mirroring PROPERTY 7 below for mapCodexStatus.
 */
const liveObservationStamps = new Map<string, LiveObservationStamp>()

let reconcileRunning = false
let dirty = false
let watcher: fs.FSWatcher | null = null
let intervalHandle: NodeJS.Timeout | null = null
let stopped = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true once this service has completed at least one reconcile pass
 * that evaluated this workspace — i.e. it is in the "seen" set regardless of
 * which status resulted. Used by index.ts's handlePostMountOverlay as the
 * Codex-appropriate substitute for Claude's isWorkspaceSessionReady: Claude
 * asks "does the session file report a concrete status yet"; Codex asks
 * "has this service looked at this workspace's rollout+lock state yet" —
 * both answer the same underlying question ("is there a real signal here
 * for the loading overlay to trust"), just from each harness's own data
 * source, never from the other's.
 */
export function hasObservedCodexStatus(workspaceId: string): boolean {
  return observedWorkspaces.has(workspaceId)
}

/**
 * Starts the locks-dir watcher (best-effort, tolerates a missing dir) and
 * the self-rescheduling interval reconcile, and runs an initial reconcile
 * pass immediately. Idempotent-safe to call once at startup, mirroring
 * startSessionStateService's shape exactly. Returns a `{ stop }` handle the
 * caller must wire into the same app-quit cleanup path Claude's service
 * uses (see index.ts).
 */
export function startCodexStatusService(): { stop: () => void } {
  stopped = false
  _startWatcher()
  scheduleIntervalReconcile()
  void reconcile()

  return {
    stop() {
      stopped = true
      if (intervalHandle) {
        clearTimeout(intervalHandle)
        intervalHandle = null
      }
      if (watcher) {
        watcher.close()
        watcher = null
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

function _startWatcher(): void {
  try {
    watcher = fs.watch(locksDir(), () => {
      scheduleReconcile()
    })
    watcher.on('error', (err) => {
      console.warn('[codexStatusState] fs.watch error — falling back to interval-only:', err)
      logDiagMain({
        category: 'anomaly',
        level: 'warn',
        event: DIAG_EVENTS.SESSION_WATCH_FALLBACK,
        data: { err: String(err), harness: HARNESS_ID }
      })
      if (watcher) {
        watcher.close()
        watcher = null
      }
    })
  } catch (err) {
    // Directory may not exist yet (no Codex activity ever) — the interval
    // reconcile below still runs regardless, so this is a soft degrade, not
    // a service failure.
    console.warn(
      '[codexStatusState] could not watch locks dir — falling back to interval-only:',
      err
    )
    logDiagMain({
      category: 'anomaly',
      level: 'warn',
      event: DIAG_EVENTS.SESSION_WATCH_FALLBACK,
      data: { err: String(err), harness: HARNESS_ID }
    })
  }
}

// ---------------------------------------------------------------------------
// PROPERTY 4 — single-flight scheduling
//
// A DELIBERATE, EXPLAINED DUPLICATION of sessionState.ts's
// scheduleReconcile/_runReconcile pattern (its lines ~373-408), not an
// import or a shared extraction. Folding this into shared plumbing would
// mean any future change to Codex's reconcile cadence — or a bug in a
// shared abstraction — could affect Claude's own reconcile timing, which is
// exactly the risk this whole unit was built to avoid touching. ~15 lines
// duplicated here is cheaper and safer than a shared risk surface touching
// sessionState.ts's stability.
// ---------------------------------------------------------------------------

function scheduleReconcile(): void {
  if (stopped) return
  if (reconcileRunning) {
    dirty = true
    return
  }
  void _runReconcile()
}

function scheduleIntervalReconcile(): void {
  if (stopped) return
  intervalHandle = setTimeout(() => {
    scheduleReconcile()
    scheduleIntervalReconcile()
  }, RECONCILE_INTERVAL_MS)
}

async function _runReconcile(): Promise<void> {
  reconcileRunning = true
  dirty = false
  try {
    await reconcile()
  } catch (err) {
    console.warn('[codexStatusState] reconcile error:', err)
    logDiagMain({
      category: 'error',
      level: 'warn',
      event: DIAG_EVENTS.SESSION_RECONCILE_FAILED,
      data: { err: String(err), harness: HARNESS_ID }
    })
  } finally {
    reconcileRunning = false
    if (dirty && !stopped) {
      dirty = false
      void _runReconcile()
    }
  }
}

// ---------------------------------------------------------------------------
// Core reconcile
// ---------------------------------------------------------------------------

interface CodexWorkspaceRow {
  id: string
  claude_session_id: string
}

/**
 * PROPERTY 3/2 cost bound — DB query mirrors sessionState.ts's
 * loadOwnedWorkspaceRows shape (same try/catch-and-log-null-on-failure
 * discipline), filtered to Codex-harness, session-bound, non-archived rows.
 * `claude_session_id` is the harness-agnostic DB column that holds Codex's
 * own rollout id (see session.ts's header for why the name is misleading
 * but correct to reuse) — filtering it IS NOT NULL in SQL means every row
 * this function returns is a workspace a Codex rollout might actually
 * exist for, bounding this service's per-tick cost by BOUND workspace
 * count, never by total session/rollout-file count on disk.
 */
function loadCodexWorkspaceRows(): CodexWorkspaceRow[] | null {
  try {
    const db = getDb()
    return db
      .prepare(
        `SELECT id, claude_session_id
         FROM workspaces
         WHERE harness_id = ? AND claude_session_id IS NOT NULL AND archived_at IS NULL`
      )
      .all(HARNESS_ID) as CodexWorkspaceRow[]
  } catch (err) {
    console.warn('[codexStatusState] failed to query workspaces:', err)
    logDiagMain({
      category: 'error',
      level: 'warn',
      event: DIAG_EVENTS.SESSION_RECONCILE_FAILED,
      data: { err: String(err), harness: HARNESS_ID }
    })
    return null
  }
}

/**
 * LATE-BINDING RE-ARM (support-multi-harness) — mirrors loadCodexWorkspaceRows'
 * shape exactly (same try/catch-and-log-null-on-failure discipline), but
 * scoped to the OPPOSITE set: Codex-harness, non-archived rows whose
 * `claude_session_id` is STILL NULL. Feeds selectUnboundCodexWorkspaceIds
 * (statusMap.ts) — see this file's header for why the reconcile loop now
 * also drives late session-discovery retries for these rows, instead of
 * relying solely on session.ts's short, bounded scheduleCodexSessionDiscovery
 * schedule.
 *
 * Every row this returns is already unbound by construction of the SQL
 * (`claude_session_id IS NULL`); selectUnboundCodexWorkspaceIds still
 * re-filters it rather than trusting that — see that function's own doc
 * comment on why it's written to accept a broader, mixed shape.
 */
function loadUnboundCodexWorkspaceRows(): CodexWorkspaceRowMaybeUnbound[] | null {
  try {
    const db = getDb()
    return db
      .prepare(
        `SELECT id, claude_session_id
         FROM workspaces
         WHERE harness_id = ? AND claude_session_id IS NULL AND archived_at IS NULL`
      )
      .all(HARNESS_ID) as CodexWorkspaceRowMaybeUnbound[]
  } catch (err) {
    console.warn('[codexStatusState] failed to query unbound workspaces:', err)
    logDiagMain({
      category: 'error',
      level: 'warn',
      event: DIAG_EVENTS.SESSION_RECONCILE_FAILED,
      data: { err: String(err), harness: HARNESS_ID }
    })
    return null
  }
}

/**
 * One late-binding retry attempt for a single unbound workspace: runs
 * discovery (discoverAndBindCodexSession, ./session — the SAME function
 * scheduleCodexSessionDiscovery's own bounded retries call, so this is
 * genuinely piggybacking on the existing mechanism, not a second discovery
 * implementation), then re-reads the workspace row to see whether THIS call
 * is what just bound it. discoverAndBindCodexSession returns void by
 * design (fire-and-forget, fail-soft — see its own doc comment), so the
 * only way to know whether THIS attempt caused a bind is to check
 * before/after via getWorkspace (workspaces.ts, already the discovery
 * function's own read path).
 *
 * If this attempt is the one that bound it, immediately calls
 * scheduleCodexTitleGeneration (./titleGeneration) — that module's own
 * scheduler is otherwise ONLY ever invoked once, from launch.ts, at initial
 * launch time (verified: no other call site exists in this codebase), so a
 * workspace that was still unbound at launch would never get a second
 * chance at title generation without this. Re-arming it here means title
 * generation starts trying (readFirstPromptForWorkspace, etc.) as soon as a
 * late bind happens, rather than never at all.
 *
 * Never throws — discoverAndBindCodexSession already fails soft, and the
 * re-read below degrades to "assume not bound by this call" on any error
 * (a later reconcile tick will simply retry).
 */
function retryLateBinding(workspaceId: string): void {
  let wasUnboundBefore = true
  try {
    wasUnboundBefore = !getWorkspace(workspaceId)?.claudeSessionId
  } catch {
    // Defensive — if even the pre-read throws, fall through to discovery
    // anyway; the post-read below will simply also fail soft and this tick
    // just won't detect a fresh bind (a later tick will).
  }

  discoverAndBindCodexSession(workspaceId)

  if (!wasUnboundBefore) return

  try {
    const ws = getWorkspace(workspaceId)
    if (ws?.claudeSessionId) {
      scheduleCodexTitleGeneration(workspaceId)
    }
  } catch {
    // DB hiccup on the re-read — worst case, title generation only starts
    // on a LATER tick once this workspace is re-evaluated as still unbound
    // (it won't be, once bound) or via whatever other path already exists;
    // never let this throw into the reconcile loop.
  }
}

// PROPERTY 2 — liveness computation itself lives in statusMap.ts
// (isLockHeld, imported above), NOT here. Relocated so
// scripts/verify-codex-status.ts can exercise the REAL function directly
// against a real temp directory (this module can't be imported standalone
// under plain `bun run` — it transitively pulls in `electron` via
// getDb()/orpheusNotify — so the liveness logic has to live in the
// dependency-free leaf module for a test to call the real thing rather than
// a reimplementation). See statusMap.ts's own header comment on isLockHeld
// for the full mechanism: a non-blocking exclusive-open PROBE against each
// workspace's own lock file path, not a directory listing — existence
// alone was tried first and found to misreport an orphaned lock (one left
// behind by a codex process that never got to run its own exit cleanup) as
// still held, which is documented in full there.

/**
 * PROPERTY 5 — torn-read tolerance. Reads the rollout file's lines and
 * delegates to findLastCodexTaskEvent (already per-line try/catch); the
 * read itself is wrapped so a missing file, permissions error, or any other
 * fs failure degrades to `null` (no task event observed) rather than
 * throwing and aborting the whole tick for every other workspace.
 */
function readTaskEventForFile(filePath: string): ReturnType<typeof findLastCodexTaskEvent> {
  try {
    const contents = fs.readFileSync(filePath, 'utf8')
    return findLastCodexTaskEvent(contents.split('\n'))
  } catch {
    return null
  }
}

/**
 * Reads the SAME app setting Claude's own driveStatusTransition
 * (src/main/sessionState.ts) reads for its own idle->awaiting_input/idle
 * split — no new setting is introduced for Codex; both harnesses share one
 * knob so a user configuring "how long is 'just finished' " gets one
 * consistent answer regardless of which harness a workspace runs. Returns
 * the threshold in MILLISECONDS (the setting itself is stored in minutes).
 */
function readStaleThresholdMs(): number {
  return (getAppUiState().staleAfterMinutes ?? UI_STATE_DEFAULTS.staleAfterMinutes) * 60_000
}

/**
 * One workspace's reconcile step: resolve its rollout file (reusing
 * findCodexRolloutFileById — see this function's own doc comment on why no
 * second discovery mechanism is written here), compute its last lifecycle
 * event and lock-held state, derive idle duration for a terminal event (the
 * IMPURE part — Date.now() + getAppUiState() live here, never inside
 * statusMap.ts's pure functions, mirroring exactly how sessionState.ts's
 * driveStatusTransition computes its own idleDuration/threshold inline
 * rather than inside _mapFileStatus), map to a WorkspaceStatus via
 * mapCodexStatus (PROPERTY 7 — no decision logic duplicated here), and
 * drive setStatusFromFile only on an actual change (PROPERTY 6).
 *
 * NO ROLLOUT FILE FOUND degrades safely without a special case: taskEvent
 * stays null and lockHeld is still probed as normal (a narrow startup race
 * can have the lock created before the rollout file's first line is
 * flushed) — deriveLiveObservationStamp/mapCodexStatus already resolve this
 * correctly either way: with no rollout event at all, idleDurationMs is
 * still measurable (anchored to first-observed-live-time — see
 * deriveLiveObservationStamp's doc comment in statusMap.ts), so a freshly
 * launched workspace with no turn taken yet but a held lock now correctly
 * reads awaiting_input rather than idle, exactly like a freshly RESUMED
 * workspace whose rollout event is stale.
 *
 * IDLE-DURATION ANCHORING (support-multi-harness age-anchoring fix) — the
 * IMPURE part of this computation: `codex resume <id>` replays a saved
 * transcript into the terminal but appends NOTHING to the rollout file, so
 * after an app restart the process can be brand new (lock freshly held)
 * while the rollout's last lifecycle event is arbitrarily old. Measuring
 * idleDurationMs directly from that stale rollout timestamp would
 * misclassify a genuinely-alive, freshly-resumed session as long-idle. The
 * fix: idleDurationMs is derived via deriveLiveObservationStamp
 * (statusMap.ts, PURE — this module only owns the impure
 * liveObservationStamps Map and Date.now(), never the decision itself),
 * which anchors "idle since" to max(the rollout event's own timestamp, when
 * THIS specific live session was first observed lock-held) — see that
 * function's own doc comment for the full reasoning, including why the
 * anchor is "first observation of this session" and NOT app boot time or a
 * per-tick re-stamp (both would break staleAfterMinutes in the opposite
 * direction).
 *
 * TIME-BASED RE-FIRING IS INTENTIONAL, NOT A BUG TO SUPPRESS. A workspace
 * sitting at 'awaiting_input' (rendered 'ready') for longer than the stale
 * threshold SHOULD eventually transition to 'idle' on a later tick purely
 * because idleDurationMs grows every tick even though the underlying
 * rollout/lock state hasn't changed — exactly like Claude's own stale-
 * demotion. This still holds under the new anchoring: firstObservedLiveAtMs
 * is set ONCE per liveness window (not re-stamped every tick), so
 * idleDurationMs keeps growing tick over tick for a session left alive and
 * untouched, and it will still cross staleThresholdMs and demote to idle.
 * The lastDrivenStatus dedup below only suppresses RE-DRIVING the SAME
 * computed status; it does not and must not suppress a genuine
 * awaiting_input -> idle transition once the threshold is crossed.
 */
function reconcileOneWorkspace(ws: CodexWorkspaceRow): void {
  const filePath = findCodexRolloutFileById(codexSessionsRoot(), ws.claude_session_id)
  const taskEvent = filePath ? readTaskEventForFile(filePath) : null
  const lockHeld = isLockHeld(path.join(locksDir(), `${ws.claude_session_id}.lock`))

  const { nextStamp, idleDurationMs } = deriveLiveObservationStamp(
    liveObservationStamps.get(ws.id),
    ws.claude_session_id,
    lockHeld,
    taskEvent,
    Date.now()
  )
  if (nextStamp) {
    liveObservationStamps.set(ws.id, nextStamp)
  } else {
    liveObservationStamps.delete(ws.id)
  }

  const staleThresholdMs = readStaleThresholdMs()

  const status = mapCodexStatus(taskEvent, lockHeld, idleDurationMs, staleThresholdMs)

  observedWorkspaces.add(ws.id)

  if (lastDrivenStatus.get(ws.id) !== status) {
    setStatusFromFile(ws.id, status)
    lastDrivenStatus.set(ws.id, status)
  }
}

/** Prune per-workspace tracking state for workspaces no longer bound/active
 *  (archived, removed, or reassigned to a different harness) — mirrors
 *  sessionState.ts's pruneStaleWorkspaceEntries to bound memory growth over
 *  the app's lifetime. */
function pruneStaleEntries(activeWorkspaceIds: ReadonlySet<string>): void {
  for (const id of lastDrivenStatus.keys()) {
    if (!activeWorkspaceIds.has(id)) lastDrivenStatus.delete(id)
  }
  for (const id of observedWorkspaces) {
    if (!activeWorkspaceIds.has(id)) observedWorkspaces.delete(id)
  }
  for (const id of liveObservationStamps.keys()) {
    if (!activeWorkspaceIds.has(id)) liveObservationStamps.delete(id)
  }
}

// NOT `async` — every step here is synchronous (fs.readFileSync, the
// per-workspace isLockHeld openSync/closeSync probe, the getDb() query), so
// there is no `await` to make an async function body meaningful (see
// usage.ts's getCodexUsage/getCodexCost for the same reasoning). The
// Promise-returning signature matches _runReconcile's `await reconcile()`
// call, mirroring sessionState.ts's own reconcile() shape.
function reconcile(): Promise<void> {
  const rows = loadCodexWorkspaceRows()
  if (rows === null) return Promise.resolve()

  const activeWorkspaceIds = new Set<string>()
  for (const ws of rows) {
    activeWorkspaceIds.add(ws.id)
    reconcileOneWorkspace(ws)
  }
  pruneStaleEntries(activeWorkspaceIds)

  // LATE-BINDING RE-ARM (support-multi-harness) — see this file's header
  // for why this piggybacks on the reconcile loop rather than owning a
  // separate watcher/schedule. Unbound rows are NOT part of `rows` above
  // (loadCodexWorkspaceRows filters claude_session_id IS NOT NULL), so this
  // is a genuinely separate query/loop, not a filter over the same rows.
  const unboundRows = loadUnboundCodexWorkspaceRows()
  if (unboundRows !== null) {
    for (const workspaceId of selectUnboundCodexWorkspaceIds(unboundRows)) {
      retryLateBinding(workspaceId)
    }
  }

  return Promise.resolve()
}
