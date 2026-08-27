// ---------------------------------------------------------------------------
// scripts/verify-harness-codex-session.ts
//
// Behavior guard for src/main/harness/codex/session.ts (C5, multi-harness
// migration plan) — the discoverer that binds a Codex workspace to its real
// Codex session id, and codexSessionArgs, the resume-argv builder that reads
// that binding back. Read that file's header first for the full mechanics;
// this script asserts against the REAL exported functions, not a
// restatement of their logic.
//
// TWO LAYERS OF COVERAGE:
//   A. findCodexUserRolloutId — a PURE function (aside from the fs reads
//      themselves) over an explicit sessions-root directory, a cwd, and a
//      mount-time floor. Exercised against REAL fixture rollout files
//      written to a temp dir by this script (mirroring the real on-disk
//      shape verified against codex-cli 0.148.0 on a dev machine) — no live
//      Codex process, no network, no DB.
//   B. discoverAndBindCodexSession / codexSessionArgs — the impure wrappers
//      that call getWorkspace/setWorkspaceClaudeSessionId
//      (../../workspaces.ts), which need a real (in-memory) `workspaces`
//      table. Same node:sqlite DatabaseSync + node:module register()
//      resolve-hook technique as scripts/verify-harness-session.ts (Claude's
//      equivalent) and scripts/verify-harness-codex-launch.ts, reused
//      verbatim for the same reason: getDb()/electron must be stubbed
//      before workspaces.ts's import chain resolves, and node:sqlite +
//      `--experimental-strip-types` avoids the better-sqlite3-under-Bun
//      crash documented in those two files' headers.
//
// RUNTIME CHOICE — plain `node --experimental-strip-types`, matching every
// other harness verifier in this family for the same reasons.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

class Database extends DatabaseSync {}

const dbStubSource = `
export function getDb() {
  if (!globalThis.__HARNESS_CODEX_SESSION_TEST_DB__) {
    throw new Error('verify-harness-codex-session: no test DB set before a workspaces.ts call')
  }
  return globalThis.__HARNESS_CODEX_SESSION_TEST_DB__
}
`

const electronStubSource = `
export const app = {}
export const BrowserWindow = { getAllWindows: () => [] }
`

const hooks = `
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(electronStubSource))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStubUrl, shortCircuit: true }
  }
  if (specifier === './db' || specifier === '../db' || specifier === '../../db') {
    return { url: dbStubUrl, shortCircuit: true }
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

function createFreshDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      cwd TEXT NOT NULL,
      pinned_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT 0,
      last_opened_at INTEGER,
      archived_at INTEGER,
      closed_at INTEGER,
      status TEXT NOT NULL DEFAULT 'idle',
      name_is_auto INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER,
      claude_session_id TEXT,
      last_title TEXT,
      forked_from_session_id TEXT,
      parent_workspace_id TEXT,
      worktree_parent_cwd TEXT,
      worktree_branch TEXT,
      harness_id TEXT NOT NULL DEFAULT 'claude'
    )
  `)
  ;(
    globalThis as unknown as { __HARNESS_CODEX_SESSION_TEST_DB__: unknown }
  ).__HARNESS_CODEX_SESSION_TEST_DB__ = db
  return db
}

function insertWorkspace(
  db: InstanceType<typeof Database>,
  row: { id: string; cwd: string; claudeSessionId?: string | null; createdAt?: number }
): void {
  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, cwd, claude_session_id, harness_id, created_at)
     VALUES (?, 'proj-1', 'ws', ?, ?, 'codex-cli', ?)`
  ).run(row.id, row.cwd, row.claudeSessionId ?? null, row.createdAt ?? Date.now())
}

const { findCodexUserRolloutId, discoverAndBindCodexSession, codexSessionArgs } =
  await import('../src/main/harness/codex/session.ts')
const { getWorkspace } = await import('../src/main/workspaces.ts')

// ---------------------------------------------------------------------------
// Fixture rollout-file helpers
// ---------------------------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpheus-codex-session-test-'))

function shardDir(sessionsRoot: string, date: Date): string {
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return path.join(sessionsRoot, yyyy, mm, dd)
}

/** Writes one fixture rollout file with a session_meta line 1, matching the
 *  REAL shape verified against codex-cli 0.148.0 (see session.ts's header).
 *  `raw`, when supplied, overrides the whole first line verbatim — used for
 *  malformed/truncated-JSON fixtures. */
function writeRollout(
  sessionsRoot: string,
  date: Date,
  opts: {
    id: string
    sessionId?: string
    cwd: string
    threadSource?: string | null
    timestamp: string
    raw?: string
  }
): string {
  const dir = shardDir(sessionsRoot, date)
  fs.mkdirSync(dir, { recursive: true })
  const filename = `rollout-${date.toISOString().slice(0, 10)}T00-00-00-${opts.id}.jsonl`
  const filePath = path.join(dir, filename)
  const line =
    opts.raw !== undefined
      ? opts.raw
      : JSON.stringify({
          timestamp: opts.timestamp,
          type: 'session_meta',
          payload: {
            id: opts.id,
            session_id: opts.sessionId ?? opts.id,
            cwd: opts.cwd,
            ...(opts.threadSource === null ? {} : { thread_source: opts.threadSource ?? 'user' })
          }
        })
  fs.writeFileSync(filePath, line + '\n{"type":"turn_context"}\n')
  return filePath
}

let scenarioCounter = 0
function freshSessionsRoot(): string {
  scenarioCounter += 1
  const dir = path.join(tmpRoot, `scenario-${scenarioCounter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

const NOW = new Date('2026-08-20T20:00:00.000Z')
const MOUNT_FLOOR_MS = new Date('2026-08-20T19:55:00.000Z').getTime()

// ---------------------------------------------------------------------------
// A1. THE CRITICAL CASE — four rollouts share one session_id (root + three
//     subagents, exactly the shape verified on a real machine). Only the
//     thread_source: 'user' file must be selected; its OWN id (which, for
//     the root row, equals session_id) is what's returned.
// ---------------------------------------------------------------------------
{
  const root = freshSessionsRoot()
  const rootId = 'root-session-0001'
  writeRollout(root, NOW, {
    id: rootId,
    sessionId: rootId,
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  writeRollout(root, NOW, {
    id: 'subagent-aaa',
    sessionId: rootId,
    cwd: '/repo',
    threadSource: 'subagent',
    timestamp: '2026-08-20T19:58:05.000Z'
  })
  writeRollout(root, NOW, {
    id: 'subagent-bbb',
    sessionId: rootId,
    cwd: '/repo',
    threadSource: 'subagent',
    timestamp: '2026-08-20T19:58:10.000Z'
  })
  writeRollout(root, NOW, {
    id: 'subagent-ccc',
    sessionId: rootId,
    cwd: '/repo',
    threadSource: 'subagent',
    timestamp: '2026-08-20T19:58:15.000Z'
  })
  const found = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(
    found,
    rootId,
    'must select the thread_source: "user" file, never a subagent, even though subagents are newer and share session_id'
  )
  console.log(
    '✓ four-files-one-session_id subagent case: only the thread_source:"user" file is selected'
  )
}

// ---------------------------------------------------------------------------
// A2. cwd mismatch is excluded.
// ---------------------------------------------------------------------------
{
  const root = freshSessionsRoot()
  writeRollout(root, NOW, {
    id: 'other-repo-session',
    cwd: '/some/other/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  const found = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(found, null, 'a session_meta for a DIFFERENT cwd must be excluded')
  console.log('✓ cwd mismatch is excluded')
}

// ---------------------------------------------------------------------------
// A3. A file older than the mount-time floor is excluded.
// ---------------------------------------------------------------------------
{
  const root = freshSessionsRoot()
  writeRollout(root, NOW, {
    id: 'stale-session',
    cwd: '/repo',
    threadSource: 'user',
    // Well before MOUNT_FLOOR_MS (19:55) — e.g. a user running `codex` by
    // hand in this cwd before Orpheus ever launched it.
    timestamp: '2026-08-20T10:00:00.000Z'
  })
  const found = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(found, null, 'a session predating the mount-time floor must be excluded')
  console.log('✓ a file older than the mount-time floor is excluded')
}

// ---------------------------------------------------------------------------
// A4. malformed/truncated JSON on line 1 is skipped, not fatal — and a
//     valid file elsewhere is still found.
// ---------------------------------------------------------------------------
{
  const root = freshSessionsRoot()
  writeRollout(root, NOW, {
    id: 'truncated',
    cwd: '/repo',
    raw: '{"timestamp": "2026-08-20T19:58:00.000Z", "type": "session_meta", "payload": {"id": "trunc',
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  writeRollout(root, NOW, {
    id: 'not-json-at-all',
    cwd: '/repo',
    raw: 'this is not json',
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  writeRollout(root, NOW, {
    id: 'good-session',
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T19:59:00.000Z'
  })
  const found = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(
    found,
    'good-session',
    'malformed/truncated files must be skipped without throwing, and a valid file must still be found'
  )
  console.log('✓ malformed/truncated JSON on line 1 is skipped, not fatal')
}

// ---------------------------------------------------------------------------
// A5. empty/missing shard dir yields "no binding" and does not throw.
// ---------------------------------------------------------------------------
{
  const root = freshSessionsRoot() // real dir exists, but has zero shard subdirs
  const found = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(found, null, 'an empty sessions root must yield null, not throw')

  const missingRoot = path.join(root, 'does', 'not', 'exist')
  const foundMissing = findCodexUserRolloutId(missingRoot, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(foundMissing, null, 'a missing sessions root must yield null, not throw')
  console.log('✓ empty/missing shard dir yields "no binding" and does not throw')
}

// ---------------------------------------------------------------------------
// A6. missing thread_source key (verified real case — the 'originator':
//     'codex_exec' shape on this dev machine has NO thread_source key at
//     all on some rows) must be excluded, not treated as a wildcard match.
// ---------------------------------------------------------------------------
{
  const root = freshSessionsRoot()
  writeRollout(root, NOW, {
    id: 'no-thread-source-field',
    cwd: '/repo',
    threadSource: null,
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  const found = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(
    found,
    null,
    'a row with no thread_source key at all must be excluded, not treated as a match'
  )
  console.log('✓ a row missing the thread_source key entirely is excluded')
}

// ---------------------------------------------------------------------------
// A7. midnight boundary — a session written just before midnight is still
//     found when "now" is just after midnight (yesterday's shard is
//     searched too).
// ---------------------------------------------------------------------------
{
  const root = freshSessionsRoot()
  const lateNight = new Date('2026-08-19T23:58:00.000Z')
  writeRollout(root, lateNight, {
    id: 'late-night-session',
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-19T23:58:00.000Z'
  })
  const justAfterMidnight = new Date('2026-08-20T00:02:00.000Z')
  const floor = new Date('2026-08-19T23:57:00.000Z').getTime()
  const found = findCodexUserRolloutId(root, '/repo', floor, justAfterMidnight)
  assert.equal(
    found,
    'late-night-session',
    'a session written just before midnight must still be found when mounting just after midnight'
  )
  console.log("✓ midnight boundary: yesterday's shard is searched too")
}

// ---------------------------------------------------------------------------
// A8. among multiple valid candidates, the NEWEST wins.
// ---------------------------------------------------------------------------
{
  const root = freshSessionsRoot()
  writeRollout(root, NOW, {
    id: 'older-valid',
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T19:56:00.000Z'
  })
  writeRollout(root, NOW, {
    id: 'newer-valid',
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T19:59:00.000Z'
  })
  const found = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(found, 'newer-valid', 'among multiple valid candidates, the newest must win')
  console.log('✓ among multiple valid candidates, the newest wins')
}

// All codexSessionArgs scenarios below point CODEX_HOME at a throwaway
// fixture dir rather than touching the real user's ~/.codex — codexRolloutExists
// (the fix under test) now calls codexSessionsRoot(), which prefers
// CODEX_HOME over os.homedir() precisely so tests (and real users who
// relocate their Codex state) can redirect it without touching HOME
// wholesale. Restored in a finally so a later scenario that relies on the
// ambient/unset value (there are none left, but this is the safe default)
// isn't affected.
function withCodexHome<T>(sessionsRoot: string, fn: () => T): T {
  const original = process.env.CODEX_HOME
  process.env.CODEX_HOME = sessionsRoot
  try {
    return fn()
  } finally {
    if (original === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = original
  }
}

// ---------------------------------------------------------------------------
// B1. codexSessionArgs — resume argv token ORDER: ["resume", id], subcommand
//     first, exactly two tokens. THE EXISTENCE GATE (this file's fix): this
//     must pass ONLY because a real fixture rollout for 'real-codex-id'
//     exists under the fixture CODEX_HOME — codexSessionArgs now checks for
//     it via codexRolloutExists before ever emitting 'resume'.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  insertWorkspace(db, { id: 'ws-bound', cwd: '/repo', claudeSessionId: 'real-codex-id' })
  const codexHome = freshSessionsRoot()
  const sessionsRoot = path.join(codexHome, 'sessions')
  writeRollout(sessionsRoot, NOW, {
    id: 'real-codex-id',
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  const tokens = withCodexHome(codexHome, () => codexSessionArgs('ws-bound'))
  assert.deepEqual(
    tokens,
    ['resume', 'real-codex-id'],
    'codexSessionArgs must emit exactly ["resume", <id>], subcommand-first, when the bound id\'s rollout still exists on disk'
  )
  console.log(
    '✓ codexSessionArgs resume argv token order: ["resume", id], subcommand-first (rollout exists)'
  )
}

// ---------------------------------------------------------------------------
// B1b. THE BUG THIS FILE FIXES — a workspace bound to an id whose rollout is
//     GONE (archived/deleted, CODEX_HOME moved, or never existed) must
//     degrade to a FRESH session ([]), never emit `resume` against an id
//     Codex can no longer find. This is the missing half of Claude's
//     sessionJsonlExists discipline that this module's header now documents
//     as fixed.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  insertWorkspace(db, {
    id: 'ws-bound-gone',
    cwd: '/repo',
    claudeSessionId: 'archived-or-deleted-id'
  })
  // Empty CODEX_HOME — no rollout for this id anywhere.
  const codexHome = freshSessionsRoot()
  const tokens = withCodexHome(codexHome, () => codexSessionArgs('ws-bound-gone'))
  assert.deepEqual(
    tokens,
    [],
    'a bound id whose rollout cannot be found on disk must degrade to a fresh session ([]), not ["resume", <gone id>]'
  )
  console.log(
    "✓ codexSessionArgs degrades to [] when the bound id's rollout is missing (archived/deleted/moved CODEX_HOME)"
  )
}

// ---------------------------------------------------------------------------
// B2. codexSessionArgs degrades to [] — no workspaceId, unbound workspace,
//     missing workspace row, and (defense-in-depth) a throwing DB. NEVER a
//     bare ['resume'] with no id: `codex resume` with no SESSION_ID opens an
//     interactive, cwd-filtered PICKER — a workspace mount must never land
//     there, so codexSessionArgs's only two shapes are [] and
//     ['resume', <non-empty id>], structurally (the id check gates the
//     return before 'resume' is ever pushed).
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  insertWorkspace(db, { id: 'ws-unbound', cwd: '/repo', claudeSessionId: null })
  assert.deepEqual(codexSessionArgs(undefined), [], 'no workspaceId -> []')
  assert.deepEqual(codexSessionArgs('ws-unbound'), [], 'unbound workspace -> []')
  assert.deepEqual(codexSessionArgs('no-such-workspace'), [], 'missing workspace row -> []')
  void db
  console.log('✓ codexSessionArgs degrades to [] for undefined/unbound/missing workspace')
}

// B2b. Every REAL codexSessionArgs output, across every scenario in this
// file so far, is either [] or exactly ['resume', <id>] — never a bare
// ['resume'] (which would trigger Codex's interactive picker). This is a
// structural sweep, not a single case, precisely because "never emit a bare
// resume" is an invariant about EVERY call, not one fixture. ws-sweep-bound's
// rollout fixture exists on disk so this sweep still exercises the
// ['resume', <id>] shape post-existence-gate, not just the [] shape.
{
  const db = createFreshDb()
  insertWorkspace(db, { id: 'ws-sweep-bound', cwd: '/repo', claudeSessionId: 'sweep-id' })
  insertWorkspace(db, { id: 'ws-sweep-unbound', cwd: '/repo', claudeSessionId: null })
  const codexHome = freshSessionsRoot()
  const sessionsRoot = path.join(codexHome, 'sessions')
  writeRollout(sessionsRoot, NOW, {
    id: 'sweep-id',
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  withCodexHome(codexHome, () => {
    for (const id of [undefined, 'ws-sweep-bound', 'ws-sweep-unbound', 'ws-sweep-missing']) {
      const tokens = codexSessionArgs(id)
      const isEmpty = tokens.length === 0
      const isResumeWithId = tokens.length === 2 && tokens[0] === 'resume' && tokens[1].length > 0
      assert.ok(
        isEmpty || isResumeWithId,
        `codexSessionArgs(${String(id)}) must be [] or ["resume", <non-empty id>] — got ${JSON.stringify(tokens)}`
      )
    }
    assert.deepEqual(
      codexSessionArgs('ws-sweep-bound'),
      ['resume', 'sweep-id'],
      'ws-sweep-bound has a real fixture rollout, so this sweep must still exercise the resume shape, not just []'
    )
  })
  console.log(
    '✓ codexSessionArgs never emits a bare ["resume"] with no id, across every scenario (including a real resume case)'
  )
}

// ---------------------------------------------------------------------------
// B3. discoverAndBindCodexSession — end to end: writes a real fixture
//     rollout, runs discovery against the real getWorkspace/
//     setWorkspaceClaudeSessionId chain, and confirms the workspace row is
//     actually updated (not just that the pure finder returns the right id
//     in isolation).
// ---------------------------------------------------------------------------
{
  // discoverAndBindCodexSession now derives its own floor from the
  // workspace's own createdAt (minus the grace constant) rather than
  // taking a floor argument — so this scenario sets createdAt to a time
  // just before the fixture rollout's own timestamp, mirroring how a real
  // workspace's createdAt precedes the Codex process it launches.
  const db = createFreshDb()
  const createdAt = Date.now() - 60_000
  insertWorkspace(db, {
    id: 'ws-to-discover',
    cwd: '/discover/me',
    claudeSessionId: null,
    createdAt
  })

  // Point the module's sessions-root resolution at our fixture dir by
  // overriding HOME for this scenario only (session.ts derives the root as
  // os.homedir()/.codex/sessions — same derivation Claude's own session.ts
  // uses for ~/.claude/projects, so this mirrors that file's own test
  // technique isn't available here since os.homedir() isn't mockable
  // without a real env var; HOME is the standard, safe way to redirect it
  // for a subprocess-free unit test).
  const fixtureHome = freshSessionsRoot()
  const originalHome = process.env.HOME
  process.env.HOME = fixtureHome
  try {
    const sessionsRoot = path.join(fixtureHome, '.codex', 'sessions')
    // discoverAndBindCodexSession -> findCodexUserRolloutId's DEFAULT `now`
    // parameter is the REAL `new Date()` (this is the one scenario that
    // exercises that impure default rather than passing an explicit `now`),
    // so the fixture must be shard-placed against the real current instant,
    // not the fixed NOW constant every other scenario uses — shardDir keys
    // off LOCAL calendar date (matching Codex's own real on-disk sharding,
    // verified against a live rollout file: shard dir is local-date, while
    // the payload's own `timestamp` field is UTC), and NOW's fixed UTC
    // instant can land on a different LOCAL date than the real "now" when
    // the two are hours apart — bit exactly this in development under
    // Asia/Calcutta (UTC+5:30).
    const realNow = new Date()
    writeRollout(sessionsRoot, realNow, {
      id: 'discovered-real-id',
      cwd: '/discover/me',
      threadSource: 'user',
      timestamp: realNow.toISOString()
    })
    discoverAndBindCodexSession('ws-to-discover')
    const ws = getWorkspace('ws-to-discover')
    assert.equal(
      ws?.claudeSessionId,
      'discovered-real-id',
      'discoverAndBindCodexSession must persist the discovered id onto the workspace row'
    )
  } finally {
    process.env.HOME = originalHome
  }
  console.log(
    '✓ discoverAndBindCodexSession persists the discovered id via setWorkspaceClaudeSessionId'
  )
}

// ---------------------------------------------------------------------------
// B3b. THE REMOUNT-BINDING FIX — the case that was CURRENTLY BROKEN before
//     the createdAt-anchored floor and must now pass. A naive "Date.now() at
//     this remount" floor would sit AFTER the workspace's own rollout
//     timestamp (the rollout was written whenever Codex last ran for this
//     workspace, which is always in the past relative to "now" at a later
//     remount) and would incorrectly reject it. The createdAt-anchored floor
//     fixes this: `ws.createdAt` is set once, at creation, and stays behind
//     the workspace's own rollout timestamp for its entire lifetime.
//
//     Scenario: a workspace was created an hour ago (`createdAt` = now -
//     1h). Codex started writing its rollout shortly after creation (a
//     timestamp comfortably after createdAt, comfortably before "now"). The
//     user is NOW reopening/remounting the workspace, long after that
//     session started. discoverAndBindCodexSession('ws-remount') — called
//     with NO floor argument, exactly as a real remount would call it via
//     scheduleCodexSessionDiscovery — must still bind to that rollout's id.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  insertWorkspace(db, {
    id: 'ws-remount',
    cwd: '/remount/me',
    claudeSessionId: null,
    createdAt: oneHourAgo
  })

  const fixtureHome = freshSessionsRoot()
  const originalHome = process.env.HOME
  process.env.HOME = fixtureHome
  try {
    const sessionsRoot = path.join(fixtureHome, '.codex', 'sessions')
    // Rollout written ~55 minutes ago: AFTER createdAt (workspace existed
    // first, then Codex started this session shortly after), but well
    // BEFORE "now" (the remount happening at test time) — exactly the
    // "old session, reopened much later" shape that a Date.now()-at-mount
    // floor rejected.
    const rolloutTime = new Date(oneHourAgo + 5 * 60 * 1000)
    writeRollout(sessionsRoot, rolloutTime, {
      id: 'own-prior-session',
      cwd: '/remount/me',
      threadSource: 'user',
      timestamp: rolloutTime.toISOString()
    })
    discoverAndBindCodexSession('ws-remount')
    const ws = getWorkspace('ws-remount')
    assert.equal(
      ws?.claudeSessionId,
      'own-prior-session',
      'a remount must bind to this workspace\'s own prior rollout even though its timestamp predates "now" at this remount'
    )
  } finally {
    process.env.HOME = originalHome
  }
  console.log(
    "✓ remount binds to a workspace's own prior session (createdAt-anchored floor, not Date.now()-at-mount)"
  )
}

// ---------------------------------------------------------------------------
// B3c. The discrimination the floor exists for is NOT lost — a rollout that
//     PREDATES the workspace's own createdAt (a genuinely unrelated `codex`
//     session the user ran by hand in this cwd before Orpheus ever created
//     the workspace) must still be excluded, even on the createdAt-anchored
//     floor.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  const createdAt = Date.now() - 60 * 60 * 1000
  insertWorkspace(db, {
    id: 'ws-remount-excl',
    cwd: '/remount/me',
    claudeSessionId: null,
    createdAt
  })

  const fixtureHome = freshSessionsRoot()
  const originalHome = process.env.HOME
  process.env.HOME = fixtureHome
  try {
    const sessionsRoot = path.join(fixtureHome, '.codex', 'sessions')
    // Well before createdAt (even accounting for MOUNT_FLOOR_GRACE_MS's
    // 5-minute backward grace) — a manual session that genuinely predates
    // this workspace's existence.
    const manualSessionTime = new Date(createdAt - 30 * 60 * 1000)
    writeRollout(sessionsRoot, manualSessionTime, {
      id: 'unrelated-manual-session',
      cwd: '/remount/me',
      threadSource: 'user',
      timestamp: manualSessionTime.toISOString()
    })
    discoverAndBindCodexSession('ws-remount-excl')
    const ws = getWorkspace('ws-remount-excl')
    assert.equal(
      ws?.claudeSessionId,
      null,
      'a rollout predating createdAt (a genuinely unrelated manual session) must still be excluded'
    )
  } finally {
    process.env.HOME = originalHome
  }
  console.log(
    '✓ a rollout predating workspace createdAt (unrelated manual session) is still correctly excluded'
  )
}

// ---------------------------------------------------------------------------
// B4. discoverAndBindCodexSession never throws — missing workspace, and a
//     sessions root that doesn't exist at all.
// ---------------------------------------------------------------------------
{
  const db = createFreshDb()
  void db
  assert.doesNotThrow(() => {
    discoverAndBindCodexSession('no-such-workspace')
  }, 'a missing workspace must not throw')
  console.log('✓ discoverAndBindCodexSession never throws for a missing workspace')
}

console.log('\nAll harness-codex-session assertions passed.\n')

// ---------------------------------------------------------------------------
// Mutation tests — each assertion above is deliberately broken here and
// this section confirms the broken version FAILS, proving the assertion
// actually tests something (per this repo's documented "assert behaviour,
// not source text" discipline — an assertion never tried against a mutation
// is one you don't know works).
// ---------------------------------------------------------------------------

function mustFail(label: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.log(`  mutation caught (expected failure) [${label}]:`, (err as Error).message)
    return
  }
  throw new Error(`MUTATION TEST FAILED TO CATCH A BUG: ${label} did not throw`)
}

// THE critical mutation, per the C5 task brief: remove the
// thread_source === 'user' filter and confirm the suite fails. This calls a
// LOCAL re-implementation of findCodexUserRolloutId's matching loop with
// that one filter line deleted, run against the SAME fixture files A1 wrote
// to disk, and asserts it selects a subagent id instead of the root id —
// proving the real function's filter is load-bearing (if it were dead code,
// this mutated version would agree with the real one and mustFail would
// itself fail to catch anything).
mustFail("removing the thread_source === 'user' filter is caught", () => {
  type SessionMetaPayload = {
    id?: unknown
    cwd?: unknown
    thread_source?: unknown
  }
  function readSessionMetaMutated(
    filePath: string
  ): { timestamp: string; payload: SessionMetaPayload } | null {
    let firstLine: string
    try {
      const contents = fs.readFileSync(filePath, 'utf8')
      const nl = contents.indexOf('\n')
      firstLine = nl === -1 ? contents : contents.slice(0, nl)
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(firstLine) as {
        type?: string
        timestamp?: string
        payload?: SessionMetaPayload
      }
      if (
        parsed.type !== 'session_meta' ||
        typeof parsed.timestamp !== 'string' ||
        !parsed.payload
      ) {
        return null
      }
      return { timestamp: parsed.timestamp, payload: parsed.payload }
    } catch {
      return null
    }
  }
  // Re-run scenario A1's exact fixture dir (scenario-1) with the
  // thread_source filter DELETED — cwd/floor/newest-wins logic kept intact,
  // only the one filter line removed.
  const root = path.join(tmpRoot, 'scenario-1')
  const dir = shardDir(root, NOW)
  const files = fs.readdirSync(dir).map((f) => path.join(dir, f))
  let best: { id: string; ts: number } | null = null
  for (const f of files) {
    const meta = readSessionMetaMutated(f)
    if (!meta) continue
    // <-- the deleted line would have been: if (meta.payload.thread_source !== 'user') continue
    if (meta.payload.cwd !== '/repo') continue
    if (typeof meta.payload.id !== 'string') continue
    const ts = Date.parse(meta.timestamp)
    if (ts < MOUNT_FLOOR_MS) continue
    if (best === null || ts > best.ts) best = { id: meta.payload.id, ts }
  }
  const mutatedResult = best?.id ?? null
  const realResult = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(
    mutatedResult,
    realResult,
    'a discoverer missing the thread_source filter selects a DIFFERENT (subagent) id than the real, filtered one'
  )
})
console.log(
  'mutation test: removing the thread_source==="user" filter is correctly caught as a failing assertion'
)

mustFail('cwd filter removed is caught', () => {
  const root = freshSessionsRoot()
  writeRollout(root, NOW, {
    id: 'wrong-cwd-session',
    cwd: '/completely/different/cwd',
    threadSource: 'user',
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  // The real function correctly excludes this (cwd mismatch) -> null.
  const real = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(
    'wrong-cwd-session',
    real,
    'a mutated (cwd-filter-less) result must disagree with the real, correctly-null result'
  )
})
console.log('mutation test: a missing cwd filter is correctly caught as a failing assertion')

mustFail('mount-time floor removed is caught', () => {
  const root = freshSessionsRoot()
  writeRollout(root, NOW, {
    id: 'stale-mutation-check',
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T01:00:00.000Z'
  })
  const real = findCodexUserRolloutId(root, '/repo', MOUNT_FLOOR_MS, NOW)
  assert.equal(
    'stale-mutation-check',
    real,
    'a mutated (floor-less) result must disagree with the real, correctly-null result'
  )
})
console.log('mutation test: a missing mount-time floor is correctly caught as a failing assertion')

mustFail('resume argv token order (flags-before-subcommand) is caught', () => {
  const db = createFreshDb()
  insertWorkspace(db, { id: 'ws-order-check', cwd: '/repo', claudeSessionId: 'order-check-id' })
  const codexHome = freshSessionsRoot()
  const sessionsRoot = path.join(codexHome, 'sessions')
  writeRollout(sessionsRoot, NOW, {
    id: 'order-check-id',
    cwd: '/repo',
    threadSource: 'user',
    timestamp: '2026-08-20T19:58:00.000Z'
  })
  const real = withCodexHome(codexHome, () => codexSessionArgs('ws-order-check'))
  const wrongOrder = ['order-check-id', 'resume'] // reversed
  assert.deepEqual(
    wrongOrder,
    real,
    'a reversed (non-subcommand-first) token order must disagree with the real result'
  )
})
console.log(
  'mutation test: reversed resume argv token order is correctly caught as a failing assertion'
)

mustFail('existence gate (codexRolloutExists check) removed is caught', () => {
  const db = createFreshDb()
  insertWorkspace(db, {
    id: 'ws-existence-gate-check',
    cwd: '/repo',
    claudeSessionId: 'no-rollout-for-this-id'
  })
  // Deliberately empty CODEX_HOME — no rollout anywhere for this id. The
  // real (fixed) codexSessionArgs must return [] here; a mutated version
  // with the codexRolloutExists check deleted would instead return
  // ['resume', 'no-rollout-for-this-id'] unconditionally (the old, buggy
  // behavior this file's fix replaces).
  const codexHome = freshSessionsRoot()
  const real = withCodexHome(codexHome, () => codexSessionArgs('ws-existence-gate-check'))
  const mutatedNoGate = ['resume', 'no-rollout-for-this-id']
  assert.deepEqual(
    mutatedNoGate,
    real,
    'a mutated (existence-gate-less) result must disagree with the real, correctly-empty result'
  )
})
console.log(
  'mutation test: removing the codexRolloutExists existence gate is correctly caught as a failing assertion'
)

fs.rmSync(tmpRoot, { recursive: true, force: true })
