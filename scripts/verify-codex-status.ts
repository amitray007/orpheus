/**
 * verify-codex-status.ts — regression harness for Codex's status-indicator
 * mapping (src/main/harness/codex/statusMap.ts).
 *
 * Guards:
 *   1. mapCodexStatus's truth table, especially THE STUCK-INDICATOR FIX —
 *      a crashed Codex process leaving `task_started` as the last rollout
 *      event must still read as idle once its thread-writer-lock is gone
 *      (lockHeld === false wins unconditionally, even over a fresh-looking
 *      task_started).
 *   2. findLastCodexTaskEvent's last-line-wins semantics in BOTH directions
 *      (started -> terminal, and the reverse), plus tolerance of a
 *      truncated/malformed trailing line.
 *   3. turn_aborted recognized as a TERMINAL event — the fix for the
 *      "aborted turn stuck as working" gap: a task_started followed by a
 *      turn_aborted (no task_complete ever following) must resolve off the
 *      turn_aborted, not the stale task_started.
 *   4. The idle-duration-based awaiting_input/idle split, including the
 *      exact boundary (idleDurationMs >= staleThresholdMs -> idle, strictly
 *      below -> awaiting_input), matching Claude's own
 *      `idleDuration >= threshold` comparison in sessionState.ts.
 *   5. No code path in mapCodexStatus/findLastCodexTaskEvent can produce a
 *      value that maps to 'attention' — Codex's rollout is not a channel
 *      that can honestly carry that signal (see statusMap.ts's header).
 *   6. isLockHeld's non-blocking O_EXLOCK probe correctly distinguishes a
 *      HELD lock from a FREE/orphaned one and a MISSING file, and correctly
 *      observes a lock's RELEASE (the case that proves this is a real
 *      state probe, not an existence check in disguise) — see statusMap.ts's
 *      own header comment on isLockHeld for the full mechanism and why
 *      existence alone was found to be wrong.
 *
 * This imports the REAL mapCodexStatus/findLastCodexTaskEvent/isLockHeld
 * functions from src/main/harness/codex/statusMap.ts — a deliberately
 * electron/db-free (not fs-free — see that file's own header) module built
 * specifically so this pure/fs-only logic can be exercised directly under
 * plain `bun run`, mirroring scripts/verify-session-status.ts's own
 * reasoning for importing sessionStatusMap.ts's _mapFileStatus directly
 * instead of sessionState.ts.
 *
 * NO BOUND SESSION (no rollout file found at all) is NOT this parser's
 * concern — that case is handled by the CALLER (statusState.ts's
 * reconciler), which only ever invokes findLastCodexTaskEvent with lines
 * already read from a file it confirmed exists. This harness therefore
 * never constructs a "file not found" scenario for findLastCodexTaskEvent.
 *
 * Run: bun run scripts/verify-codex-status.ts
 */

import assert from 'node:assert'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { WorkspaceStatus } from '../src/shared/types.ts'
import {
  mapCodexStatus,
  findLastCodexTaskEvent,
  isLockHeld,
  selectUnboundCodexWorkspaceIds,
  deriveLiveObservationStamp,
  type LiveObservationStamp
} from '../src/main/harness/codex/statusMap.ts'
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

// ---------------------------------------------------------------------------
// mapCodexStatus — full truth table
// ---------------------------------------------------------------------------

assert.equal(
  mapCodexStatus({ kind: 'started', atMs: null }, true, null, STALE_THRESHOLD_MS),
  'in_progress',
  'lockHeld=true + started event must map to in_progress'
)

assert.equal(
  mapCodexStatus({ kind: 'started', atMs: null }, false, null, STALE_THRESHOLD_MS),
  'idle',
  'THE STUCK-INDICATOR FIX: lockHeld=false must win over a fresh started event, mapping to idle'
)

assert.equal(
  mapCodexStatus(null, true, null, STALE_THRESHOLD_MS),
  'idle',
  'lockHeld=true + no task event + UNMEASURABLE idleDurationMs (null) must still be idle — this ' +
    'stays idle ONLY because idleDurationMs is null here (the "can\'t measure" rule), NOT because ' +
    'taskEvent===null is unconditionally idle anymore — see the age-anchoring-fix cases below for ' +
    'the null-event branch now being GATED by idleDurationMs like the terminal-event branch always was'
)

assert.equal(
  mapCodexStatus(null, false, null, STALE_THRESHOLD_MS),
  'idle',
  'lockHeld=false + no task event must be idle (liveness veto still applies)'
)

assert.equal(
  mapCodexStatus({ kind: 'terminal', atMs: null }, true, null, STALE_THRESHOLD_MS),
  'idle',
  'a terminal event with no measurable idle duration must degrade to idle, not awaiting_input'
)

assert.equal(
  mapCodexStatus({ kind: 'terminal', atMs: Date.now() }, false, null, STALE_THRESHOLD_MS),
  'idle',
  'lockHeld=false + terminal event must be idle (liveness veto wins over everything)'
)

console.log(
  '✓ mapCodexStatus base truth table (liveness veto, started, null, unmeasurable terminal)'
)

// ---------------------------------------------------------------------------
// mapCodexStatus — AGE-ANCHORING FIX (support-multi-harness) regression
// coverage. `codex resume <id>` replays a saved transcript into the terminal
// but appends NOTHING to the rollout file, so a freshly-resumed live process
// can have a rollout event that is arbitrarily stale. mapCodexStatus itself
// does not know or care how the CALLER derived idleDurationMs — its contract
// is simply "trust the idleDurationMs you were handed" — so these cases
// prove the mapper honors a SMALL idleDurationMs regardless of how old
// taskEvent.atMs itself is, and that the null-event branch is now gated by
// idleDurationMs exactly like the terminal-event branch always was.
// ---------------------------------------------------------------------------

{
  // THE regression test for the actual bug. A stale rollout event
  // (taskEvent.atMs is ~16.5 hours old, matching the live repro on the
  // machine this fix was diagnosed on) must NOT by itself force idle once
  // the CALLER has correctly anchored idleDurationMs to a fresh live
  // observation (what statusState.ts's deriveLiveObservationStamp would
  // have computed via max(taskEvent.atMs, firstObservedLiveAtMs) — see
  // deriveLiveObservationStamp's own coverage further below for that
  // derivation itself). This is mapCodexStatus's CONTRACT, not concerned
  // with how idleDurationMs was derived.
  const veryStaleEventAtMs = Date.now() - 16.5 * 60 * 60_000
  const freshIdleDurationMs = 10 * 60_000 // 10 minutes — what a fresh live-observation anchor yields
  const oneHourThresholdMs = 60 * 60_000

  const result = mapCodexStatus(
    { kind: 'terminal', atMs: veryStaleEventAtMs },
    true,
    freshIdleDurationMs,
    oneHourThresholdMs
  )
  assert.equal(
    result,
    'awaiting_input',
    'THE AGE-ANCHORING FIX REGRESSION TEST: a 16.5-hour-stale taskEvent.atMs must NOT force idle ' +
      'when the caller-provided idleDurationMs is small (10min, below the 1hr threshold) — proves ' +
      'mapCodexStatus honors the idleDurationMs it is handed regardless of how old the event itself is'
  )
}

{
  // This MUST fail against today's UNPATCHED mapper: the old code returned
  // 'idle' unconditionally for taskEvent===null, ignoring idleDurationMs
  // entirely (`if (taskEvent === null) return 'idle'` before ever looking
  // at idleDurationMs). Confirmed by reasoning directly from the diff: the
  // old null-branch short-circuited to 'idle' with no idleDurationMs check
  // at all, so this exact call would have returned 'idle', not
  // 'awaiting_input', pre-fix. Covers "freshly-launched, no turn ever taken
  // yet, lock held" — the process is alive and sitting at the composer, so
  // this should read the same as a freshly-resumed session with a small
  // idleDurationMs.
  const freshIdleDurationMs = 10 * 60_000
  const oneHourThresholdMs = 60 * 60_000
  const result = mapCodexStatus(null, true, freshIdleDurationMs, oneHourThresholdMs)
  assert.equal(
    result,
    'awaiting_input',
    'taskEvent=null + lockHeld=true + a SMALL caller-provided idleDurationMs must map to ' +
      'awaiting_input, not the old unconditional idle — this is the null-branch gating fix'
  )
}

{
  // Stale-process-observation case: no turn ever taken, but the live
  // observation itself is old (past threshold) — must still demote to idle,
  // proving the null-branch gating doesn't defeat staleAfterMinutes.
  const staleIdleDurationMs = 2 * 60 * 60_000 // 2 hours — past the 1hr threshold
  const oneHourThresholdMs = 60 * 60_000
  const result = mapCodexStatus(null, true, staleIdleDurationMs, oneHourThresholdMs)
  assert.equal(
    result,
    'idle',
    'taskEvent=null + lockHeld=true + a LARGE caller-provided idleDurationMs (past threshold) ' +
      'must still map to idle — staleness must keep working under the new null-branch gating'
  )
}

{
  // Liveness veto still wins even when idleDurationMs is fresh/small —
  // proves the veto ordering was not disturbed by the null-branch change.
  const freshIdleDurationMs = 0
  const oneHourThresholdMs = 60 * 60_000
  const result = mapCodexStatus(null, false, freshIdleDurationMs, oneHourThresholdMs)
  assert.equal(
    result,
    'idle',
    'lockHeld=false must still win over even a maximally-fresh (0ms) idleDurationMs — the ' +
      'liveness veto is unconditional and checked first, unaffected by the null-branch gating fix'
  )
}

console.log(
  '✓ mapCodexStatus age-anchoring fix (stale taskEvent + fresh caller idleDurationMs -> ' +
    'awaiting_input; null-event branch now gated by idleDurationMs; staleness + liveness veto ' +
    'both still hold)'
)

// ---------------------------------------------------------------------------
// mapCodexStatus — idle-duration boundary (awaiting_input vs idle)
// ---------------------------------------------------------------------------

assert.equal(
  mapCodexStatus(
    { kind: 'terminal', atMs: null },
    true,
    STALE_THRESHOLD_MS - 1,
    STALE_THRESHOLD_MS
  ),
  'awaiting_input',
  'idleDurationMs strictly below the stale threshold must map to awaiting_input (ready)'
)

assert.equal(
  mapCodexStatus({ kind: 'terminal', atMs: null }, true, 0, STALE_THRESHOLD_MS),
  'awaiting_input',
  'idleDurationMs of 0 (just happened) must map to awaiting_input'
)

assert.equal(
  mapCodexStatus({ kind: 'terminal', atMs: null }, true, STALE_THRESHOLD_MS, STALE_THRESHOLD_MS),
  'idle',
  'idleDurationMs EXACTLY AT the stale threshold must map to idle (>= comparison, matching ' +
    "Claude's sessionState.ts driveStatusTransition: idleDuration >= threshold -> idle)"
)

assert.equal(
  mapCodexStatus(
    { kind: 'terminal', atMs: null },
    true,
    STALE_THRESHOLD_MS + 1,
    STALE_THRESHOLD_MS
  ),
  'idle',
  'idleDurationMs above the stale threshold must map to idle'
)

console.log('✓ mapCodexStatus idle-duration boundary (below/at/above stale threshold)')

// ---------------------------------------------------------------------------
// mapCodexStatus — nothing can ever produce 'attention'
// ---------------------------------------------------------------------------

{
  const possibleEvents: Array<Parameters<typeof mapCodexStatus>[0]> = [
    null,
    { kind: 'started', atMs: null },
    { kind: 'terminal', atMs: null },
    { kind: 'terminal', atMs: Date.now() }
  ]
  const possibleLockHeld = [true, false]
  const possibleIdleDurations = [
    null,
    0,
    STALE_THRESHOLD_MS - 1,
    STALE_THRESHOLD_MS,
    STALE_THRESHOLD_MS + 1
  ]

  let checked = 0
  for (const event of possibleEvents) {
    for (const lockHeld of possibleLockHeld) {
      for (const idleDurationMs of possibleIdleDurations) {
        const result: WorkspaceStatus = mapCodexStatus(
          event,
          lockHeld,
          idleDurationMs,
          STALE_THRESHOLD_MS
        )
        assert.notEqual(
          result,
          'attention',
          `mapCodexStatus must never return 'attention' (got it for event=${JSON.stringify(event)}, lockHeld=${lockHeld}, idleDurationMs=${idleDurationMs})`
        )
        checked++
      }
    }
  }
  console.log(
    `✓ mapCodexStatus exhaustive sweep (${checked} combinations) never returns 'attention'`
  )
}

// ---------------------------------------------------------------------------
// findLastCodexTaskEvent — empty/no-match/last-wins/torn-line tolerance
// ---------------------------------------------------------------------------

assert.equal(findLastCodexTaskEvent([]), null, 'empty file must yield null')

assert.equal(
  findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"token_count"}}',
    '{"type":"turn_context","payload":{"model":"gpt-5.4"}}'
  ]),
  null,
  'a file with no recognized lifecycle event must yield null'
)

{
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}',
    '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"a","completed_at":1000}}'
  ])
  assert.equal(
    result?.kind,
    'terminal',
    'task_started then task_complete must return terminal (last-wins)'
  )
  assert.equal(
    result?.atMs,
    1000 * 1000,
    'task_complete completed_at (epoch seconds) must convert to ms'
  )
}

{
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"task_complete","turn_id":"a","completed_at":1000}}',
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"b"}}'
  ])
  assert.equal(
    result?.kind,
    'started',
    'task_complete then task_started must return started (proves genuine last-wins, not just second-non-null-wins)'
  )
}

{
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}',
    '{"type":"event_msg","payload":{"type":"task_started'
  ])
  assert.equal(
    result?.kind,
    'started',
    'a truncated/malformed trailing line must not throw, and the last GOOD line before it must still win'
  )
}

console.log('✓ findLastCodexTaskEvent (empty/no-match/last-wins-both-directions/torn-line)')

// ---------------------------------------------------------------------------
// findLastCodexTaskEvent — turn_aborted: the "aborted turn stuck as
// working" fix, and the depth-counter trap (unbalanced started/terminal
// counts must not confuse a last-event-wins scan)
// ---------------------------------------------------------------------------

{
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}',
    '{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"a"}}'
  ])
  assert.equal(
    result?.kind,
    'terminal',
    'THE CRITICAL FIX: task_started then turn_aborted (no task_complete ever) must resolve to ' +
      'terminal, not stay pinned on the stale task_started'
  )
}

{
  // Simulates the exact unbalanced-counts case called out in the task brief
  // (133/561 real rollouts have more started than completed events, or vice
  // versa) — three task_started lines followed by a single turn_aborted. A
  // depth/balance counter would still show "2 more starts than terminals"
  // and could stay pinned on in-flight; last-event-wins must correctly
  // resolve to terminal regardless of the imbalance.
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}',
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"b"}}',
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"c"}}',
    '{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"c"}}'
  ])
  assert.equal(
    result?.kind,
    'terminal',
    'an unbalanced started/terminal count (3 starts, 1 terminal) must still resolve off the LAST ' +
      'event (terminal), never pin to in-flight from historical imbalance'
  )
}

{
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"a"}}',
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"b"}}'
  ])
  assert.equal(
    result?.kind,
    'started',
    'turn_aborted then a fresh task_started must correctly resolve to started (a genuinely new ' +
      'turn began after the abort)'
  )
}

console.log(
  '✓ findLastCodexTaskEvent turn_aborted handling (stuck-as-working fix + depth-counter trap)'
)

// ---------------------------------------------------------------------------
// findLastCodexTaskEvent — defensive turn_started/turn_complete aliases
// ---------------------------------------------------------------------------

{
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"turn_started","turn_id":"a"}}'
  ])
  assert.equal(
    result?.kind,
    'started',
    'turn_started must be accepted as a defensive started-alias'
  )
}

{
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"turn_complete","turn_id":"a","completed_at":2000}}'
  ])
  assert.equal(
    result?.kind,
    'terminal',
    'turn_complete must be accepted as a defensive terminal-alias'
  )
  assert.equal(
    result?.atMs,
    2000 * 1000,
    'turn_complete completed_at must convert seconds to ms same as task_complete'
  )
}

console.log('✓ findLastCodexTaskEvent defensive turn_started/turn_complete aliases')

// ---------------------------------------------------------------------------
// findLastCodexTaskEvent — timestamp resolution preference (completed_at
// over outer timestamp; outer timestamp fallback for turn_aborted)
// ---------------------------------------------------------------------------

{
  const result = findLastCodexTaskEvent([
    '{"timestamp":"2026-08-22T22:38:46.957Z","type":"event_msg","payload":{"type":"task_complete","completed_at":1787438326}}'
  ])
  assert.equal(
    result?.atMs,
    1787438326 * 1000,
    'payload.completed_at (epoch seconds) must be preferred over the outer ISO8601 timestamp'
  )
}

{
  // turn_aborted with no completed_at field at all (verified realistic
  // shape — an aborted turn has no well-defined completion instant) must
  // fall back to the outer timestamp.
  const result = findLastCodexTaskEvent([
    '{"timestamp":"2026-08-22T22:40:00.000Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"a"}}'
  ])
  assert.equal(
    result?.atMs,
    Date.parse('2026-08-22T22:40:00.000Z'),
    'turn_aborted with no completed_at must fall back to the outer ISO8601 timestamp'
  )
}

{
  // Neither field usable at all -> atMs must be null, never throw/NaN.
  const result = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"a"}}'
  ])
  assert.equal(
    result?.atMs,
    null,
    'a terminal event with no completed_at AND no outer timestamp must yield atMs=null, never NaN'
  )
}

console.log(
  '✓ findLastCodexTaskEvent timestamp resolution (completed_at preference + outer-timestamp fallback)'
)

// ---------------------------------------------------------------------------
// Mutation tests — deliberately break the implementation, confirm the
// harness catches it with a clear message, then confirm a clean pass again.
// These run IN-PROCESS against monkey-patched copies of the real functions
// rather than editing the source file, so this script stays a pure
// assertion runner with no side effects on disk.
// ---------------------------------------------------------------------------

console.log('')
console.log('--- mutation test 1: turn_aborted NOT recognized as terminal ---')
{
  // Reimplements findLastCodexTaskEvent's scan with turn_aborted excluded
  // from TERMINAL_EVENT_TYPES, to prove the real assertion above would have
  // caught this exact regression.
  function brokenFindLastCodexTaskEvent(
    lines: string[]
  ): ReturnType<typeof findLastCodexTaskEvent> {
    const STARTED = new Set(['task_started', 'turn_started'])
    const TERMINAL_MISSING_ABORT = new Set(['task_complete', 'turn_complete']) // BUG: turn_aborted omitted
    let last: ReturnType<typeof findLastCodexTaskEvent> = null
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      let parsed: { type?: string; payload?: { type?: string } }
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      if (parsed.type !== 'event_msg') continue
      const payloadType = parsed.payload?.type
      if (typeof payloadType !== 'string') continue
      if (STARTED.has(payloadType)) last = { kind: 'started', atMs: null }
      else if (TERMINAL_MISSING_ABORT.has(payloadType)) last = { kind: 'terminal', atMs: null }
    }
    return last
  }

  const mutatedResult = brokenFindLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}',
    '{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"a"}}'
  ])

  try {
    assert.equal(
      mutatedResult?.kind,
      'terminal',
      'MUTATION EXPECTED TO FAIL: task_started then turn_aborted must resolve to terminal'
    )
    console.log(
      'UNEXPECTED PASS — mutation 1 did not trigger a failure (test is not sensitive enough)'
    )
    process.exitCode = 1
  } catch (err) {
    console.log('✓ mutation 1 correctly FAILED as expected:')
    console.log(`  ${(err as Error).message}`)
  }
}

console.log('')
console.log('--- mutation test 2: idle-duration comparison operator flipped (< instead of >=) ---')
{
  function brokenMapCodexStatus(
    taskEvent: Parameters<typeof mapCodexStatus>[0],
    lockHeld: boolean,
    idleDurationMs: number | null,
    staleThresholdMs: number
  ): WorkspaceStatus {
    if (!lockHeld) return 'idle'
    if (taskEvent === null) return 'idle'
    if (taskEvent.kind === 'started') return 'in_progress'
    if (idleDurationMs === null) return 'idle'
    // BUG: flipped operator — should be `idleDurationMs >= staleThresholdMs ? 'idle' : 'awaiting_input'`
    return idleDurationMs < staleThresholdMs ? 'idle' : 'awaiting_input'
  }

  const mutatedResult = brokenMapCodexStatus(
    { kind: 'terminal', atMs: null },
    true,
    STALE_THRESHOLD_MS - 1,
    STALE_THRESHOLD_MS
  )

  try {
    assert.equal(
      mutatedResult,
      'awaiting_input',
      'MUTATION EXPECTED TO FAIL: idleDurationMs below threshold must map to awaiting_input'
    )
    console.log(
      'UNEXPECTED PASS — mutation 2 did not trigger a failure (test is not sensitive enough)'
    )
    process.exitCode = 1
  } catch (err) {
    console.log('✓ mutation 2 correctly FAILED as expected:')
    console.log(`  ${(err as Error).message}`)
  }
}

console.log('')
console.log('--- confirming a clean pass against the REAL (unmutated) implementation ---')
{
  const realResult = findLastCodexTaskEvent([
    '{"type":"event_msg","payload":{"type":"task_started","turn_id":"a"}}',
    '{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"a"}}'
  ])
  assert.equal(
    realResult?.kind,
    'terminal',
    'real findLastCodexTaskEvent must pass turn_aborted case cleanly'
  )

  const realStatus = mapCodexStatus(
    { kind: 'terminal', atMs: null },
    true,
    STALE_THRESHOLD_MS - 1,
    STALE_THRESHOLD_MS
  )
  assert.equal(
    realStatus,
    'awaiting_input',
    'real mapCodexStatus must pass the boundary case cleanly'
  )
  console.log(
    '✓ real implementation passes both mutated cases cleanly (mutations were correctly detected as wrong)'
  )
}

// ---------------------------------------------------------------------------
// isLockHeld — the FIXED liveness probe (non-blocking exclusive-open, not
// directory existence). See statusMap.ts's own header comment on isLockHeld
// for the full mechanism, verification against real lsof ground truth, and
// the alternatives that were tried and rejected before landing on this one.
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
  "  (no-bound-session / no-rollout-file case is the CALLER's (statusState.ts's) responsibility — this parser only ever receives lines already read from a file that was found)"
)

// ---------------------------------------------------------------------------
// deriveLiveObservationStamp (src/main/harness/codex/statusMap.ts) — the
// AGE-ANCHORING FIX's own pure derivation (support-multi-harness). This is
// the statusState.ts-side half of the fix: given a workspace's previously
// tracked stamp (or none), its current session id, lockHeld, taskEvent, and
// "now", decides the NEXT stamp to store and the idleDurationMs to hand
// mapCodexStatus. Imports and calls the REAL exported function (also the
// one statusState.ts's reconcileOneWorkspace calls in production), not a
// reimplementation — statusState.ts itself can't be imported under plain
// `bun run` (pulls in electron via getDb()/orpheusNotify at module scope),
// which is exactly why this derivation was extracted into statusMap.ts in
// the first place — same reasoning as every other pure decision this file
// already tests directly from that module.
// ---------------------------------------------------------------------------

console.log('')
console.log('--- deriveLiveObservationStamp: stamp lifecycle + idleDurationMs derivation ---')

{
  // First observation of a newly-live session (no prior stamp) — must stamp
  // fresh at `nowMs`, and with no taskEvent at all, idleDurationMs must be
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
    'with no taskEvent, idleDurationMs must equal nowMs - firstObservedLiveAtMs (0 on first tick)'
  )
}

{
  // THE CORE FIX ITSELF: an existing stamp from an EARLIER observation, plus
  // a stale terminal taskEvent — idleDurationMs must anchor to the STAMP
  // (fresher), not the stale event, i.e. max(taskEvent.atMs, stamp) must
  // pick the stamp when the stamp is more recent than the event.
  const firstObservedLiveAtMs = 1_000_000
  const nowMs = firstObservedLiveAtMs + 10 * 60_000 // 10 minutes after first observed
  const staleEventAtMs = firstObservedLiveAtMs - 16 * 60 * 60_000 // 16 hours BEFORE first observed
  const prevStamp: LiveObservationStamp = { sessionId: 'session-a', firstObservedLiveAtMs }

  const result = deriveLiveObservationStamp(
    prevStamp,
    'session-a',
    true,
    { kind: 'terminal', atMs: staleEventAtMs },
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
      'nowMs - staleEventAtMs (~16.17hrs) — the stale rollout event must not dominate a fresh live observation'
  )
}

{
  // A taskEvent NEWER than the stamp must win instead (max picks the event)
  // — proves this is a genuine max(), not "always prefer the stamp".
  const firstObservedLiveAtMs = 1_000_000
  const nowMs = firstObservedLiveAtMs + 60 * 60_000 // 1 hour after first observed
  const recentEventAtMs = firstObservedLiveAtMs + 55 * 60_000 // 55 minutes after first observed (newer than the stamp, older than now)
  const prevStamp: LiveObservationStamp = { sessionId: 'session-a', firstObservedLiveAtMs }

  const result = deriveLiveObservationStamp(
    prevStamp,
    'session-a',
    true,
    { kind: 'terminal', atMs: recentEventAtMs },
    nowMs
  )
  assert.equal(
    result.idleDurationMs,
    5 * 60_000,
    'when taskEvent.atMs is NEWER than the stamp, idleDurationMs must anchor to the event ' +
      '(nowMs - recentEventAtMs = 5min), proving this is max(), not a stamp-only anchor'
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
  '--- mutation test 9: deriveLiveObservationStamp reverted to raw taskEvent.atMs (no max()) ---'
)
{
  // Reimplements the derivation WITHOUT the max() — the exact regression
  // this fix corrects: idleDurationMs anchored directly to the rollout
  // event's own timestamp, ignoring the live-observation stamp entirely.
  function brokenDeriveLiveObservationStamp(
    prevStamp: LiveObservationStamp | undefined,
    sessionId: string,
    lockHeld: boolean,
    taskEvent: Parameters<typeof deriveLiveObservationStamp>[3],
    nowMs: number
  ): { nextStamp: LiveObservationStamp | null; idleDurationMs: number | null } {
    if (!lockHeld) return { nextStamp: null, idleDurationMs: null }
    const stamp: LiveObservationStamp =
      prevStamp && prevStamp.sessionId === sessionId
        ? prevStamp
        : { sessionId, firstObservedLiveAtMs: nowMs }
    // BUG: uses taskEvent.atMs directly with no max() against the stamp —
    // reproduces the original age-mismeasurement bug.
    const eventAtMs = taskEvent?.kind === 'terminal' ? taskEvent.atMs : null
    if (eventAtMs === null)
      return { nextStamp: stamp, idleDurationMs: nowMs - stamp.firstObservedLiveAtMs }
    return { nextStamp: stamp, idleDurationMs: nowMs - eventAtMs }
  }

  const firstObservedLiveAtMs = 1_000_000
  const nowMs = firstObservedLiveAtMs + 10 * 60_000
  const staleEventAtMs = firstObservedLiveAtMs - 16 * 60 * 60_000
  const prevStamp: LiveObservationStamp = { sessionId: 'session-a', firstObservedLiveAtMs }

  const mutatedResult = brokenDeriveLiveObservationStamp(
    prevStamp,
    'session-a',
    true,
    { kind: 'terminal', atMs: staleEventAtMs },
    nowMs
  )

  try {
    assert.equal(
      mutatedResult.idleDurationMs,
      10 * 60_000,
      'MUTATION EXPECTED TO FAIL: without max(), idleDurationMs is measured from the stale event ' +
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
  // fix was diagnosed from: a 16.5hr-stale rollout event, a session first
  // observed live 10 minutes ago).
  const realResult = deriveLiveObservationStamp(
    prevStamp,
    'session-a',
    true,
    { kind: 'terminal', atMs: staleEventAtMs },
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
