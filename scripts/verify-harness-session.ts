// ---------------------------------------------------------------------------
// scripts/verify-harness-session.ts
//
// Behavior guard for src/main/harness/claude/session.ts (U5, multi-harness
// architecture plan) — claudeSessionArgs, the parallel implementation of
// claudeSettings.ts's pushSessionContinuityFlags. Asserts against the REAL
// exported function (and the real getWorkspace/sessionJsonlExists logic it
// runs), not a restatement of the branch logic.
//
// RUNTIME CHOICE — plain `node --experimental-strip-types`, mirroring
// scripts/verify-harness-claude-launch.ts exactly. claudeSessionArgs calls
// getWorkspace (src/main/workspaces.ts, which imports getDb from
// src/main/db — real src/main/db/index.ts imports better-sqlite3, which
// reliably crashes Bun 1.3.10 on this machine the moment `new Database(...)`
// runs under `bun run`, verified empirically by verify-harness-settings.ts).
// workspaces.ts also transitively reaches './db' a SECOND way, via its own
// import of claudeWorkspaceSettings.ts -> overridesStore.ts -> './db'. Both
// hops use the literal specifier './db' (both files live directly under
// src/main/), so the resolve hook below matches on that literal specifier
// text — same precedent as verify-harness-claude-launch.ts's own hook
// (see its comment: node's ESM resolver rejects a directory import
// outright with ERR_UNSUPPORTED_DIR_IMPORT, so probing the resolved target
// via nextResolve first isn't viable; matching the specifier text is).
// This script uses node:sqlite's DatabaseSync (aliased to `Database`) for
// a real in-memory `workspaces` table, plus a node:module `register()`
// resolve hook redirecting 'electron' to an inert stub and every './db' /
// '../db' hit to a virtual module backed by that DatabaseSync instance.
//
// resolveHarness (src/main/harness/registry.ts) is intercepted too, but for
// a DIFFERENT reason: not because it needs a DB (CLAUDE_DESCRIPTOR is a
// static object; registry.ts's module body only REFERENCES
// composeClaudeLaunch, never calls it) but because the capability-gating
// scenarios (capabilities.resume=false, capabilities.fork=false) need a
// resolveHarness whose returned capabilities this script controls per
// scenario — the real registry always returns Claude's real (true, true)
// descriptor, which can't express "a harness lacking resume" without
// editing registry.ts itself (out of scope — U5's hard constraints forbid
// touching registry.ts). The stub module below is a REAL ES module with a
// REAL claudeSessionArgs-shaped resolveHarness export; only its return
// value is test-controlled (via a mutable globalThis flag), so
// claudeSessionArgs's own gating logic (`if (!capabilities.resume) return
// []`, `if (capabilities.fork && ...)`) still runs for real against
// whatever this script sets.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

class Database extends DatabaseSync {}

const dbStubSource = `
export function getDb() {
  if (!globalThis.__HARNESS_SESSION_TEST_DB__) {
    throw new Error('verify-harness-session: no test DB set before a getDb() call')
  }
  return globalThis.__HARNESS_SESSION_TEST_DB__
}
`

// session.ts reads Claude's capabilities from its LEAF module
// (claude/curated.ts's CLAUDE_CAPABILITIES), not via resolveHarness — going
// through the registry made a harness module depend on the registry that
// composes it, closing a launch -> session -> registry -> launch cycle that
// check:arch rejects. So the stub intercepts './curated', not '../registry'.
//
// Default mirrors Claude's real capabilities (resume: true, fork: true) so
// scenarios that don't touch them get real, unchanged behavior.
const registryStubSource = `
export const CLAUDE_CAPABILITIES = new Proxy({}, {
  get(_t, prop) {
    const caps = globalThis.__HARNESS_SESSION_TEST_CAPS__ ?? { resume: true, fork: true }
    return caps[prop]
  }
})
`

const hooks = `
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const registryStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(registryStubSource))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: 'data:text/javascript,export const app = {}; export const BrowserWindow = { getAllWindows: () => [] }', shortCircuit: true }
  }
  // Redirect EVERY relative import of the db directory to the stub, from
  // any parent — not just workspaces.ts's own './db'. src/main/db is a
  // DIRECTORY module (db/index.ts), and node's ESM resolver rejects a
  // directory import outright (ERR_UNSUPPORTED_DIR_IMPORT) rather than
  // falling back to index.ts the way bundler resolution does — so
  // resolving via nextResolve first (to check the target) throws before
  // this hook can react. Match the literal specifier instead: session.ts
  // pulls in workspaces.ts (./db directly) AND
  // claudeWorkspaceSettings.ts -> overridesStore.ts (./db again, different
  // parent directory but the same specifier text since both live in
  // src/main/) — same precedent as verify-harness-claude-launch.ts's own
  // hook for the identical reason.
  // (Plain string compare rather than a regex: this hook is serialized
  // into a data: URL, where a regex literal's slashes do not survive
  // encoding.)
  if (specifier === './db' || specifier === '../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  // session.ts's own relative specifier for the registry module — see this
  // file's header for why this is intercepted (capability-gating control,
  // not a DB dependency).
  if (specifier === './curated' && context.parentURL && context.parentURL.endsWith('/src/main/harness/claude/session.ts')) {
    return { url: registryStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    // src/main/**/*.ts and src/shared/**/*.ts use extensionless relative
    // imports (bundler moduleResolution) — retry with .ts appended, same
    // fallback verify-migration-engine.ts / verify-harness-claude-launch.ts
    // use.
    if (err && err.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !specifier.endsWith('.ts')) {
      return await nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`
register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url)

type TestWorkspaceRow = {
  id: string
  project_id: string
  name: string
  cwd: string
  claude_session_id: string | null
  forked_from_session_id: string | null
  harness_id: string
}

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
  ;(globalThis as unknown as { __HARNESS_SESSION_TEST_DB__: unknown }).__HARNESS_SESSION_TEST_DB__ =
    db
  return db
}

function insertWorkspace(db: InstanceType<typeof Database>, row: TestWorkspaceRow): void {
  db.prepare(
    `INSERT INTO workspaces (id, project_id, name, cwd, claude_session_id, forked_from_session_id, harness_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.project_id,
    row.name,
    row.cwd,
    row.claude_session_id,
    row.forked_from_session_id,
    row.harness_id
  )
}

function setCapabilities(caps: { resume: boolean; fork: boolean } | undefined): void {
  ;(
    globalThis as unknown as { __HARNESS_SESSION_TEST_CAPS__: unknown }
  ).__HARNESS_SESSION_TEST_CAPS__ = caps
}

const { claudeSessionArgs } = await import('../src/main/harness/claude/session.ts')

// A cwd that will never actually have a real ~/.claude/projects/<encoded>/
// transcript on the machine running this script — sessionJsonlExists must
// resolve false for it, exercising the "no transcript yet" branches.
const NO_TRANSCRIPT_CWD = '/tmp/verify-harness-session-nonexistent-cwd'

// ---------------------------------------------------------------------------
// 1. No workspaceId at all -> [], no throw, no DB touch (getWorkspace must
//    not even be called — mirrors pushSessionContinuityFlags's own
//    `if (!workspaceId) return` early return).
// ---------------------------------------------------------------------------
{
  setCapabilities(undefined)
  const result = claudeSessionArgs(undefined)
  assert.deepEqual(result, [], 'no workspaceId -> [] with no throw')
  console.log('✓ no workspaceId -> [] (no throw, no DB touch)')
}

// ---------------------------------------------------------------------------
// 2. Workspace has no claudeSessionId -> [].
// ---------------------------------------------------------------------------
{
  setCapabilities(undefined)
  const db = createFreshDb()
  insertWorkspace(db, {
    id: 'ws-no-session',
    project_id: 'proj-1',
    name: 'w',
    cwd: NO_TRANSCRIPT_CWD,
    claude_session_id: null,
    forked_from_session_id: null,
    harness_id: 'claude'
  })
  const result = claudeSessionArgs('ws-no-session')
  assert.deepEqual(result, [], 'no claudeSessionId -> []')
  console.log('✓ workspace with no claudeSessionId -> []')
}

// ---------------------------------------------------------------------------
// 3. Unknown workspace id (getWorkspace returns null) -> [].
// ---------------------------------------------------------------------------
{
  setCapabilities(undefined)
  createFreshDb()
  const result = claudeSessionArgs('does-not-exist')
  assert.deepEqual(result, [], 'unknown workspace id -> []')
  console.log('✓ unknown workspace id -> [] (getWorkspace returns null)')
}

// ---------------------------------------------------------------------------
// 4. No transcript, no fork -> bare --session-id (normal first launch).
// ---------------------------------------------------------------------------
{
  setCapabilities(undefined)
  const db = createFreshDb()
  insertWorkspace(db, {
    id: 'ws-first-launch',
    project_id: 'proj-1',
    name: 'w',
    cwd: NO_TRANSCRIPT_CWD,
    claude_session_id: 'session-abc',
    forked_from_session_id: null,
    harness_id: 'claude'
  })
  const result = claudeSessionArgs('ws-first-launch')
  assert.deepEqual(
    result,
    ['--session-id', 'session-abc'],
    'no transcript + no fork -> bare --session-id'
  )
  console.log("✓ no transcript, no fork -> exactly ['--session-id', <id>]")
}

// ---------------------------------------------------------------------------
// 5. Fork with no transcript yet -> all three fork flags, IN ORDER.
// ---------------------------------------------------------------------------
{
  setCapabilities(undefined)
  const db = createFreshDb()
  insertWorkspace(db, {
    id: 'ws-fork',
    project_id: 'proj-1',
    name: 'w',
    cwd: NO_TRANSCRIPT_CWD,
    claude_session_id: 'our-new-uuid',
    forked_from_session_id: 'parent-uuid',
    harness_id: 'claude'
  })
  const result = claudeSessionArgs('ws-fork')
  assert.deepEqual(
    result,
    ['--session-id', 'our-new-uuid', '--resume', 'parent-uuid', '--fork-session'],
    'fork with no transcript -> --session-id/--resume/--fork-session in exactly this order'
  )
  console.log(
    "✓ fork with no transcript -> exactly ['--session-id', <new>, '--resume', <parent>, '--fork-session'] in order"
  )
}

// ---------------------------------------------------------------------------
// 6. Existing transcript -> exactly ['--resume', <id>], even when
//    forkedFromSessionId is also set (transcript existing takes priority —
//    branch 1 before branch 2, matching pushSessionContinuityFlags).
//    Uses a real temp file + real cwd/session id so sessionJsonlExists's
//    actual fs.statSync path resolves true.
// ---------------------------------------------------------------------------
{
  setCapabilities(undefined)
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { encodePathToClaudeDir } = await import('../src/main/claudeProjectDir.ts')

  const cwd = '/tmp/verify-harness-session-real-cwd'
  const sessionId = `verify-session-${Date.now()}`
  const encoded = encodePathToClaudeDir(cwd)
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded)
  const jsonlPath = path.join(dir, `${sessionId}.jsonl`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(jsonlPath, '')

  try {
    const db = createFreshDb()
    insertWorkspace(db, {
      id: 'ws-resume',
      project_id: 'proj-1',
      name: 'w',
      cwd,
      claude_session_id: sessionId,
      forked_from_session_id: 'some-parent-that-should-be-ignored',
      harness_id: 'claude'
    })
    const result = claudeSessionArgs('ws-resume')
    assert.deepEqual(
      result,
      ['--resume', sessionId],
      "existing transcript -> exactly ['--resume', <id>], fork ignored once transcript exists"
    )
    console.log("✓ existing transcript -> exactly ['--resume', <id>]")
  } finally {
    fs.rmSync(jsonlPath, { force: true })
  }
}

// ---------------------------------------------------------------------------
// 7. capabilities.resume === false -> [] EVEN THOUGH a session id and an
//    on-disk transcript both exist — the whole branch must be skipped
//    before touching sessionJsonlExists's decision at all.
// ---------------------------------------------------------------------------
{
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { encodePathToClaudeDir } = await import('../src/main/claudeProjectDir.ts')

  const cwd = '/tmp/verify-harness-session-no-resume-cwd'
  const sessionId = `verify-session-no-resume-${Date.now()}`
  const encoded = encodePathToClaudeDir(cwd)
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded)
  const jsonlPath = path.join(dir, `${sessionId}.jsonl`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(jsonlPath, '')

  try {
    const db = createFreshDb()
    insertWorkspace(db, {
      id: 'ws-no-resume-cap',
      project_id: 'proj-1',
      name: 'w',
      cwd,
      claude_session_id: sessionId,
      forked_from_session_id: null,
      harness_id: 'claude'
    })
    setCapabilities({ resume: false, fork: true })
    const result = claudeSessionArgs('ws-no-resume-cap')
    assert.deepEqual(
      result,
      [],
      'capabilities.resume=false -> [] even with a session id and an existing transcript'
    )
    console.log(
      '✓ capabilities.resume=false -> [] even when a session id and transcript both exist'
    )
  } finally {
    fs.rmSync(jsonlPath, { force: true })
    setCapabilities(undefined)
  }
}

// ---------------------------------------------------------------------------
// 8. capabilities.fork === false -> the fork branch (2) is skipped, falling
//    through to plain --session-id (branch 3) instead of the fork flags —
//    but plain resume (branch 1, once a transcript exists) still works
//    unaffected, proving fork:false gates ONLY branch 2.
// ---------------------------------------------------------------------------
{
  setCapabilities({ resume: true, fork: false })
  const db = createFreshDb()
  insertWorkspace(db, {
    id: 'ws-no-fork-cap',
    project_id: 'proj-1',
    name: 'w',
    cwd: NO_TRANSCRIPT_CWD,
    claude_session_id: 'our-new-uuid-2',
    forked_from_session_id: 'parent-uuid-2',
    harness_id: 'claude'
  })
  const result = claudeSessionArgs('ws-no-fork-cap')
  assert.deepEqual(
    result,
    ['--session-id', 'our-new-uuid-2'],
    'capabilities.fork=false -> fork branch skipped, falls back to bare --session-id'
  )
  console.log('✓ capabilities.fork=false -> fork branch skipped, bare --session-id emitted instead')
  setCapabilities(undefined)
}

// ---------------------------------------------------------------------------
// 8b. capabilities.fork === false, but a transcript ALREADY exists -> plain
//     resume (branch 1) is completely unaffected by fork:false.
// ---------------------------------------------------------------------------
{
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const { encodePathToClaudeDir } = await import('../src/main/claudeProjectDir.ts')

  const cwd = '/tmp/verify-harness-session-no-fork-resume-cwd'
  const sessionId = `verify-session-no-fork-resume-${Date.now()}`
  const encoded = encodePathToClaudeDir(cwd)
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded)
  const jsonlPath = path.join(dir, `${sessionId}.jsonl`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(jsonlPath, '')

  try {
    const db = createFreshDb()
    insertWorkspace(db, {
      id: 'ws-no-fork-cap-resume',
      project_id: 'proj-1',
      name: 'w',
      cwd,
      claude_session_id: sessionId,
      forked_from_session_id: 'irrelevant-parent',
      harness_id: 'claude'
    })
    setCapabilities({ resume: true, fork: false })
    const result = claudeSessionArgs('ws-no-fork-cap-resume')
    assert.deepEqual(
      result,
      ['--resume', sessionId],
      'capabilities.fork=false must not affect plain resume once a transcript exists'
    )
    console.log('✓ capabilities.fork=false -> plain resume (branch 1) still works unaffected')
  } finally {
    fs.rmSync(jsonlPath, { force: true })
    setCapabilities(undefined)
  }
}

console.log('\nAll harness-session assertions passed.')
