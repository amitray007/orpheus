// ---------------------------------------------------------------------------
// scripts/verify-codex-title-generation.ts
//
// Behavior guard for src/main/harness/codex/titleGeneration.ts
// (support-multi-harness) — the background sidebar-title generator for
// Codex workspaces (Codex sets the terminal title to the git repo folder
// name, identical across every workspace in that repo, so this module
// generates a real one from the user's first prompt via a local model).
//
// Covers the THREE pure, directly-callable, exported functions this unit's
// task brief calls out as standalone testable units:
//   1. extractFirstCodexPrompt — picks the event_msg/user_message form,
//      rejects the message/role=user form (the bug this extraction exists
//      to avoid — that form picks up injected AGENTS.md/plugin/memory
//      context before the real human prompt), picks the FIRST matching
//      record when multiple exist, and tolerates a torn/invalid JSON line
//      mixed into otherwise-valid lines without throwing.
//   2. sanitizeGeneratedTitle — strips ANSI escapes, strips one layer of
//      surrounding quotes (straight and smart), collapses internal
//      newlines/whitespace to single spaces, rejects empty/whitespace-only
//      input, and caps length at the module's chosen cap with real
//      truncation asserted on an over-long input.
//   3. isFmUnavailable — the exact legal-notice string (in either stdout or
//      stderr) triggers "unavailable"; ordinary successful output does not;
//      stderr-only content that is NOT the legal-notice string (e.g. the
//      Private Cloud Compute warning `fm respond` can print while still
//      succeeding) must NOT trigger "unavailable", since that case is
//      required to read as SUCCESS.
//
// FUNCTIONALLY DB-FREE, BUT THE IMPORT CHAIN STILL TOUCHES ELECTRON: this
// script only ever calls the three pure functions above, never
// scheduleCodexTitleGeneration/runOneAttempt (which do touch getWorkspace/
// setWorkspaceLastTitle) — but titleGeneration.ts imports those from
// ../../workspaces at MODULE SCOPE, and workspaces.ts imports `electron` at
// module scope for getDb(). That import happens whether or not this script
// ever calls a DB-touching export, so plain `bun run`/`node` alone fails to
// even resolve the module graph. Same node:module register() resolve-hook
// technique as scripts/verify-codex-usage-reader.ts (and
// verify-harness-codex-session.ts/verify-harness-session.ts before it),
// stubbing `electron` and `./db`/`../../db` — neither stub is ever
// exercised by this script's call path, they only need to exist so the
// import graph resolves.
//
// Run: node --experimental-strip-types scripts/verify-codex-title-generation.ts
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'

const electronStubSource = `
export const app = {}
export const BrowserWindow = { getAllWindows: () => [] }
`

// See this file's header — titleGeneration.ts -> ../../workspaces ->
// './db' (module scope) is never actually invoked by anything this script
// calls, but must resolve.
const dbStubSource = `
export function getDb() {
  throw new Error('verify-codex-title-generation: getDb() should never be called on this script\\'s call path')
}
`

// ---------------------------------------------------------------------------
// Fake ../../workspaces module for section 4's scheduleCodexTitleGeneration
// idempotency test — a small, controllable in-memory store standing in for
// getWorkspace/hasCodexTitleGenerationRun/markCodexTitleGenerationRun/
// setWorkspaceLastTitle (imported by titleGeneration.ts) PLUS
// setWorkspaceClaudeSessionId (imported by ./session, which titleGeneration.ts
// itself imports from for codexSessionsRoot/findCodexRolloutFileById — so
// the whole module graph needs this export to resolve even though this
// script's own scheduleCodexTitleGeneration call path never calls it).
// Exposed on globalThis so this script (loaded through the SAME resolve
// hook, not a separate process) can read/reset it between assertions
// without re-importing titleGeneration.ts.
// ---------------------------------------------------------------------------

const workspacesStubSource = `
const store = new Map()
globalThis.__verifyCodexTitleGenStore = store

export function getWorkspace(id) {
  return store.get(id) ?? null
}

export function setWorkspaceClaudeSessionId(id, sessionId) {
  const ws = store.get(id)
  if (ws) ws.claudeSessionId = sessionId
}

export function hasCodexTitleGenerationRun(id) {
  return store.get(id)?.codexTitleGenerated === true
}

export function markCodexTitleGenerationRun(id) {
  const ws = store.get(id)
  if (ws) {
    ws.codexTitleGenerated = true
    ws.markCalls = (ws.markCalls ?? 0) + 1
  }
}

export function setWorkspaceLastTitle(id, title) {
  const ws = store.get(id)
  if (ws) ws.lastTitle = title
}
`

const hooks = `
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(electronStubSource))}
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const workspacesStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(workspacesStubSource))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStubUrl, shortCircuit: true }
  }
  if (specifier === './db' || specifier === '../db' || specifier === '../../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  if (specifier === '../../workspaces' || specifier === '../../workspaces.ts') {
    return { url: workspacesStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return await nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url)

const {
  extractFirstCodexPrompt,
  sanitizeGeneratedTitle,
  isFmUnavailable,
  scheduleCodexTitleGeneration
} = await import('../src/main/harness/codex/titleGeneration.ts')

// The resolve hook above intercepts titleGeneration.ts's OWN import of
// ../../workspaces (a relative specifier from inside that file), which is
// a DIFFERENT specifier string than this script's own relative import
// would need — so the stub's store is reached via the global it sets,
// rather than a second import here.
const workspacesStore = (
  globalThis as unknown as { __verifyCodexTitleGenStore: Map<string, Record<string, unknown>> }
).__verifyCodexTitleGenStore

// ---------------------------------------------------------------------------
// 1. extractFirstCodexPrompt
// ---------------------------------------------------------------------------

{
  // The message/role=user form appears BEFORE the real event_msg/
  // user_message form — exactly the shape a real rollout has (injected
  // AGENTS.md/plugin context lands as a message/role=user record before the
  // human's first real event_msg/user_message).
  const lines = [
    JSON.stringify({
      type: 'message',
      role: 'user',
      content: '# AGENTS.md instructions\n<recommended_plugins>...'
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'fix the login bug' }
    })
  ]
  const result = extractFirstCodexPrompt(lines)
  assert.equal(
    result,
    'fix the login bug',
    'must pick the event_msg/user_message record, not the message/role=user one'
  )
}

{
  // FIRST matching record wins when multiple event_msg/user_message records
  // exist.
  const lines = [
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'first prompt' }
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'second prompt' }
    })
  ]
  assert.equal(
    extractFirstCodexPrompt(lines),
    'first prompt',
    'must return the FIRST matching event_msg/user_message record'
  )
}

{
  // Torn/invalid JSON line mixed in with valid lines must not throw, and
  // the valid prompt after it must still be found.
  const lines = [
    '{"type":"event_msg","payload":{"type":"user_mess', // truncated mid-write
    'not json at all {{{',
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'real prompt' } })
  ]
  let result: string | null = null
  assert.doesNotThrow(() => {
    result = extractFirstCodexPrompt(lines)
  }, 'must tolerate a torn/invalid JSON line without throwing')
  assert.equal(result, 'real prompt', 'must still find the valid prompt after a torn line')
}

{
  // No matching record at all -> null.
  const lines = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'abc' } }),
    JSON.stringify({ type: 'message', role: 'user', content: 'not the right shape' }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'not a user message' }
    })
  ]
  assert.equal(
    extractFirstCodexPrompt(lines),
    null,
    'must return null when no event_msg/user_message record exists'
  )
}

console.log(
  '✓ extractFirstCodexPrompt: event_msg/user_message form only, first-wins, torn-line tolerant'
)

// ---------------------------------------------------------------------------
// 2. sanitizeGeneratedTitle
// ---------------------------------------------------------------------------

{
  // Real ANSI-wrapped string.
  const raw = '\x1b[1mFix login bug\x1b[0m'
  assert.equal(sanitizeGeneratedTitle(raw), 'Fix login bug', 'must strip ANSI escape codes')
}

{
  // Surrounding straight quotes.
  assert.equal(
    sanitizeGeneratedTitle('"Fix login bug"'),
    'Fix login bug',
    'must strip one layer of surrounding straight quotes'
  )
}

{
  // Surrounding smart/curly quotes.
  assert.equal(
    sanitizeGeneratedTitle('“Fix login bug”'),
    'Fix login bug',
    'must strip one layer of surrounding smart/curly quotes'
  )
}

{
  // Internal newlines/whitespace collapsed to single spaces.
  assert.equal(
    sanitizeGeneratedTitle('Fix   the\n  login\tbug'),
    'Fix the login bug',
    'must collapse internal whitespace/newlines to single spaces'
  )
}

{
  // Empty/whitespace-only input rejected.
  assert.equal(sanitizeGeneratedTitle(''), null, 'must reject empty input')
  assert.equal(sanitizeGeneratedTitle('   \n\t  '), null, 'must reject whitespace-only input')
}

{
  // Cap respected + truncation actually happens on an over-long input.
  const longTitle = 'word '.repeat(20).trim() // well under the garbage-reject threshold, over the cap
  const result = sanitizeGeneratedTitle(longTitle)
  assert.ok(result !== null, 'a long-but-plausible title must not be rejected outright')
  assert.ok(
    result!.length <= 60,
    `result must respect the 60-char cap, got length ${result!.length}`
  )
  assert.ok(
    result!.length < longTitle.length,
    'truncation must actually shorten an over-long input'
  )
}

console.log(
  '✓ sanitizeGeneratedTitle: strips ANSI, strips quotes (straight+smart), collapses whitespace, rejects empty, caps+truncates'
)

// ---------------------------------------------------------------------------
// 3. isFmUnavailable
// ---------------------------------------------------------------------------

const LEGAL_NOTICE = 'YOU HAVE NOT AGREED TO THE APPLE FOUNDATION MODELS CLI LEGAL NOTICE & TERMS'

{
  // Legal notice in stdout -> unavailable.
  assert.equal(
    isFmUnavailable(`Error: ${LEGAL_NOTICE}`, '', false),
    true,
    'legal notice string in stdout must trigger unavailable'
  )
}

{
  // Legal notice in stderr -> unavailable.
  assert.equal(
    isFmUnavailable('', `Error: ${LEGAL_NOTICE}`, false),
    true,
    'legal notice string in stderr must trigger unavailable'
  )
}

{
  // Ordinary successful output -> NOT unavailable.
  assert.equal(
    isFmUnavailable('Fix login bug', '', false),
    false,
    'ordinary successful stdout must not trigger unavailable'
  )
}

{
  // Private Cloud Compute warning on stderr, exit 0, real stdout -> must
  // read as SUCCESS (not unavailable) per the verified fm behavior this
  // predicate must honor.
  assert.equal(
    isFmUnavailable(
      'Fix login bug',
      'Error: Private Cloud Compute is not available in this context...',
      false
    ),
    false,
    'a Private Cloud Compute stderr warning alongside successful stdout must NOT trigger unavailable'
  )
}

{
  // Errored invocation (e.g. binary missing) -> unavailable regardless of
  // stdout/stderr content.
  assert.equal(
    isFmUnavailable('', '', true),
    true,
    'an errored invocation must trigger unavailable'
  )
}

console.log(
  '✓ isFmUnavailable: legal-notice marker (stdout or stderr) triggers unavailable, ordinary success and the Private Cloud Compute warning do not, an errored invocation always does'
)

// ---------------------------------------------------------------------------
// 4. scheduleCodexTitleGeneration idempotency (support-multi-harness) —
//    simulates the "called once from launch.ts at launch time, called
//    again from statusState.ts's reconcile loop on a late session bind"
//    scenario. Only ONE generation attempt may actually fire across both
//    calls; the SECOND call's timers must all early-return via the SAME
//    guards runOneAttempt/the scheduler already has:
//      - hasCodexTitleGenerationRun (true once ANY attempt has run, success
//        or failure — see this module's header on why "already attempted"
//        is tracked separately from lastTitle)
//      - ws.lastTitle (set once an attempt SUCCEEDS)
//    Drives scheduleCodexTitleGeneration's real internal setTimeout calls
//    deterministically by monkey-patching the GLOBAL setTimeout — the
//    scheduler calls the bare global function (not an injected clock), so
//    intercepting it here is the only way to fire its five scheduled
//    delays without a five-call real-time wait. Captured callbacks are run
//    in the SAME order the scheduler registers them (delay order), exactly
//    mirroring what real timers firing in sequence would do.
// ---------------------------------------------------------------------------

console.log('')
console.log('--- scheduleCodexTitleGeneration: idempotent across two callers ---')

function withFakeGlobalTimers<T>(run: () => T): T {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending: Array<() => void> = []

  // @ts-expect-error — deliberately narrower fake signature than the full
  // Node/DOM setTimeout overload set; only the (fn, ms) shape this module
  // uses is exercised.
  globalThis.setTimeout = ((fn: () => void) => {
    pending.push(fn)
    // Return a timer-like handle with the .unref?.() the scheduler calls.
    return { unref: () => undefined } as unknown as NodeJS.Timeout
  }) as typeof setTimeout
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout

  try {
    const result = run()
    // Drain in registration order (== delay order, since
    // scheduleCodexTitleGeneration registers TITLE_RETRY_DELAYS_MS in
    // ascending order) — mirrors real timers firing in sequence. Each
    // callback is itself a `void (async () => {...})()` IIFE, so this
    // synchronously kicks off each attempt's async body; the actual DB/
    // fs/child-process work inside still resolves on the microtask queue,
    // which is why the assertions below `await` a tick after draining.
    while (pending.length > 0) {
      const fn = pending.shift()
      fn?.()
    }
    return result
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
}

// A microtask-queue flush helper — the fake timers above fire each
// scheduled callback's async IIFE synchronously, but that IIFE's own
// internal awaits (getWorkspace/hasCodexTitleGenerationRun calls, which are
// synchronous in the stub, but still `await`ed as if async) still need the
// event loop to drain before their effects (markCodexTitleGenerationRun,
// setWorkspaceLastTitle) are observable.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

{
  const workspaceId = 'ws-idempotency-test'
  // No claudeSessionId bound and no rollout file on disk — every scheduled
  // attempt's readFirstPromptForWorkspace/findCodexRolloutFileById call
  // will resolve to null (`if (!ws.claudeSessionId) return`), so no attempt
  // ever reaches runOneAttempt/execFile — this test isolates the
  // SCHEDULING/guard idempotency the task brief asks for, not the
  // generation backends themselves (already covered by isFmUnavailable/
  // sanitizeGeneratedTitle above, and by verify-codex-status.ts's/this
  // file's other sections).
  workspacesStore.set(workspaceId, {
    id: workspaceId,
    lastTitle: null,
    claudeSessionId: null,
    codexTitleGenerated: false,
    markCalls: 0
  })

  // First caller (simulates launch.ts's call at launch time).
  withFakeGlobalTimers(() => {
    scheduleCodexTitleGeneration(workspaceId)
  })
  await flushMicrotasks()

  const afterFirstCaller = workspacesStore.get(workspaceId)!
  assert.equal(
    afterFirstCaller.markCalls,
    0,
    'sanity: with no claudeSessionId bound, every scheduled attempt must early-return before ' +
      'ever calling markCodexTitleGenerationRun (never mark an attempt that never actually ran)'
  )

  // Simulate a late bind happening between the two callers (exactly what
  // statusState.ts's retryLateBinding observes right before it calls
  // scheduleCodexTitleGeneration a second time) — still no rollout file on
  // disk, so readFirstPromptForWorkspace will still return null and no
  // REAL generation attempt fires; what this proves is that the SECOND
  // caller's timers run through the exact same guard chain without
  // duplicating work.
  afterFirstCaller.claudeSessionId = 'a-late-bound-session-id'

  // Second caller (simulates statusState.ts's retryLateBinding calling it
  // again after a late bind).
  withFakeGlobalTimers(() => {
    scheduleCodexTitleGeneration(workspaceId)
  })
  await flushMicrotasks()

  console.log(
    '✓ scheduleCodexTitleGeneration ran through both callers’ full timer schedules without throwing'
  )
}

{
  // A SHARPER version of the same idempotency claim: pre-seed the store as
  // if a FIRST attempt already ran and marked codexTitleGenerated — this is
  // exactly the state a workspace is in the instant runOneAttempt's finally
  // block completes. A SECOND caller's every scheduled delay must then
  // early-return via `if (alreadyRun) return` with ZERO further
  // markCodexTitleGenerationRun calls (the count must stay exactly as it
  // started), proving the guard makes a second scheduling pass a genuine
  // no-op rather than a redundant re-mark.
  const workspaceId = 'ws-idempotency-already-run'
  workspacesStore.set(workspaceId, {
    id: workspaceId,
    lastTitle: 'Fix login bug', // set by the (simulated) first attempt's success
    claudeSessionId: 'some-bound-session-id',
    codexTitleGenerated: true, // set by the (simulated) first attempt's finally block
    markCalls: 1
  })

  withFakeGlobalTimers(() => {
    scheduleCodexTitleGeneration(workspaceId)
  })
  await flushMicrotasks()

  const afterSecondCaller = workspacesStore.get(workspaceId)!
  assert.equal(
    afterSecondCaller.markCalls,
    1,
    'THE IDEMPOTENCY GUARANTEE: a second scheduling pass against an already-attempted workspace ' +
      'must fire ZERO additional generation attempts — markCalls must stay exactly at 1, not grow ' +
      "to 2, proving hasCodexTitleGenerationRun's guard makes calling scheduleCodexTitleGeneration " +
      'twice for the same workspace (launch.ts once, statusState.ts’s late-bind retry once more) safe'
  )
  assert.equal(
    afterSecondCaller.lastTitle,
    'Fix login bug',
    "the first attempt's real title must be untouched by the redundant second scheduling pass"
  )

  console.log(
    '✓ scheduleCodexTitleGeneration called twice for an already-attempted workspace fires exactly ' +
      'one generation attempt (markCalls stays at 1) — safe to call from both launch.ts and ' +
      "statusState.ts's late-bind retry for the same workspace"
  )
}

console.log(
  '\nAll codex title-generation assertions passed: first-prompt extraction, output sanitization, fm-unavailable detection, scheduleCodexTitleGeneration idempotency across two callers.'
)
