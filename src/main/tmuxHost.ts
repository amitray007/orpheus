// ---------------------------------------------------------------------------
// src/main/tmuxHost.ts
//
// Owns tmux session lifecycle for EVERY workspace (desktop app AND the TUI —
// see docs/TUI_SPEC.md D1, rewritten from "two disjoint hosts" to universal
// tmux hosting). A workspace hosted here runs `claude` inside a detached
// tmux session that survives the SSH/Tailscale link dropping, the desktop
// app closing, or a phone attaching/detaching. The desktop app's native
// libghostty surface no longer runs `claude` directly for a NEW mount — it
// runs `tmux attach-session` (resources/orpheus-attach.sh) against the same
// session the TUI would attach to. See resolveMountStrategy() below for the
// create-vs-attach decision the terminal:mount handler (index.ts) drives off
// of, and buildTmuxAttachEnv() for what the desktop surface actually execs.
//
// STAGED ROLLOUT, NOT A LIVE MIGRATION: an already-running native surface
// (mounted before this change, or mounted this session and still alive) is
// left completely alone — re-parenting a running `claude` into tmux would
// mean killing and `--resume`ing it, dropping in-flight turns/scrollback.
// Conversion to tmux-hosted happens naturally on that workspace's NEXT
// mount from a cold surface (app relaunch, or workspace closed+reopened),
// because the native addon's own re-attach path ignores `opts.command` for
// an already-live entry (packages/ghostty-surface/addon.mm) — nothing here
// needs to detect "is this the first mount since restart" itself.
//
// ELECTRON-IMPORT DISCIPLINE (load-bearing for testability)
// -----------------------------------------------------------------------
// scripts/verify-tmux-host.ts must run on plain Linux via `bun run`, with NO
// Electron runtime present — and even a *present but not fully installed*
// local `electron` package (no downloaded binary, as in a fresh/sandboxed
// checkout) throws unconditionally from its own top-level module code the
// instant anything `require`s/imports it (`Electron failed to install
// correctly`), regardless of named vs. namespace import style. So this file
// must never cause 'electron' to be evaluated at module-LOAD time — only a
// genuine runtime call may touch it:
//   1. resolveTmuxSocketName() is the only place this file touches Electron.
//      It defers the require behind `createRequire(__filename)` (node:module)
//      INSIDE the function body, so 'electron' is only resolved if/when this
//      function actually runs (never at import time, and never from the
//      verify script, which only calls the pure helpers below). This is
//      deliberately NOT a literal `require('electron')` call (that would
//      also trip `@typescript-eslint/no-require-imports`) — see
//      loadElectronApp()'s own comment.
//   2. composeClaudeLaunch/buildMountEnv (claudeSettings.ts /
//      orpheusSurfaceAdapter.ts) transitively import `electron` too (via
//      workspaces.ts). hostWorkspace() pulls them in with a dynamic
//      `import()` INSIDE the function body (mirrors the TUI's own D4 lazy-
//      require pattern for Ink) so their module graph is only evaluated on
//      an actual call, never at import time.
// The pure helpers (tmuxSocketNameForAppName, tmuxSessionName,
// shouldBlockNativeMount, shouldRetainInTmuxEnvironment, buildTreeFrame) have
// zero Electron/DB dependency and are safe to import + call directly from
// the verify script.
// ---------------------------------------------------------------------------

import { execFile } from 'node:child_process'
import * as nodePath from 'node:path'
import { createRequire } from 'node:module'
import type {
  ProjectRecord,
  WorkspaceRecord,
  WorkspaceHostResult,
  WorkspaceUnhostResult,
  TreeWorkspaceFrame,
  TreeProjectFrame,
  TreeFrame,
  ClaudeEffort
} from '../shared/types'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the `tmux` binary cannot be found on PATH (ENOENT on spawn). */
export class TmuxNotAvailableError extends Error {
  constructor() {
    super('tmux is not installed (or not on PATH) — tmux hosting is unavailable')
    this.name = 'TmuxNotAvailableError'
  }
}

/** Thrown when `tmux -V` parses but reports a version below MINIMUM_TMUX_VERSION.
 *  Deliberately distinct from TmuxNotAvailableError so the fallback notice can
 *  tell the user to upgrade rather than install (see resolveMountStrategy()). */
export class TmuxVersionTooOldError extends Error {
  readonly found: TmuxVersion
  constructor(found: TmuxVersion) {
    super(
      `tmux ${MINIMUM_TMUX_VERSION.major}.${MINIMUM_TMUX_VERSION.minor}+ required ` +
        `(found ${formatTmuxVersion(found)}) — upgrade with \`brew upgrade tmux\``
    )
    this.name = 'TmuxVersionTooOldError'
    this.found = found
  }
}

// ---------------------------------------------------------------------------
// Socket-name resolution (environment separation — load-bearing: dev/prod/
// worktree/nightly must never see each other's tmux sessions)
// ---------------------------------------------------------------------------

const KNOWN_APP_NAME_SOCKETS: Readonly<Record<string, string>> = Object.freeze({
  Orpheus: 'orpheus',
  'Orpheus Dev': 'orpheus-dev',
  'Orpheus WT': 'orpheus-wt',
  'Orpheus Nightly': 'orpheus-nightly'
})

/** Lowercase, ASCII-only, dash-collapsed slug shared by the socket-name
 *  fallback and session-name derivation below. Never returns a leading or
 *  trailing dash, and strips `.`/`:` (and everything else non-alphanumeric)
 *  since tmux treats both as target-string separators. */
function slugifyAscii(input: string, maxLength: number): string {
  const collapsed = input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-+/u, '')
    .replace(/-+$/u, '')
  return collapsed.slice(0, maxLength).replace(/-+$/u, '')
}

/**
 * Pure mapping from an Electron app display name (`app.getPath('userData')`'s
 * basename) to its tmux socket name (`tmux -L <name>`). Exported standalone
 * so it's unit-testable without Electron — see scripts/verify-tmux-host.ts.
 * An unrecognized app name (e.g. a renamed bundle) falls back to a
 * deterministic slug of the name itself rather than throwing, so hosting
 * still works (in its own, still-isolated, socket) for an unexpected variant.
 */
export function tmuxSocketNameForAppName(appName: string): string {
  const known = KNOWN_APP_NAME_SOCKETS[appName]
  if (known != null) return known
  const slug = slugifyAscii(appName, 32)
  return slug.length > 0 ? slug : 'orpheus'
}

/**
 * Deferred, indirect access to Electron's `app` — see the module doc comment.
 * `createRequire(__filename)('electron')` is NOT a literal `require(...)`
 * call (the identifier is `nodeRequire`, not `require`), so it doesn't trip
 * `@typescript-eslint/no-require-imports`; more importantly, nothing here
 * runs until resolveTmuxSocketName() is actually called, so importing this
 * module never evaluates 'electron'.
 */
function loadElectronApp(): { getPath(name: string): string } {
  const nodeRequire = createRequire(__filename)
  return (nodeRequire('electron') as typeof import('electron')).app
}

/** Electron-dependent wrapper: derives the socket name from the CURRENT
 *  app's userData directory basename, exactly mirroring how the data dir
 *  itself already separates dev/prod/wt/nightly (see appMode.ts APP_NAME /
 *  packages/orpheus-cli/src/paths.ts resolveAppName). */
export function resolveTmuxSocketName(): string {
  const userDataDir = loadElectronApp().getPath('userData')
  return tmuxSocketNameForAppName(nodePath.basename(userDataDir))
}

// ---------------------------------------------------------------------------
// Session naming
// ---------------------------------------------------------------------------

const SESSION_SLUG_MAX_LENGTH = 24
const SESSION_ID_SUFFIX_LENGTH = 8

/**
 * `<workspace-slug>-<first 8 chars of workspace id>` — readable in a bare
 * `tmux ls`, legal as a tmux target (slug strips `.`/`:`, tmux's own target
 * separators), and collision-free in practice: two workspaces sharing a name
 * still get distinct session names because their ids differ. Pure + exported
 * for scripts/verify-tmux-host.ts.
 */
export function tmuxSessionName(workspaceName: string, workspaceId: string): string {
  const slug = slugifyAscii(workspaceName, SESSION_SLUG_MAX_LENGTH)
  const safeSlug = slug.length > 0 ? slug : 'workspace'
  const idSuffix = workspaceId.slice(0, SESSION_ID_SUFFIX_LENGTH)
  return `${safeSlug}-${idSuffix}`
}

/**
 * The TUI's grouped-session name for a workspace.
 *
 * WHY A SECOND SESSION EXISTS AT ALL: the desktop and the TUI attach to the
 * same terminal, but only the TUI needs the `^\ Back` footer — on the
 * desktop that status row is a stolen line, since the app's own UI already
 * provides navigation. tmux has NO per-client options (`set-option -c` does
 * not exist) and `status` accepts only on/off, never a format, so the row
 * height cannot be varied per client on one session. Session GROUPS can:
 * grouped sessions share windows and panes but keep independent session
 * options, so the primary runs `status off` and this one runs `status on`
 * over the identical pane. Verified live with both clients attached — same
 * window id, same pane id, different status.
 *
 * The `-tui` suffix cannot collide with a real workspace session: those are
 * always `<slug>-<8 hex chars>` (see tmuxSessionName above).
 */
export function tmuxTuiSessionName(workspaceName: string, workspaceId: string): string {
  return `${tmuxSessionName(workspaceName, workspaceId)}-tui`
}

// ---------------------------------------------------------------------------
// tmux version gate
//
// `new-session -e` (per-flag env injection — hostWorkspace uses it below)
// works from tmux >=2.1, but `set-option ... window-size latest` (also used
// in hostWorkspace, for the "most-recently-active client sets the pane size"
// behavior a desktop+phone attach needs) requires >=3.1 — that is the
// binding constraint, so 3.1 is MINIMUM_TMUX_VERSION. Below it, `new-session`
// itself doesn't fail (the -e flags are accepted), but the later
// `set-option window-size latest` call does, surfacing as a cryptic argv
// parse error deep inside hostWorkspace() rather than a clear upfront
// message — this gate exists so the caller (resolveMountStrategy) can catch
// it BEFORE attempting to host anything and fall back to native hosting with
// an explicit "upgrade tmux" notice instead.
// ---------------------------------------------------------------------------

export const MINIMUM_TMUX_VERSION: TmuxVersion = Object.freeze({ major: 3, minor: 1, suffix: '' })

export type TmuxVersion = { major: number; minor: number; suffix: string }

function formatTmuxVersion(v: TmuxVersion): string {
  return `${v.major}.${v.minor}${v.suffix}`
}

/**
 * Parses `tmux -V` output (e.g. `"tmux 3.2a"`, `"tmux 3.1"`, `"tmux next-3.4"`).
 * Pure — exported standalone for scripts/verify-tmux-host.ts. Returns null for
 * anything that doesn't contain a `<major>.<minor>` pair (including the rare
 * `tmux next-X.Y` development-snapshot format, which we deliberately do not
 * special-case: treating an unparseable version as "insufficient" and falling
 * back to native hosting is the safe default, never a crash).
 */
export function parseTmuxVersion(raw: string): TmuxVersion | null {
  const match = /(\d+)\.(\d+)([a-z]*)/u.exec(raw)
  if (match == null) return null
  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  if (Number.isNaN(major) || Number.isNaN(minor)) return null
  return { major, minor, suffix: match[3] ?? '' }
}

/** Pure comparison — exported standalone for scripts/verify-tmux-host.ts.
 *  A version letter suffix (e.g. `3.2a` vs `3.2`) never affects sufficiency;
 *  only major/minor are compared. */
export function isTmuxVersionSufficient(
  found: TmuxVersion,
  minimum: TmuxVersion = MINIMUM_TMUX_VERSION
): boolean {
  if (found.major !== minimum.major) return found.major > minimum.major
  return found.minor >= minimum.minor
}

// One-shot-per-process cache: the tmux binary on PATH cannot change version
// mid-run of the app, so there is no staleness concern (unlike the
// short-TTL hosted-sessions cache below, which reflects genuinely mutable
// state). Cleared only by resetTmuxVersionCacheForTests() below.
let tmuxVersionCache: Promise<TmuxVersion> | null = null

/**
 * Env for every `tmux` spawn — the USER's PATH, not Electron's.
 *
 * A Finder-launched Electron app starts with a stripped PATH that does not
 * include Homebrew's bin dir, so `execFile('tmux', ...)` failed with ENOENT
 * and surfaced as "tmux is not installed" to a user who has tmux installed
 * and on their own PATH. It appeared INTERMITTENT because a terminal-launched
 * build inherits the right PATH and works fine — only the normal,
 * double-clicked launch broke.
 *
 * Same fix, and same reasoning, as github.ts's resolveGhPathEnv() for `gh`.
 *
 * shellHelpers is loaded through createRequire, NOT a static import: it pulls
 * in `electron`, and a static import would break this module's Electron-free
 * guarantee (scripts/verify-tmux-host.ts imports it under plain `bun` with no
 * Electron runtime, and caught exactly that). Same deferral the file header
 * documents for its own Electron access. If the helper is unavailable — which
 * is the harness's case — we fall back to the inherited PATH, i.e. the old
 * behaviour.
 */
function tmuxSpawnEnv(): NodeJS.ProcessEnv {
  let shellPath: string | null = null
  try {
    const helpers = createRequire(__filename)('./shellHelpers') as {
      getCachedShellPath?: () => string | null
    }
    shellPath = helpers.getCachedShellPath?.() ?? null
  } catch {
    shellPath = null
  }
  const basePath = shellPath != null && shellPath !== '' ? shellPath : (process.env['PATH'] ?? '')

  // Belt-and-braces for the cold-mount case: callers are expected to prime
  // the shell-path cache before probing (index.ts does), but if one does not,
  // an unprimed cache would leave us on Electron's stripped PATH and report a
  // perfectly-installed tmux as missing. Appending the common package-manager
  // bin dirs costs nothing when they are already present (PATH lookup stops
  // at the first hit) and turns that failure into a success. These are the
  // standard Homebrew prefixes for Apple Silicon and Intel plus MacPorts —
  // NOT a guess at where the user put things, and never a replacement for
  // their real PATH, only a suffix.
  // Opt-out so a caller can genuinely simulate "tmux is not installed" —
  // without it, appending real bin dirs makes that state unreachable and
  // scripts/verify-tmux-host.ts cannot test the TmuxNotAvailableError path
  // that archive/teardown depends on catching (it caught exactly that).
  if (process.env['ORPHEUS_TMUX_NO_PATH_FALLBACK'] === '1') {
    return { ...process.env, PATH: basePath }
  }

  const FALLBACK_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']
  const seen = new Set(basePath.split(':').filter(Boolean))
  const merged = [...seen, ...FALLBACK_BIN_DIRS.filter((dir) => !seen.has(dir))].join(':')

  return { ...process.env, PATH: merged }
}

async function queryTmuxVersion(): Promise<TmuxVersion> {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-V'], { env: tmuxSpawnEnv() }, (error, stdout) => {
      if (error != null) {
        const code = (error as NodeJS.ErrnoException).code
        reject(code === 'ENOENT' ? new TmuxNotAvailableError() : error)
        return
      }
      const parsed = parseTmuxVersion(stdout)
      if (parsed == null) {
        reject(new Error(`could not parse tmux -V output: ${stdout.trim()}`))
        return
      }
      resolve(parsed)
    })
  })
}

/**
 * Ensures the installed tmux is new enough BEFORE the first real tmux
 * operation in a mount attempt. Throws TmuxNotAvailableError (binary
 * missing) or TmuxVersionTooOldError (parses but too old) or a generic
 * Error (unparseable -V output) — all three are caught identically by
 * resolveMountStrategy() and route to the native-hosting fallback, so the
 * only thing that varies is the notice text the user sees.
 */
export async function ensureTmuxVersion(): Promise<TmuxVersion> {
  tmuxVersionCache ??= queryTmuxVersion().catch((err: unknown) => {
    tmuxVersionCache = null // don't cache a rejection — a transient spawn failure shouldn't stick forever
    throw err
  })
  let version: TmuxVersion
  try {
    version = await tmuxVersionCache
  } catch (err) {
    lastKnownTmuxAvailable = false
    throw err
  }
  if (!isTmuxVersionSufficient(version)) {
    lastKnownTmuxAvailable = false
    throw new TmuxVersionTooOldError(version)
  }
  lastKnownTmuxAvailable = true
  return version
}

/** Test-only: scripts/verify-tmux-host.ts calls this between cases that
 *  simulate different tmux binaries via PATH manipulation. */
export function resetTmuxVersionCacheForTests(): void {
  tmuxVersionCache = null
  lastKnownTmuxAvailable = null
}

// ---------------------------------------------------------------------------
// Effective hosting-policy accessor (Gap 2 fix — staged rollout must
// actually surface a "Restart to enable remote access" chip for existing
// native workspaces, not just convert silently on the next app relaunch).
//
// recomputeDirty() (src/main/ipc/claudeSettings.ts) runs SYNCHRONOUSLY,
// fired-and-forgotten after every settings-mutation IPC handler — making it
// async would mean touching every one of its ~6 call sites across
// claudeSettings.ts/claudeAuth.ts for a policy that (today) never actually
// needs a fresh probe: tmux availability is resolved once per app run by
// ensureTmuxVersion() (whichever mount/host call happens first) and cannot
// change mid-run without a tmux (re)install, which this app has no live
// signal for anyway. So the dirty-recompute path reads the LAST-KNOWN
// result of that one-shot check synchronously here, rather than either (a)
// going async itself or (b) re-shelling `tmux -V` on every settings change.
// Before ANY mount/host call has run in this app session, this returns
// 'unknown' — recomputeDirty() treats 'unknown' as "don't flag hosting-mode
// drift yet" (see effectiveHostingModeFor below) rather than guessing, since
// guessing wrong in either direction is worse than a brief window where the
// chip doesn't fire for a workspace that hasn't even been mounted this run.
// ---------------------------------------------------------------------------

let lastKnownTmuxAvailable: boolean | null = null

/** 'tmux' | 'native' | 'unknown' — see the section doc comment above for why
 *  this is sync and what 'unknown' means. Exported for
 *  scripts/verify-tmux-host.ts and for claudeSettings.ts's recomputeDirty(). */
export function currentEffectiveHostingPolicy(): 'tmux' | 'native' | 'unknown' {
  if (lastKnownTmuxAvailable === null) return 'unknown'
  return lastKnownTmuxAvailable ? 'tmux' : 'native'
}

// ---------------------------------------------------------------------------
// tmux process plumbing — argv arrays only, never a shell string (env values
// carry arbitrary user text and secrets).
// ---------------------------------------------------------------------------

type TmuxRunResult = { stdout: string; stderr: string }

function runTmux(socketName: string, args: string[]): Promise<TmuxRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'tmux',
      ['-L', socketName, ...args],
      { maxBuffer: 4 * 1024 * 1024, env: tmuxSpawnEnv() },
      (error, stdout, stderr) => {
        if (error == null) {
          resolve({ stdout, stderr })
          return
        }
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT') {
          reject(new TmuxNotAvailableError())
          return
        }
        // Deliberately do not include stdout/stderr in the rejected Error's
        // message here — callers that want the raw text read `stderr` off
        // the resolved/caught result themselves (see hostWorkspace's
        // duplicate-session recovery); this keeps a bare `console.error` of
        // the thrown error from ever echoing tmux's own text unfiltered.
        reject(Object.assign(new Error(`tmux ${args[0] ?? ''} failed`), { stderr }))
      }
    )
  })
}

/** True once `tmux has-session` succeeds; false for "no such session" AND for
 *  "no server running at all" (tmux exits 1 identically for both — see
 *  docs/TUI_SPEC.md and the empirical check in scripts/verify-tmux-host.ts). */
async function hasSession(socketName: string, sessionName: string): Promise<boolean> {
  try {
    await runTmux(socketName, ['has-session', '-t', sessionName])
    return true
  } catch (err) {
    if (err instanceof TmuxNotAvailableError) throw err
    return false
  }
}

/**
 * BUG FIX (real-world race discovered during manual verification, not
 * theoretical): `tmux new-session -d` can return success BEFORE the tmux
 * SERVER has finished daemonizing on a brand-new socket — the very next
 * `execFile('tmux', ['-L', socket, ...])` call (scrubSecretEnvironment or
 * applyManagedSessionOptions, both of which run immediately after
 * new-session in hostWorkspace()) can then fail with "no server running on
 * <socket>", even though has-session would report the session as live a few
 * milliseconds later. scrubSecretEnvironment's per-key calls already
 * swallow this silently (best-effort by design — see its own doc comment),
 * which is exactly why this race went unnoticed until
 * applyManagedSessionOptions's non-swallowed errors surfaced it loudly in
 * manual testing (mouse/history-limit/set-titles/window-size never got
 * applied, and the whole terminal:mount call failed).
 *
 * Fix: poll has-session with a short bounded backoff RIGHT AFTER
 * `new-session -d` returns, before anything else touches the session. Once
 * has-session succeeds the server is provably up and every subsequent call
 * is safe. Total budget is small (five attempts, exponential-ish delay
 * capped at 100ms, ~250ms worst case) — this is a startup race, not a slow
 * operation, so it either resolves almost instantly or something is
 * actually wrong (in which case the caller's own error handling takes over
 * on the next real tmux call).
 */
async function waitForSessionServerReady(socketName: string, sessionName: string): Promise<void> {
  const delaysMs = [10, 20, 40, 80, 100]
  for (const delayMs of delaysMs) {
    if (await hasSession(socketName, sessionName)) return
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  // Give it one last shot without swallowing — if the server genuinely never
  // came up, the caller's next real tmux call will surface a proper error
  // rather than this helper silently pretending everything is fine.
}

/** Flatten an env map into repeated `-e KEY=VALUE` argv pairs. The tmux
 *  SERVER is a long-lived daemon — sessions created later inherit the
 *  server's own environment, not the spawning client's — so every var MUST
 *  travel through `-e` or ORPHEUS_CLAUDE_FLAGS/ORPHEUS_WORKSPACE_ID/auth env
 *  silently vanish for a session hosted against an already-running server. */
function envArgs(env: Readonly<Record<string, string>>): string[] {
  const args: string[] = []
  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`)
  }
  return args
}

/**
 * Names that MUST remain in the tmux session's stored environment table so a
 * future window/pane opened in the SAME session still behaves correctly.
 * Deliberately tiny — everything else gets scrubbed (see
 * shouldRetainInTmuxEnvironment below). Each entry is non-secret by
 * construction (a path, a variant tag, or an id — never a token/key/secret):
 *   - ORPHEUS_WORKSPACE_ID — load-bearing for the `orpheus` CLI's spawn
 *     guardrails/self-action checks (orpheusSurfaceAdapter.ts); a new pane
 *     without it would misattribute every `orpheus` invocation.
 *   - ORPHEUS_BIN_DIR / ORPHEUS_USER_PATH — PATH-prepend plumbing so
 *     `orpheus`/the user's own tools still resolve in a future pane.
 *   - ORPHEUS_DATA_VARIANT — tells the CLI which data dir (dev/wt/nightly/
 *     prod) to target; wrong/missing data in a future pane would point the
 *     CLI at a different Orpheus install's DB.
 *   - PATH / TERM — standard shell environment, not Orpheus-specific and
 *     never secret; tmux itself expects TERM to survive.
 */
const TMUX_ENV_RETAIN_ALLOWLIST: ReadonlySet<string> = new Set([
  'ORPHEUS_WORKSPACE_ID',
  'ORPHEUS_BIN_DIR',
  'ORPHEUS_USER_PATH',
  'ORPHEUS_DATA_VARIANT',
  'PATH',
  'TERM'
])

/**
 * ALLOWLIST, not a blocklist. A name-pattern blocklist (e.g. logRedaction.ts's
 * `isSensitiveLogKey`, which is exactly right for its own job — a miss there
 * just makes a log line noisier) is the wrong shape here: a miss means a
 * credential sits readable in `tmux show-environment` for the session's
 * entire life. `isSensitiveLogKey` was verified to miss real-world secret
 * env vars that don't happen to match its name patterns (e.g.
 * `GOOGLE_APPLICATION_CREDENTIALS` — "credential**s**", plural, not
 * "credential") and, more fundamentally, it can never account for a user's
 * own arbitrary `customEnvVars` (composeClaudeLaunch merges those in last —
 * see claudeSettings.ts — so a key literally named anything, e.g.
 * `MY_COMPANY_CREDS`, reaches `-e` with no name pattern to catch it).
 * Exported standalone (pure) for scripts/verify-tmux-host.ts.
 */
export function shouldRetainInTmuxEnvironment(key: string): boolean {
  return TMUX_ENV_RETAIN_ALLOWLIST.has(key)
}

/**
 * `tmux show-environment` leaks any `-e`-supplied value for the life of the
 * session (verified empirically — see scripts/verify-tmux-integration.ts),
 * which is a real regression against the libghostty path (launch env dies
 * with the surface there). Scrub every key EXCEPT the small operational
 * allowlist above, immediately after the session is created — the already-
 * spawned `claude` process keeps its own copy (env is captured at exec
 * time), so scrubbing the session's stored table cannot break the running
 * process; it only prevents a FUTURE window/pane in this session from
 * inheriting a credential it never needed.
 */
async function scrubSecretEnvironment(
  socketName: string,
  sessionName: string,
  env: Readonly<Record<string, string>>
): Promise<void> {
  const keysToScrub = Object.keys(env).filter((key) => !shouldRetainInTmuxEnvironment(key))
  await Promise.all(
    keysToScrub.map((key) =>
      runTmux(socketName, ['set-environment', '-t', sessionName, '-u', key]).catch(() => {
        // Best-effort: a key tmux never actually stored (or a benign race)
        // must not fail the whole host operation over a scrub no-op.
      })
    )
  )
}

// ---------------------------------------------------------------------------
// listHostedSessions — used by both the tree frame and the terminal:mount
// native-mount guard (D1).
// ---------------------------------------------------------------------------

export async function listHostedSessions(): Promise<Set<string>> {
  const socketName = resolveTmuxSocketName()
  try {
    const { stdout } = await runTmux(socketName, ['list-sessions', '-F', '#{session_name}'])
    return new Set(
      stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    )
  } catch (err) {
    if (err instanceof TmuxNotAvailableError) throw err
    // "no server running on <socket>" — nothing hosted, not an error.
    return new Set()
  }
}

// Short-TTL cache for the terminal:mount hot path (D1 guard): a fresh
// `tmux list-sessions` round-trip on EVERY mount would be wasteful, but the
// guard still needs a bounded staleness window rather than never refreshing.
// Invalidated immediately on any hostWorkspace/unhostWorkspace call so the
// guard reflects a just-hosted/just-killed session without waiting out the TTL.
const HOSTED_SESSIONS_CACHE_TTL_MS = 1500
let hostedSessionsCache: { expiresAt: number; sessions: Set<string> } | null = null

export async function listHostedSessionsCached(): Promise<Set<string>> {
  const now = Date.now()
  if (hostedSessionsCache != null && hostedSessionsCache.expiresAt > now) {
    return hostedSessionsCache.sessions
  }
  const sessions = await listHostedSessions()
  hostedSessionsCache = { expiresAt: now + HOSTED_SESSIONS_CACHE_TTL_MS, sessions }
  return sessions
}

function invalidateHostedSessionsCache(): void {
  hostedSessionsCache = null
}

/**
 * REPURPOSED (docs/TUI_SPEC.md D1 was rewritten from "two disjoint hosts,
 * first-opener wins" to universal tmux hosting). This predicate's SHAPE is
 * unchanged — "does a tmux session already exist under this workspace's
 * session name" — but its ROLE at the call site is now different:
 *
 *   OLD: true → refuse to mount at all, return a placeholder to the renderer.
 *   NEW: true → double-launch safety net / informational input only. The
 *        mount path (resolveMountStrategy + terminal:mount in index.ts)
 *        NEVER calls a raw `tmux new-session` itself — it always goes
 *        through hostWorkspace(), which is already idempotent (has-session
 *        check → reuse-or-create, with duplicate-session race recovery
 *        baked in — see isDuplicateSessionError below). This predicate is
 *        used only to decide (a) whether the routed-model health gate
 *        should run (skip it on a known-attach — see terminal:mount) and
 *        (b) whether a launch snapshot already tracked in-memory should be
 *        trusted as-is vs re-seeded (see the snapshot-handling comment in
 *        index.ts's terminal:mount). Still exported standalone so the
 *        decision logic is unit-testable without tmux/Electron involved —
 *        see scripts/verify-tmux-host.ts.
 */
export function shouldBlockNativeMount(
  hostedSessions: ReadonlySet<string>,
  sessionName: string
): boolean {
  return hostedSessions.has(sessionName)
}

/**
 * MIRROR of shouldBlockNativeMount, protecting the OPPOSITE direction — used
 * by the `workspace.host` command-socket action (commandServer.ts) to decide
 * whether creating/attaching a tmux session for this workspace is safe. These
 * two guards are NOT redundant with each other even though they sound
 * similar:
 *   - shouldBlockNativeMount: is there a tmux session ALREADY hosting this
 *     workspace, checked from the DESKTOP before it would create one
 *     natively. Queries tmux (list-sessions).
 *   - shouldBlockTmuxHost (this function): is there a LIVE NATIVE surface
 *     or a live `claude` process for this workspace, checked from the
 *     TUI/CLI's `workspace.host` action before it would create OR attach to
 *     a tmux session. Queries the addon's in-process surface map + claude's
 *     own on-disk session registry (~/.claude/sessions/<pid>.json), PLUS
 *     (as of the universal-tmux-hosting cutover, docs/TUI_SPEC.md D1) a
 *     tmux `has-session` query the caller resolves via
 *     listHostedSessionsCached(), passed in as `tmuxSessionExists`.
 *
 * REPURPOSED (docs/TUI_SPEC.md D1 was rewritten from "two disjoint hosts,
 * first-opener wins" to universal tmux hosting). Under the OLD model, EITHER
 * signal being live was sufficient to refuse: there was no tmux session to
 * attach to, so any live native/claude process meant a fresh `--resume` here
 * would race a second writer against the same transcript. Under the NEW
 * model that reasoning only holds when NO tmux session exists yet — if the
 * workspace is already tmux-hosted (the desktop mounted it through the
 * universal-tmux path), attaching here is just a second tmux CLIENT on an
 * EXISTING session, which is exactly what tmux is for: one `claude` process,
 * multiple attached clients, no double-writer risk at all.
 *
 * So the real double-launch danger is narrower than "native or claude is
 * live" — it's "native or claude is live AND there is no tmux session to
 * attach to instead", i.e. the desktop is running claude natively with NO
 * tmux session backing it (pre-conversion, or the tmux-missing-fallback
 * case). A live tmux session always wins and allows the attach, regardless
 * of what the native-surface/claude-session signals say.
 *
 * Pure over its three inputs so the decision is unit-testable without
 * Electron/tmux/claude's session registry involved — see
 * scripts/verify-tmux-host.ts. All three signals are resolved by the caller
 * (commandServer.ts) since they require live process/Electron/tmux state
 * this file must stay free of at import time. The caller MUST fail safe
 * (treat `tmuxSessionExists` as false) when the tmux query itself fails —
 * a wrong "allow" here risks transcript corruption, a wrong "refuse" is
 * just a confusing message the user can retry.
 */
export function shouldBlockTmuxHost(
  nativeSurfaceLive: boolean,
  claudeSessionLive: boolean,
  tmuxSessionExists: boolean
): boolean {
  if (tmuxSessionExists) return false
  return nativeSurfaceLive || claudeSessionLive
}

// ---------------------------------------------------------------------------
// resolveMountStrategy — the tmux-hosted-vs-native-fallback decision for
// terminal:mount (index.ts). Pure over its inputs (no I/O of its own) so
// it's unit-testable without tmux/Electron — see scripts/verify-tmux-host.ts.
//
// Deliberately NOT an attach-vs-create decision: per the create-path
// invariant above, hostWorkspace() ALWAYS owns that (it's idempotent —
// has-session check, then reuse or create). This function only decides
// tmux-at-all vs native-fallback; index.ts inspects hostWorkspace()'s own
// `created` field afterward to know which one happened.
// ---------------------------------------------------------------------------

export type MountStrategy =
  | { kind: 'tmux' }
  | { kind: 'native-fallback'; reason: 'not-installed' | 'version-too-old'; detail: string }

/**
 * @param tmuxAvailability Pre-resolved outcome of ensureTmuxVersion() for
 *   this mount — a discriminated result rather than a thrown error so this
 *   function stays pure/sync and testable without async/await in the tests.
 */
export function resolveMountStrategy(
  tmuxAvailability:
    | { ok: true }
    | { ok: false; reason: 'not-installed' | 'version-too-old'; detail: string }
): MountStrategy {
  if (!tmuxAvailability.ok) {
    return {
      kind: 'native-fallback',
      reason: tmuxAvailability.reason,
      detail: tmuxAvailability.detail
    }
  }
  return { kind: 'tmux' }
}

// ---------------------------------------------------------------------------
// hostWorkspace / unhostWorkspace
// ---------------------------------------------------------------------------

export type HostWorkspaceParams = {
  workspaceId: string
  projectId: string | undefined
  workspaceName: string
  cwd: string
}

/** True when a `new-session` failure is just a race against another opener
 *  that won between our has-session check and this call. Exported (not just
 *  internal to hostWorkspace) so scripts/verify-tmux-host.ts's concurrent-
 *  double-launch test can assert a losing caller's rejection is THIS specific,
 *  handled race and not some other unexpected tmux failure — see that test's
 *  own doc comment for why it drives the identical has-session/new-session
 *  sequence directly (real Electron/DB dependencies inside hostWorkspace()'s
 *  own composeClaudeLaunch/buildMountEnv call chain make hostWorkspace()
 *  itself uninvokable from a plain `bun run` harness). */
export function isDuplicateSessionError(err: unknown): boolean {
  const stderr =
    err != null && typeof err === 'object' ? (err as { stderr?: unknown }).stderr : null
  return typeof stderr === 'string' && stderr.includes('duplicate session')
}

/**
 * BUG FIX (found during manual verification, not theoretical — reproduced
 * empirically): `tmux new-session ... -- <command>` does NOT execve a
 * SINGLE trailing argv token directly. tmux re-parses a lone command string
 * through a shell-like tokenizer before running it, splitting on
 * whitespace. `command` here is an ABSOLUTE PATH to orpheus-claude.sh
 * resolved from `process.resourcesPath`/`__dirname` (buildMountEnv /
 * orpheusSurfaceAdapter.ts) — and every packaged Orpheus variant except
 * production has a SPACE in its bundle name ("Orpheus Dev.app",
 * "Orpheus WT.app", "Orpheus Nightly.app"), so the resolved path itself
 * contains a space. Passed as a single token, tmux split it into two
 * "words" ("/Applications/Orpheus" and "Dev.app/Contents/.../orpheus-claude.sh"),
 * producing an immediate exit 127 ("command not found") — the tmux SERVER
 * then exits too, since a freshly-created single-session server with no
 * sessions left has nothing to keep it alive (`exit-empty` default `on`).
 * This silently killed every tmux-hosted mount on any non-production build.
 *
 * Fix: wrap the command in a MULTI-token argv exactly the way the native
 * libghostty addon already does for the identical reason (see
 * packages/ghostty-surface/addon.mm's `bash -c "exec -l '<cmd>'"` — single-
 * quoted so spaces in the bundle path survive intact through bash's own
 * parsing) — `['bash', '-c', "exec -l '<cmd>'"]` is 3 distinct argv
 * elements, so tmux execve's `bash` directly and never re-tokenizes the
 * quoted path itself. The `exec -l` matches the addon's own invocation
 * style (a login-shell exec, replacing bash's own process rather than
 * forking a child) for consistency, though tmux's own process-group
 * handling differs slightly from the native surface's — verified working
 * empirically against a real Orpheus Dev.app path containing a space.
 */
export function tmuxSessionCommandArgv(command: string): string[] {
  return ['bash', '-c', `exec -l '${command}'`]
}

/**
 * Create the tmux session for a workspace if one isn't already running.
 * Composes the launch EXACTLY the way the libghostty path does —
 * composeClaudeLaunch + buildMountEnv, see orpheusSurfaceAdapter.ts's own doc
 * comment — so the two hosts can never drift on flags/settings/auth env.
 * Both are dynamically imported (see the module doc comment above) so this
 * file stays importable outside Electron.
 *
 * HARD INVARIANT (do not add a second session-creation code path): this is
 * the ONLY place in the app that runs `tmux new-session`. It already owns
 * the has-session idempotency check, the secret-env scrub
 * (scrubSecretEnvironment), and duplicate-session race recovery
 * (isDuplicateSessionError) below — a second `new-session` call site
 * anywhere else (e.g. inlined into terminal:mount for the "create" case)
 * would silently regress the credential scrub, which is a real security
 * regression, not just duplicated code. The desktop mount path
 * (terminal:mount in index.ts) always calls this function to ensure a
 * session exists, then separately mounts the native surface running the
 * ATTACH wrapper (buildTmuxAttachEnv in orpheusSurfaceAdapter.ts) — it never
 * constructs a `new-session` argv itself.
 *
 * WHAT THE SESSION RUNS, AND WHY IT SURVIVES `claude` EXITING: `command`
 * (resolved by buildMountEnv, today always orpheus-claude.sh's path) is
 * exec'd as the session's own command — completely unchanged by universal
 * tmux hosting, which only adds a SEPARATE attach wrapper for the desktop
 * surface to reach this session, never touches what the session itself
 * runs. orpheus-claude.sh already ends with `exec zsh -i` after `claude`
 * exits (see that script, bottom) — so the underlying tmux session's
 * foreground process becomes an interactive zsh once claude exits/crashes,
 * and the SESSION ITSELF (not just the pane) stays alive. This is load
 * bearing for multi-client hosting: without it, `claude` exiting would kill
 * the whole tmux session and drop every attached client (desktop AND a
 * phone via the TUI) simultaneously, which is never desired — confirmed by
 * reading orpheus-claude.sh directly, not assumed.
 */
export async function hostWorkspace(
  params: HostWorkspaceParams,
  cmdServer?: { sockPath: string; token: string },
  /** Test-only injection seam: overrides resolveTmuxSocketName() so
   *  scripts/verify-tmux-host.ts can drive this against a throwaway socket
   *  without an Electron runtime. Real callers never pass this. */
  socketNameOverride?: string
): Promise<WorkspaceHostResult> {
  await ensureTmuxVersion() // throws TmuxNotAvailableError / TmuxVersionTooOldError — caller (resolveMountStrategy path) routes both to native fallback

  const socketName = socketNameOverride ?? resolveTmuxSocketName()
  const sessionName = tmuxSessionName(params.workspaceName, params.workspaceId)
  const tuiSessionName = tmuxTuiSessionName(params.workspaceName, params.workspaceId)

  if (await hasSession(socketName, sessionName)) {
    // Re-apply on the ALREADY-RUNNING path too, not just at creation: a
    // session created by an older build carries that build's options, and
    // nothing else ever revisits them. Without this, `status off` (and any
    // future managed option) would only reach sessions created after the
    // upgrade — an existing workspace would keep the desktop's status row
    // until it was torn down and rehosted. set-option is idempotent, so
    // re-running it on every host is free.
    await applyManagedSessionOptions(socketName, sessionName)
    await ensureTuiSession(socketName, sessionName, tuiSessionName)
    return { sessionName, tuiSessionName, socketName, created: false, alreadyRunning: true }
  }

  const [{ composeClaudeLaunch }, { buildMountEnv }] = await Promise.all([
    import('./claudeSettings'),
    import('./orpheusSurfaceAdapter')
  ])

  const launch = composeClaudeLaunch(params.projectId, params.workspaceId)
  // sockPath (notify-hook plumbing) is intentionally omitted: hooks are
  // "dormant enrichment, not the status driver" (CLAUDE.md) and the notify
  // server instance lives outside commandServer.ts's reach without a wider
  // index.ts wiring change than this feature's scope allows. cmdServer IS
  // threaded through when the caller has it (commandServer.ts knows its own
  // sockPath/token — see startCommandServer), so a tmux-hosted `orpheus`
  // invocation still gets zero-config ORPHEUS_CMD_SOCK/ORPHEUS_CMD_TOKEN.
  //
  // STATUS-PIPELINE INVARIANT: buildMountEnv resolves the SAME
  // orpheus-claude.sh wrapper the native (non-tmux) path uses, unconditionally
  // — including its `unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT
  // CLAUDE_CODE_SESSION_ID ...` block (see that script) that prevents
  // Orpheus's own Electron-launched-from-inside-a-Claude-session vars from
  // leaking down and making the hosted `claude` register as a nested/child
  // session. Since tmux's `new-session` below execs this SAME command
  // unchanged, `claude` still registers itself in
  // ~/.claude/sessions/<pid>.json exactly as it does under native hosting,
  // so sessionState.ts's file-watch-driven activity status (CLAUDE.md's
  // "Workspace activity status" section) keeps working for tmux-hosted
  // workspaces with no changes needed on that side.
  const { command, env } = buildMountEnv(
    params.workspaceId,
    params.projectId,
    undefined,
    cmdServer,
    launch
  )

  console.log(
    '[tmuxHost] new-session workspaceId=%s session=%s socket=%s envKeys=%s',
    params.workspaceId,
    sessionName,
    tuiSessionName,
    socketName,
    Object.keys(env).sort().join(',')
  )

  try {
    await runTmux(socketName, [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-c',
      params.cwd,
      ...envArgs(env),
      '--',
      ...tmuxSessionCommandArgv(command)
    ])
  } catch (err) {
    if (isDuplicateSessionError(err)) {
      invalidateHostedSessionsCache()
      await ensureTuiSession(socketName, sessionName, tuiSessionName)
      return { sessionName, tuiSessionName, socketName, created: false, alreadyRunning: true }
    }
    throw err
  }

  // See waitForSessionServerReady's own doc comment: `new-session -d` can
  // return before the tmux server has fully daemonized on a brand-new
  // socket, which made the very next tmux call race a "no server running"
  // error (found during manual verification). This closes that race before
  // anything else touches the session.
  await waitForSessionServerReady(socketName, sessionName)

  // Secret scrub MUST run before anything else touches the new session so no
  // window exists where `tmux show-environment` can leak a credential longer
  // than necessary; the cosmetic/behavioral options below are not security
  // sensitive, so their exact ordering relative to each other doesn't matter.
  await scrubSecretEnvironment(socketName, sessionName, env)
  await applyManagedSessionOptions(socketName, sessionName)
  await ensureTuiSession(socketName, sessionName, tuiSessionName)

  invalidateHostedSessionsCache()
  return { sessionName, tuiSessionName, socketName, created: true, alreadyRunning: false }
}

// ---------------------------------------------------------------------------
// Managed per-session tmux options — applied via `set-option -t <session>`,
// scoped to the SESSION Orpheus just created, never written to the user's own
// ~/.tmux.conf and never applied server-wide. This is deliberately the
// "scoped set-option calls" approach rather than a managed conf file passed
// via `-f`: every option needed here (window-size, mouse, history-limit,
// set-titles) has a session-scoped `-t` form, so a conf file would add a
// second place these live (a file on disk PLUS these calls) for zero benefit
// — if a future option genuinely has no session-scoped form, that's the
// trigger to introduce a managed conf file, not before.
// ---------------------------------------------------------------------------

/** Exported (not just internal to hostWorkspace) so scripts/verify-tmux-host.ts
 *  can exercise the exact same set-option sequence against a throwaway
 *  socket/session without needing Electron — this function has zero
 *  Electron dependency of its own (plain tmux argv calls only). */
export async function applyManagedSessionOptions(
  socketName: string,
  sessionName: string
): Promise<void> {
  // window-size latest: the most-recently-active ATTACHED client sets the
  // pane size — needed for a session two clients (desktop + a phone via the
  // TUI) can both attach to. KNOWN TRADE-OFF (flagged explicitly, not just in
  // this comment — see the PR report): this means ANY client attaching,
  // including a phone over Tailscale, resizes the shared session and will
  // visibly resize the desktop user's terminal out from under them mid-use.
  // This is inherent to tmux's shared-session model in its simple/default
  // form; per-client independent sizing is a further exploration, not
  // required for this change.
  //
  // mouse on: ghostty's own scrollback/selection no longer applies once a
  // pane is tmux-hosted (scrollback becomes tmux's, not ghostty's — the one
  // documented daily-UX regression for desktop users moving to tmux
  // hosting); `mouse on` keeps scroll-to-scroll-back and click-drag
  // selection working THROUGH tmux rather than forcing a modifier-key
  // passthrough workflow.
  //
  // history-limit 50000: tmux's default (2000) is small next to what
  // ghostty's own native scrollback typically offers; 50000 lines is a
  // generous replacement, applied per-session (not server-wide) so it never
  // touches a session this app didn't create.
  //
  // set-titles on: tmux's OWN title-forwarding mechanism (distinct from
  // `allow-passthrough`, which tunnels arbitrary escape sequences like
  // sixel/images and is unrelated to title propagation — NOT needed here).
  // `set-titles on` makes tmux forward the active pane's reported title to
  // the OUTER terminal (ghostty's surface, whose setTitleCallback drives the
  // workspace title bar) via its own OSC title-set sequence. Available since
  // tmux's earliest versions (well below MINIMUM_TMUX_VERSION), so no
  // version conditional is needed. tmux's compiled-in default is already
  // `on`, but this is set explicitly rather than relied upon implicitly —
  // this session's title propagation must not depend on whatever the user's
  // OWN ~/.tmux.conf (which Orpheus never reads or writes) might set.
  //
  // set-titles-string "#{pane_title}": what set-titles ABOVE actually
  // forwards. tmux's compiled-in default format is
  // `"#S:#I:#W - \"#T\" #{session_alerts}"` — session name, window index,
  // window name, then the pane title in quotes, then any alert flags. Left
  // at that default, the forwarded OSC title is noisy session/window
  // bookkeeping wrapped around the actual title (e.g.
  // `wsname-abc123:0:sleep - "✳ Claude Code"` instead of the clean
  // `✳ Claude Code` claude itself sets via its own OSC sequence) — verified
  // empirically against a real tmux server. `#{pane_title}` alone forwards
  // exactly what the foreground process (claude) last set, matching what the
  // native (non-tmux) path already shows, so a workspace's title bar reads
  // identically whether it's tmux-hosted or not.
  // ORPHEUS FOOTER — replaces tmux's own status bar (see the format strings
  // below). Purpose: a workspace attached from the TUI had NO visible way
  // back. The only exit was tmux's `prefix d`, which is undocumented in this
  // UI and unreliable here anyway — Claude Code running in the pane can
  // swallow the prefix. `C-\` is bound below as a direct, prefix-free
  // detach, and the footer's whole job is to advertise it.
  //
  // WHY `C-\` AND NOT SOMETHING MORE OBVIOUS: tested live against a real
  // Claude Code session. `C-g` opens its external editor, `C-o` toggles the
  // transcript view, and `C-_` moved its effort indicator — all three are
  // taken. `C-\` did nothing, leaving the prompt untouched. Anything bound
  // here becomes unavailable to whatever runs inside the pane, so this was
  // measured rather than assumed.
  const options: [string, string][] = [
    ['window-size', 'latest'],
    ['mouse', 'on'],
    ['history-limit', '50000'],
    ['set-titles', 'on'],
    ['set-titles-string', '#{pane_title}'],
    // Status bar OFF on the PRIMARY session — this is the one the desktop
    // attaches to, where the app's own UI already provides navigation and a
    // status row is a stolen line. The TUI attaches to a GROUPED sibling
    // session (tmuxTuiSessionName) which turns it back on; see
    // applyManagedTuiSessionOptions below.
    ['status', 'off']
  ]
  for (const [key, value] of options) {
    await runTmux(socketName, ['set-option', '-t', sessionName, key, value])
  }

  // Prefix-free detach: `C-\` returns straight to the picker. `-n` binds it
  // in the ROOT table (no prefix), which is the whole point — an escape that
  // depends on a prefix the inner app might eat is not an escape.
  await runTmux(socketName, ['bind-key', '-n', 'C-\\', 'detach-client'])
}

/**
 * Options for the TUI's GROUPED session — the footer, and only the footer.
 *
 * Session options do NOT propagate across a session group (verified: one
 * group ran `status off` and `status on` simultaneously), which is exactly
 * why the group exists. Anything session-scoped that both clients need must
 * be set on both; `window-size`/`history-limit` are window- or server-scoped
 * and are already covered by the primary's pass.
 */
/**
 * Create (or adopt) the TUI's grouped session and apply its footer options.
 *
 * `new-session -d -A -s <tui> -t <primary>` is attach-or-create: it adopts an
 * existing session of that name rather than erroring, so repeated hosts and
 * repeated TUI attaches are both safe. The primary MUST already exist —
 * grouping against a missing target errors — which is why every caller runs
 * this after the primary is up.
 *
 * Failure here is deliberately non-fatal: the TUI can still attach to the
 * primary and work, just without the footer. Hosting a workspace must not
 * fail because a cosmetic status bar could not be set up.
 */
async function ensureTuiSession(
  socketName: string,
  sessionName: string,
  tuiSessionName: string
): Promise<void> {
  try {
    await runTmux(socketName, ['new-session', '-d', '-A', '-s', tuiSessionName, '-t', sessionName])
    await applyManagedTuiSessionOptions(socketName, tuiSessionName)
  } catch (err) {
    if (err instanceof TmuxNotAvailableError) throw err
    console.warn(
      '[tmuxHost] could not set up TUI session %s (footer unavailable, attach still works): %s',
      tuiSessionName,
      err instanceof Error ? err.message : String(err)
    )
  }
}

export async function applyManagedTuiSessionOptions(
  socketName: string,
  tuiSessionName: string
): Promise<void> {
  const options: [string, string][] = [
    ['status', 'on'],
    ['status-style', 'bg=default,fg=colour245'],
    // Nothing on this bar refreshes, so never poll: `status-interval 0`
    // avoids a shell subprocess on a timer for every attached client, which
    // matters on a phone over Tailscale.
    ['status-interval', '0'],
    // #{=-N:...} truncates from the LEFT, keeping the title's tail — the
    // distinguishing words are usually at the end, and the fixed exit hint
    // must never be pushed off screen. The budget follows the client's own
    // width, so it adapts as the client resizes.
    [
      'status-format[0]',
      ' #[fg=colour44]\u258c#[fg=colour252] ' +
        '#{=-#{e|-|:#{client_width},18}:#{pane_title}}' +
        '#[align=right]#[fg=colour108]^\\#[fg=colour245] Back '
    ],
    // Session options, NOT inherited from the primary — set here too.
    ['mouse', 'on'],
    ['set-titles', 'on'],
    ['set-titles-string', '#{pane_title}'],
    // Blank tmux's own window list; the bar is only the two things above.
    ['window-status-format', ''],
    ['window-status-current-format', '']
  ]
  for (const [key, value] of options) {
    await runTmux(socketName, ['set-option', '-t', tuiSessionName, key, value])
  }
}

export async function unhostWorkspace(
  params: {
    workspaceId: string
    workspaceName: string
  },
  /** Test-only injection seam: overrides resolveTmuxSocketName() so
   *  scripts/verify-tmux-host.ts can drive this against a throwaway socket
   *  without an Electron runtime. Real callers never pass this. */
  socketNameOverride?: string
): Promise<WorkspaceUnhostResult> {
  const socketName = socketNameOverride ?? resolveTmuxSocketName()
  const sessionName = tmuxSessionName(params.workspaceName, params.workspaceId)
  const tuiSessionName = tmuxTuiSessionName(params.workspaceName, params.workspaceId)

  // Kill the TUI's grouped session FIRST, and tolerate its absence — it only
  // exists once a TUI has attached at least once.
  //
  // This is not optional tidying. A grouped session holds the shared window
  // open on its own: killing ONLY the primary leaves the sibling alive with
  // the pane's `claude` process still running (verified — the pane pid
  // survived the primary's kill). Archiving a workspace would then strand
  // real work in a session nothing ever looks for again.
  try {
    await runTmux(socketName, ['kill-session', '-t', tuiSessionName])
  } catch (err) {
    if (err instanceof TmuxNotAvailableError) throw err
    // No TUI session for this workspace — expected, not an error.
  }

  try {
    await runTmux(socketName, ['kill-session', '-t', sessionName])
    invalidateHostedSessionsCache()
    return { killed: true }
  } catch (err) {
    if (err instanceof TmuxNotAvailableError) throw err
    // Primary already gone. If the TUI kill above DID land we still changed
    // state, but `killed` reports on the primary, matching this function's
    // existing contract.
    invalidateHostedSessionsCache()
    return { killed: false }
  }
}

/**
 * BUG FIX (workspace rename orphaning its tmux session): tmuxSessionName()
 * is derived from `<workspace-slug>-<id suffix>`, so renaming a workspace
 * changes the session name a future hasSession()/hostWorkspace() lookup
 * computes — while the ALREADY-RUNNING tmux session keeps its OLD name. The
 * next hostWorkspace() call for this workspace would then find no session
 * under the new name and spawn a SECOND `claude` process, orphaning the
 * first one forever (a permanent leak, since nothing ever looks for a
 * session under the old name again).
 *
 * Fix chosen: (a) `tmux rename-session` the running session in place,
 * keyed by the OLD name the caller must supply (mainAdapter.ts's rename
 * port reads the workspace's name before calling the DB rename, so the old
 * name is available there). This preserves the documented "readable in a
 * bare `tmux ls`" design intent (docs/TUI_SPEC.md's "Session naming"
 * section) and needs no migration/dual-lookup for sessions created under
 * the old scheme, unlike keying purely by workspace id.
 *
 * MUST be resilient: a workspace rename is a DB operation that must succeed
 * regardless of tmux state. This function is called AFTER the DB rename has
 * already committed, so any failure here — tmux not installed, no session
 * currently running for this workspace (the common case: most workspaces
 * are never tmux-hosted), a race, whatever — must never throw back into the
 * rename path. Failures are swallowed after a warning log; the caller (the
 * DB rename) has already succeeded and must stay succeeded. Only genuine
 * tmux-not-installed is distinguished from "no session to rename" in the
 * log line, so a real misconfiguration is still visible without spamming a
 * warning for the overwhelmingly common non-hosted case.
 */
export async function renameHostedSession(
  params: {
    workspaceId: string
    oldWorkspaceName: string
    newWorkspaceName: string
  },
  /** Test-only injection seam: overrides resolveTmuxSocketName() so
   *  scripts/verify-tmux-host.ts can drive this against a throwaway socket
   *  without an Electron runtime. Real callers never pass this. */
  socketNameOverride?: string
): Promise<void> {
  const oldSessionName = tmuxSessionName(params.oldWorkspaceName, params.workspaceId)
  const newSessionName = tmuxSessionName(params.newWorkspaceName, params.workspaceId)
  if (oldSessionName === newSessionName) return // no-op: slug unchanged (e.g. only casing/punctuation differs)

  let socketName: string
  try {
    socketName = socketNameOverride ?? resolveTmuxSocketName()
  } catch {
    return // Electron app handle unavailable — nothing to rename against
  }

  try {
    // Rename the TUI's grouped session too, and INDEPENDENTLY of the primary
    // — the two can exist separately, and the TUI derives its name from the
    // workspace name exactly as the primary does. Left behind under the old
    // name it would be orphaned: nothing computes that name again, so it
    // would hold the shared window open forever with no way back to it.
    const oldTui = tmuxTuiSessionName(params.oldWorkspaceName, params.workspaceId)
    const newTui = tmuxTuiSessionName(params.newWorkspaceName, params.workspaceId)
    if (await hasSession(socketName, oldTui)) {
      await runTmux(socketName, ['rename-session', '-t', oldTui, newTui])
      invalidateHostedSessionsCache()
    }

    if (!(await hasSession(socketName, oldSessionName))) {
      return // no live session under the old name — the common case, not an error
    }
    await runTmux(socketName, ['rename-session', '-t', oldSessionName, newSessionName])
    invalidateHostedSessionsCache()
  } catch (err) {
    if (err instanceof TmuxNotAvailableError) {
      return // tmux not installed — tolerate exactly like every other tmux-optional path
    }
    console.warn(
      '[tmuxHost] rename-session failed workspaceId=%s old=%s new=%s: %s',
      params.workspaceId,
      oldSessionName,
      newSessionName,
      err instanceof Error ? err.message : String(err)
    )
  }
}

// ---------------------------------------------------------------------------
// Tree frame — full snapshot for the TUI's `/subscribe` `tree` frame (see
// docs/TUI_SPEC.md D5). Pure: takes already-fetched records + an already-
// resolved hosted-session set, does no I/O itself, so it's unit-testable
// (scripts/verify-tmux-host.ts) without a DB or tmux involved.
// ---------------------------------------------------------------------------

/** A workspace record enriched with the two live-only fields the wire format
 *  carries that don't live on WorkspaceRecord itself. Callers (commandServer.ts)
 *  merge these in from getWorkspaceFileInfo/session state before calling
 *  buildTreeFrame — see that module's collectTreeSourceWorkspaces. The wire
 *  shapes themselves (TreeWorkspaceFrame/TreeProjectFrame/TreeFrame) live in
 *  src/shared/types.ts, the single source of truth for the protocol. */
export type TreeSourceWorkspace = WorkspaceRecord & {
  waitingFor?: string
  lastActivityAt?: number | null
  /** Effective (layered) model/effort for this workspace — resolved by the
   *  caller (commandServer.ts's withLiveTreeOverlay, via
   *  claudeSettings.ts's resolveEffectiveModelAndEffort) BEFORE calling
   *  buildTreeFrame, not inside this module. tmuxHost.ts must stay
   *  Electron/DB-free (see this file's own "ELECTRON-IMPORT DISCIPLINE"
   *  header) so scripts/verify-tmux-host.ts can keep running as a pure,
   *  no-Electron/no-DB harness — resolveEffectiveModelAndEffort reads the
   *  DB, so it cannot be called from toTreeWorkspaceFrame below. Optional so
   *  existing pure-function test fixtures that don't set these keep
   *  compiling; toTreeWorkspaceFrame falls back to safe defaults when absent. */
  model?: string
  effort?: ClaudeEffort
  /** The resolved model's owning provider id (`'claude'`, `'codex'`, `'xai'`,
   *  `'antigravity'`), resolved by the caller (commandServer.ts's
   *  withLiveTreeOverlay, via claudeSettings.ts's
   *  resolveEffectiveModelAndEffort) BEFORE calling buildTreeFrame — same
   *  reason as model/effort above: resolution consults the cliproxy model
   *  cache and tmuxHost.ts must stay Electron/DB-free (see this file's own
   *  "ELECTRON-IMPORT DISCIPLINE" header) so scripts/verify-tmux-host.ts
   *  keeps running as a pure harness. Unlike model/effort, undefined has no
   *  safe non-placeholder default — toTreeWorkspaceFrame passes it through
   *  as-is (never fabricates a provider). */
  providerId?: string
  /** Current git branch of `cwd`, resolved by the caller (commandServer.ts's
   *  withLiveTreeOverlay, via its synchronous getCachedCurrentBranch cache
   *  over src/main/git.ts's getCurrentBranch) BEFORE calling buildTreeFrame —
   *  same reason as model/effort above: this is an async subprocess-backed
   *  lookup and tmuxHost.ts must stay Electron/DB/subprocess-free so
   *  scripts/verify-tmux-host.ts keeps running as a pure harness. Distinct
   *  from `worktreeBranch` (WorkspaceRecord's own persisted field, which is
   *  only ever non-null for a worktree-backed workspace) — this is the
   *  cwd's actual current branch, resolved independently, populated for
   *  every git-backed workspace. Undefined/null both mean "not yet resolved
   *  or not a git repo" — toTreeWorkspaceFrame normalizes either to `null`. */
  gitBranch?: string | null
}

/** `sort_order ASC NULLS LAST, <time> DESC` — MUST match the desktop sidebar
 *  exactly (docs/TUI_SPEC.md D5; see src/main/workspaces.ts's
 *  listWorkspacesForProject/listChildWorkspaces ORDER BY clauses for the
 *  workspace-side precedent) so a desktop drag-reorder shows up in the TUI on
 *  the next frame. Generic over the record shape so the same comparator
 *  serves both projects (addedAt) and workspaces (createdAt). */
function sortBySortOrderThenTimeDesc<T>(
  items: readonly T[],
  sortOrderOf: (item: T) => number | null,
  timeOf: (item: T) => number
): T[] {
  return [...items].sort((a, b) => {
    const sa = sortOrderOf(a)
    const sb = sortOrderOf(b)
    if (sa == null && sb != null) return 1
    if (sa != null && sb == null) return -1
    if (sa != null && sb != null && sa !== sb) return sa - sb
    return timeOf(b) - timeOf(a)
  })
}

// Fallback effort when the caller hasn't resolved one (e.g. an older/stub
// TreeSourceWorkspace fixture in scripts/verify-tmux-host.ts) — 'auto' is
// the same "no override" default composeClaudeLaunch's own layering ladder
// bottoms out at, so this is a safe, meaning-preserving default, not a guess.
const DEFAULT_EFFORT: ClaudeEffort = 'auto'

function toTreeWorkspaceFrame(
  ws: TreeSourceWorkspace,
  hostedSessions: ReadonlySet<string>
): TreeWorkspaceFrame {
  const sessionName = tmuxSessionName(ws.name, ws.id)
  return {
    id: ws.id,
    name: ws.name,
    status: ws.status,
    ...(ws.waitingFor != null ? { waitingFor: ws.waitingFor } : {}),
    parentWorkspaceId: ws.parentWorkspaceId,
    worktreeBranch: ws.worktreeBranch,
    gitBranch: ws.gitBranch ?? null,
    model: ws.model ?? '',
    effort: ws.effort ?? DEFAULT_EFFORT,
    providerId: ws.providerId,
    sortOrder: ws.sortOrder,
    tmuxHosted: shouldBlockNativeMount(hostedSessions, sessionName),
    lastActivityAt: ws.lastActivityAt ?? ws.lastOpenedAt ?? null,
    lastTitle: ws.lastTitle
  }
}

function groupActiveWorkspacesByProject(
  workspaces: readonly TreeSourceWorkspace[]
): Map<string, TreeSourceWorkspace[]> {
  const byProject = new Map<string, TreeSourceWorkspace[]>()
  for (const ws of workspaces) {
    if (ws.archivedAt != null) continue // active scope only — mirrors listWorkspacesForProject's default
    const existing = byProject.get(ws.projectId)
    if (existing != null) existing.push(ws)
    else byProject.set(ws.projectId, [ws])
  }
  return byProject
}

function buildTreeProjectFrame(
  project: ProjectRecord,
  workspaces: readonly TreeSourceWorkspace[],
  hostedSessions: ReadonlySet<string>
): TreeProjectFrame {
  const orderedWorkspaces = sortBySortOrderThenTimeDesc(
    workspaces,
    (w) => w.sortOrder,
    (w) => w.createdAt
  )
  return {
    id: project.id,
    name: project.name,
    cwd: project.path,
    sortOrder: project.sortOrder,
    workspaces: orderedWorkspaces.map((ws) => toTreeWorkspaceFrame(ws, hostedSessions))
  }
}

export function buildTreeFrame(
  projects: readonly ProjectRecord[],
  workspaces: readonly TreeSourceWorkspace[],
  hostedSessions: ReadonlySet<string>,
  revision: number
): TreeFrame {
  const workspacesByProject = groupActiveWorkspacesByProject(workspaces)
  const orderedProjects = sortBySortOrderThenTimeDesc(
    projects,
    (p) => p.sortOrder,
    (p) => p.addedAt
  )

  return {
    type: 'tree',
    revision,
    projects: orderedProjects.map((project) =>
      buildTreeProjectFrame(project, workspacesByProject.get(project.id) ?? [], hostedSessions)
    )
  }
}
