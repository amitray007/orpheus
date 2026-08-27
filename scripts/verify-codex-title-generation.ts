// ---------------------------------------------------------------------------
// scripts/verify-codex-title-generation.ts
//
// Behavior guard for src/main/harness/codex/titleGeneration.ts
// (support-multi-harness, migrated in the thread-DB unit) — the background
// sidebar-title generator for Codex workspaces (Codex sets the terminal
// title to the git repo folder name, identical across every workspace in
// that repo, so this module generates a real one from the user's first
// prompt via a local model).
//
// Covers:
//   1. First-prompt extraction, now a thin pass-through to threadDb.ts's
//      getFirstUserPromptText — exercised here against REAL SQLite fixture
//      DBs (node:sqlite's DatabaseSync) with the schema verified on a real
//      ~/.codex/thread_history_1.sqlite, NOT the prior rollout-JSONL
//      two-tier scan (deleted along with its `#`/`<` "looks injected"
//      heuristic — see titleGeneration.ts's own header for why the thread
//      DB's userMessage records carry no injected-context contamination to
//      filter, so that heuristic's documented failure mode — a genuine
//      prompt starting with `#` or `<` being wrongly skipped — is now
//      simply GONE rather than carried forward). threadDb.ts's own
//      dedicated harness (scripts/verify-codex-status.ts, section 7)
//      already covers getFirstUserPromptText's own query logic in depth
//      (earliest-turn selection, text-part concatenation, degrade-to-null
//      paths) — the assertions here re-confirm the SAME function through
//      titleGeneration.ts's actual call path (readFirstPromptForWorkspace),
//      including the '#'-prefix regression case specific to this unit's
//      history, rather than duplicating every one of that harness's cases.
//   2. sanitizeGeneratedTitle — strips ANSI escapes, strips one layer of
//      surrounding quotes (straight and smart), collapses internal
//      newlines/whitespace to single spaces, rejects empty/whitespace-only
//      input, and caps length at the module's chosen cap with real
//      truncation asserted on an over-long input. UNCHANGED by the
//      thread-DB migration.
//   3. isFmUnavailable — the exact legal-notice string (in either stdout or
//      stderr) triggers "unavailable"; ordinary successful output does not;
//      stderr-only content that is NOT the legal-notice string (e.g. the
//      Private Cloud Compute warning `fm respond` can print while still
//      succeeding) must NOT trigger "unavailable", since that case is
//      required to read as SUCCESS. UNCHANGED by the thread-DB migration.
//   4. scheduleCodexTitleGeneration idempotency across two callers
//      (launch.ts + statusState.ts's late-bind retry) — UNCHANGED
//      reasoning, still exercised via the same fake-global-timers approach;
//      the workspace fixture's `claudeSessionId` now doubles as the
//      thread-DB thread_id (CODEX_HOME is pointed at a fixture DB with NO
//      matching thread rather than "no rollout file on disk").
//
// FUNCTIONALLY DB-FREE (electron/better-sqlite3-wise), BUT THE IMPORT CHAIN
// STILL TOUCHES ELECTRON: this script never calls a getWorkspace/
// setWorkspaceLastTitle DB write for real (the fixture store below stands
// in), but titleGeneration.ts imports those from ../../workspaces at MODULE
// SCOPE, and workspaces.ts imports `electron` at module scope for getDb().
// That import happens whether or not this script ever calls a DB-touching
// export, so plain `bun run`/`node` alone fails to even resolve the module
// graph. Same node:module register() resolve-hook technique as
// scripts/verify-codex-usage-reader.ts (and
// verify-harness-codex-session.ts/verify-harness-session.ts before it),
// stubbing `electron` and `./db`/`../../db` — neither stub is ever
// exercised by this script's call path, they only need to exist so the
// import graph resolves. threadDb.ts's own `node:sqlite` import is REAL
// (no stub) — it has no electron dependency and this script needs the real
// DatabaseSync to build and read fixture DBs anyway.
//
// Run: node --experimental-strip-types scripts/verify-codex-title-generation.ts
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
// setWorkspaceLastTitle (imported by titleGeneration.ts). Exposed on
// globalThis so this script (loaded through the SAME resolve hook, not a
// separate process) can read/reset it between assertions without
// re-importing titleGeneration.ts.
//
// setWorkspaceClaudeSessionId IS NO LONGER STUBBED HERE (thread-DB
// migration) — titleGeneration.ts no longer imports ./session at all (it
// reads threadDb.ts's getFirstUserPromptText directly, keyed by the
// workspace's already-bound claudeSessionId), so the module graph this
// script exercises has one fewer stub to carry.
// ---------------------------------------------------------------------------

const workspacesStubSource = `
const store = new Map()
globalThis.__verifyCodexTitleGenStore = store

export function getWorkspace(id) {
  return store.get(id) ?? null
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

// ---------------------------------------------------------------------------
// Fake 'node:child_process' for section 1's real-generation-path assertions.
//
// WHY THIS EXISTS: titleGeneration.ts's generateTitleForPrompt spawns REAL
// `fm`/`codex exec` subprocesses. CI runs every verify-* harness on
// ubuntu-latest (see .github/workflows/ci.yml) — `fm` (Apple Foundation
// Models CLI) does not exist on Linux at all, and even on a real macOS dev
// machine, depending on a live subprocess call (network, model
// availability, real wall-clock latency) makes an assertion harness flaky
// for reasons that have nothing to do with the code under test. Stubbing
// `node:child_process`'s execFile here — the ONE function
// titleGeneration.ts actually calls (via promisify(childProcess.execFile))
// — keeps section 1's assertions deterministic and platform-independent
// while still exercising the REAL scheduleCodexTitleGeneration ->
// runOneAttempt -> generateTitleForPrompt -> tryFmBackend call chain.
//
// The stub always succeeds via the 'fm' path (first callback arg) with a
// short canned title, so runOneAttempt reaches setWorkspaceLastTitle /
// markCodexTitleGenerationRun deterministically and quickly — what these
// assertions verify is that readFirstPromptForWorkspace found a prompt at
// all (via threadDb.ts), not what a live model would generate from it
// (already covered by sections 2/3's pure sanitizeGeneratedTitle/
// isFmUnavailable assertions).
const childProcessStubSource = `
import { promisify } from 'node:util'

function execFileCallback(file, args, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  queueMicrotask(() => cb(null, 'Stubbed Title', ''))
  return { unref: () => undefined }
}
// titleGeneration.ts calls promisify(childProcess.execFile) — Node's REAL
// child_process.execFile carries a util.promisify.custom implementation
// that resolves { stdout, stderr } (not a bare string), which is why a
// plain callback-shaped stub isn't enough on its own: without this custom
// symbol, promisify falls back to its default "resolve with the single
// callback arg after err" behavior, resolving with just stdout as a raw
// string and leaving result.stderr undefined — exactly the
// "Cannot read properties of undefined (reading 'includes')" failure this
// stub exists to avoid (isFmUnavailable reads both stdout AND stderr).
execFileCallback[promisify.custom] = (file, args, options) => {
  return new Promise((resolve) => {
    queueMicrotask(() => resolve({ stdout: 'Stubbed Title', stderr: '' }))
  })
}

export function execFile(...args) {
  return execFileCallback(...args)
}
execFile[promisify.custom] = execFileCallback[promisify.custom]
`

const hooks = `
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(electronStubSource))}
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const workspacesStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(workspacesStubSource))}
const childProcessStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(childProcessStubSource))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStubUrl, shortCircuit: true }
  }
  if (specifier === './db' || specifier === '../db' || specifier === '../../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  if (specifier === 'node:child_process') {
    return { url: childProcessStubUrl, shortCircuit: true }
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

const { sanitizeGeneratedTitle, isFmUnavailable, scheduleCodexTitleGeneration } =
  await import('../src/main/harness/codex/titleGeneration.ts')
const { threadHistoryDbPath } = await import('../src/main/harness/codex/threadDb.ts')

// The resolve hook above intercepts titleGeneration.ts's OWN import of
// ../../workspaces (a relative specifier from inside that file), which is
// a DIFFERENT specifier string than this script's own relative import
// would need — so the stub's store is reached via the global it sets,
// rather than a second import here.
const workspacesStore = (
  globalThis as unknown as { __verifyCodexTitleGenStore: Map<string, Record<string, unknown>> }
).__verifyCodexTitleGenStore

// ---------------------------------------------------------------------------
// Fixture thread-history DB helpers — same schema as
// scripts/verify-codex-status.ts's fixtures (kept in sync deliberately;
// both scripts build the identical CREATE TABLE statements verified against
// a real ~/.codex/thread_history_1.sqlite — see threadDb.ts's own header).
// ---------------------------------------------------------------------------

function createFixtureSchema(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE thread_turns (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      rollout_ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      first_user_item_id TEXT,
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
  `)
  return db
}

function insertUserMessageTurn(
  db: DatabaseSync,
  threadId: string,
  turnId: string,
  rolloutOrdinal: number,
  itemId: string,
  promptText: string
): void {
  db.prepare(
    `INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, started_at, completed_at, first_user_item_id)
     VALUES (?, ?, ?, 'completed', 1000, 1005, ?)`
  ).run(threadId, turnId, rolloutOrdinal, itemId)
  const itemJson = JSON.stringify({
    type: 'userMessage',
    id: itemId,
    clientId: null,
    content: [{ type: 'text', text: promptText, text_elements: [] }]
  })
  db.prepare(
    `INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type)
     VALUES (?, ?, ?, ?, 1000000, ?, 'userMessage')`
  ).run(threadId, turnId, itemId, rolloutOrdinal, itemJson)
}

/** Runs `run` with CODEX_HOME pointed at a fresh temp dir whose
 *  thread_history_1.sqlite is built by `build`, then tears the dir down. */
async function withFixtureCodexHome<T>(
  build: (db: DatabaseSync) => void,
  run: () => Promise<T> | T
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-title-gen-thread-db-'))
  const prevCodexHome = process.env['CODEX_HOME']
  try {
    process.env['CODEX_HOME'] = tmpDir
    const db = createFixtureSchema(threadHistoryDbPath(tmpDir))
    build(db)
    db.close()
    return await run()
  } finally {
    if (prevCodexHome === undefined) delete process.env['CODEX_HOME']
    else process.env['CODEX_HOME'] = prevCodexHome
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 1. First-prompt extraction, via titleGeneration.ts's real call path
//    (scheduleCodexTitleGeneration -> readFirstPromptForWorkspace ->
//    threadDb.ts's getFirstUserPromptText), exercised end-to-end against
//    real fixture DBs.
// ---------------------------------------------------------------------------

// A workspace whose readFirstPromptForWorkspace finds a real prompt reaches
// runOneAttempt, which calls generateTitleForPrompt — stubbed via the
// 'node:child_process' resolve-hook stub above (see this file's header:
// the real fm/codex-exec backends are never invoked from this harness, so
// this resolves near-instantly and deterministically, cross-platform).
//
// UNLIKE section 4's idempotency assertions — where every scheduled
// attempt early-returns BEFORE runOneAttempt (no claudeSessionId bound), so
// firing all five setTimeout registrations back-to-back is harmless — a
// workspace here genuinely reaches runOneAttempt on its FIRST scheduled
// attempt. In real production, TITLE_RETRY_DELAYS_MS's five delays are
// staggered real wall-clock seconds apart, so the first attempt's
// runOneAttempt (and its markCodexTitleGenerationRun) always completes long
// before the second timer fires. Draining all five fake timers
// SYNCHRONOUSLY back-to-back (withFakeGlobalTimers' normal drain loop)
// breaks that ordering: all five callbacks' synchronous guard checks
// (hasCodexTitleGenerationRun) run before any of their awaited
// runOneAttempt calls resolve, so every one of them would reach
// runOneAttempt — a test-harness artifact of firing timers without their
// real relative delays, not a real production race. drainOneTimerAtATime
// below fixes this by flushing microtasks BETWEEN each fired timer, exactly
// modelling the real "each attempt fully resolves before the next timer's
// delay would even elapse" property.
async function drainOneTimerAtATime(run: () => void): Promise<void> {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const pending: Array<() => void> = []

  // @ts-expect-error — see withFakeGlobalTimers below for the same narrowed-signature note.
  globalThis.setTimeout = ((fn: () => void) => {
    pending.push(fn)
    return { unref: () => undefined } as unknown as NodeJS.Timeout
  }) as typeof setTimeout
  globalThis.clearTimeout = (() => undefined) as typeof clearTimeout

  try {
    run()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }

  while (pending.length > 0) {
    const fn = pending.shift()
    fn?.()
    await flushMicrotasks()
  }
}

{
  // Baseline: a bound workspace whose thread has a real first prompt must
  // have it picked up, reaching runOneAttempt (markCalls incremented)
  // rather than early-returning at the `if (!firstPrompt) return` guard —
  // proving readFirstPromptForWorkspace found the prompt via threadDb.ts.
  const workspaceId = 'ws-real-prompt'
  const threadId = 'thread-real-prompt'
  workspacesStore.set(workspaceId, {
    id: workspaceId,
    lastTitle: null,
    claudeSessionId: threadId,
    codexTitleGenerated: false,
    markCalls: 0
  })

  await withFixtureCodexHome(
    (db) => {
      insertUserMessageTurn(db, threadId, 'turn-1', 1, 'item-1', 'What is this codebase about?')
    },
    async () => {
      await drainOneTimerAtATime(() => {
        scheduleCodexTitleGeneration(workspaceId)
      })
    }
  )

  const after = workspacesStore.get(workspaceId)!
  assert.equal(
    after.markCalls,
    1,
    'a workspace whose bound thread has a real first prompt must reach runOneAttempt (markCalls=1), ' +
      'proving readFirstPromptForWorkspace found the prompt via threadDb.ts rather than early-returning'
  )
  assert.equal(
    after.lastTitle,
    'Stubbed Title',
    'runOneAttempt must persist the (stubbed) generated title via setWorkspaceLastTitle'
  )
}

{
  // THE OLD ROLLOUT-SCANNING HEURISTIC'S DOCUMENTED FAILURE MODE, NOW FIXED:
  // a genuine human prompt whose first line starts with '#' must be found
  // and used — the old extractFirstCodexPrompt's looksInjected() would have
  // wrongly skipped this (treating it as an injected AGENTS.md/persona
  // block). The thread DB's userMessage records carry no such
  // contamination, so no such heuristic exists in the new call path at all.
  const workspaceId = 'ws-hash-prefix-prompt'
  const threadId = 'thread-hash-prefix'
  workspacesStore.set(workspaceId, {
    id: workspaceId,
    lastTitle: null,
    claudeSessionId: threadId,
    codexTitleGenerated: false,
    markCalls: 0
  })

  await withFixtureCodexHome(
    (db) => {
      insertUserMessageTurn(db, threadId, 'turn-1', 1, 'item-1', '# fix this bug in the parser')
    },
    async () => {
      await drainOneTimerAtATime(() => {
        scheduleCodexTitleGeneration(workspaceId)
      })
    }
  )

  const after = workspacesStore.get(workspaceId)!
  assert.equal(
    after.markCalls,
    1,
    "THE OLD HEURISTIC'S FAILURE MODE MUST NOW PASS: a genuine prompt starting with '#' must reach " +
      'runOneAttempt (markCalls=1) via threadDb.ts, not be silently skipped the way the old ' +
      "rollout-scanning extractFirstCodexPrompt's looksInjected() would have skipped it"
  )
}

{
  // No thread found at all (unbound, or a thread id the fixture DB has no
  // rows for) -> readFirstPromptForWorkspace returns null ->
  // `if (!firstPrompt) return` -> generation never attempted, markCalls
  // stays 0. This is the "no rollout file"-equivalent degrade case under
  // the new design.
  const workspaceId = 'ws-no-prompt'
  workspacesStore.set(workspaceId, {
    id: workspaceId,
    lastTitle: null,
    claudeSessionId: 'thread-with-no-rows-in-fixture-db',
    codexTitleGenerated: false,
    markCalls: 0
  })

  await withFixtureCodexHome(
    () => {
      // No rows inserted at all — the DB exists but has nothing for this thread id.
    },
    async () => {
      await withFakeGlobalTimers(async () => {
        scheduleCodexTitleGeneration(workspaceId)
      })
      await flushMicrotasks()
    }
  )

  const after = workspacesStore.get(workspaceId)!
  assert.equal(
    after.markCalls,
    0,
    'a bound thread id with no rows in the fixture DB must never reach runOneAttempt — ' +
      'readFirstPromptForWorkspace degrades to null, and the scheduler early-returns'
  )
}

console.log(
  "✓ first-prompt extraction via threadDb.ts (real fixture DBs, through titleGeneration.ts's actual call path): " +
    "finds a real prompt, finds a '#'-prefixed prompt (old heuristic's failure mode now fixed), " +
    'degrades cleanly when the thread has no rows'
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

async function withFakeGlobalTimers<T>(run: () => Promise<T> | T): Promise<T> {
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
    const result = await run()
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
  // No claudeSessionId bound and no thread-history DB at all (CODEX_HOME
  // left unset/pointed at whatever the ambient environment has, same
  // "nothing to find" shape as the old "no rollout file on disk" case) —
  // every scheduled attempt's readFirstPromptForWorkspace call will resolve
  // to null (`if (!ws.claudeSessionId) return`), so no attempt ever reaches
  // runOneAttempt/execFile — this test isolates the SCHEDULING/guard
  // idempotency the task brief asks for, not the generation backends
  // themselves (already covered by isFmUnavailable/sanitizeGeneratedTitle
  // above, and by section 1's real-fixture-DB assertions).
  workspacesStore.set(workspaceId, {
    id: workspaceId,
    lastTitle: null,
    claudeSessionId: null,
    codexTitleGenerated: false,
    markCalls: 0
  })

  // First caller (simulates launch.ts's call at launch time).
  await withFakeGlobalTimers(() => {
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
  // scheduleCodexTitleGeneration a second time) — still no thread-history
  // rows for this thread id, so readFirstPromptForWorkspace will still
  // return null and no REAL generation attempt fires; what this proves is
  // that the SECOND caller's timers run through the exact same guard chain
  // without duplicating work.
  afterFirstCaller.claudeSessionId = 'a-late-bound-session-id-with-no-fixture-rows'

  // Second caller (simulates statusState.ts's retryLateBinding calling it
  // again after a late bind).
  await withFakeGlobalTimers(() => {
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

  await withFakeGlobalTimers(() => {
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
  '\nAll codex title-generation assertions passed: first-prompt extraction via threadDb.ts (real fixture DBs), output sanitization, fm-unavailable detection, scheduleCodexTitleGeneration idempotency across two callers.'
)
