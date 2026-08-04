// ---------------------------------------------------------------------------
// scripts/verify-project-add.ts
//
// Assertion harness for src/main/projectPathResolve.ts — the path
// validation/resolution/existence-check logic backing the `project.add`
// command-socket action (src/main/commandServer.ts) and the
// `orpheus project add <path>` CLI command. Mirrors
// scripts/verify-command-action.ts's own no-Electron/no-SQLite constraint:
// this module (like commandAction.ts) is intentionally Electron-free, so it
// can be imported and exercised directly without booting the app, opening
// the real orpheus.sqlite, or binding the command socket (commandServer.ts
// itself DOES require Electron/getDb() to construct its full dispatch
// table — see that module's own doc comment for why the 'project.add'
// dispatch entry is a one-line call into resolveProjectAddPath()).
//
// resolveProjectAddPath IS THE HANDLER'S OWN VALIDATION LOGIC, NOT A PROXY
// FOR IT: commandServer.ts's 'project.add' entry is
// `(args) => addProject(resolveProjectAddPath(args))` — every line of
// validate/resolve/existence-check the handler runs before ever reaching
// addProject() lives in resolveProjectAddPath, so calling it directly here
// exercises the REAL handler behavior end to end, not a reimplementation or
// a source-text grep of it. (An earlier revision of this harness asserted
// the guard's presence by grepping commandServer.ts's source text — that
// approach was mutation-tested and found wanting: wrapping the guard in
// `if (false && ...)` left the grep passing while the guard did nothing.
// Extracting resolveProjectAddPath and calling it directly closes that gap:
// a neutered guard now fails an assertion, not just goes undetected by one.)
//
// Covers, per the task brief's "at minimum" bar for command-socket coverage:
//   1. resolveProjectPath (pure — no fs access): tilde expansion (`~`,
//      `~/rest`), relative-segment resolution against a given cwd, and
//      idempotence on an already-absolute path (the CLI pre-resolves before
//      sending over the socket — see commands/project.ts's header — so the
//      server-side re-resolution must be a safe no-op in that common case).
//   2. assertProjectDirectory: accepts a real, existing directory; REJECTS
//      (throws ProjectDirectoryNotFoundError) a non-existent path and a path
//      that exists but is a FILE, not a directory — the two failure modes
//      the task brief calls out by name ("non-existent directory" plus the
//      implicit is-a-directory check addProject's own default-workspace
//      creation depends on).
//   3. resolveProjectAddPath — the FULL handler-equivalent path, called
//      directly with args shapes the socket could plausibly receive: a
//      non-string path, an empty-string path, a missing path key, and a
//      good path that resolves + passes the existence check. This is what
//      actually stands in for "hit the dispatch handler" without Electron.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  resolveProjectPath,
  assertProjectDirectory,
  resolveProjectAddPath,
  ProjectDirectoryNotFoundError
} from '../src/main/projectPathResolve.ts'

// ---------------------------------------------------------------------------
// resolveProjectPath
// ---------------------------------------------------------------------------

function testResolveProjectPath(): void {
  const cwd = '/Users/example/code/orpheus'

  // Already-absolute path: returned unchanged (idempotent) — the CLI always
  // sends an absolute path (it pre-resolves against ITS OWN cwd before
  // hitting the socket; see commands/project.ts's header), so the server's
  // own resolution must be a no-op in the common case, never a
  // double-resolve bug.
  assert.equal(
    resolveProjectPath('/tmp/some-project', cwd),
    '/tmp/some-project',
    'an already-absolute path is returned unchanged'
  )

  // Bare '~' expands to the home directory exactly.
  assert.equal(resolveProjectPath('~', cwd), os.homedir(), "bare '~' expands to os.homedir()")

  // '~/rest' expands the home dir and joins the remainder.
  assert.equal(
    resolveProjectPath('~/code/my-project', cwd),
    path.join(os.homedir(), 'code', 'my-project'),
    "'~/rest' expands home dir and joins the remainder"
  )

  // Relative path resolves against the GIVEN cwd, not process.cwd() — the
  // whole point of accepting cwd as a parameter rather than hardcoding
  // process.cwd() internally (the CLI pre-resolves against its own; this
  // parameter exists so the function itself is testable independent of
  // whatever directory happens to be running this script).
  assert.equal(resolveProjectPath('.', cwd), cwd, "'.' resolves to the given cwd exactly")
  assert.equal(
    resolveProjectPath('../other-project', cwd),
    path.resolve(cwd, '../other-project'),
    'a relative path with .. resolves against the given cwd'
  )
  assert.equal(
    resolveProjectPath('subdir', cwd),
    path.join(cwd, 'subdir'),
    'a bare relative path joins onto the given cwd'
  )

  // '~otheruser/...' (a DIFFERENT user's home) is intentionally NOT
  // expanded — Node has no portable way to resolve another user's home
  // without shelling out, so this is left as a literal path segment
  // (resolved relative to cwd like any other non-tilde string), which then
  // fails assertProjectDirectory's existence check with a clear message
  // rather than silently guessing wrong.
  assert.equal(
    resolveProjectPath('~otheruser/project', cwd),
    path.resolve(cwd, '~otheruser/project'),
    "'~otheruser/...' is left unexpanded, resolved as a literal relative segment"
  )

  console.log(
    '✓ resolveProjectPath: idempotent on an already-absolute path, expands ~ and ~/rest via ' +
      'os.homedir(), resolves relative segments (., .., bare) against the given cwd, and ' +
      "deliberately leaves '~otheruser/...' unexpanded rather than guessing"
  )
}

// ---------------------------------------------------------------------------
// assertProjectDirectory
// ---------------------------------------------------------------------------

function testAssertProjectDirectory(): void {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpheus-project-add-'))
  try {
    // A real, existing directory: must NOT throw.
    assert.doesNotThrow(
      () => assertProjectDirectory(tmpRoot),
      'a real, existing directory passes the check'
    )

    // Non-existent path: MUST throw ProjectDirectoryNotFoundError, not
    // silently pass through — this is the exact case the task brief calls
    // out: registering a typo'd path would otherwise create a project (and
    // its default workspace) pointing at nothing.
    const missing = path.join(tmpRoot, 'does-not-exist')
    assert.throws(
      () => assertProjectDirectory(missing),
      ProjectDirectoryNotFoundError,
      'a non-existent path is rejected with ProjectDirectoryNotFoundError'
    )

    // A path that EXISTS but is a FILE, not a directory: also must throw —
    // addProject()'s own default-workspace creation assumes cwd is a real
    // directory, so a file path must be rejected just as hard as a missing
    // one, not treated as "exists, good enough".
    const filePath = path.join(tmpRoot, 'not-a-directory.txt')
    fs.writeFileSync(filePath, 'hello')
    assert.throws(
      () => assertProjectDirectory(filePath),
      ProjectDirectoryNotFoundError,
      'an existing FILE (not a directory) is rejected with ProjectDirectoryNotFoundError'
    )

    // Error messages are distinguishable (not-found vs not-a-directory) —
    // asserted loosely (substring, not exact match) so wording can evolve
    // without this test becoming brittle, but the DISTINCTION must survive.
    try {
      assertProjectDirectory(missing)
      assert.fail('expected assertProjectDirectory to throw for a missing path')
    } catch (err) {
      assert.ok(
        err instanceof ProjectDirectoryNotFoundError && err.message.includes('not found'),
        'missing-path error message mentions "not found"'
      )
    }
    try {
      assertProjectDirectory(filePath)
      assert.fail('expected assertProjectDirectory to throw for a file path')
    } catch (err) {
      assert.ok(
        err instanceof ProjectDirectoryNotFoundError && err.message.includes('not a directory'),
        'file-path error message mentions "not a directory"'
      )
    }

    console.log(
      '✓ assertProjectDirectory: accepts a real existing directory, REJECTS a non-existent path ' +
        'and a path that exists but is a file (not a directory) — both via ' +
        'ProjectDirectoryNotFoundError with a distinguishable message'
    )
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// resolveProjectAddPath — the 'project.add' dispatch handler's FULL
// validation logic, called directly with the args shapes the socket could
// plausibly receive. See this file's header for why this replaces an
// earlier source-text-grep approach.
// ---------------------------------------------------------------------------

function testResolveProjectAddPath(): void {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orpheus-project-add-handler-'))
  try {
    // Non-string path: rejected before any fs access.
    assert.throws(
      () => resolveProjectAddPath({ path: 123 }),
      /args\.path is required/,
      'a non-string args.path is rejected'
    )
    // Empty-string path: also rejected, not treated as "no path given but OK".
    assert.throws(
      () => resolveProjectAddPath({ path: '' }),
      /args\.path is required/,
      'an empty-string args.path is rejected'
    )
    // Missing path key entirely.
    assert.throws(
      () => resolveProjectAddPath({}),
      /args\.path is required/,
      'a missing args.path key is rejected'
    )
    // null/undefined explicit values.
    assert.throws(
      () => resolveProjectAddPath({ path: null }),
      /args\.path is required/,
      'a null args.path is rejected'
    )

    // A non-existent directory: rejected by the existence check (this is
    // the path.add-specific case the task brief calls out — the FULL
    // handler path, not just assertProjectDirectory in isolation).
    const missing = path.join(tmpRoot, 'does-not-exist')
    assert.throws(
      () => resolveProjectAddPath({ path: missing }),
      ProjectDirectoryNotFoundError,
      'a non-existent directory is rejected by the full handler path'
    )

    // A GOOD path: resolved and returned, no throw. Uses the cwd parameter
    // (not process.cwd()) so this assertion is independent of wherever this
    // script happens to run from. 'subdir' must exist first (the whole
    // point of assertProjectDirectory) — create it, then resolve.
    fs.mkdirSync(path.join(tmpRoot, 'subdir'))
    const resolved = resolveProjectAddPath({ path: 'subdir' }, tmpRoot)
    assert.equal(
      resolved,
      path.join(tmpRoot, 'subdir'),
      'a good relative path resolves against the given cwd and is returned'
    )

    console.log(
      '✓ resolveProjectAddPath: rejects a non-string, empty-string, missing-key, or null ' +
        'args.path; rejects a non-existent directory via the FULL handler path; resolves and ' +
        'returns a good relative path against the given cwd once it exists'
    )
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

testResolveProjectPath()
testAssertProjectDirectory()
testResolveProjectAddPath()

await testAddProjectBroadcasts()

console.log('\nAll project-add assertions passed.')

// ---------------------------------------------------------------------------
// addProject() broadcast coverage — src/main/projects.ts's addProject()
// (bug fix: it previously never called broadcastProjectChanged at all, so a
// project added from the CLI/TUI socket bridge or a second desktop window
// left every OTHER renderer's sidebar stale until some unrelated refresh).
// This is a DIFFERENT module than the rest of this file (projects.ts, not
// projectPathResolve.ts) and — unlike everything above — is NOT Electron-
// free: it imports `electron`'s BrowserWindow at module scope and calls
// getDb() (Electron's `app.getPath('userData')`) at runtime, plus
// createWorkspace/importSessionsForProject/refreshGithubData, each with
// their own further Electron/fs/network coupling. Booting the real app to
// exercise this would be disproportionate for two call sites, so this uses
// `bun:test`'s `mock.module()` (confirmed to work in a plain `bun run`
// script, not just under `bun test`) to replace exactly the modules
// addProject() imports with minimal fakes — a REAL in-memory SQLite
// `projects` table (so the actual SQL addProject() runs is exercised, not a
// hand-rolled fake of `db.prepare`), backed by `bun:sqlite` rather than
// `better-sqlite3` (the real native `better-sqlite3` addon isn't loadable
// under the plain `bun run` runtime this script executes under — verified:
// it throws ERR_DLOPEN_FAILED, the same reason scripts/verify-migration-
// engine.ts uses node:sqlite's DatabaseSync for its own harness instead of
// better-sqlite3 — though THAT module isn't available under bun either, so
// this uses bun:sqlite specifically, with a tiny `.transaction()` shim
// added since bun:sqlite's Database doesn't implement better-sqlite3's
// transaction() wrapper and addProject() calls db.transaction(fn)()) — plus
// no-op stubs for everything addProject() doesn't use the return value of
// (createWorkspace, importSessionsForProject, refreshGithubData, the
// cache-invalidation/runtime-resource-scope side calls).
// `setProjectChangedSender()` (exported from projects.ts specifically for
// this — see that file's "TEST SEAM" comment) replaces the BrowserWindow
// fan-out with a spy that records every broadcast, which is what this test
// actually asserts against: BOTH addProject() call sites (dedup path,
// fresh-insert path) must broadcast, not just one — a bare source-text grep
// couldn't tell a live call from a commented-out or dead-branch one (see
// this file's own header for why verify-project-add.ts already rejects
// that approach elsewhere).
// ---------------------------------------------------------------------------

async function testAddProjectBroadcasts(): Promise<void> {
  const { mock } = await import('bun:test')
  const { Database: SqliteDatabase } = await import('bun:sqlite')

  const db = new SqliteDatabase(':memory:')
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      claude_encoded_name TEXT,
      added_at INTEGER NOT NULL,
      last_opened_at INTEGER,
      expanded_in_sidebar INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER,
      pinned_at INTEGER,
      github_owner TEXT,
      github_repo TEXT,
      github_avatar_url TEXT,
      github_checked_at INTEGER,
      classified INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0
    )
  `)
  // better-sqlite3-compatible `.transaction(fn)` shim: addProject() calls
  // `db.transaction(() => {...})()` (see src/main/projects.ts's
  // `insertProject`) — bun:sqlite's Database has no such method natively.
  // Only needs to support the exact shape addProject() uses: wrap in a
  // BEGIN/COMMIT, roll back on throw.
  const dbWithTransaction = db as InstanceType<typeof SqliteDatabase> & {
    transaction: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A) => R
  }
  dbWithTransaction.transaction = (fn) => {
    return (...args) => {
      db.exec('BEGIN')
      try {
        const result = fn(...args)
        db.exec('COMMIT')
        return result
      } catch (err) {
        db.exec('ROLLBACK')
        throw err
      }
    }
  }

  // Module specifiers exactly as src/main/projects.ts imports them, resolved
  // to absolute paths so mock.module() doesn't depend on this script's own
  // location relative to src/main.
  const projectsTsDir = new URL('../src/main/', import.meta.url)
  const abs = (rel: string): string => new URL(rel, projectsTsDir).pathname

  mock.module('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
  // './db' resolves to db/index.ts (a directory module), not a sibling
  // db.ts file — the wrong specifier here would silently fall through to
  // the REAL db/index.ts (which imports electron's `app`) instead of being
  // intercepted, so getDb() must be mocked at its actual resolved path.
  mock.module(abs('db/index.ts'), () => ({ getDb: () => dbWithTransaction }))
  mock.module(abs('workspaces.ts'), () => ({ createWorkspace: () => undefined }))
  mock.module(abs('sessions.ts'), () => ({ importSessionsForProject: async () => [] }))
  mock.module(abs('githubAvatar.ts'), () => ({ refreshGithubData: async () => undefined }))
  mock.module(abs('claudeProjectSettings.ts'), () => ({
    invalidateClaudeProjectSettingsCache: () => undefined
  }))
  mock.module(abs('controlPlane/runtimeResourceScopeRevision.ts'), () => ({
    markRuntimeResourceScopeChanged: () => undefined
  }))

  const { addProject, setProjectChangedSender } = await import('../src/main/projects.ts')

  const broadcasts: Array<{ id: string; path: string }> = []
  const previousSender = setProjectChangedSender((project) => {
    broadcasts.push({ id: project.id, path: project.path })
  })

  try {
    // FRESH-INSERT PATH: a brand-new path must broadcast exactly once, with
    // the newly-created project's own id/path.
    const fresh = addProject('/fake/fresh-project')
    assert.equal(broadcasts.length, 1, 'fresh-insert path: addProject broadcasts exactly once')
    assert.equal(
      broadcasts[0]!.id,
      fresh.id,
      'fresh-insert path: the broadcast payload carries the newly-created project'
    )
    assert.equal(broadcasts[0]!.path, '/fake/fresh-project')

    // DEDUP PATH: re-adding the SAME path must ALSO broadcast (the bug fix
    // covers both branches — an earlier revision of this fix could plausibly
    // add the call to only one of the two `if (existing) { ... return }` /
    // fall-through branches and still look correct at a glance).
    const deduped = addProject('/fake/fresh-project')
    assert.equal(broadcasts.length, 2, 'dedup path: addProject ALSO broadcasts on re-add')
    assert.equal(deduped.id, fresh.id, 'dedup path: returns the SAME project id, not a duplicate')
    assert.equal(
      broadcasts[1]!.id,
      fresh.id,
      'dedup path: the broadcast payload carries the existing (bumped) project'
    )

    // A second, genuinely different fresh path broadcasts again — confirms
    // the fresh-insert broadcast isn't a one-shot fluke tied to call order.
    const secondFresh = addProject('/fake/second-project')
    assert.equal(broadcasts.length, 3, 'a second distinct fresh-insert also broadcasts')
    assert.equal(broadcasts[2]!.id, secondFresh.id)

    console.log(
      '✓ addProject: broadcasts projects:changed on BOTH the fresh-insert path and the dedup (already-exists) path, with the correct project payload each time'
    )
  } finally {
    setProjectChangedSender(previousSender)
    db.close()
  }
}
