// ---------------------------------------------------------------------------
// scripts/verify-tmux-host-composition.ts
//
// CALL-SITE regression guard for tmuxHost.ts's hostWorkspace(). Fixes a real
// bug found on the user's live dev DB: hostWorkspace() composed the tmux
// session's launch via claudeSettings.ts's composeClaudeLaunch (reading the
// pre-cutover claude_global_settings columns) while the native mount path
// (orpheusSurfaceAdapter.ts's composeLaunchForMount, called from
// terminal:mount in index.ts) composed via the harness registry
// (composeClaudeHarnessLaunch, reading harness_settings) — see fcb579cc /
// 1d214b05 for the emitter cutover this call site had been missed by. Since
// tmux hosting is the DEFAULT launch path (native hosting only happens when
// tmux is missing/too old), this meant most users' `claude` process ran
// with STALE settings the UI no longer showed as current, with no dirty-chip
// signal (recomputeDirty also compares against composeClaudeLaunch).
//
// WHY scripts/verify-harness-launch-parity.ts CANNOT CATCH THIS. That gate
// compares the two EMITTERS against each other on matched synthetic
// fixtures — it never calls hostWorkspace() or anything in tmuxHost.ts, so a
// bug in WHICH emitter a call site reaches is invisible to it by
// construction. Two emitters agreeing perfectly in isolation says nothing
// about which one a given caller actually invokes. This harness instead
// calls the REAL exported hostWorkspace() end-to-end (real tmux session,
// real DB-backed settings composition, real harness registry resolution)
// and inspects what actually reached the spawned tmux session's argv — the
// call site, not the emitter.
//
// THE ASSERTION: seed harness_settings and claude_global_settings with
// DELIBERATELY DIFFERENT --permission-mode values for the same workspace,
// call hostWorkspace() for real, and assert the flags that reached
// `tmux new-session`'s env carry the harness_settings value, not the
// claude_global_settings one. A version of this assertion that passes
// before the tmuxHost.ts fix (calling composeClaudeLaunch directly) is not
// testing the right thing — see the fix's own report for the literal
// reverted-diff failure message this assertion produces under mutation.
//
// WHY NOT INSPECT `tmux show-environment` AFTER hostWorkspace() RETURNS —
// scrubSecretEnvironment() (tmuxHost.ts) intentionally unsets every
// non-allowlisted key (including ORPHEUS_CLAUDE_FLAGS/ORPHEUS_HARNESS_FLAGS)
// from the session's STORED environment table immediately after creation,
// so a post-return `show-environment` read would race the scrub and prove
// nothing reliable. Instead this harness intercepts execFile('tmux', ...)
// at the exact `new-session` call — recording its full argv (including the
// `-e KEY=VALUE` pairs envArgs() emits) — then transparently forwards the
// call to the REAL node:child_process implementation so hostWorkspace()
// still drives a genuine tmux server end-to-end (has-session,
// waitForSessionServerReady, scrubSecretEnvironment, applyManagedSessionOptions,
// ensureTuiSession all run for real against a real throwaway socket). Only
// the `new-session` argv capture is synthetic; nothing about tmux itself is
// faked, and no tmux protocol response is simulated.
//
// `command` (buildMountEnv's resolved orpheus-claude.sh path) is left
// untouched — the spawned session execs the real dev-layout wrapper script.
// That script would go on to actually invoke `claude`, which this harness
// does not want; the throwaway session is killed immediately after the
// argv capture, before the wrapper gets far enough to matter, and runs
// under a process-unique socket name so it can never collide with a real
// hosted workspace.
//
// RUNTIME — plain `node --experimental-strip-types`, NOT `bun run`. Same
// constraint as verify-harness-launch-parity.ts / verify-workspace-harness-
// create.ts: better-sqlite3 hard-crashes Bun 1.3.10, node:sqlite has no bun
// equivalent, and hostWorkspace()'s own module doc comment documents that
// its composeLaunchForMount/buildMountEnv call chain transitively imports
// Electron's `app` and getDb()'s better-sqlite3 binding, both of which need
// the same register()-hook short-circuit (electron, ./db, ../db) the sibling
// harnesses use, PLUS node:child_process here (to intercept execFile for the
// new-session argv capture only — every other execFile call passes through
// untouched to the real implementation).
//
// THE BODY RUNS INSIDE async function main(), NOT AT TOP LEVEL. A bare
// top-level `await` in THIS file collided with orpheusSurfaceAdapter.ts's
// (entirely ordinary, Vite-bundled-in-production) use of `__dirname`:
// Node's per-file CJS/ESM auto-detector, when it sees top-level await
// ANYWHERE in the graph before it parses a file using `__dirname`, throws
// ERR_AMBIGUOUS_MODULE_SYNTAX for that file even though the file is
// otherwise unambiguous ESM (import/export throughout) — verified by a
// minimal two-file repro. Wrapping this file's own await calls inside an
// async function removes that graph-wide signal; globalThis.__dirname below
// then satisfies orpheusSurfaceAdapter.ts's read directly (Node ESM has no
// built-in __dirname, unlike CJS).
//
// SKIPPED, NOT FAILED, WHEN TMUX ISN'T ON PATH — mirrors
// scripts/verify-tmux-host.ts's own gate; this harness needs a real tmux
// server to prove hostWorkspace()'s full call chain works end-to-end. CI
// installs tmux explicitly before running the tmux harnesses (see ci.yml
// and CLAUDE.md's own note on this) — do not remove that step.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { register } from 'node:module'
import { execFile as realExecFile } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(realExecFile)

/** Mirrors verify-tmux-integration.ts's own tmuxSocketPath() exactly (see
 *  that file's doc comment) — asks tmux itself for the real socket FILE
 *  path via `display-message`, rather than recomputing tmux's resolution
 *  rule (which differs from Node's os.tmpdir() on macOS: tmux hardcodes
 *  /tmp, not $TMPDIR). MUST be called while the server is still alive. */
async function tmuxSocketPath(socket: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('tmux', [
      '-L',
      socket,
      'display-message',
      '-p',
      '#{socket_path}'
    ])
    const queried = stdout.trim()
    if (queried !== '') return queried
  } catch {
    // Server already gone — fall through to the literal fallback below.
  }
  const tmpDir = process.env.TMUX_TMPDIR ?? `/tmp/tmux-${process.getuid?.() ?? 0}`
  return nodePath.join(tmpDir, socket)
}

class Database extends DatabaseSync {}

function hasTmux(): Promise<boolean> {
  return new Promise((resolve) => {
    realExecFile('tmux', ['-V'], (error) => resolve(error == null))
  })
}

async function main(): Promise<void> {
  if (!(await hasTmux())) {
    console.log('⚠ tmux not on PATH — skipping verify-tmux-host-composition.ts (not a failure)')
    return
  }

  // Captured argv of the `new-session` call hostWorkspace() issues,
  // populated by the execFile interceptor registered below. Set on
  // globalThis since the hook's inline module is a separate synthetic
  // module and cannot close over this file's local scope directly.
  ;(
    globalThis as unknown as { __TMUX_COMPOSITION_CAPTURE__: string[][] }
  ).__TMUX_COMPOSITION_CAPTURE__ = []

  // appMode.ts references the bare identifier __ORPHEUS_MODE__ — normally a
  // Vite build-time `define` (electron.vite.config.ts) substituted at bundle
  // time, absent under plain node. An unqualified identifier reference at
  // module scope resolves against the global object, so setting it here
  // satisfies appMode.ts without needing a bundler. 'development' matches
  // this repo's only supported local build variant (dev), keeping isDev/
  // isWorktreeBuild/isNightly's derived values what a real dev run would see.
  ;(globalThis as unknown as { __ORPHEUS_MODE__: string }).__ORPHEUS_MODE__ = 'development'

  // See the file header: orpheusSurfaceAdapter.ts uses __dirname (ordinary
  // under Vite/Electron's CJS-interop main-process bundle), which Node ESM
  // does not provide natively. buildMountEnv resolves the dev-layout wrapper
  // path as join(__dirname, '../../resources', wrapperScript) — i.e. it
  // expects __dirname to be src/main/ (two levels above the repo root's
  // resources/ dir), exactly where orpheusSurfaceAdapter.ts itself lives.
  // Pointing this at THIS script's own directory (scripts/, one level up
  // from the repo root, not two) resolved to a nonexistent sibling path
  // (…/worktrees/resources/orpheus-claude.sh instead of …/worktrees/
  // <this-worktree>/resources/orpheus-claude.sh) — found by tracing why the
  // spawned session's `bash -c "exec -l '<path>'"` exited immediately
  // (exit 127, unresolvable path) and killed the only session in it,
  // surfacing several tmux calls later as "no server running" on the next
  // real tmux call (applyManagedSessionOptions), a classic misdirected-
  // failure symptom. The composed env/flags this harness actually asserts
  // on are unaffected either way (buildMountEnv resolves `command` and
  // `env` independently) — this fixes hostWorkspace() being able to run to
  // completion at all, not the assertion under test.
  ;(globalThis as unknown as { __dirname: string }).__dirname = fileURLToPath(
    new URL('../src/main/', import.meta.url)
  )

  // process.resourcesPath only exists inside a packaged/running Electron
  // process (Contents/Resources); buildMountEnv/orpheusNotify.ts read it
  // unconditionally (join(process.resourcesPath, 'bin')) even on the
  // app.isPackaged === false branch. A real, process-unique tmp dir stands
  // in for it — nothing under it needs to actually exist, since this
  // harness never executes the resolved command, only inspects the composed
  // env that names it.
  ;(process as unknown as { resourcesPath: string }).resourcesPath = mkdtempSync(
    join(tmpdir(), 'orpheus-tmux-composition-resources-')
  )

  const dbStubSource = `
export function getDb() {
  if (!globalThis.__TMUX_COMPOSITION_TEST_DB__) {
    throw new Error('verify-tmux-host-composition: no test DB set')
  }
  return globalThis.__TMUX_COMPOSITION_TEST_DB__
}
`

  // hostWorkspace()'s composeLaunchForMount/buildMountEnv call chain pulls
  // in a wide slice of src/main (orpheusNotify.ts, ghosttyConfig.ts, etc.),
  // each of which imports its own handful of electron named exports at
  // module load time — even though hostWorkspace() itself never touches
  // most of them. Rather than chase one MODULE_NOT_FOUND-style export error
  // at a time, this stub covers every named export any src/main/*.ts file
  // imports from 'electron' (audited via a repo-wide grep), each a harmless
  // no-op/stub. Only app.getPath('userData')/app.isPackaged are
  // functionally real — they back writeGhosttyConfigFile's actual
  // fs.writeFileSync call, which needs a real writable directory to succeed
  // rather than throw.
  const electronStubSource = `
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const userDataDir = mkdtempSync(join(tmpdir(), 'orpheus-tmux-composition-'))
export const app = {
  isPackaged: false,
  getPath: (name) => name === 'userData' ? userDataDir : tmpdir(),
  getAllWindows: () => [],
  on: () => {},
  once: () => {},
  whenReady: () => Promise.resolve()
}
export const BrowserWindow = class {
  static getAllWindows() { return [] }
  static fromWebContents() { return null }
}
export const Menu = { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) }
export const Notification = class {
  static isSupported() { return false }
  show() {}
  on() {}
}
export const clipboard = { writeText: () => {}, readText: () => '' }
export const dialog = {
  showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  showMessageBox: () => Promise.resolve({ response: 0 })
}
export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} }
export const nativeImage = { createFromPath: () => ({}), createFromDataURL: () => ({}) }
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) }
export const shell = {
  openExternal: () => Promise.resolve(),
  openPath: () => Promise.resolve(''),
  showItemInFolder: () => {}
}
export const powerSaveBlocker = { start: () => 0, stop: () => {}, isStarted: () => false }
`

  // Passthrough execFile: records the argv of the 'new-session' tmux call,
  // forwards EVERY call (including this one) unmodified to the real
  // node:child_process implementation. No tmux protocol is simulated — only
  // observed. Reaches the REAL implementation via node:module's
  // createRequire (CJS require bypasses this file's own ESM resolve hook,
  // which otherwise intercepts every 'node:child_process' specifier in the
  // graph — including this stub module's own import of it — and recurses
  // into itself infinitely).
  const childProcessStubSource = `
import { createRequire } from 'node:module'
// createRequire needs a real file URL/path — this module's own
// import.meta.url (a data: URL) doesn't qualify, so it borrows the outer
// script's instead; any real absolute path on disk works equally well here.
const realExecFile = createRequire(${JSON.stringify(import.meta.url)})('node:child_process').execFile
export function execFile(...args) {
  const argvList = args[1]
  // hostWorkspace() issues TWO 'new-session' calls: the primary session
  // (carrying the composed launch env via -e KEY=VALUE pairs) and
  // ensureTuiSession()'s grouped '-tui' sibling (new-session -d -A -s
  // <tui> -t <primary>, no -e at all — a grouped session shares the
  // primary's env/window rather than getting its own). Only the '-e'-
  // carrying call is the one this harness composes/inspects launch env
  // from, so the TUI companion call is filtered out here rather than
  // captured and disambiguated later.
  if (Array.isArray(argvList) && argvList.includes('new-session') && argvList.includes('-e')) {
    globalThis.__TMUX_COMPOSITION_CAPTURE__.push([...argvList])
  }
  return realExecFile(...args)
}
`

  const hooks = `
const dbStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(dbStubSource))}
const electronStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(electronStubSource))}
const childProcessStubUrl = ${JSON.stringify('data:text/javascript,' + encodeURIComponent(childProcessStubSource))}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: electronStubUrl, shortCircuit: true }
  }
  if (specifier === './db' || specifier === '../db') {
    return { url: dbStubUrl, shortCircuit: true }
  }
  // Only tmuxHost.ts's own top-level 'node:child_process' import is meant to
  // be intercepted (it is the only caller whose execFile invocations this
  // harness needs to observe). Node's resolve hook has no per-importer
  // scoping, so this intercepts EVERY 'node:child_process' import in the
  // whole graph — harmless, since the stub forwards every call through to
  // the real implementation (reached via createRequire, not a nested ESM
  // import, so the stub's own load never re-enters this hook) unchanged;
  // only 'new-session' calls are also recorded.
  if (specifier === 'node:child_process') {
    return { url: childProcessStubUrl, shortCircuit: true }
  }
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    if (
      err &&
      err.code === 'ERR_MODULE_NOT_FOUND' &&
      specifier.startsWith('.') &&
      !specifier.endsWith('.ts')
    ) {
      return await nextResolve(specifier + '.ts', context)
    }
    throw err
  }
}
`

  register(`data:text/javascript,${encodeURIComponent(hooks)}`)

  const { renderCreateTable } = await import('../src/main/db/render.ts')
  const { schema } = await import('../src/main/db/schema.ts')
  const { setHarnessSettings } = await import('../src/main/harness/settings.ts')
  const { hostWorkspace, tmuxSessionName, tmuxTuiSessionName } =
    await import('../src/main/tmuxHost.ts')

  const PROJECT_ID = 'proj-tmux-composition'
  const WORKSPACE_ID = 'ws-tmux-composition'
  const WORKSPACE_NAME = 'tmux-composition'
  const CWD = process.cwd()
  // Process-unique so a stray leftover from a prior/parallel run (or a real
  // hosted workspace) can never collide with this throwaway socket.
  const SOCKET_NAME = `orpheus-verify-composition-${process.pid}`

  function createFreshDb(): InstanceType<typeof Database> {
    const db = new Database(':memory:')
    for (const table of [
      'projects',
      'claude_global_settings',
      'claude_project_settings',
      'claude_workspace_settings',
      'workspaces',
      'harness_settings',
      // app_ui_state carries FK columns to these two (Panes v2 last-panel/
      // last-layout persistence) — node:sqlite's DatabaseSync enforces FKs
      // at insert time even though getAppUiState's self-heal INSERT never
      // sets them, so both must exist for that self-heal INSERT to succeed.
      'pane_panels',
      'pane_layouts',
      'app_ui_state'
    ]) {
      db.exec(renderCreateTable(table, schema[table]))
    }
    db.exec(
      `CREATE UNIQUE INDEX idx_harness_settings_key ON harness_settings (harness_id, scope, scope_id)`
    )
    db.exec(`INSERT INTO claude_global_settings (id, updated_at) VALUES (1, 0)`)
    db.prepare(`INSERT INTO projects (id, path, name, added_at) VALUES (?, ?, ?, 0)`).run(
      PROJECT_ID,
      CWD,
      'tmux composition'
    )
    db.prepare(
      `INSERT INTO workspaces (id, project_id, name, cwd, created_at, status, name_is_auto, harness_id)
       VALUES (?, ?, ?, ?, 0, 'idle', 1, 'claude')`
    ).run(WORKSPACE_ID, PROJECT_ID, WORKSPACE_NAME, CWD)
    ;(
      globalThis as unknown as { __TMUX_COMPOSITION_TEST_DB__: unknown }
    ).__TMUX_COMPOSITION_TEST_DB__ = db
    return db
  }

  const db = createFreshDb()

  // -----------------------------------------------------------------------
  // THE DIVERGENCE FIXTURE — deliberately different --permission-mode
  // values in the two storages for the SAME workspace, exactly reproducing
  // what was found on the user's real dev DB (harness_settings:
  // acceptEdits, claude_global_settings: bypassPermissions).
  // -----------------------------------------------------------------------

  setHarnessSettings('claude', 'global', undefined, {
    curated: { model: 'sonnet' },
    args: [{ key: '--permission-mode', value: 'acceptEdits', enabled: true }]
  })

  db.prepare(`UPDATE claude_global_settings SET model = ?, permission_mode = ? WHERE id = 1`).run(
    'sonnet',
    'bypassPermissions'
  )

  try {
    const result = await hostWorkspace(
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID, workspaceName: WORKSPACE_NAME, cwd: CWD },
      undefined,
      SOCKET_NAME
    )
    assert.equal(result.created, true, 'sanity: hostWorkspace must actually create a new session')
    assert.equal(result.sessionName, tmuxSessionName(WORKSPACE_NAME, WORKSPACE_ID))
    assert.equal(result.tuiSessionName, tmuxTuiSessionName(WORKSPACE_NAME, WORKSPACE_ID))

    const capture = (globalThis as unknown as { __TMUX_COMPOSITION_CAPTURE__: string[][] })
      .__TMUX_COMPOSITION_CAPTURE__
    assert.equal(capture.length, 1, 'hostWorkspace must issue exactly one new-session call')
    const argv = capture[0]!

    // envArgs() emits repeated -e KEY=VALUE pairs; find the flags value.
    const flagsArg = argv.find(
      (token, i) => argv[i - 1] === '-e' && /^ORPHEUS_(CLAUDE|HARNESS)_FLAGS=/.test(token)
    )
    assert.ok(
      flagsArg,
      'the new-session argv must carry an ORPHEUS_CLAUDE_FLAGS/ORPHEUS_HARNESS_FLAGS -e pair'
    )
    const flagsValue = flagsArg!.slice(flagsArg!.indexOf('=') + 1)

    assert.ok(
      flagsValue.includes('--permission-mode') && flagsValue.includes('acceptEdits'),
      `THE BUG: composed flags must reflect harness_settings ('acceptEdits'), got: ${flagsValue}`
    )
    assert.ok(
      !flagsValue.includes('bypassPermissions'),
      `THE BUG: composed flags must NOT reflect the stale claude_global_settings value ('bypassPermissions'), got: ${flagsValue}`
    )

    console.log(
      '✓ hostWorkspace() composes the tmux session launch from harness_settings (acceptEdits), not the stale claude_global_settings column (bypassPermissions)'
    )
  } finally {
    // Best-effort teardown of the real throwaway tmux server this harness
    // spun up — never touches any other socket. Mirrors
    // verify-tmux-integration.ts's own cleanup() exactly: capture the
    // socket FILE path (by asking tmux itself, via tmuxSocketPath — must
    // happen before kill-server, while the server can still answer) then
    // kill-server AND unlink the file, since kill-server tears down the
    // server process but does not reliably remove the socket file itself
    // (see that file's own tmuxSocketPath doc comment for why a recomputed
    // path is wrong on macOS) — without this, every run of this harness
    // left a stray file under $TMUX_TMPDIR/tmux-<uid>/, confirmed while
    // developing this harness.
    const socketPath = await tmuxSocketPath(SOCKET_NAME)
    await new Promise<void>((resolve) => {
      realExecFile('tmux', ['-L', SOCKET_NAME, 'kill-server'], () => resolve())
    })
    await rm(socketPath, { force: true }).catch(() => {})
  }

  console.log('\ntmux host composition (call-site) verification passed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
