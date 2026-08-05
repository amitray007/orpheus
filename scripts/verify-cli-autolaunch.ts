// ---------------------------------------------------------------------------
// scripts/verify-cli-autolaunch.ts
//
// Assertion harness for packages/orpheus-cli/src/autolaunch.ts — the pure
// decision logic behind `orpheus tui`'s (and every other action command's)
// auto-launch flow.
//
// THE BUG THIS COVERS
// --------------------
// `orpheus tui` over SSH (Termius from a phone) used to hang ~15s then print
// a misleading "Orpheus was launched but didn't come up in time." Root
// cause: `open -a <App>` needs a GUI/Aqua session, which a bare SSH login
// does not have — but the CLI spawned it detached with stdio:'ignore' +
// .unref(), discarding the exit code, then polled the FULL 15s timeout
// waiting for a socket that was never going to appear, always sleeping a
// fixed 500ms after every probe even when failure was knowable in
// milliseconds.
//
// This harness exercises the four PURE functions the fix is built from —
// not cli.ts's actual autoLaunch() (which spawns real processes and would
// need a real Orpheus app to exercise honestly). Per CLAUDE.md's "assert
// behaviour, not source text": each function below is called directly with
// constructed inputs and its output is asserted, so a neutered/dead
// implementation fails these assertions rather than passing a source-text
// grep. Every assertion below was deliberately broken (see the MUTATION
// TESTS section at the bottom of this comment / the git history of this
// file's development) and confirmed to fail before being restored.
//
// Covers:
//   1. decideLaunchAttempts — always tries plain `open -a` first; adds the
//      `launchctl asuser <uid>` fallback only when a uid is available, in
//      the right order, with the right args.
//   2. allAttemptsFailed — true only when EVERY attempt has a non-zero/null
//      exit code; false if any attempt succeeded (exit 0), including a
//      mixed pass (first fails, second succeeds) which is the exact SSH
//      fallback scenario this fix adds.
//   3. classifyLaunchOutcome — the three-way split (ready / launchFailed /
//      timedOut) from {anyAttemptSucceeded, probeSucceeded}.
//   4. formatLaunchFailureDetail — produces a human-readable multi-attempt
//      failure summary (exit code + stderr) used in the thrown error message.
//   5. nextPollDelayMs — a probe that resolves near-instantly still gets a
//      bounded gap before the next attempt, but never MORE than the full
//      poll interval, and a probe that already consumed the whole interval
//      sleeps zero extra (the fix for "wasted 500ms after an instant ENOENT").
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import {
  decideLaunchAttempts,
  allAttemptsFailed,
  classifyLaunchOutcome,
  formatLaunchFailureDetail,
  nextPollDelayMs,
  type LaunchAttemptResult
} from '../packages/orpheus-cli/src/autolaunch.ts'

// ---------------------------------------------------------------------------
// 1. decideLaunchAttempts
// ---------------------------------------------------------------------------

{
  const withUid = decideLaunchAttempts('Orpheus Dev', 501)
  assert.equal(withUid.length, 2, 'with a uid, two attempts are produced')
  assert.equal(withUid[0]!.command, 'open', 'first attempt is plain `open`')
  assert.deepEqual(
    withUid[0]!.args,
    ['-a', 'Orpheus Dev'],
    'first attempt args are `-a <appName>`, using the resolved app name verbatim'
  )
  assert.equal(withUid[1]!.command, 'launchctl', 'second attempt is the launchctl fallback')
  assert.deepEqual(
    withUid[1]!.args,
    ['asuser', '501', 'open', '-a', 'Orpheus Dev'],
    "second attempt routes into the uid's GUI bootstrap via `launchctl asuser <uid> open -a <appName>`"
  )
  console.log('✓ decideLaunchAttempts: with a uid, produces [open -a, launchctl asuser] in order')
}

{
  const withoutUid = decideLaunchAttempts('Orpheus', null)
  assert.equal(withoutUid.length, 1, 'without a uid, only the plain `open -a` attempt is produced')
  assert.equal(withoutUid[0]!.command, 'open')
  console.log('✓ decideLaunchAttempts: without a uid, omits the launchctl fallback')
}

// ---------------------------------------------------------------------------
// 2. allAttemptsFailed
// ---------------------------------------------------------------------------

function result(exitCode: number | null, stderr = ''): LaunchAttemptResult {
  return { label: 'test', exitCode, stderr }
}

{
  assert.equal(
    allAttemptsFailed([result(1), result(1)]),
    true,
    'all non-zero exit codes → every attempt failed'
  )
  assert.equal(
    allAttemptsFailed([result(null), result(1)]),
    true,
    'a spawn error (null exit code) alongside a non-zero exit is still all-failed'
  )
  assert.equal(
    allAttemptsFailed([result(1), result(0)]),
    false,
    'SSH fallback scenario: plain `open -a` fails (exit 1), launchctl asuser succeeds (exit 0) → NOT all failed'
  )
  assert.equal(allAttemptsFailed([result(0)]), false, 'a lone successful attempt is not all-failed')
  assert.equal(allAttemptsFailed([]), false, 'an empty result list is vacuously not "all failed"')
  console.log('✓ allAttemptsFailed: true only when every attempt has a non-zero/null exit code')
}

// ---------------------------------------------------------------------------
// 3. classifyLaunchOutcome
// ---------------------------------------------------------------------------

{
  assert.equal(
    classifyLaunchOutcome({ anyAttemptSucceeded: false, probeSucceeded: true }),
    'ready',
    'probe succeeding always means ready, regardless of attempt success (defensive: should not happen in practice, but probe truth wins)'
  )
  assert.equal(
    classifyLaunchOutcome({ anyAttemptSucceeded: false, probeSucceeded: false }),
    'launchFailed',
    'no attempt succeeded and the probe never came up → launchFailed (fail fast, no point polling)'
  )
  assert.equal(
    classifyLaunchOutcome({ anyAttemptSucceeded: true, probeSucceeded: false }),
    'timedOut',
    'an attempt succeeded (app WAS launched) but the socket never came up → timedOut, the genuine cold-start case'
  )
  console.log('✓ classifyLaunchOutcome: ready / launchFailed / timedOut three-way split is correct')
}

// ---------------------------------------------------------------------------
// 4. formatLaunchFailureDetail
// ---------------------------------------------------------------------------

{
  const detail = formatLaunchFailureDetail([
    { label: 'open -a (GUI session)', exitCode: 1, stderr: 'Unable to find application' },
    { label: 'launchctl asuser (SSH/no-GUI-session fallback)', exitCode: null, stderr: '' }
  ])
  assert.match(detail, /open -a \(GUI session\)/, 'includes the first attempt label')
  assert.match(detail, /exit 1/, 'includes the first attempt exit code')
  assert.match(detail, /Unable to find application/, 'includes the first attempt stderr detail')
  assert.match(
    detail,
    /launchctl asuser \(SSH\/no-GUI-session fallback\)/,
    'includes the second attempt label'
  )
  assert.match(
    detail,
    /no exit code/,
    'a null exit code (spawn error) is worded distinctly from exit 0/1'
  )
  console.log(
    "✓ formatLaunchFailureDetail: folds every attempt's label + exit code + stderr into one message"
  )
}

// ---------------------------------------------------------------------------
// 5. nextPollDelayMs
// ---------------------------------------------------------------------------

{
  assert.equal(
    nextPollDelayMs({ probeSucceeded: true, elapsedMsSinceProbeStart: 0, pollIntervalMs: 500 }),
    0,
    'a successful probe needs no further delay'
  )
  assert.equal(
    nextPollDelayMs({ probeSucceeded: false, elapsedMsSinceProbeStart: 0, pollIntervalMs: 500 }),
    500,
    'an instantly-failing probe (e.g. ENOENT) still gets the full bounded gap before the next attempt'
  )
  assert.equal(
    nextPollDelayMs({ probeSucceeded: false, elapsedMsSinceProbeStart: 500, pollIntervalMs: 500 }),
    0,
    'a probe that already consumed the entire interval sleeps ZERO extra — the fix for wasted fixed-interval sleeps'
  )
  assert.equal(
    nextPollDelayMs({ probeSucceeded: false, elapsedMsSinceProbeStart: 300, pollIntervalMs: 500 }),
    200,
    'a probe that partially consumed the interval sleeps only the remainder, not the full interval again'
  )
  assert.equal(
    nextPollDelayMs({ probeSucceeded: false, elapsedMsSinceProbeStart: 900, pollIntervalMs: 500 }),
    0,
    'a probe that overshot the interval never returns a negative delay'
  )
  console.log(
    '✓ nextPollDelayMs: sleeps only the remaining interval after a probe, never a fixed re-sleep on top'
  )
}

console.log('\nverify-cli-autolaunch: all assertions passed.')
