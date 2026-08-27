/**
 * verify-codex-status.ts — regression harness for Codex's status-indicator
 * mapping (src/main/harness/codex/statusMap.ts), migrated (support-multi-
 * harness thread-DB migration) to Codex's OWN thread-history DB
 * (~/.codex/thread_history_1.sqlite) as the turn-status source, replacing
 * the prior rollout-JSONL scan.
 *
 * Guards:
 *   1. mapCodexStatus's truth table, especially THE STUCK-INDICATOR FIX —
 *      a crashed Codex process leaving `inProgress` as the last recorded
 *      turn status must still read as idle once its thread-writer-lock is
 *      gone (lockHeld === false wins unconditionally, even over a
 *      fresh-looking 'inProgress' status). This is UNCHANGED by the
 *      thread-DB migration — see statusMap.ts's header, "WHY LIVENESS IS
 *      STILL NEEDED", for why the DB alone cannot replace this signal.
 *   2. 'completed' | 'failed' | 'interrupted' all collapse to the SAME
 *      terminal bucket, matching Codex's own four verified distinct status
 *      values (no fifth value observed on a real DB).
 *   3. The idle-duration-based awaiting_input/idle split, including the
 *      exact boundary (idleDurationMs >= staleThresholdMs -> idle, strictly
 *      below -> awaiting_input), matching Claude's own
 *      `idleDuration >= threshold` comparison in sessionState.ts.
 *   4. No code path in mapCodexStatus can produce a value that maps to
 *      'attention' — neither the rollout nor the thread DB is a channel
 *      that can honestly carry that signal (see statusMap.ts's header).
 *   5. isLockHeld's non-blocking O_EXLOCK probe correctly distinguishes a
 *      HELD lock from a FREE/orphaned one and a MISSING file, and correctly
 *      observes a lock's RELEASE (the case that proves this is a real
 *      state probe, not an existence check in disguise) — UNCHANGED by the
 *      thread-DB migration, see statusMap.ts's own header comment on
 *      isLockHeld for the full mechanism and why existence alone was found
 *      to be wrong.
 *   6. deriveLiveObservationStamp's age-anchoring fix for `codex resume` —
 *      UNCHANGED reasoning, now fed by the thread DB's own completedAtMs
 *      instead of a rollout event's timestamp.
 *   7. getLatestTurn/getFirstUserPromptText (src/main/harness/codex/
 *      threadDb.ts) against REAL SQLite fixture DBs built in a temp dir
 *      with the exact schema verified on a live thread_history_1.sqlite:
 *      latest-turn-by-rollout_ordinal selection, epoch-seconds->ms
 *      conversion, degrade-to-null on missing file/table/thread/column.
 *
 * This imports the REAL mapCodexStatus/isLockHeld/deriveLiveObservationStamp
 * functions from src/main/harness/codex/statusMap.ts and getLatestTurn from
 * threadDb.ts — deliberately electron-free leaf modules built specifically
 * so this pure/fs/sqlite-only logic can be exercised directly, mirroring
 * scripts/verify-session-status.ts's own reasoning for importing
 * sessionStatusMap.ts's _mapFileStatus directly instead of sessionState.ts.
 *
 * RUNNER: this script now uses node:sqlite's DatabaseSync (real fixture DBs)
 * — same constraint as every other node:sqlite-touching harness in this
 * repo (bun has no node:sqlite equivalent) — so it is dispatched via
 * `node --experimental-strip-types`, NOT plain `bun run`, unlike its
 * pre-migration self. See scripts/verify-agentic-regression.ts's dispatch
 * table.
 *
 * Run: node --experimental-strip-types scripts/verify-codex-status.ts
 */

import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WorkspaceStatus } from '../src/shared/types.ts'
import {
  mapCodexStatus,
  isLockHeld,
  selectUnboundCodexWorkspaceIds,
  deriveLiveObservationStamp,
  type LiveObservationStamp
} from '../src/main/harness/codex/statusMap.ts'
import {
  getLatestTurn,
  getFirstUserPromptText,
  threadHistoryDbPath,
  type CodexLatestTurn
} from '../src/main/harness/codex/threadDb.ts'
import { ActivityBootBuffer } from '../src/main/activityBootBuffer.ts'
import type { ActivityUpdate } from '../src/main/activitySink.ts'
import { statusToActivityDetail, resolveActivityDetail } from '../src/shared/activityDetail.ts'
import type { WorkspaceActivityDetail } from '../src/shared/types.ts'

// A generous, realistic stale threshold for the tests below (mirrors the
// UI_STATE_DEFAULTS.staleAfterMinutes shape — minutes converted to ms — but
// hardcoded here so this harness never silently drifts if the app default
// changes; the boundary math being tested is what matters, not the app's
// current default value).
const STALE_THRESHOLD_MS = 5 * 60_000 // 5 minutes

function inProgressTurn(): CodexLatestTurn {
  return { status: 'inProgress', startedAtMs: Date.now(), completedAtMs: null }
}

function terminalTurn(
  status: 'completed' | 'failed' | 'interrupted',
  completedAtMs: number | null
): CodexLatestTurn {
  return { status, startedAtMs: completedAtMs, completedAtMs }
}

// ---------------------------------------------------------------------------
// mapCodexStatus — full truth table
// ---------------------------------------------------------------------------

assert.equal(
  mapCodexStatus(inProgressTurn(), true, null, STALE_THRESHOLD_MS),
  'in_progress',
  "lockHeld=true + status='inProgress' must map to in_progress"
)

assert.equal(
  mapCodexStatus(inProgressTurn(), false, null, STALE_THRESHOLD_MS),
  'idle',
  "THE STUCK-INDICATOR FIX: lockHeld=false must win over a fresh 'inProgress' status, mapping to idle"
)

assert.equal(
  mapCodexStatus(null, true, null, STALE_THRESHOLD_MS),
  'idle',
  'lockHeld=true + no recorded turn + UNMEASURABLE idleDurationMs (null) must still be idle — this ' +
    'stays idle ONLY because idleDurationMs is null here (the "can\'t measure" rule), NOT because ' +
    'latestTurn===null is unconditionally idle anymore — see the age-anchoring-fix cases below for ' +
    'the null-turn branch now being GATED by idleDurationMs like the terminal-turn branch always was'
)

assert.equal(
  mapCodexStatus(null, false, null, STALE_THRESHOLD_MS),
  'idle',
  'lockHeld=false + no recorded turn must be idle (liveness veto still applies)'
)

assert.equal(
  mapCodexStatus(terminalTurn('completed', null), true, null, STALE_THRESHOLD_MS),
  'idle',
  'a terminal turn with no measurable idle duration must degrade to idle, not awaiting_input'
)

assert.equal(
  mapCodexStatus(terminalTurn('completed', Date.now()), false, null, STALE_THRESHOLD_MS),
  'idle',
  'lockHeld=false + terminal turn must be idle (liveness veto wins over everything)'
)

console.log(
  '✓ mapCodexStatus base truth table (liveness veto, inProgress, null, unmeasurable terminal)'
)

// ---------------------------------------------------------------------------
// mapCodexStatus — 'failed' and 'interrupted' collapse to the SAME terminal
// bucket as 'completed' — Codex's four verified real status values, no
// fifth observed.
// ---------------------------------------------------------------------------

for (const status of ['completed', 'failed', 'interrupted'] as const) {
  assert.equal(
    mapCodexStatus(terminalTurn(status, Date.now() - 1000), true, 1000, STALE_THRESHOLD_MS),
    'awaiting_input',
    `a fresh terminal turn with status='${status}' must map to awaiting_input identically to the others`
  )
}
console.log(
  "✓ mapCodexStatus: 'completed' | 'failed' | 'interrupted' all collapse to the same terminal bucket"
)

// ---------------------------------------------------------------------------
// mapCodexStatus — AGE-ANCHORING FIX (support-multi-harness) regression
// coverage. `codex resume <id>` replays a saved transcript into the
// terminal but appends NOTHING to the thread DB until the next turn, so a
// freshly-resumed process can be alive right now while the thread's last
// recorded turn is hours old. mapCodexStatus itself is not where the fix
// lives (it just consults the idleDurationMs it is handed) — see
// deriveLiveObservationStamp's own coverage further below for that
// derivation itself). This is mapCodexStatus's CONTRACT, not concerned
// with WHERE idleDurationMs came from.
// ---------------------------------------------------------------------------

{
  const staleTurnAtMs = Date.now() - 16 * 60 * 60_000 // 16 hours ago (stale by itself)
  const freshIdleDurationMs = 10 * 60_000 // but the CALLER observed this live session 10 minutes ago
  const result = mapCodexStatus(
    terminalTurn('completed', staleTurnAtMs),
    true,
    freshIdleDurationMs,
    STALE_THRESHOLD_MS
  )
  assert.equal(
    result,
    'idle',
    'mapCodexStatus honors the idleDurationMs it is handed regardless of how old the turn itself is'
  )
}

{
  const freshIdleDurationMs = 2 * 60_000
  const oneHourThresholdMs = 60 * 60_000
  const result = mapCodexStatus(null, true, freshIdleDurationMs, oneHourThresholdMs)
  assert.equal(
    result,
    'awaiting_input',
    'a freshly-observed-live session with no recorded turn yet must read awaiting_input, not idle — ' +
      'this is the "freshly launched, no turn taken, lock held" case the age-anchoring fix enables'
  )
}

{
  const staleIdleDurationMs = 2 * 60 * 60_000
  const oneHourThresholdMs = 60 * 60_000
  const result = mapCodexStatus(null, true, staleIdleDurationMs, oneHourThresholdMs)
  assert.equal(
    result,
    'idle',
    'a long-unobserved live session with no recorded turn must still demote to idle once stale'
  )
}

{
  const freshIdleDurationMs = 2 * 60_000
  const oneHourThresholdMs = 60 * 60_000
  const result = mapCodexStatus(null, false, freshIdleDurationMs, oneHourThresholdMs)
  assert.equal(
    result,
    'idle',
    'liveness veto still wins even with a fresh idleDurationMs and no recorded turn'
  )
}

console.log(
  '✓ mapCodexStatus age-anchoring fix (stale turn + fresh caller idleDurationMs -> ' +
    'awaiting_input; null-turn branch gated by idleDurationMs like the terminal-turn branch)'
)

// ---------------------------------------------------------------------------
// mapCodexStatus — idle-duration boundary (awaiting_input vs idle)
// ---------------------------------------------------------------------------

assert.equal(
  mapCodexStatus(
    terminalTurn('completed', Date.now() - (STALE_THRESHOLD_MS - 1)),
    true,
    STALE_THRESHOLD_MS - 1,
    STALE_THRESHOLD_MS
  ),
  'awaiting_input',
  'idleDurationMs strictly below staleThresholdMs must be awaiting_input'
)

assert.equal(
  mapCodexStatus(terminalTurn('completed', null), true, 0, STALE_THRESHOLD_MS),
  'awaiting_input',
  'idleDurationMs=0 is a valid MEASURED value ("observed alive just now" — e.g. a freshly-launched ' +
    'workspace with no turn recorded yet, anchored to first-observation), not the same as null ' +
    '(unmeasurable) — mapCodexStatus must not conflate a null completedAtMs with an unmeasurable ' +
    'idleDurationMs when the caller supplied a real measured one'
)

assert.equal(
  mapCodexStatus(terminalTurn('completed', null), true, STALE_THRESHOLD_MS, STALE_THRESHOLD_MS),
  'idle',
  'idleDurationMs exactly AT staleThresholdMs must be idle (>= comparison, not >)'
)

assert.equal(
  mapCodexStatus(
    terminalTurn('completed', Date.now() - (STALE_THRESHOLD_MS + 1)),
    true,
    STALE_THRESHOLD_MS + 1,
    STALE_THRESHOLD_MS
  ),
  'idle',
  'idleDurationMs strictly above staleThresholdMs must be idle'
)

console.log('✓ mapCodexStatus idle-duration boundary (below/at/above stale threshold)')

// ---------------------------------------------------------------------------
// mapCodexStatus — nothing can ever produce 'attention'
// ---------------------------------------------------------------------------

{
  const possibleTurns: Array<CodexLatestTurn | null> = [
    null,
    inProgressTurn(),
    terminalTurn('completed', Date.now()),
    terminalTurn('failed', Date.now()),
    terminalTurn('interrupted', Date.now()),
    terminalTurn('completed', null)
  ]
  let checked = 0
  for (const turn of possibleTurns) {
    for (const lockHeld of [true, false]) {
      for (const idleDurationMs of [null, 0, STALE_THRESHOLD_MS - 1, STALE_THRESHOLD_MS]) {
        checked++
        const result: WorkspaceStatus = mapCodexStatus(
          turn,
          lockHeld,
          idleDurationMs,
          STALE_THRESHOLD_MS
        )
        assert.notEqual(
          result,
          'attention',
          `mapCodexStatus must never return 'attention' (got it for turn=${JSON.stringify(turn)}, lockHeld=${lockHeld}, idleDurationMs=${idleDurationMs})`
        )
      }
    }
  }
  console.log(
    `✓ mapCodexStatus exhaustive sweep (${checked} combinations) never returns 'attention'`
  )
}

// ---------------------------------------------------------------------------
// isLockHeld — the FIXED liveness probe (non-blocking exclusive-open, not
// directory existence). UNCHANGED by the thread-DB migration — see
// statusMap.ts's own header comment on isLockHeld for the full mechanism,
// verification against real lsof ground truth, and the alternatives that
// were tried and rejected before landing on this one.
//
// THIS TEST HOLDS A REAL O_EXLOCK FILE DESCRIPTOR OPEN, in this same
// process, across the assertions below, and probes that SAME path with a
// SEPARATE openSync call. BSD/darwin flock semantics are per-open-file-
// description — a second open() attempt on a path already exclusively
// locked by ANOTHER open() call genuinely contends for the lock even when
// both calls happen to be in the same process, so this single-process test
// is a faithful reproduction of "another (codex) process holds this lock",
// not a weaker same-process stand-in for it. Verified directly before
// writing this test: held file -> true, free file -> false, missing file
// -> false (ENOENT), and — the assertion that matters most, because it's
// the one a same-process self-lock oversight COULD get wrong — after the
// holder fd is closed, a re-probe of the same path correctly flips back to
// false. Confirmed all four cases pass against the real function before
// this was relied on as a valid single-process test strategy.
// ---------------------------------------------------------------------------

console.log('')
console.log('--- isLockHeld: held / free / missing / post-release (real O_EXLOCK probe) ---')
{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lock-probe-test-'))
  const heldPath = path.join(tmpDir, 'held.lock')
  const freePath = path.join(tmpDir, 'free.lock')
  const missingPath = path.join(tmpDir, 'nonexistent.lock')

  // Same darwin O_EXLOCK flag bit isLockHeld itself uses to PROBE — here
  // used WITHOUT O_NONBLOCK, deliberately: this open is meant to actually
  // ACQUIRE and hold the lock (a blocking exclusive-lock acquire is fine
  // here since nothing else in this test process holds it yet), whereas
  // isLockHeld's own probe adds O_NONBLOCK because it must never block
  // waiting for a lock it only wants to test, not take. fs.constants.O_EXLOCK
  // is undefined on this Node — see statusMap.ts's header comment for why
  // the numeric value is required.
  const O_EXLOCK = 0x20

  let holderFd: number | null = null
  try {
    fs.writeFileSync(heldPath, '')
    fs.writeFileSync(freePath, '')

    // Acquire a real exclusive lock on heldPath and hold it open across the
    // assertions below — this is what makes it "held" for isLockHeld to
    // detect, not merely a file that happens to exist.
    holderFd = fs.openSync(heldPath, fs.constants.O_RDONLY | O_EXLOCK)

    assert.equal(
      isLockHeld(heldPath),
      true,
      'a file with a real, currently-held exclusive lock must resolve to held=true'
    )
    assert.equal(
      isLockHeld(freePath),
      false,
      'a file that exists but has no lock holder must resolve to held=false'
    )
    assert.equal(
      isLockHeld(missingPath),
      false,
      'a nonexistent file (ENOENT) must resolve to held=false, not throw'
    )

    // THE ASSERTION THAT PROVES THIS IS A STATE PROBE, NOT AN EXISTENCE
    // CHECK: release the lock, then re-probe the SAME path. If isLockHeld
    // were secretly still keying off existence (or a same-process-blind
    // self-lock artifact), this would incorrectly still read true — the
    // file itself is untouched, only the lock STATE changed.
    fs.closeSync(holderFd)
    holderFd = null
    assert.equal(
      isLockHeld(heldPath),
      false,
      'after the holder releases the lock (fd closed), a re-probe of the SAME still-existing ' +
        'file must flip to held=false — proves this probes lock state, not file existence'
    )

    console.log(
      '✓ isLockHeld: held -> true, free -> false, missing -> false, post-release -> false'
    )
  } finally {
    if (holderFd !== null) {
      try {
        fs.closeSync(holderFd)
      } catch {
        // Already closed or never opened — nothing further to clean up.
      }
    }
    // Clean up even on assertion failure so a failing run doesn't leave a
    // locked file (or its holder fd) behind.
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

console.log('')
console.log('--- mutation test 3: isLockHeld reverted to bare existsSync (the orphan-lock bug) ---')
{
  // Reimplements isLockHeld as a plain existence check (the exact bug that
  // was found and fixed — see statusMap.ts's header for the full story),
  // to prove the held/post-release assertions above would have caught this
  // exact regression had it shipped.
  function brokenIsLockHeld(lockFilePath: string): boolean {
    return fs.existsSync(lockFilePath)
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-lock-mutation-test-'))
  const heldPath = path.join(tmpDir, 'held.lock')
  const O_EXLOCK = 0x20

  let holderFd: number | null = null
  try {
    fs.writeFileSync(heldPath, '')
    holderFd = fs.openSync(heldPath, fs.constants.O_RDONLY | O_EXLOCK)
    fs.closeSync(holderFd) // release immediately — heldPath is now an ORPHAN: exists, unheld
    holderFd = null

    const mutatedResult = brokenIsLockHeld(heldPath)

    try {
      assert.equal(
        mutatedResult,
        false,
        'MUTATION EXPECTED TO FAIL: existsSync must not treat an orphaned (released) lock file as held'
      )
      console.log(
        'UNEXPECTED PASS — mutation 3 did not trigger a failure (test is not sensitive enough)'
      )
      process.exitCode = 1
    } catch (err) {
      console.log('✓ mutation 3 correctly FAILED as expected:')
      console.log(`  ${(err as Error).message}`)
    }

    // Confirm the REAL isLockHeld correctly resolves the same orphaned file
    // to false, where the broken reimplementation above returned true.
    const realResult = isLockHeld(heldPath)
    assert.equal(
      realResult,
      false,
      'real isLockHeld must correctly resolve the same orphaned file to false'
    )
    console.log(
      '✓ real isLockHeld resolves the identical orphaned file correctly (mutation was correctly detected as wrong)'
    )
  } finally {
    if (holderFd !== null) {
      try {
        fs.closeSync(holderFd)
      } catch {
        // Already closed — nothing further to clean up.
      }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

console.log('')
console.log(
  "  (no-bound-thread / no-thread-DB case is handled by threadDb.ts's own null-degrade contract — see section 7 below)"
)

// ---------------------------------------------------------------------------
// deriveLiveObservationStamp (src/main/harness/codex/statusMap.ts) — the
// AGE-ANCHORING FIX's own pure derivation (support-multi-harness). UNCHANGED
// reasoning by the thread-DB migration — this is the statusState.ts-side
// half of the fix: given a workspace's previously tracked stamp (or none),
// its current session id, lockHeld, latestTurn, and "now", decides the NEXT
// stamp to store and the idleDurationMs to hand mapCodexStatus. Imports and
// calls the REAL exported function (also the one statusState.ts's
// reconcileOneWorkspace calls in production), not a reimplementation —
// statusState.ts itself can't be imported under plain `bun run`/node (pulls
// in electron via getDb()/orpheusNotify at module scope), which is exactly
// why this derivation was extracted into statusMap.ts in the first place —
// same reasoning as every other pure decision this file already tests
// directly from that module.
// ---------------------------------------------------------------------------

console.log('')
console.log('--- deriveLiveObservationStamp: stamp lifecycle + idleDurationMs derivation ---')

{
  // First observation of a newly-live session (no prior stamp) — must stamp
  // fresh at `nowMs`, and with no latestTurn at all, idleDurationMs must be
  // exactly 0 (idleSinceMs collapses to firstObservedLiveAtMs === nowMs).
  const nowMs = 1_000_000
  const result = deriveLiveObservationStamp(undefined, 'session-a', true, null, nowMs)
  assert.deepEqual(
    result.nextStamp,
    { sessionId: 'session-a', firstObservedLiveAtMs: nowMs },
    'first observation of a newly-live session (no prior stamp) must stamp fresh at nowMs'
  )
  assert.equal(
    result.idleDurationMs,
    0,
    'with no latestTurn, idleDurationMs must equal nowMs - firstObservedLiveAtMs (0 on first tick)'
  )
}

{
  // THE CORE FIX ITSELF: an existing stamp from an EARLIER observation, plus
  // a stale terminal turn — idleDurationMs must anchor to the STAMP
  // (fresher), not the stale turn, i.e. max(turn.completedAtMs, stamp) must
  // pick the stamp when the stamp is more recent than the turn.
  const firstObservedLiveAtMs = 1_000_000
  const nowMs = firstObservedLiveAtMs + 10 * 60_000 // 10 minutes after first observed
  const staleTurnAtMs = firstObservedLiveAtMs - 16 * 60 * 60_000 // 16 hours BEFORE first observed
  const prevStamp: LiveObservationStamp = { sessionId: 'session-a', firstObservedLiveAtMs }

  const result = deriveLiveObservationStamp(
    prevStamp,
    'session-a',
    true,
    terminalTurn('completed', staleTurnAtMs),
    nowMs
  )
  assert.deepEqual(
    result.nextStamp,
    prevStamp,
    'an existing stamp for the SAME session id must be kept as-is (firstObservedLiveAtMs is not re-stamped)'
  )
  assert.equal(
    result.idleDurationMs,
    10 * 60_000,
    'THE FIX: idleDurationMs must anchor to nowMs - firstObservedLiveAtMs (10min), NOT ' +
      'nowMs - staleTurnAtMs (~16.17hrs) — a stale thread-DB turn must not dominate a fresh live observation'
  )
}

{
  // A turn NEWER than the stamp must win instead (max picks the turn) —
  // proves this is a genuine max(), not "always prefer the stamp".
  const firstObservedLiveAtMs = 1_000_000
  const nowMs = firstObservedLiveAtMs + 60 * 60_000 // 1 hour after first observed
  const recentTurnAtMs = firstObservedLiveAtMs + 55 * 60_000 // 55 minutes after first observed (newer than the stamp, older than now)
  const prevStamp: LiveObservationStamp = { sessionId: 'session-a', firstObservedLiveAtMs }

  const result = deriveLiveObservationStamp(
    prevStamp,
    'session-a',
    true,
    terminalTurn('completed', recentTurnAtMs),
    nowMs
  )
  assert.equal(
    result.idleDurationMs,
    5 * 60_000,
    'when the turn completedAtMs is NEWER than the stamp, idleDurationMs must anchor to the turn ' +
      '(nowMs - recentTurnAtMs = 5min), proving this is max(), not a stamp-only anchor'
  )
}

{
  // Session id CHANGE (workspace re-bound to a different Codex session) must
  // NOT reuse the old stamp — must start fresh at nowMs for the new session.
  const nowMs = 5_000_000
  const oldStamp: LiveObservationStamp = {
    sessionId: 'session-OLD',
    firstObservedLiveAtMs: 1_000_000
  }
  const result = deriveLiveObservationStamp(oldStamp, 'session-NEW', true, null, nowMs)
  assert.deepEqual(
    result.nextStamp,
    { sessionId: 'session-NEW', firstObservedLiveAtMs: nowMs },
    'a session id change must NOT reuse the old stamp — must start fresh at nowMs for the new session id'
  )
  assert.equal(
    result.idleDurationMs,
    0,
    'a fresh stamp for a rebound session must yield idleDurationMs=0 on first observation, not ' +
      'inherit age from the old sessions stamp'
  )
}

{
  // Lock NOT held — must clear the stamp entirely (nextStamp: null) so a
  // LATER re-acquire starts fresh, and idleDurationMs is null (unused by
  // mapCodexStatus's veto branch anyway, but must not be a stale number).
  const nowMs = 9_000_000
  const prevStamp: LiveObservationStamp = {
    sessionId: 'session-a',
    firstObservedLiveAtMs: 1_000_000
  }
  const result = deriveLiveObservationStamp(prevStamp, 'session-a', false, null, nowMs)
  assert.equal(
    result.nextStamp,
    null,
    'lockHeld=false must clear the stamp entirely (nextStamp: null), regardless of a prior stamp existing'
  )
  assert.equal(
    result.idleDurationMs,
    null,
    'lockHeld=false must yield idleDurationMs=null (unused by mapCodexStatus veto branch, but must not be stale)'
  )
}

console.log(
  '✓ deriveLiveObservationStamp: fresh stamp on first observation, existing stamp kept + max() ' +
    'anchoring (the fix itself), session-id-change resets, lock-released clears'
)

console.log('')
console.log(
  '--- mutation test 9: deriveLiveObservationStamp reverted to raw latestTurn.completedAtMs (no max()) ---'
)
{
  // Reimplements the derivation WITHOUT the max() — the exact regression
  // this fix corrects: idleDurationMs anchored directly to the thread DB's
  // own turn timestamp, ignoring the live-observation stamp entirely.
  function brokenDeriveLiveObservationStamp(
    prevStamp: LiveObservationStamp | undefined,
    sessionId: string,
    lockHeld: boolean,
    latestTurn: Parameters<typeof deriveLiveObservationStamp>[3],
    nowMs: number
  ): { nextStamp: LiveObservationStamp | null; idleDurationMs: number | null } {
    if (!lockHeld) return { nextStamp: null, idleDurationMs: null }
    const stamp: LiveObservationStamp =
      prevStamp && prevStamp.sessionId === sessionId
        ? prevStamp
        : { sessionId, firstObservedLiveAtMs: nowMs }
    // BUG: uses latestTurn.completedAtMs directly with no max() against the
    // stamp — reproduces the original age-mismeasurement bug.
    const eventAtMs =
      latestTurn && latestTurn.status !== 'inProgress' ? latestTurn.completedAtMs : null
    if (eventAtMs === null)
      return { nextStamp: stamp, idleDurationMs: nowMs - stamp.firstObservedLiveAtMs }
    return { nextStamp: stamp, idleDurationMs: nowMs - eventAtMs }
  }

  const firstObservedLiveAtMs = 1_000_000
  const nowMs = firstObservedLiveAtMs + 10 * 60_000
  const staleTurnAtMs = firstObservedLiveAtMs - 16 * 60 * 60_000
  const prevStamp: LiveObservationStamp = { sessionId: 'session-a', firstObservedLiveAtMs }

  const mutatedResult = brokenDeriveLiveObservationStamp(
    prevStamp,
    'session-a',
    true,
    terminalTurn('completed', staleTurnAtMs),
    nowMs
  )

  try {
    assert.equal(
      mutatedResult.idleDurationMs,
      10 * 60_000,
      'MUTATION EXPECTED TO FAIL: without max(), idleDurationMs is measured from the stale turn ' +
        '(~16.17hrs) instead of the fresh live-observation stamp (10min) — reproduces THE original bug'
    )
    console.log(
      'UNEXPECTED PASS — mutation 9 did not trigger a failure (test is not sensitive enough)'
    )
    process.exitCode = 1
  } catch (err) {
    console.log('✓ mutation 9 correctly FAILED as expected:')
    console.log(`  ${(err as Error).message}`)
  }

  // Confirm the REAL deriveLiveObservationStamp resolves the identical
  // scenario correctly (this is the exact scenario from the live repro this
  // fix was diagnosed from: a 16.5hr-stale turn, a session first observed
  // live 10 minutes ago).
  const realResult = deriveLiveObservationStamp(
    prevStamp,
    'session-a',
    true,
    terminalTurn('completed', staleTurnAtMs),
    nowMs
  )
  assert.equal(
    realResult.idleDurationMs,
    10 * 60_000,
    'real deriveLiveObservationStamp must correctly anchor to the fresh live-observation stamp'
  )
  console.log(
    '✓ real deriveLiveObservationStamp resolves the identical scenario correctly (mutation was correctly detected as wrong)'
  )
}

// ---------------------------------------------------------------------------
// threadDb.ts — getLatestTurn / getFirstUserPromptText against REAL SQLite
// fixture DBs (node:sqlite's DatabaseSync), built with the EXACT schema
// verified against a live ~/.codex/thread_history_1.sqlite on a real dev
// machine (see threadDb.ts's own header for the full verification detail):
// thread_turns(thread_id, turn_id, rollout_ordinal, status, started_at,
// completed_at, first_user_item_id, ...) and thread_items(thread_id,
// turn_id, item_id, item_json, item_type, ...), plus a minimal
// _sqlx_migrations table so the schema-version observability path is
// exercised too.
//
// Every fixture DB is built in a fresh temp dir and pointed at via
// threadHistoryDbPath's CODEX_HOME-style resolution — this script sets
// CODEX_HOME to the temp dir for the duration of each scenario so the real,
// unmodified threadDb.ts functions read the fixture rather than any real
// ~/.codex/thread_history_1.sqlite on the machine running this suite.
// ---------------------------------------------------------------------------

console.log('')
console.log('--- threadDb.ts: getLatestTurn / getFirstUserPromptText against real fixture DBs ---')

function withFixtureCodexHome<T>(build: (dbPath: string) => void, run: () => T): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-db-test-'))
  const prevCodexHome = process.env['CODEX_HOME']
  try {
    process.env['CODEX_HOME'] = tmpDir
    const dbPath = threadHistoryDbPath(tmpDir)
    build(dbPath)
    return run()
  } finally {
    if (prevCodexHome === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = prevCodexHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function createFixtureSchema(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      error_json TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER,
      first_user_item_id TEXT,
      final_agent_item_id TEXT,
      PRIMARY KEY (thread_id, turn_id)
    );
    CREATE TABLE thread_items (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      item_json TEXT NOT NULL,
      item_type TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (thread_id, turn_id, item_id)
    );
    CREATE TABLE _sqlx_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      installed_on TEXT,
      success INTEGER
    );
    INSERT INTO _sqlx_migrations (version, description, installed_on, success)
    VALUES (1, 'thread history', '2026-01-01', 1),
           (2, 'thread items item type', '2026-01-01', 1),
           (3, 'turn rollout positions', '2026-01-01', 1),
           (4, 'thread items updated at ordinal', '2026-01-01', 1);
  `)
  return db
}

{
  // getLatestTurn: latest-by-rollout_ordinal selection, epoch-seconds->ms
  // conversion. Deliberately inserts turns OUT OF started_at order but IN
  // rollout_ordinal order, so a correct implementation must key off
  // rollout_ordinal (the verified-monotonic column), not started_at/insert
  // order — the exact distinction threadDb.ts's header calls out.
  const threadId = 'thread-latest-turn'
  withFixtureCodexHome(
    (dbPath) => {
      const db = createFixtureSchema(dbPath)
      // turn-2 has the HIGHER rollout_ordinal (500 > 1) but a LOWER
      // started_at (1000 < 2000) than turn-1 — the two orderings
      // deliberately DISAGREE, so a mutant that keys off started_at (or
      // insert order) instead of rollout_ordinal picks the WRONG row and
      // this assertion catches it.
      db.exec(`
        INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at)
        VALUES
          ('${threadId}', 'turn-1', 1, 'completed', 2000, 2005),
          ('${threadId}', 'turn-2', 500, 'inProgress', 1000, NULL);
      `)
      db.close()
    },
    () => {
      const result = getLatestTurn(threadId)
      assert.deepEqual(
        result,
        { status: 'inProgress', startedAtMs: 1_000_000, completedAtMs: null },
        'getLatestTurn must select the row with the HIGHEST rollout_ordinal (turn-2), even though ' +
          'it has a LOWER started_at than turn-1 — proves selection keys off rollout_ordinal, not ' +
          'started_at or insert order'
      )
    }
  )
  console.log(
    '✓ getLatestTurn: selects by rollout_ordinal (not started_at/insert order), converts seconds->ms'
  )
}

{
  // getLatestTurn: unknown thread id -> null (no turns recorded yet).
  withFixtureCodexHome(
    (dbPath) => {
      createFixtureSchema(dbPath).close()
    },
    () => {
      assert.equal(
        getLatestTurn('thread-does-not-exist'),
        null,
        'getLatestTurn must return null for a thread id with no rows at all'
      )
    }
  )
  console.log('✓ getLatestTurn: unknown thread id degrades to null')
}

{
  // getLatestTurn: missing DB file entirely (user who never ran interactive
  // codex) -> null, never throws.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-thread-db-missing-'))
  const prevCodexHome = process.env['CODEX_HOME']
  try {
    process.env['CODEX_HOME'] = tmpDir // no thread_history_1.sqlite written here at all
    assert.equal(
      getLatestTurn('any-thread-id'),
      null,
      'getLatestTurn must return null when the DB file does not exist at all, never throw'
    )
    assert.equal(
      getFirstUserPromptText('any-thread-id'),
      null,
      'getFirstUserPromptText must return null when the DB file does not exist at all, never throw'
    )
  } finally {
    if (prevCodexHome === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = prevCodexHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
  console.log(
    '✓ getLatestTurn/getFirstUserPromptText: missing DB file degrades to null, never throws'
  )
}

{
  // getLatestTurn: an unrecognized status string (future Codex schema drift)
  // -> null, never passed through as an unrecognized value.
  const threadId = 'thread-unknown-status'
  withFixtureCodexHome(
    (dbPath) => {
      const db = createFixtureSchema(dbPath)
      db.exec(`
        INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at)
        VALUES ('${threadId}', 'turn-1', 1, 'somethingFutureCodexInvented', 1000, 1005);
      `)
      db.close()
    },
    () => {
      assert.equal(
        getLatestTurn(threadId),
        null,
        'an unrecognized status string must degrade to null, never be passed through unchecked'
      )
    }
  )
  console.log(
    '✓ getLatestTurn: unrecognized status string degrades to null (schema-drift tolerance)'
  )
}

{
  // getFirstUserPromptText: EARLIEST turn with a non-null first_user_item_id
  // wins, NOT the latest turn's own first_user_item_id — reproduces the
  // real verified case (a thread whose latest turn has first_user_item_id
  // = NULL despite an earlier turn carrying the thread's real opening
  // prompt). Also verifies multi-part content is concatenated (text parts
  // only, non-text parts like localImage skipped).
  const threadId = 'thread-first-prompt'
  withFixtureCodexHome(
    (dbPath) => {
      const db = createFixtureSchema(dbPath)
      db.exec(`
        INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, first_user_item_id)
        VALUES
          ('${threadId}', 'turn-1', 1, 'completed', 1000, 1005, 'item-opening'),
          ('${threadId}', 'turn-2', 500, 'completed', 2000, 2005, NULL);
      `)
      const openingJson = JSON.stringify({
        type: 'userMessage',
        id: 'item-opening',
        clientId: null,
        content: [
          { type: 'localImage', detail: null, path: '/tmp/screenshot.png' },
          { type: 'text', text: 'Read this codebase and tell me', text_elements: [] },
          { type: 'text', text: 'what it does.', text_elements: [] }
        ]
      })
      const stmt = db.prepare(
        `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
         VALUES (?, ?, ?, 1, 1000000, ?, 'userMessage')`
      )
      stmt.run(threadId, 'turn-1', 'item-opening', openingJson)
      db.close()
    },
    () => {
      const result = getFirstUserPromptText(threadId)
      assert.equal(
        result,
        'Read this codebase and tell me what it does.',
        'must find the EARLIEST turn with a non-null first_user_item_id (turn-1, not the latest ' +
          'turn-2 whose first_user_item_id is NULL), and concatenate only the text parts, in order, ' +
          'skipping the non-text localImage part entirely'
      )
    }
  )
  console.log(
    '✓ getFirstUserPromptText: earliest-turn-with-non-null-first_user_item_id + text-part concatenation'
  )
}

{
  // getFirstUserPromptText: a prompt that itself starts with '#' must be
  // returned verbatim — THE OLD ROLLOUT-SCANNING HEURISTIC'S DOCUMENTED
  // FAILURE MODE (looksInjected treated any '#'/'<'-prefixed first line as
  // injected context and skipped it) is now GONE: the thread DB's
  // userMessage records carry no injected-context contamination to filter,
  // so no such heuristic exists in this module at all, and this case must
  // now PASS where the old design would have wrongly returned null/a later
  // fallback candidate instead.
  const threadId = 'thread-hash-prefix-prompt'
  withFixtureCodexHome(
    (dbPath) => {
      const db = createFixtureSchema(dbPath)
      db.exec(`
        INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, first_user_item_id)
        VALUES ('${threadId}', 'turn-1', 1, 'completed', 1000, 1005, 'item-hash');
      `)
      const itemJson = JSON.stringify({
        type: 'userMessage',
        id: 'item-hash',
        clientId: null,
        content: [{ type: 'text', text: '# fix this bug in the parser', text_elements: [] }]
      })
      const stmt = db.prepare(
        `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
         VALUES (?, ?, ?, 1, 1000000, ?, 'userMessage')`
      )
      stmt.run(threadId, 'turn-1', 'item-hash', itemJson)
      db.close()
    },
    () => {
      const result = getFirstUserPromptText(threadId)
      assert.equal(
        result,
        '# fix this bug in the parser',
        "THE OLD HEURISTIC'S FAILURE MODE MUST NOW PASS: a genuine human prompt starting with '#' " +
          'must be returned as-is — the thread DB has no injected-context contamination requiring ' +
          'a #/< discriminator, so none is applied'
      )
    }
  )
  console.log(
    "✓ getFirstUserPromptText: a prompt starting with '#' is returned verbatim (old heuristic's failure mode now fixed)"
  )
}

{
  // getFirstUserPromptText: no turn has a first_user_item_id at all -> null.
  const threadId = 'thread-no-first-prompt'
  withFixtureCodexHome(
    (dbPath) => {
      const db = createFixtureSchema(dbPath)
      db.exec(`
        INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, first_user_item_id)
        VALUES ('${threadId}', 'turn-1', 1, 'completed', 1000, 1005, NULL);
      `)
      db.close()
    },
    () => {
      assert.equal(
        getFirstUserPromptText(threadId),
        null,
        'a thread with no turn carrying a first_user_item_id must degrade to null'
      )
    }
  )
  console.log(
    '✓ getFirstUserPromptText: no first_user_item_id anywhere in the thread degrades to null'
  )
}

{
  // getFirstUserPromptText: first_user_item_id points at a row that isn't
  // in thread_items at all (torn write / schema drift) -> null, never throw.
  const threadId = 'thread-dangling-item-id'
  withFixtureCodexHome(
    (dbPath) => {
      const db = createFixtureSchema(dbPath)
      db.exec(`
        INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, first_user_item_id)
        VALUES ('${threadId}', 'turn-1', 1, 'completed', 1000, 1005, 'item-does-not-exist');
      `)
      db.close()
    },
    () => {
      assert.equal(
        getFirstUserPromptText(threadId),
        null,
        'a first_user_item_id with no matching thread_items row must degrade to null, not throw'
      )
    }
  )
  console.log(
    '✓ getFirstUserPromptText: dangling first_user_item_id (no matching row) degrades to null'
  )
}

{
  // getFirstUserPromptText: unknown future schema version (_sqlx_migrations
  // ahead of what threadDb.ts was verified against) must NOT block a
  // successful read — only a genuinely missing/renamed column should.
  const threadId = 'thread-future-schema'
  withFixtureCodexHome(
    (dbPath) => {
      const db = createFixtureSchema(dbPath)
      db.exec(`
        INSERT INTO _sqlx_migrations (version, description, installed_on, success)
        VALUES (99, 'a future migration this module has never seen', '2099-01-01', 1);
        INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, first_user_item_id)
        VALUES ('${threadId}', 'turn-1', 1, 'completed', 1000, 1005, 'item-1');
      `)
      const itemJson = JSON.stringify({
        type: 'userMessage',
        id: 'item-1',
        clientId: null,
        content: [{ type: 'text', text: 'still works fine', text_elements: [] }]
      })
      const stmt = db.prepare(
        `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
         VALUES (?, ?, ?, 1, 1000000, ?, 'userMessage')`
      )
      stmt.run(threadId, 'turn-1', 'item-1', itemJson)
      db.close()
    },
    () => {
      assert.equal(
        getFirstUserPromptText(threadId),
        'still works fine',
        'an unrecognized future _sqlx_migrations version must not block a successful read of ' +
          'columns this module actually reads and understands'
      )
      assert.deepEqual(
        getLatestTurn(threadId),
        { status: 'completed', startedAtMs: 1_000_000, completedAtMs: 1_005_000 },
        'getLatestTurn must also succeed normally despite the unrecognized future schema version'
      )
    }
  )
  console.log(
    '✓ getLatestTurn/getFirstUserPromptText: unknown future schema version does not block a valid read'
  )
}

// ---------------------------------------------------------------------------
// ActivityBootBuffer (src/main/activityBootBuffer.ts) — the boot-seed
// delivery fix for the "renderer wasn't ready yet" race that dropped a
// Codex workspace's post-restart status dot (see index.ts's onActivityBatch
// wiring for the full production call site). Imports the REAL class, not a
// reimplementation, per this repo's "assert behaviour, not source text" rule.
//
// Coverage required by the task brief:
//   1. an update staged before "ready" is buffered, not sent
//   2. once "ready" fires, the buffered update(s) ARE delivered (merged)
//   3. an update staged AFTER ready is delivered immediately (not buffered)
//   4. a second identical observation after delivery does not redeliver
//      (this buffer never dedupes by VALUE — that's orpheusNotify.ts's job,
//      deliberately untouched by this fix — so what's asserted here is that
//      the buffer itself doesn't invent an extra delivery: a second stage()
//      call post-ready passes through exactly once, and markReady() itself
//      is idempotent so a stray double-fire of the ready event can't
//      re-deliver an already-flushed batch)
// ---------------------------------------------------------------------------

console.log('')
console.log('--- ActivityBootBuffer: boot-seed delivery ---')

function makeUpdate(workspaceId: string, detail: ActivityUpdate['detail']): ActivityUpdate {
  return { workspaceId, status: 'idle', detail }
}

{
  const buffer = new ActivityBootBuffer()

  // (1) staged before ready must be buffered (stage() returns null), not sent.
  const beforeReadyResult = buffer.stage(makeUpdate('ws-1', 'idle'))
  assert.equal(
    beforeReadyResult,
    null,
    'an update staged before markReady() must be buffered (stage() returns null), not passed through'
  )
  assert.equal(buffer.isReady(), false, 'buffer must not be ready before markReady() is called')

  // A second workspace's update also staged pre-ready, to prove the flush
  // merges MULTIPLE buffered workspaces into one batch, not just one.
  const secondBeforeReady = buffer.stage(makeUpdate('ws-2', 'attention'))
  assert.equal(secondBeforeReady, null, 'a second pre-ready update must also be buffered')

  // (2) markReady() must return exactly the buffered updates, merged.
  const flushed = buffer.markReady()
  assert.equal(buffer.isReady(), true, 'buffer must be ready after markReady()')
  assert.equal(flushed.length, 2, 'markReady() must flush both buffered updates as one batch')
  const flushedIds = flushed.map((u) => u.workspaceId).sort()
  assert.deepEqual(
    flushedIds,
    ['ws-1', 'ws-2'],
    'the flushed batch must contain both workspaces that were staged before ready'
  )

  // (3) staged AFTER ready must pass straight through (return the same update).
  const afterReadyUpdate = makeUpdate('ws-3', 'working')
  const afterReadyResult = buffer.stage(afterReadyUpdate)
  assert.equal(
    afterReadyResult,
    afterReadyUpdate,
    'an update staged after ready must be returned immediately (passthrough), not buffered'
  )

  // (4a) markReady() called again (e.g. a stray double-fire of the ready
  // event) must not re-deliver — idempotent, returns empty.
  const secondMarkReady = buffer.markReady()
  assert.deepEqual(
    secondMarkReady,
    [],
    'calling markReady() a second time must return an empty array, never re-deliver the first flush'
  )

  // (4b) a second identical stage() post-ready must still pass through
  // exactly once per call (no accidental buffering/dedup inside this class —
  // steady-state VALUE dedup is orpheusNotify.ts's job, not this buffer's).
  const repeatUpdate = makeUpdate('ws-3', 'working')
  const repeatResult = buffer.stage(repeatUpdate)
  assert.equal(
    repeatResult,
    repeatUpdate,
    'a second stage() call post-ready must pass through on its own — this buffer performs no value dedup'
  )

  console.log(
    '✓ ActivityBootBuffer: pre-ready buffering, merged flush-on-ready, post-ready passthrough, idempotent markReady()'
  )
}

// reset() must re-arm buffering for a subsequent renderer reload (dev HMR,
// crash recovery) — a ready buffer must go back to buffering after reset(),
// and any stale pre-reset pending entries must not leak into the next flush.
{
  const buffer = new ActivityBootBuffer()
  buffer.stage(makeUpdate('ws-stale', 'idle'))
  buffer.markReady() // first boot's flush
  assert.equal(buffer.isReady(), true, 'sanity: buffer must be ready after the first markReady()')

  buffer.reset()
  assert.equal(buffer.isReady(), false, 'reset() must flip the buffer back to not-ready')

  const stagedAfterReset = buffer.stage(makeUpdate('ws-reload', 'ready'))
  assert.equal(
    stagedAfterReset,
    null,
    'an update staged after reset() must buffer again, exactly like the original boot'
  )

  const flushedAfterReload = buffer.markReady()
  const idsAfterReload = flushedAfterReload.map((u) => u.workspaceId)
  assert.deepEqual(
    idsAfterReload,
    ['ws-reload'],
    "reset()'s flush must contain only what was staged since the reset, not the stale pre-reset entry"
  )

  console.log('✓ ActivityBootBuffer: reset() re-arms buffering for a subsequent reload')
}

console.log('')
console.log('--- mutation test 4: ActivityBootBuffer.stage() always drops (never flushes) ---')
{
  // Reimplements stage()/markReady() with the bug this fix's own header
  // warns against: buffering is fine, but the flush step silently discards
  // instead of returning the pending updates — reproducing the exact
  // "buffered forever, never delivered" failure this whole fix exists to
  // prevent, to prove the assertions above would have caught it.
  class BrokenActivityBootBuffer {
    private ready = false
    private readonly pending = new Map<string, ActivityUpdate>()
    stage(update: ActivityUpdate): ActivityUpdate | null {
      if (this.ready) return update
      this.pending.set(update.workspaceId, update)
      return null
    }
    markReady(): ActivityUpdate[] {
      this.ready = true
      this.pending.clear() // BUG: clears without ever returning what was cleared
      return []
    }
  }

  const broken = new BrokenActivityBootBuffer()
  broken.stage(makeUpdate('ws-1', 'idle'))
  const mutatedFlush = broken.markReady()

  try {
    assert.equal(
      mutatedFlush.length,
      1,
      'MUTATION EXPECTED TO FAIL: markReady() must return the buffered update, not silently drop it'
    )
    console.log(
      'UNEXPECTED PASS — mutation 4 did not trigger a failure (test is not sensitive enough)'
    )
    process.exitCode = 1
  } catch (err) {
    console.log('✓ mutation 4 correctly FAILED as expected:')
    console.log(`  ${(err as Error).message}`)
  }

  // Confirm the REAL ActivityBootBuffer resolves the identical scenario correctly.
  const real = new ActivityBootBuffer()
  real.stage(makeUpdate('ws-1', 'idle'))
  const realFlush = real.markReady()
  assert.equal(
    realFlush.length,
    1,
    'real ActivityBootBuffer must correctly flush the buffered update on markReady()'
  )
  console.log(
    '✓ real ActivityBootBuffer resolves the identical scenario correctly (mutation was correctly detected as wrong)'
  )
}

// ---------------------------------------------------------------------------
// statusToActivityDetail / resolveActivityDetail (src/shared/activityDetail.ts)
// — the renderer boot-time fallback fix for a harness-agnostic gap: the
// activity store starts empty on every renderer load and is filled ONLY by
// 'workspace:activityBatch' pushes, which don't fire when a boot-time
// reconcile recomputes the SAME detail that was already persisted (no
// dedup-gate change, so no broadcast — see orpheusNotify.ts's
// broadcastDetailIfChanged). statusToActivityDetail is also what
// orpheusNotify.ts's computeDetail now delegates to, so this section doubles
// as that mapping's own regression net.
//
// Coverage required by the task brief:
//   (a) statusToActivityDetail's full truth table
//   (b) resolveActivityDetail: live wins even when it differs from what the
//       fallback would produce; live absent + fallback present -> mapped
//       fallback; live absent + no fallback -> undefined
// ---------------------------------------------------------------------------

console.log('')
console.log('--- statusToActivityDetail: full truth table ---')
{
  const table: Array<[WorkspaceStatus, WorkspaceActivityDetail]> = [
    ['attention', 'attention'],
    ['in_progress', 'working'],
    ['awaiting_input', 'ready'],
    ['idle', 'idle'],
    ['archived', 'archived']
  ]
  for (const [status, expected] of table) {
    assert.equal(
      statusToActivityDetail(status),
      expected,
      `statusToActivityDetail(${status}) must map to ${expected}`
    )
  }
  console.log(
    '✓ statusToActivityDetail: attention/in_progress/awaiting_input/idle/archived all map correctly'
  )
}

console.log('')
console.log('--- resolveActivityDetail: live-wins / fallback / neither ---')
{
  // Live value present -> live value wins, even when it DIFFERS from what
  // the fallback status would produce (proves precedence is presence-based,
  // not "is the live value falsy/idle").
  assert.equal(
    resolveActivityDetail('working', 'idle'),
    'working',
    'a live detail must win even when the fallback status would produce a different value'
  )
  assert.equal(
    resolveActivityDetail('idle', 'attention'),
    'idle',
    'a live "idle" entry must still win over a non-idle fallback status — presence wins, not value'
  )
  assert.equal(
    resolveActivityDetail('archived', 'in_progress'),
    'archived',
    'an explicit live "archived" entry must not be overridden by a non-archived fallback status'
  )

  // Live absent + fallback status present -> mapped fallback.
  assert.equal(
    resolveActivityDetail(undefined, 'attention'),
    'attention',
    'no live entry + fallback status "attention" must resolve to the mapped fallback'
  )
  assert.equal(
    resolveActivityDetail(undefined, 'in_progress'),
    'working',
    'no live entry + fallback status "in_progress" must resolve to the mapped fallback'
  )

  // Live absent + no fallback status -> undefined.
  assert.equal(
    resolveActivityDetail(undefined, undefined),
    undefined,
    'no live entry and no fallback status must resolve to undefined'
  )

  console.log(
    '✓ resolveActivityDetail: live value always wins when present; falls back to mapped status only on a miss; undefined with neither'
  )
}

console.log('')
console.log('--- mutation test 5: resolveActivityDetail always returns undefined ---')
{
  function brokenResolveActivityDetail(): WorkspaceActivityDetail | undefined {
    // BUG: ignores both arguments — never surfaces a live OR a fallback value.
    return undefined
  }

  try {
    assert.equal(
      brokenResolveActivityDetail(),
      'working' as unknown as undefined,
      'MUTATION EXPECTED TO FAIL: a live detail must be surfaced, not discarded'
    )
    console.log(
      'UNEXPECTED PASS — mutation 5a did not trigger a failure (test is not sensitive enough)'
    )
    process.exitCode = 1
  } catch (err) {
    console.log('✓ mutation 5a correctly FAILED as expected:')
    console.log(`  ${(err as Error).message}`)
  }

  // Confirm the REAL resolveActivityDetail resolves the identical scenario correctly.
  assert.equal(
    resolveActivityDetail('working', 'idle'),
    'working',
    'real resolveActivityDetail must correctly surface the live value in this scenario'
  )
  console.log(
    '✓ real resolveActivityDetail resolves the identical scenario correctly (mutation was correctly detected as wrong)'
  )
}

console.log('')
console.log('--- mutation test 6: resolveActivityDetail lets fallback override a live value ---')
{
  function brokenResolveActivityDetailFallbackWins(
    liveDetail: WorkspaceActivityDetail | undefined,
    fallbackStatus: WorkspaceStatus | undefined
  ): WorkspaceActivityDetail | undefined {
    // BUG: checks fallback FIRST, so a present fallback status always wins
    // even when a live value already exists — the exact regression this
    // fix's "live store presence always wins" rule guards against.
    if (fallbackStatus !== undefined) return statusToActivityDetail(fallbackStatus)
    return liveDetail
  }

  const mutatedResult = brokenResolveActivityDetailFallbackWins('working', 'idle')

  try {
    assert.equal(
      mutatedResult,
      'working',
      'MUTATION EXPECTED TO FAIL: a present fallback status must never override an existing live value'
    )
    console.log(
      'UNEXPECTED PASS — mutation 6 did not trigger a failure (test is not sensitive enough)'
    )
    process.exitCode = 1
  } catch (err) {
    console.log('✓ mutation 6 correctly FAILED as expected:')
    console.log(`  ${(err as Error).message}`)
  }

  // Confirm the REAL resolveActivityDetail resolves the identical scenario correctly.
  const realResult = resolveActivityDetail('working', 'idle')
  assert.equal(
    realResult,
    'working',
    'real resolveActivityDetail must keep the live value in this exact scenario'
  )
  console.log(
    '✓ real resolveActivityDetail resolves the identical scenario correctly (mutation was correctly detected as wrong)'
  )
}

// ---------------------------------------------------------------------------
// selectUnboundCodexWorkspaceIds (support-multi-harness late-binding re-arm)
// — statusMap.ts's pure selection over a mixed bound/unbound row array.
// Imports and calls the REAL exported function (also the one
// statusState.ts's reconcile() calls in production via
// loadUnboundCodexWorkspaceRows), not a reimplementation. Relocated here
// (not defined inline in statusState.ts) specifically because
// statusState.ts imports getDb()/orpheusNotify (electron-touching) at
// module scope, which makes it unimportable under plain `bun run` — verified
// empirically: importing statusState.ts directly from this script throws on
// resolving the `electron` module before any assertion even runs. statusMap.ts
// has no such import (fs alone, same as every other export this file already
// tests from it), so this is the leaf that keeps the REAL production logic
// directly testable.
// ---------------------------------------------------------------------------

console.log('')
console.log('--- selectUnboundCodexWorkspaceIds: mixed bound/unbound row selection ---')
{
  const rows = [
    { id: 'ws-bound-1', claude_session_id: 'some-uuid-1' },
    { id: 'ws-unbound-1', claude_session_id: null },
    { id: 'ws-bound-2', claude_session_id: 'some-uuid-2' },
    { id: 'ws-unbound-2', claude_session_id: null },
    { id: 'ws-unbound-3', claude_session_id: null }
  ]

  const result = selectUnboundCodexWorkspaceIds(rows)

  assert.deepEqual(
    result,
    ['ws-unbound-1', 'ws-unbound-2', 'ws-unbound-3'],
    'must return exactly the unbound ids, in input order, none of the bound ones'
  )
  console.log(
    '✓ selectUnboundCodexWorkspaceIds returns exactly the unbound ids in order, excluding every bound row'
  )
}

{
  // All-bound and all-unbound edge cases.
  assert.deepEqual(
    selectUnboundCodexWorkspaceIds([
      { id: 'a', claude_session_id: 'x' },
      { id: 'b', claude_session_id: 'y' }
    ]),
    [],
    'an all-bound array must return an empty array'
  )
  assert.deepEqual(
    selectUnboundCodexWorkspaceIds([
      { id: 'a', claude_session_id: null },
      { id: 'b', claude_session_id: null }
    ]),
    ['a', 'b'],
    'an all-unbound array must return every id'
  )
  assert.deepEqual(
    selectUnboundCodexWorkspaceIds([]),
    [],
    'an empty array must return an empty array'
  )
  console.log('✓ selectUnboundCodexWorkspaceIds edge cases (all-bound, all-unbound, empty)')
}

console.log('')
console.log(
  '--- mutation test 7: selectUnboundCodexWorkspaceIds returns ALL ids regardless of binding ---'
)
{
  // Reimplements the selection ignoring claude_session_id entirely — the
  // exact bug this would be if the IS NULL check were dropped/inverted.
  function brokenSelectAllIds(
    rows: Array<{ id: string; claude_session_id: string | null }>
  ): string[] {
    return rows.map((row) => row.id) // BUG: no filter at all
  }

  const rows = [
    { id: 'ws-bound', claude_session_id: 'some-uuid' },
    { id: 'ws-unbound', claude_session_id: null }
  ]
  const mutatedResult = brokenSelectAllIds(rows)

  try {
    assert.deepEqual(
      mutatedResult,
      ['ws-unbound'],
      'MUTATION EXPECTED TO FAIL: must exclude the bound row, not return every id'
    )
    console.log(
      'UNEXPECTED PASS — mutation 7 did not trigger a failure (test is not sensitive enough)'
    )
    process.exitCode = 1
  } catch (err) {
    console.log('✓ mutation 7 correctly FAILED as expected:')
    console.log(`  ${(err as Error).message}`)
  }

  const realResult = selectUnboundCodexWorkspaceIds(rows)
  assert.deepEqual(
    realResult,
    ['ws-unbound'],
    'real selectUnboundCodexWorkspaceIds must correctly exclude the bound row'
  )
  console.log(
    '✓ real selectUnboundCodexWorkspaceIds resolves the identical scenario correctly (mutation was correctly detected as wrong)'
  )
}

console.log('')
console.log(
  '--- mutation test 8: selectUnboundCodexWorkspaceIds filters the WRONG direction (!== null) ---'
)
{
  // Reimplements the filter inverted — the exact bug this would be if the
  // reconcile loop's late-binding retry query/filter were flipped to
  // select the ALREADY-bound rows instead of the unbound ones.
  function brokenSelectInverted(
    rows: Array<{ id: string; claude_session_id: string | null }>
  ): string[] {
    // BUG: should be `=== null`, this selects the BOUND rows instead.
    return rows.filter((row) => row.claude_session_id !== null).map((row) => row.id)
  }

  const rows = [
    { id: 'ws-bound', claude_session_id: 'some-uuid' },
    { id: 'ws-unbound', claude_session_id: null }
  ]
  const mutatedResult = brokenSelectInverted(rows)

  try {
    assert.deepEqual(
      mutatedResult,
      ['ws-unbound'],
      'MUTATION EXPECTED TO FAIL: an inverted filter selects the bound row instead of the unbound one'
    )
    console.log(
      'UNEXPECTED PASS — mutation 8 did not trigger a failure (test is not sensitive enough)'
    )
    process.exitCode = 1
  } catch (err) {
    console.log('✓ mutation 8 correctly FAILED as expected:')
    console.log(`  ${(err as Error).message}`)
  }

  const realResult = selectUnboundCodexWorkspaceIds(rows)
  assert.deepEqual(
    realResult,
    ['ws-unbound'],
    'real selectUnboundCodexWorkspaceIds must correctly select only the unbound row'
  )
  console.log(
    '✓ real selectUnboundCodexWorkspaceIds resolves the identical scenario correctly (mutation was correctly detected as wrong)'
  )
}

console.log('PASS: verify-codex-status')
