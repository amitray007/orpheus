// ---------------------------------------------------------------------------
// scripts/verify-tmux-host.ts
//
// Pure-function harness for src/main/tmuxHost.ts. Runs on plain Linux via
// `bun run` with NO Electron required — the PURE exports
// (tmuxSocketNameForAppName, tmuxSessionName, shouldBlockNativeMount,
// shouldRetainInTmuxEnvironment, buildTreeFrame) need neither Electron nor
// tmux. See tmuxHost.ts's own module doc comment for why importing it here
// is safe (Electron access is deferred behind resolveTmuxSocketName()/
// hostWorkspace(), never touched at import time or by anything the pure
// section below calls).
//
// The RENAME/ARCHIVE-TEARDOWN section further down additionally exercises
// renameHostedSession()/unhostWorkspace() against a REAL, throwaway tmux
// socket (via each function's test-only `socketNameOverride` param — see
// their own doc comments in tmuxHost.ts) — still with NO Electron involved,
// since the override bypasses resolveTmuxSocketName() entirely. That
// section is skipped (not failed) when tmux isn't on PATH, mirroring
// scripts/verify-tmux-integration.ts's own hasTmux() gate; ALL sockets it
// creates are process-unique (`orpheus-verify-host-<pid>-*`) and torn down
// in a `finally`, unlinking the socket file too (kill-server alone leaves it
// behind — see verify-tmux-integration.ts's tmuxSocketPath() comment for why).
//
// scripts/verify-tmux-integration.ts remains the companion END-TO-END harness
// for the lower-level tmux plumbing (env delivery, secret scrub, socket
// isolation) this file doesn't re-test.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import * as path from 'node:path'
import {
  tmuxSocketNameForAppName,
  tmuxSessionName,
  shouldBlockNativeMount,
  shouldRetainInTmuxEnvironment,
  buildTreeFrame,
  renameHostedSession,
  unhostWorkspace,
  TmuxNotAvailableError,
  type TreeSourceWorkspace
} from '../src/main/tmuxHost'
import type { ProjectRecord } from '../src/shared/types'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// tmuxSocketNameForAppName — the four known variants + an unknown fallback
// ---------------------------------------------------------------------------

{
  assert.equal(tmuxSocketNameForAppName('Orpheus'), 'orpheus')
  assert.equal(tmuxSocketNameForAppName('Orpheus Dev'), 'orpheus-dev')
  assert.equal(tmuxSocketNameForAppName('Orpheus WT'), 'orpheus-wt')
  assert.equal(tmuxSocketNameForAppName('Orpheus Nightly'), 'orpheus-nightly')
  console.log('✓ the four known app-name -> socket-name mappings are exact')
}

{
  // Unknown/renamed bundle: deterministic slug fallback, never a throw, and
  // still distinct from every known socket name (environment separation
  // holds even for a variant nobody planned for).
  const fallback = tmuxSocketNameForAppName('Some Renamed Bundle')
  assert.equal(fallback, 'some-renamed-bundle')
  assert.notEqual(fallback, 'orpheus')
  assert.equal(tmuxSocketNameForAppName('Some Renamed Bundle'), fallback, 'deterministic')

  // Degenerate input (all-symbol/emoji name) still yields a non-empty,
  // tmux-legal socket name rather than an empty string or a throw.
  const degenerate = tmuxSocketNameForAppName('!!!')
  assert.ok(degenerate.length > 0)
  assert.doesNotMatch(degenerate, /[.:]/)
  console.log('✓ an unrecognized app name falls back to a deterministic, non-empty slug')
}

// ---------------------------------------------------------------------------
// tmuxSessionName — slugging rules
// ---------------------------------------------------------------------------

{
  // Spaces + mixed case -> lowercase, dash-joined.
  assert.equal(tmuxSessionName('My Workspace', 'abcdef1234567890'), 'my-workspace-abcdef12')
}

{
  // '.' and ':' are tmux target separators and MUST NOT survive into the
  // session name in any form.
  const name = tmuxSessionName('feature: fix.bug', '11112222333344445555')
  assert.doesNotMatch(name, /[.:]/)
  assert.equal(name, 'feature-fix-bug-11112222')
}

{
  // Unicode/emoji collapse to ASCII-only; never throws, never empty.
  const name = tmuxSessionName('日本語 emoji 🎉 name', 'ffffeeee11112222')
  assert.doesNotMatch(name, /[.:]/)
  assert.match(name, /^[a-z0-9-]+-ffffeeee$/)
}

{
  // Empty-after-slugify workspace name still yields a legal, non-empty slug.
  const name = tmuxSessionName('🎉🎉🎉', 'aaaa1111bbbb2222')
  assert.equal(name, 'workspace-aaaa1111')
}

{
  // Long name is capped at 24 slug chars (before the id suffix), with no
  // dangling trailing dash from the truncation.
  const longName = 'a'.repeat(40)
  const name = tmuxSessionName(longName, 'cccc3333dddd4444')
  const [slug, idSuffix] = name.split(/-(?=[^-]+$)/)
  assert.equal(slug.length, 24)
  assert.equal(idSuffix, 'cccc3333')
  assert.ok(!name.includes('--'), 'must not leave a double-dash from a trimmed trailing run')
}

{
  // Collision behavior: two workspaces sharing a name still get DISTINCT
  // session names, because the id suffix differs.
  const a = tmuxSessionName('shared-name', '1111aaaa2222bbbb')
  const b = tmuxSessionName('shared-name', '9999zzzz8888yyyy')
  assert.notEqual(a, b)
  assert.equal(a, 'shared-name-1111aaaa')
  assert.equal(b, 'shared-name-9999zzzz')
  console.log('✓ session-name slugging (unicode/`.`/`:` stripping, length cap, collisions) holds')
}

// ---------------------------------------------------------------------------
// shouldBlockNativeMount — the terminal:mount native-mount guard predicate
// ---------------------------------------------------------------------------

{
  const hosted = new Set(['my-workspace-abcdef12'])
  assert.equal(shouldBlockNativeMount(hosted, 'my-workspace-abcdef12'), true)
  assert.equal(shouldBlockNativeMount(hosted, 'other-workspace-11112222'), false)
  assert.equal(shouldBlockNativeMount(new Set(), 'my-workspace-abcdef12'), false)
  console.log('✓ shouldBlockNativeMount only blocks a session tmux actually reports as hosted')
}

// ---------------------------------------------------------------------------
// shouldRetainInTmuxEnvironment — the secret-scrub ALLOWLIST predicate.
//
// This MUST be an allowlist, not a name-pattern blocklist: a miss in a
// blocklist (e.g. logRedaction.ts's isSensitiveLogKey, which is exactly
// right for ITS job — a miss there just makes a log line noisier) means a
// credential sits readable in `tmux show-environment` for the session's
// entire life. Assert both the false-negative a blocklist approach produces
// AND the operational keys that must survive for a future window/pane.
// ---------------------------------------------------------------------------

{
  // Known "obviously secret" names — must be scrubbed (NOT retained).
  for (const key of [
    'ANTHROPIC_API_KEY',
    'AWS_SECRET_ACCESS_KEY',
    'AZURE_CLIENT_SECRET',
    'ORPHEUS_CMD_TOKEN',
    'ORPHEUS_RUNTIME_LEASE_TOKEN'
  ]) {
    assert.equal(shouldRetainInTmuxEnvironment(key), false, `${key} must be scrubbed`)
  }

  // The exact miss a NAME-PATTERN blocklist has for real-world secret env
  // vars: "credential**s**" (plural) doesn't match a "credential" literal.
  assert.equal(
    shouldRetainInTmuxEnvironment('GOOGLE_APPLICATION_CREDENTIALS'),
    false,
    'GOOGLE_APPLICATION_CREDENTIALS must be scrubbed even though its name does not match a ' +
      '"credential" (singular) pattern'
  )

  // An arbitrary user-defined customEnvVars key — composeClaudeLaunch merges
  // these in last (claudeSettings.ts) with NO name convention to pattern-match
  // on at all. The allowlist approach scrubs it correctly because it isn't
  // one of the handful of named exceptions, not because its name "looks"
  // secret.
  assert.equal(
    shouldRetainInTmuxEnvironment('MY_COMPANY_CREDS'),
    false,
    'an arbitrary custom env var must be scrubbed by default (allowlist, not a name guess)'
  )

  // Every allowlisted operational key must be retained.
  for (const key of [
    'ORPHEUS_WORKSPACE_ID',
    'ORPHEUS_BIN_DIR',
    'ORPHEUS_USER_PATH',
    'ORPHEUS_DATA_VARIANT',
    'PATH',
    'TERM'
  ]) {
    assert.equal(shouldRetainInTmuxEnvironment(key), true, `${key} must be retained`)
  }

  console.log(
    '✓ shouldRetainInTmuxEnvironment is an allowlist: known secrets, GOOGLE_APPLICATION_CREDENTIALS, ' +
      'and an arbitrary custom key are all scrubbed; every operational key is retained'
  )
}

// ---------------------------------------------------------------------------
// buildTreeFrame — ordering, filtering, and per-workspace shape
// ---------------------------------------------------------------------------

function project(overrides: Partial<ProjectRecord> & { id: string }): ProjectRecord {
  return {
    id: overrides.id,
    path: `/repo/${overrides.id}`,
    name: overrides.id,
    claudeEncodedName: null,
    addedAt: 0,
    lastOpenedAt: null,
    expandedInSidebar: true,
    sortOrder: null,
    pinnedAt: null,
    githubOwner: null,
    githubRepo: null,
    githubAvatarUrl: null,
    githubCheckedAt: null,
    classified: false,
    hidden: false,
    ...overrides
  }
}

function workspace(
  overrides: Partial<TreeSourceWorkspace> & { id: string; projectId: string }
): TreeSourceWorkspace {
  return {
    id: overrides.id,
    projectId: overrides.projectId,
    name: overrides.id,
    nameIsAuto: false,
    cwd: `/repo/${overrides.projectId}`,
    pinnedAt: null,
    createdAt: 0,
    lastOpenedAt: null,
    archivedAt: null,
    closedAt: null,
    sortOrder: null,
    status: 'idle',
    claudeSessionId: null,
    forkedFromSessionId: null,
    lastTitle: null,
    parentWorkspaceId: null,
    worktreeParentCwd: null,
    worktreeBranch: null,
    ...overrides
  } as TreeSourceWorkspace
}

{
  // Project ordering: sort_order ASC NULLS LAST, then addedAt DESC — MUST
  // match the desktop sidebar (docs/TUI_SPEC.md D5).
  const projects: ProjectRecord[] = [
    project({ id: 'no-sort-old', sortOrder: null, addedAt: 100 }),
    project({ id: 'no-sort-new', sortOrder: null, addedAt: 200 }),
    project({ id: 'sort-1', sortOrder: 1, addedAt: 1 }),
    project({ id: 'sort-0', sortOrder: 0, addedAt: 2 })
  ]
  const frame = buildTreeFrame(projects, [], new Set(), 1)
  assert.deepEqual(
    frame.projects.map((p) => p.id),
    ['sort-0', 'sort-1', 'no-sort-new', 'no-sort-old']
  )
  assert.equal(frame.type, 'tree')
  assert.equal(frame.revision, 1)
  console.log('✓ project ordering matches sort_order ASC NULLS LAST, addedAt DESC')
}

{
  // Workspace ordering within a project follows the same rule (createdAt).
  const projects: ProjectRecord[] = [project({ id: 'p1' })]
  const workspaces: TreeSourceWorkspace[] = [
    workspace({ id: 'w-old', projectId: 'p1', sortOrder: null, createdAt: 100 }),
    workspace({ id: 'w-new', projectId: 'p1', sortOrder: null, createdAt: 200 }),
    workspace({ id: 'w-first', projectId: 'p1', sortOrder: 0, createdAt: 1 })
  ]
  const frame = buildTreeFrame(projects, workspaces, new Set(), 2)
  assert.equal(frame.projects.length, 1)
  assert.deepEqual(
    frame.projects[0].workspaces.map((w) => w.id),
    ['w-first', 'w-new', 'w-old']
  )
  console.log(
    '✓ workspace ordering within a project matches sort_order ASC NULLS LAST, createdAt DESC'
  )
}

{
  // Archived workspaces are excluded (active scope only, mirrors
  // listWorkspacesForProject's default).
  const projects: ProjectRecord[] = [project({ id: 'p1' })]
  const workspaces: TreeSourceWorkspace[] = [
    workspace({ id: 'w-active', projectId: 'p1' }),
    workspace({ id: 'w-archived', projectId: 'p1', archivedAt: 12345 })
  ]
  const frame = buildTreeFrame(projects, workspaces, new Set(), 3)
  assert.deepEqual(
    frame.projects[0].workspaces.map((w) => w.id),
    ['w-active']
  )
  console.log('✓ archived workspaces are excluded from the tree frame')
}

{
  // A project with no active workspaces still appears with an empty array,
  // rather than being dropped — the TUI needs to show empty projects too.
  const projects: ProjectRecord[] = [project({ id: 'empty-project' })]
  const frame = buildTreeFrame(projects, [], new Set(), 4)
  assert.equal(frame.projects.length, 1)
  assert.deepEqual(frame.projects[0].workspaces, [])
  console.log(
    '✓ a project with zero active workspaces still appears, with an empty workspaces array'
  )
}

{
  // Per-workspace shape: waitingFor only present when the caller supplied
  // it, tmuxHosted derived from the hosted-session set via the SAME session
  // name tmuxSessionName() would compute, worktreeBranch/parentWorkspaceId
  // passed through verbatim, lastActivityAt falls back to lastOpenedAt.
  const projects: ProjectRecord[] = [project({ id: 'p1', name: 'orpheus', path: '/repo/orpheus' })]
  const attentionWs = workspace({
    id: 'ws-attention',
    projectId: 'p1',
    name: 'tmux-mobile',
    status: 'attention',
    waitingFor: 'permission prompt',
    worktreeBranch: 'feat/tmux-mobile',
    parentWorkspaceId: 'parent-1',
    sortOrder: 0,
    lastActivityAt: 999
  })
  const idleWs = workspace({
    id: 'ws-idle',
    projectId: 'p1',
    name: 'plain',
    status: 'idle',
    sortOrder: 1,
    lastOpenedAt: 42
  })
  const hostedSessionName = tmuxSessionName('tmux-mobile', 'ws-attention')
  const frame = buildTreeFrame(projects, [attentionWs, idleWs], new Set([hostedSessionName]), 41)

  assert.equal(frame.projects[0].name, 'orpheus')
  assert.equal(frame.projects[0].cwd, '/repo/orpheus')

  const [attentionOut, idleOut] = frame.projects[0].workspaces
  assert.equal(attentionOut.id, 'ws-attention')
  assert.equal(attentionOut.status, 'attention')
  assert.equal(attentionOut.waitingFor, 'permission prompt')
  assert.equal(attentionOut.worktreeBranch, 'feat/tmux-mobile')
  assert.equal(attentionOut.parentWorkspaceId, 'parent-1')
  assert.equal(attentionOut.tmuxHosted, true)
  assert.equal(attentionOut.lastActivityAt, 999)

  assert.equal(idleOut.id, 'ws-idle')
  assert.equal('waitingFor' in idleOut, false, 'waitingFor must be omitted, not null, when absent')
  assert.equal(idleOut.tmuxHosted, false)
  assert.equal(idleOut.lastActivityAt, 42, 'falls back to lastOpenedAt when no live overlay is set')
  console.log('✓ tree-frame workspace rows carry the exact documented shape (docs/TUI_SPEC.md)')
}

// ---------------------------------------------------------------------------
// BUG 1 + BUG 2 — real-tmux coverage for renameHostedSession() /
// unhostWorkspace(), against a throwaway process-unique socket (via each
// function's socketNameOverride test seam — no Electron involved). Skips
// (not fails) when tmux isn't on PATH, exactly like
// scripts/verify-tmux-integration.ts.
// ---------------------------------------------------------------------------

const RESERVED_SOCKET_NAMES = ['orpheus', 'orpheus-dev', 'orpheus-wt', 'orpheus-nightly']

function assertSafeSocketName(name: string): void {
  assert.ok(
    !RESERVED_SOCKET_NAMES.includes(name),
    `refusing to touch a real Orpheus tmux socket in a test: ${name}`
  )
}

async function tmux(socket: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  assertSafeSocketName(socket)
  return execFileAsync('tmux', ['-L', socket, ...args])
}

async function tmuxExitCode(socket: string, args: string[]): Promise<number> {
  assertSafeSocketName(socket)
  try {
    await execFileAsync('tmux', ['-L', socket, ...args])
    return 0
  } catch (err) {
    const code = (err as { code?: number }).code
    return typeof code === 'number' ? code : 1
  }
}

async function hasTmux(): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['-V'])
    return true
  } catch {
    return false
  }
}

/** Mirrors verify-tmux-integration.ts's tmuxSocketPath() exactly (see that
 *  file's doc comment for why this asks tmux itself rather than
 *  recomputing tmux's own resolution rule). */
async function tmuxSocketPath(socket: string): Promise<string> {
  try {
    const { stdout } = await tmux(socket, ['display-message', '-p', '#{socket_path}'])
    const queried = stdout.trim()
    if (queried !== '') return queried
  } catch {
    // Server already gone — fall through to the literal fallback below.
  }
  const tmpDir = process.env.TMUX_TMPDIR ?? `/tmp/tmux-${process.getuid?.() ?? 0}`
  return path.join(tmpDir, socket)
}

async function runRealTmuxChecks(): Promise<void> {
  if (!(await hasTmux())) {
    console.log(
      'tmux not found on PATH — skipping renameHostedSession/unhostWorkspace real-tmux checks ' +
        '(this is not a failure).'
    )
    return
  }

  const socket = `orpheus-verify-host-${process.pid}`
  assertSafeSocketName(socket)

  const cleanup = async (): Promise<void> => {
    const socketPath = await tmuxSocketPath(socket)
    try {
      await tmux(socket, ['kill-server'])
    } catch {
      // Already gone / never started — fine.
    }
    await rm(socketPath, { force: true }).catch(() => {})
  }

  try {
    // -------------------------------------------------------------------
    // BUG 1 — rename produces a session name that still resolves to the
    // same workspace, and does NOT leave a duplicate/orphaned session
    // under the old name.
    // -------------------------------------------------------------------
    {
      const workspaceId = 'workspace-rename-test-1234'
      const oldName = 'My Feature'
      const newName = 'My Renamed Feature'
      const oldSessionName = tmuxSessionName(oldName, workspaceId)
      const newSessionName = tmuxSessionName(newName, workspaceId)
      assert.notEqual(oldSessionName, newSessionName, 'test fixture must actually rename the slug')

      await tmux(socket, ['new-session', '-d', '-s', oldSessionName, '--', 'sleep', '60'])

      await renameHostedSession(
        { workspaceId, oldWorkspaceName: oldName, newWorkspaceName: newName },
        socket
      )

      const newExists = await tmuxExitCode(socket, ['has-session', '-t', newSessionName])
      assert.equal(newExists, 0, 'the session must be reachable under the NEW computed name')

      const oldExists = await tmuxExitCode(socket, ['has-session', '-t', oldSessionName])
      assert.equal(oldExists, 1, 'the OLD name must no longer resolve to a session')

      const { stdout } = await tmux(socket, ['list-sessions', '-F', '#{session_name}'])
      const sessionCount = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean).length
      assert.equal(sessionCount, 1, 'rename must not leave a duplicate/orphaned second session')

      await tmux(socket, ['kill-session', '-t', newSessionName])
      console.log(
        '✓ renameHostedSession() renames the live session in place — new name resolves, old ' +
          'name is gone, no duplicate is left behind'
      )
    }

    // -------------------------------------------------------------------
    // BUG 1 — rename with no live session under the old name is a clean
    // no-op: does not throw, does not create a session.
    // -------------------------------------------------------------------
    {
      const workspaceId = 'workspace-rename-test-no-session'
      await renameHostedSession(
        {
          workspaceId,
          oldWorkspaceName: 'Never Hosted',
          newWorkspaceName: 'Still Never Hosted'
        },
        socket
      )
      const sessionName = tmuxSessionName('Still Never Hosted', workspaceId)
      const exists = await tmuxExitCode(socket, ['has-session', '-t', sessionName])
      assert.equal(exists, 1, 'no session must be created for a rename with nothing running')
      console.log(
        '✓ renameHostedSession() with no live session under the old name is a silent no-op'
      )
    }

    // -------------------------------------------------------------------
    // BUG 2 — unhostWorkspace() (the archive-teardown primitive) actually
    // kills a live session.
    // -------------------------------------------------------------------
    {
      const workspaceId = 'workspace-archive-test-5678'
      const workspaceName = 'Archive Me'
      const sessionName = tmuxSessionName(workspaceName, workspaceId)
      await tmux(socket, ['new-session', '-d', '-s', sessionName, '--', 'sleep', '60'])

      const result = await unhostWorkspace({ workspaceId, workspaceName }, socket)
      assert.equal(result.killed, true)

      const exists = await tmuxExitCode(socket, ['has-session', '-t', sessionName])
      assert.equal(exists, 1, 'the session must actually be gone after unhostWorkspace()')
      console.log('✓ unhostWorkspace() (archive teardown) kills a live tmux session')
    }

    // -------------------------------------------------------------------
    // BUG 2 — unhostWorkspace() with no session is a no-op: reports
    // { killed: false } rather than throwing, so archiving a workspace
    // that was never tmux-hosted (the overwhelmingly common case) can
    // never fail the archive.
    // -------------------------------------------------------------------
    {
      const result = await unhostWorkspace(
        { workspaceId: 'workspace-never-hosted', workspaceName: 'Never Hosted' },
        socket
      )
      assert.equal(result.killed, false)
      console.log('✓ unhostWorkspace() with no session reports { killed: false }, does not throw')
    }

    // -------------------------------------------------------------------
    // BUG 2 — a tmux failure (simulated: tmux binary unreachable via an
    // emptied PATH) must not propagate out of the archive-teardown call in
    // an unrecoverable shape — unhostWorkspace() surfaces it as a typed
    // TmuxNotAvailableError specifically so callers (performArchive in
    // index.ts, mainAdapter.ts's store.remove port) can catch that ONE
    // type and swallow it, exactly as both of those call sites do. This
    // proves the contract they rely on: the thrown value is always
    // TmuxNotAvailableError, never an opaque/unrecognizable error that a
    // narrow catch could miss.
    // -------------------------------------------------------------------
    {
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        await assert.rejects(
          () =>
            unhostWorkspace(
              { workspaceId: 'workspace-no-tmux-binary', workspaceName: 'No Tmux' },
              socket
            ),
          (err: unknown) => err instanceof TmuxNotAvailableError,
          'unhostWorkspace() must reject with TmuxNotAvailableError when the tmux binary is unreachable'
        )
      } finally {
        process.env.PATH = originalPath
      }
      console.log(
        '✓ unhostWorkspace() surfaces a missing tmux binary as a typed TmuxNotAvailableError ' +
          '(the exact type performArchive/store.remove catch and swallow)'
      )
    }
  } finally {
    await cleanup()
  }
}

runRealTmuxChecks()
  .then(() => {
    console.log('\nAll tmux-host verifications passed.')
  })
  .catch((err: unknown) => {
    console.error(err)
    // process.exit(), not just process.exitCode — see
    // verify-tmux-integration.ts's identical comment: a lingering handle
    // could otherwise let the event loop live long enough for something
    // else to override the exit code.
    process.exit(1)
  })
