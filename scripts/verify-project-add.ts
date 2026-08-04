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

console.log('\nAll project-add assertions passed.')
