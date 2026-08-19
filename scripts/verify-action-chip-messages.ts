// ---------------------------------------------------------------------------
// scripts/verify-action-chip-messages.ts
//
// support-multi-harness harness-neutral-chrome unit — BEHAVIOR guard for
// src/renderer/src/components/dashboard/footer/actionChipMessages.ts's
// actionFailureMessage.
//
// THE BUG THIS CLOSES: ActionChip.tsx's invokeAction callback used to
// special-case `result.code === 'busy'` and substitute the hardcoded
// literal 'Claude is busy', discarding main's own, already harness-neutral
// error string (src/main/actions/terminal.ts's canInject-gated actions
// return `{ ok: false, code: 'busy', error: 'Workspace is busy' }`). So a
// non-Claude workspace's busy chip would show a Claude-specific message
// even though main never said "Claude" anywhere. Fixed by having the chip
// always surface `result.error` (via actionFailureMessage), regardless of
// `result.code`.
//
// Pure/DOM-free — actionFailureMessage takes an ActionResultErr and returns
// a string, no React/component mount needed, so this asserts the REAL
// exported function directly rather than a source-grep for the removed
// literal (a grep could pass even if the literal reappeared elsewhere, or
// fail to catch a differently-spelled reintroduction — see CLAUDE.md's
// "assert behaviour, not source text" discipline).
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { actionFailureMessage } from '../src/renderer/src/components/dashboard/footer/actionChipMessages.ts'
import type { ActionResultErr } from '../src/shared/types.ts'

// ---------------------------------------------------------------------------
// 1. The exact regression case — a 'busy' result must surface main's OWN
//    message, never a hardcoded 'Claude is busy' literal.
// ---------------------------------------------------------------------------

{
  const busyResult: ActionResultErr = { ok: false, code: 'busy', error: 'Workspace is busy' }
  assert.equal(
    actionFailureMessage(busyResult),
    'Workspace is busy',
    "a 'busy' result must surface main's own error string verbatim"
  )
  assert.notEqual(
    actionFailureMessage(busyResult),
    'Claude is busy',
    "a 'busy' result must NEVER be replaced with the old hardcoded 'Claude is busy' literal"
  )
  console.log(
    "✓ a 'busy' ActionResultErr surfaces main's own error string ('Workspace is busy'), not a hardcoded Claude literal"
  )
}

// ---------------------------------------------------------------------------
// 2. Every OTHER error code must also surface main's message, unfiltered —
//    proves this isn't code-specific special-casing reintroduced elsewhere.
// ---------------------------------------------------------------------------

{
  const cases: ActionResultErr[] = [
    { ok: false, code: 'not_found', error: 'No terminal surface for workspace' },
    { ok: false, code: 'failed', error: 'Something else went wrong' },
    { ok: false, code: 'invalid_params', error: 'Missing required parameter' }
  ]
  for (const result of cases) {
    assert.equal(
      actionFailureMessage(result),
      result.error,
      `code=${result.code}: must surface result.error verbatim regardless of code`
    )
  }
  console.log('✓ every error code surfaces result.error verbatim — no per-code special-casing')
}

console.log('\nAll action-chip-messages assertions passed.')

// ---------------------------------------------------------------------------
// MUTATION TEST — reinstate the old code === 'busy' special-case, confirm
// it disagrees with the real function, then report the real failure.
// ---------------------------------------------------------------------------

function assertMutationCaught(run: () => void, label: string): void {
  let threw = false
  try {
    run()
  } catch (err) {
    threw = true
    console.log(
      `  mutation caught (expected failure) [${label}]:`,
      (err as Error).message.split('\n')[0]
    )
  }
  assert.ok(threw, `MUTATION TEST FAILED TO FAIL: ${label} went undetected`)
}

{
  // Simulates the EXACT pre-fix behavior: a 'busy' code substitutes a
  // hardcoded literal instead of reading result.error.
  const oldBehavior = (result: ActionResultErr): string =>
    result.code === 'busy' ? 'Claude is busy' : (result.error ?? 'Action failed')
  const busyResult: ActionResultErr = { ok: false, code: 'busy', error: 'Workspace is busy' }
  assertMutationCaught(() => {
    assert.equal(
      oldBehavior(busyResult),
      actionFailureMessage(busyResult),
      "the old code==='busy' special-case (hardcoded 'Claude is busy') must disagree with the real, fixed function"
    )
  }, "ActionChip reverted to hardcoding 'Claude is busy' for a busy result")
}

console.log(
  "\n✓ mutation test: reverting to the hardcoded 'Claude is busy' special-case is correctly caught as a failing assertion"
)
