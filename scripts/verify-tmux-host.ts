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
import { rm, mkdtemp, writeFile, readdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { stripTrailingSourceMappingComment } from './lib/sourceMapStrip.mjs'
import {
  tmuxSocketNameForAppName,
  tmuxSessionName,
  shouldBlockNativeMount,
  shouldBlockTmuxHost,
  shouldRetainInTmuxEnvironment,
  buildTreeFrame,
  renameHostedSession,
  unhostWorkspace,
  TmuxNotAvailableError,
  parseTmuxVersion,
  isTmuxVersionSufficient,
  resolveMountStrategy,
  MINIMUM_TMUX_VERSION,
  applyManagedSessionOptions,
  tmuxSessionCommandArgv,
  isDuplicateSessionError,
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
// shouldBlockTmuxHost — the MIRROR guard (workspace.host's pre-create/attach
// check). Full 2x2x2 truth table over (nativeSurfaceLive, claudeSessionLive,
// tmuxSessionExists) — the third input is the REGRESSION coverage: under the
// old two-disjoint-hosts model, either liveness signal alone was sufficient
// to refuse; under universal tmux hosting, an existing tmux session always
// wins and allows the attach (a second tmux CLIENT on an existing session,
// not a second `claude` writer), regardless of what the other two signals
// say. This is the exact case the owner hit: a workspace open natively AND
// already tmux-hosted (the desktop mounted it through the universal-tmux
// path) must ALLOW the TUI to attach, not refuse it.
// ---------------------------------------------------------------------------

{
  // tmuxSessionExists = false: behaves exactly like the old two-signal guard
  // — refuse if EITHER native or claude-session liveness is true.
  assert.equal(
    shouldBlockTmuxHost(false, false, false),
    false,
    'no signals live, no tmux session -> safe to host (cold create)'
  )
  assert.equal(
    shouldBlockTmuxHost(true, false, false),
    true,
    'native surface live, no tmux session -> refuse (genuine double-writer risk)'
  )
  assert.equal(
    shouldBlockTmuxHost(false, true, false),
    true,
    'claude session live, no tmux session -> refuse (genuine double-writer risk)'
  )
  assert.equal(
    shouldBlockTmuxHost(true, true, false),
    true,
    'both native and claude-session live, no tmux session -> refuse'
  )

  // tmuxSessionExists = true: a live tmux session ALWAYS short-circuits to
  // allow, no matter what the other two signals report. This is the
  // regressed case (native live + tmux session exists -> must ALLOW, not
  // refuse) plus its siblings for full coverage.
  assert.equal(
    shouldBlockTmuxHost(false, false, true),
    false,
    'no other signals live, tmux session exists -> allow (plain attach)'
  )
  assert.equal(
    shouldBlockTmuxHost(true, false, true),
    false,
    'REGRESSION CASE: native surface live but a tmux session ALREADY EXISTS for this workspace ' +
      '-> must ALLOW the attach (second tmux client on an existing session is always safe) — this ' +
      'is the exact scenario the owner hit: desktop mounted the workspace through the universal-' +
      'tmux path, then pressing Enter on it in the TUI was wrongly refused'
  )
  assert.equal(
    shouldBlockTmuxHost(false, true, true),
    false,
    'claude session live but a tmux session already exists -> allow'
  )
  assert.equal(
    shouldBlockTmuxHost(true, true, true),
    false,
    'everything live including an existing tmux session -> allow'
  )

  console.log(
    '✓ shouldBlockTmuxHost: with no tmux session, refuses if EITHER native surface or claude ' +
      'session registry reports live (the genuine double-writer risk); with a tmux session already ' +
      'existing, ALWAYS allows regardless of the other two signals — full 2x2x2 truth table, ' +
      'including the regressed native-live+tmux-exists case'
  )
}

// ---------------------------------------------------------------------------
// parseTmuxVersion / isTmuxVersionSufficient — the version-gate parse/compare
// logic. Tested at the pure layer per the brief (never by installing
// different tmux binaries).
// ---------------------------------------------------------------------------

{
  assert.deepEqual(parseTmuxVersion('tmux 3.1'), { major: 3, minor: 1, suffix: '' })
  assert.deepEqual(parseTmuxVersion('tmux 3.2a'), { major: 3, minor: 2, suffix: 'a' })
  assert.deepEqual(parseTmuxVersion('tmux 2.9'), { major: 2, minor: 9, suffix: '' })
  assert.deepEqual(parseTmuxVersion('tmux next-3.4'), { major: 3, minor: 4, suffix: '' })
  assert.equal(parseTmuxVersion('not a version string at all'), null)
  assert.equal(parseTmuxVersion(''), null)
  console.log(
    '✓ parseTmuxVersion extracts major/minor/suffix from real tmux -V formats, including the ' +
      '"next-X.Y" development-snapshot format, and returns null (never throws) on garbage'
  )
}

{
  // MINIMUM_TMUX_VERSION is 3.1 — the window-size latest floor.
  assert.equal(
    isTmuxVersionSufficient({ major: 3, minor: 1, suffix: '' }),
    true,
    'exactly at minimum'
  )
  assert.equal(
    isTmuxVersionSufficient({ major: 3, minor: 2, suffix: 'a' }),
    true,
    'above minimum, suffix ignored'
  )
  assert.equal(
    isTmuxVersionSufficient({ major: 4, minor: 0, suffix: '' }),
    true,
    'next major, always sufficient'
  )
  assert.equal(
    isTmuxVersionSufficient({ major: 3, minor: 0, suffix: '' }),
    false,
    'below minimum minor'
  )
  assert.equal(
    isTmuxVersionSufficient({ major: 2, minor: 9, suffix: '' }),
    false,
    'below minimum major'
  )
  assert.equal(
    isTmuxVersionSufficient({ major: 3, minor: 1, suffix: '' }, MINIMUM_TMUX_VERSION),
    true,
    'explicit minimum param matches the default'
  )
  console.log(
    '✓ isTmuxVersionSufficient compares major/minor only (suffix never affects sufficiency), ' +
      'exactly-at-minimum passes, one below on either major or minor fails'
  )
}

// ---------------------------------------------------------------------------
// resolveMountStrategy — the tmux-vs-native-fallback decision for
// terminal:mount. Deliberately NOT an attach-vs-create decision (that's
// hostWorkspace()'s own idempotent has-session check) — this only decides
// tmux-at-all vs native-fallback.
// ---------------------------------------------------------------------------

{
  assert.deepEqual(resolveMountStrategy({ ok: true }), { kind: 'tmux' })
  assert.deepEqual(
    resolveMountStrategy({ ok: false, reason: 'not-installed', detail: 'tmux: command not found' }),
    { kind: 'native-fallback', reason: 'not-installed', detail: 'tmux: command not found' }
  )
  assert.deepEqual(
    resolveMountStrategy({
      ok: false,
      reason: 'version-too-old',
      detail: 'tmux 3.1+ required (found 2.0)'
    }),
    { kind: 'native-fallback', reason: 'version-too-old', detail: 'tmux 3.1+ required (found 2.0)' }
  )
  console.log(
    '✓ resolveMountStrategy: available -> tmux, unavailable (either reason) -> native-fallback ' +
      'carrying the reason/detail through verbatim'
  )
}

// ---------------------------------------------------------------------------
// tmuxSessionCommandArgv — BUG FIX regression coverage. tmux new-session's
// trailing single-token command gets re-tokenized by tmux itself (splitting
// on whitespace), which silently broke every tmux-hosted mount on any
// non-production build (their bundle paths all contain a space, e.g.
// "Orpheus Dev.app"). This must always return a MULTI-element argv so tmux
// never re-tokenizes the (possibly space-containing) command path.
// ---------------------------------------------------------------------------

{
  const argv = tmuxSessionCommandArgv(
    '/Applications/Orpheus Dev.app/Contents/Resources/orpheus-claude.sh'
  )
  assert.ok(argv.length > 1, 'must be multiple argv tokens, never a single re-tokenizable string')
  assert.equal(argv[0], 'bash')
  assert.equal(argv[1], '-c')
  assert.equal(
    argv[2],
    "exec -l '/Applications/Orpheus Dev.app/Contents/Resources/orpheus-claude.sh'",
    'the space-containing path must be single-quoted intact inside the bash -c string, exactly ' +
      'mirroring packages/ghostty-surface/addon.mm\'s own "bash -c \\"exec -l \'<cmd>\'\\"" wrapping'
  )
  console.log(
    '✓ tmuxSessionCommandArgv wraps the command in a multi-token argv (bash -c "exec -l \'<cmd>\'") ' +
      'so tmux never re-tokenizes a space-containing bundle path — regression coverage for the ' +
      'exit-127/dead-server bug found in manual verification'
  )
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
    lastActivityAt: 999,
    lastTitle: 'Understand codebase structure'
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
  assert.equal(attentionOut.lastTitle, 'Understand codebase structure')

  assert.equal(idleOut.id, 'ws-idle')
  assert.equal('waitingFor' in idleOut, false, 'waitingFor must be omitted, not null, when absent')
  assert.equal(idleOut.tmuxHosted, false)
  assert.equal(idleOut.lastActivityAt, 42, 'falls back to lastOpenedAt when no live overlay is set')
  assert.equal(idleOut.lastTitle, null, 'defaults to null when the source workspace has no title')
  console.log('✓ tree-frame workspace rows carry the exact documented shape (docs/TUI_SPEC.md)')
}

// ---------------------------------------------------------------------------
// SOLE-CALL-SITE INVARIANT — static-source coverage for the HARD INVARIANT
// documented on hostWorkspace() in tmuxHost.ts ("this is the ONLY place in
// the app that runs `tmux new-session`"). That invariant currently lives ONLY
// as a doc comment — nothing actually asserts it, so a future PR could add a
// second `tmux new-session` call site (e.g. inlined into terminal:mount for
// the "create" case) and silently regress the credential scrub
// (scrubSecretEnvironment) that only runs after hostWorkspace()'s own call,
// with no test failure to catch it. This is a deliberately blunt TEXT-level
// scan (not AST parsing) over every `.ts` file under `src/` for the argv
// literal `'new-session'` (single-quoted, no backticks) — the exact shape
// hostWorkspace()'s own `runTmux(socketName, ['new-session', ...])` call
// uses. Single-quoted-string form is chosen specifically because it does NOT
// match the many backtick-wrapped prose mentions of `new-session` in
// tmuxHost.ts's own comments (see e.g. its MINIMUM_TMUX_VERSION and
// waitForSessionServerReady doc comments) — verified by hand against this
// file's actual grep output before writing the regex below, so this isn't a
// guess about what "looks like code" vs. "looks like prose". No I/O, no
// tmux — runs unconditionally, not gated behind hasTmux().
// ---------------------------------------------------------------------------

{
  const NEW_SESSION_ARGV_LITERAL = /'new-session'/u
  const srcRoot = path.join(import.meta.dir, '..', 'src')

  async function findTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true })
    const files = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return findTsFiles(full)
        return entry.isFile() && full.endsWith('.ts') ? [full] : []
      })
    )
    return files.flat()
  }

  const tsFiles = await findTsFiles(srcRoot)
  assert.ok(tsFiles.length > 100, 'sanity check: the src/ file walk must have found real files')

  const matches: { file: string; line: number }[] = []
  for (const file of tsFiles) {
    const content = await readFile(file, 'utf8')
    content.split('\n').forEach((lineText, index) => {
      if (NEW_SESSION_ARGV_LITERAL.test(lineText)) {
        matches.push({ file: path.relative(srcRoot, file), line: index + 1 })
      }
    })
  }

  assert.equal(
    matches.length,
    1,
    `expected exactly ONE 'new-session' argv literal under src/ (hostWorkspace()'s own call) — ` +
      `found ${matches.length}: ${matches.map((m) => `${m.file}:${m.line}`).join(', ')}. A count ` +
      `other than 1 means either the sole-call-site invariant has been violated by a new creation ` +
      `path, or this test's file moved/was refactored and needs updating.`
  )
  assert.equal(
    matches[0]?.file,
    path.join('main', 'tmuxHost.ts'),
    'the one new-session call site must be hostWorkspace() in src/main/tmuxHost.ts'
  )

  console.log(
    `✓ the 'new-session' argv literal appears exactly once under src/ (${matches[0]?.file}:` +
      `${matches[0]?.line}, hostWorkspace()'s own call) — a text-level regression check for the ` +
      'sole-call-site HARD INVARIANT documented on hostWorkspace()'
  )
}

// ---------------------------------------------------------------------------
// stripTrailingSourceMappingComment — pure-function coverage for the fix to
// the dangling `//# sourceMappingURL=...` comments left in vendored .js
// files after scripts/package-tui-assets.mjs prunes the referenced .map
// files. Bun's runtime source-map loader logged
// `warn: Could not decode sourcemap in '<path>': UnsupportedFormat` straight
// over the TUI's rendered output whenever it hit one of these.
// ---------------------------------------------------------------------------

{
  // Real shape observed in @opentui/core/chunk-bun-t2myhmwd.js (the exact
  // file the owner's warning named).
  const real = 'var x=1;\n//# sourceMappingURL=chunk-bun-t2myhmwd.js.map\n'
  assert.equal(stripTrailingSourceMappingComment(real), 'var x=1;\n')

  // No trailing newline after the comment (EOF right after .map) — must
  // still strip cleanly rather than leave a dangling partial line.
  const noTrailingNewline = 'var x=1;\n//# sourceMappingURL=foo.js.map'
  assert.equal(stripTrailingSourceMappingComment(noTrailingNewline), 'var x=1;\n')

  // CRLF line endings — must not be missed just because the file uses \r\n.
  const crlf = 'var x=1;\r\n//# sourceMappingURL=foo.js.map\r\n'
  assert.equal(stripTrailingSourceMappingComment(crlf), 'var x=1;\n')

  // A file with no sourceMappingURL comment at all must be returned
  // byte-for-byte unchanged — this is the "don't corrupt normal JS" check.
  const untouched = "var x=1;\nconsole.log('hello');\n"
  assert.equal(stripTrailingSourceMappingComment(untouched), untouched)

  // A sourceMappingURL-looking string that is NOT on the final line (e.g.
  // appears inside a string literal mid-file) must be left alone — this
  // function only ever touches a TRAILING comment, never scans/rewrites the
  // whole file body.
  const midFile = "var url = '//# sourceMappingURL=fake.js.map';\nconsole.log(url);\n"
  assert.equal(
    stripTrailingSourceMappingComment(midFile),
    midFile,
    'a sourceMappingURL-shaped string that is not the trailing comment must be left untouched'
  )

  console.log(
    '✓ stripTrailingSourceMappingComment removes exactly the trailing sourceMappingURL comment ' +
      '(LF or CRLF, with or without a final newline), leaves ordinary JS and mid-file lookalikes ' +
      'byte-for-byte unchanged'
  )
}

// ---------------------------------------------------------------------------
// Vendored bundle regression check — proves scripts/package-tui-assets.mjs's
// actual staged output has NO dangling sourceMappingURL references left, not
// just that the pure helper is correct in isolation. Skipped (not failed)
// when the staged tree doesn't exist yet (i.e. `build:cli:tui-otui` hasn't
// been run in this checkout) — this file must stay runnable standalone via
// `bun run scripts/verify-tmux-host.ts` without requiring a full TUI build
// first.
// ---------------------------------------------------------------------------

{
  const stagedNodeModules = path.join(
    import.meta.dir,
    '..',
    'packages',
    'orpheus-cli',
    'dist',
    'node_modules'
  )

  async function findJsFiles(dir: string): Promise<string[]> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const files = await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return findJsFiles(full)
        return entry.isFile() && full.endsWith('.js') ? [full] : []
      })
    )
    return files.flat()
  }

  const jsFiles = await findJsFiles(stagedNodeModules)
  if (jsFiles.length === 0) {
    console.log(
      'staged packages/orpheus-cli/dist/node_modules not found — skipping vendored-bundle ' +
        'sourcemap-reference check (run `bun run build:cli:tui-otui` first to exercise this; not ' +
        'a failure)'
    )
  } else {
    const offenders: string[] = []
    for (const file of jsFiles) {
      const content = await readFile(file, 'utf8')
      if (/\/\/# sourceMappingURL=/u.test(content)) {
        offenders.push(path.relative(stagedNodeModules, file))
      }
    }
    assert.equal(
      offenders.length,
      0,
      `expected ZERO staged .js files with a dangling sourceMappingURL reference — found ` +
        `${offenders.length}: ${offenders.join(', ')}. package-tui-assets.mjs's stripping step ` +
        'must strip every one, since the referenced .map files are never staged.'
    )
    console.log(
      `✓ all ${jsFiles.length} staged .js file(s) under packages/orpheus-cli/dist/node_modules ` +
        'have no dangling sourceMappingURL references'
    )
  }
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
    // applyManagedSessionOptions() — the mouse/history-limit/set-titles/
    // window-size defaults hostWorkspace() applies to every session it
    // creates. Verified against a real session on the throwaway socket via
    // `show-options`, not just "the call didn't throw".
    // -------------------------------------------------------------------
    {
      const sessionName = 'managed-options-test'
      await tmux(socket, ['new-session', '-d', '-s', sessionName, '--', 'sleep', '60'])

      await applyManagedSessionOptions(socket, sessionName)

      const showOption = async (key: string): Promise<string> => {
        const { stdout } = await tmux(socket, ['show-options', '-t', sessionName, '-v', key])
        return stdout.trim()
      }

      assert.equal(
        await showOption('mouse'),
        'on',
        'mouse must be enabled on Orpheus-created sessions'
      )
      assert.equal(
        await showOption('history-limit'),
        '50000',
        "history-limit must be raised well above tmux's small default"
      )
      assert.equal(
        await showOption('set-titles'),
        'on',
        'set-titles must be on so ghostty gets the title'
      )
      assert.equal(
        await showOption('window-size'),
        'latest',
        'window-size must be latest so the most-recently-active client sizes the shared session'
      )
      assert.equal(
        await showOption('set-titles-string'),
        '#{pane_title}',
        "set-titles-string must forward the bare pane title, not tmux's noisy default " +
          '"#S:#I:#W - \\"#T\\" #{session_alerts}" format'
      )

      await tmux(socket, ['kill-session', '-t', sessionName])
      console.log(
        '✓ applyManagedSessionOptions() sets mouse=on, history-limit=50000, set-titles=on, ' +
          'set-titles-string=#{pane_title}, window-size=latest on the session it targets — ' +
          'verified via show-options, not just a non-throwing call'
      )
    }

    // -------------------------------------------------------------------
    // set-titles-string — RESOLVED-title regression coverage. The option
    // being set to "#{pane_title}" (asserted above) does not by itself prove
    // the title tmux actually forwards is clean — the option is a FORMAT
    // STRING, and tmux's own default resolves to noisy session/window
    // bookkeeping around the real title (verified empirically:
    // `"#S:#I:#W - \"#T\" #{session_alerts}"` -> something like
    // `wsname-abc123:0:bash - "My Title" `). This test drives a REAL pane
    // that sets its own title via the same OSC escape sequence `claude`
    // itself uses, then reads back what tmux would actually forward
    // (`#{pane_title}`, the resolved value of the format string) — proving
    // the fix end-to-end, not just that the right string got stored.
    // -------------------------------------------------------------------
    {
      const sessionName = 'title-resolution-test'
      const titleText = 'Test Workspace Title'
      // bash -c so the OSC title-set sequence is actually processed by a
      // shell before the pane goes idle (a bare `sleep` never reads stdin
      // and never emits its own title, so send-keys into it would be a
      // no-op — this constructs the OSC sequence directly as the pane's
      // startup command instead of relying on send-keys timing).
      await tmux(socket, [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '--',
        'bash',
        '-c',
        `printf '\\033]0;${titleText}\\007'; sleep 60`
      ])
      await applyManagedSessionOptions(socket, sessionName)

      // Give tmux a moment to process the OSC sequence the pane just emitted.
      await new Promise((resolve) => setTimeout(resolve, 300))

      const { stdout } = await tmux(socket, [
        'display-message',
        '-t',
        sessionName,
        '-p',
        '#{pane_title}'
      ])
      assert.equal(
        stdout.trim(),
        titleText,
        'the RESOLVED forwarded title must be exactly what the pane set via OSC, with no ' +
          'session-name/window-index/alert noise wrapped around it'
      )

      await tmux(socket, ['kill-session', '-t', sessionName])
      console.log(
        '✓ set-titles-string="#{pane_title}" resolves to the clean OSC-set title with no ' +
          'session/window/alert noise — verified against a real pane that actually set a title, ' +
          'not just that the option string got stored'
      )
    }

    // -------------------------------------------------------------------
    // tmuxSessionCommandArgv — END-TO-END regression test for the exit-127
    // bug: a `new-session -- <single-token-path-with-a-space>` gets
    // re-tokenized by tmux and silently kills the server. Proves the FIX
    // (multi-token bash -c argv) actually keeps a space-containing command
    // path alive as a real tmux session, not just that the pure function
    // returns the right shape.
    // -------------------------------------------------------------------
    {
      const dirWithSpace = await mkdtemp(path.join(os.tmpdir(), 'orpheus verify space '))
      const scriptPath = path.join(dirWithSpace, 'stay-alive.sh')
      await writeFile(scriptPath, '#!/bin/sh\nsleep 30\n', { mode: 0o755 })

      const sessionName = 'space-path-regression-test'
      // The BUGGY invocation this fix replaces — passing the command as a
      // single trailing token. Asserts the bug actually reproduces (so this
      // test would have caught the regression before the fix landed).
      await tmux(socket, ['new-session', '-d', '-s', sessionName, '--', scriptPath])
      // Give tmux a moment to finish tearing the (buggy) session down.
      await new Promise((resolve) => setTimeout(resolve, 100))
      const buggyExitCode = await tmuxExitCode(socket, ['has-session', '-t', sessionName])
      assert.equal(
        buggyExitCode,
        1,
        'sanity check: the single-token invocation must actually reproduce the bug (session gone) ' +
          '— if this starts failing, tmux itself may have changed behavior and this test needs review'
      )

      // The FIXED invocation — tmuxSessionCommandArgv's multi-token argv.
      const fixedSessionName = 'space-path-regression-test-fixed'
      await tmux(socket, [
        'new-session',
        '-d',
        '-s',
        fixedSessionName,
        '--',
        ...tmuxSessionCommandArgv(scriptPath)
      ])
      const fixedExitCode = await tmuxExitCode(socket, ['has-session', '-t', fixedSessionName])
      assert.equal(
        fixedExitCode,
        0,
        'tmuxSessionCommandArgv-wrapped invocation must keep a space-containing command path alive ' +
          'as a real tmux session'
      )

      await tmux(socket, ['kill-session', '-t', fixedSessionName]).catch(() => {})
      await rm(dirWithSpace, { recursive: true, force: true })
      console.log(
        '✓ tmuxSessionCommandArgv fixes the real exit-127/dead-server bug for a space-containing ' +
          'command path — reproduced the bug with the single-token invocation AND proved the fix ' +
          'keeps the session alive, against a real tmux server'
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
    // CONCURRENT-DOUBLE-LAUNCH — hostWorkspace() is the SOLE `tmux
    // new-session` call site in the app (HARD INVARIANT in tmuxHost.ts's own
    // doc comment on hostWorkspace()); both the desktop mount path
    // (terminal:mount -> resolveTmuxForMount in index.ts) and the TUI/CLI's
    // `workspace.host` command-socket action (commandServer.ts) funnel
    // through it exclusively. A design review flagged that nothing actually
    // ASSERTS the resulting idempotency under a real race between those two
    // entry points for the SAME cold workspace — this closes that gap.
    //
    // WHY THIS DOES NOT CALL hostWorkspace() ITSELF: hostWorkspace() dynamically
    // imports composeClaudeLaunch (claudeSettings.ts) and buildMountEnv
    // (orpheusSurfaceAdapter.ts), whose module graphs transitively import
    // Electron's `app` (e.g. via orpheusNotify.ts -> workspaces.ts, and
    // claudeSettings.ts's own settings-composition path). There are actually
    // TWO independent walls here, and it's worth being precise because the
    // first one is easy to mis-measure:
    //
    //   1. better-sqlite3 under Bun. `require('better-sqlite3')` SUCCEEDS —
    //      it returns a module object without touching the native binding —
    //      so a require-only probe looks like a pass. Constructing a database
    //      is what actually throws: `new Database(':memory:')` fails with
    //      "'better-sqlite3' is not yet supported in Bun. In the meantime,
    //      you could try bun:sqlite which has a similar API." Since getDb()
    //      constructs, this is a genuine blocker — but ONLY test it by
    //      constructing, never by requiring.
    //
    //   2. Electron's `app` export, which the module graph hits FIRST (before
    //      execution ever reaches getDb()/better-sqlite3). Under Bun's module
    //      resolution, `node_modules/electron/index.js` (Electron's own
    //      bootstrap stub, which only resolves to the real `app`/
    //      `BrowserWindow`/etc. exports when actually running INSIDE the
    //      Electron runtime) fails to satisfy a named `app` import at all:
    //      `bun -e "import('./src/main/claudeSettings.ts')"` fails with
    //      "Export named 'app' not found in module '.../node_modules/
    //      electron/index.js'".
    //
    // Either wall alone is sufficient to block a direct call — this file's
    // own module doc comment (NO Electron runtime present) is the documented
    // design constraint, and stubbing around either wall would fight it. So
    // this test instead drives the EXACT has-session -> new-session ->
    // catch(isDuplicateSessionError) SEQUENCE hostWorkspace() itself runs
    // (see tmuxHost.ts, the body of hostWorkspace() between its has-session
    // check and its duplicate-session recovery catch), using the same real
    // exported primitives (tmuxSessionName, isDuplicateSessionError) against
    // a real tmux server on the same throwaway socket the rest of this
    // section already uses. This proves the SEQUENCE is race-safe under real
    // concurrency — it does NOT independently prove hostWorkspace()'s own
    // wrapping of that sequence introduces no new bug (e.g. an accidental
    // second call site, or a change to the try/catch ordering). The
    // sole-call-site static assertion above is what covers that gap: it
    // guarantees hostWorkspace() is the ONLY place this sequence runs, so a
    // test proving the sequence itself is safe transitively proves
    // hostWorkspace() is safe too, PROVIDED that assertion keeps passing.
    // Neither test subsumes the other — do not delete one thinking it's
    // redundant with the other.
    // -------------------------------------------------------------------
    {
      const workspaceId = 'workspace-concurrent-host-test-9012'
      const workspaceName = 'Concurrent Host Test'
      const sessionName = tmuxSessionName(workspaceName, workspaceId)
      const cwd = process.cwd()
      const CONCURRENT_CALLER_COUNT = 5

      /** Mirrors hostWorkspace()'s own has-session -> new-session ->
       *  duplicate-session-recovery sequence exactly (tmuxHost.ts), minus the
       *  DB/Electron-dependent launch composition — see the section comment
       *  above for why. Returns which outcome this particular caller hit, so
       *  the test can assert on the SHAPE of the race (how many created vs.
       *  how many gracefully lost) rather than just "nothing threw". */
      async function raceHostAttempt(): Promise<
        | { outcome: 'created' }
        | { outcome: 'already-running' }
        | { outcome: 'error'; error: unknown }
      > {
        try {
          const alreadyExists = await tmuxExitCode(socket, ['has-session', '-t', sessionName])
          if (alreadyExists === 0) return { outcome: 'already-running' }
          await tmux(socket, [
            'new-session',
            '-d',
            '-s',
            sessionName,
            '-c',
            cwd,
            '--',
            'sleep',
            '60'
          ])
          return { outcome: 'created' }
        } catch (err) {
          if (isDuplicateSessionError(err)) return { outcome: 'already-running' }
          return { outcome: 'error', error: err }
        }
      }

      const results = await Promise.all(
        Array.from({ length: CONCURRENT_CALLER_COUNT }, () => raceHostAttempt())
      )

      const errored = results.filter((r) => r.outcome === 'error')
      assert.equal(
        errored.length,
        0,
        `every concurrent caller must either create the session or gracefully report ` +
          `already-running via isDuplicateSessionError — got unexpected error(s): ` +
          `${errored.map((r) => (r as { error: unknown }).error).join(', ')}`
      )

      const created = results.filter((r) => r.outcome === 'created')
      assert.equal(
        created.length,
        1,
        `exactly one of ${CONCURRENT_CALLER_COUNT} concurrent callers must win the create race ` +
          `(got ${created.length}) — a count other than 1 means either two sessions were created ` +
          `or the has-session/new-session race isn't actually being exercised`
      )

      const alreadyRunning = results.filter((r) => r.outcome === 'already-running')
      assert.equal(
        alreadyRunning.length,
        CONCURRENT_CALLER_COUNT - 1,
        'every losing caller must gracefully report already-running, not silently vanish'
      )

      const { stdout } = await tmux(socket, ['list-sessions', '-F', '#{session_name}'])
      const liveSessionNames = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
      assert.equal(
        liveSessionNames.filter((n) => n === sessionName).length,
        1,
        'exactly one tmux session must exist for the workspace after the race settles — not two ' +
          'under some accidental name variation, not zero'
      )

      await tmux(socket, ['kill-session', '-t', sessionName]).catch(() => {})
      console.log(
        `✓ ${CONCURRENT_CALLER_COUNT} concurrent hostWorkspace()-style create attempts for the SAME ` +
          'cold workspace resolve to exactly one created session and ' +
          `${CONCURRENT_CALLER_COUNT - 1} graceful already-running results — none throw an ` +
          'unhandled error, proving the has-session/new-session/isDuplicateSessionError idempotency ' +
          'holds under a real concurrent race'
      )
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
