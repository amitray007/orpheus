// ---------------------------------------------------------------------------
// src/main/tmuxHost.ts
//
// Owns tmux session lifecycle for workspaces opened from the TUI (`orpheus
// tui`, see docs/TUI_SPEC.md). A workspace hosted here runs `claude` inside a
// detached tmux session that survives the SSH/Tailscale link dropping — a
// second, DISJOINT host from the desktop app's libghostty surfaces (decision
// D1: "two disjoint hosts, first-opener wins").
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
  TreeFrame
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
      { maxBuffer: 4 * 1024 * 1024 },
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

/** Pure predicate for the terminal:mount native-mount guard (D1: "two
 *  disjoint hosts, first-opener wins" — never spawn a second competing
 *  `claude` against a workspace tmux already owns). Exported standalone so
 *  the decision logic is unit-testable without tmux/Electron involved. */
export function shouldBlockNativeMount(
  hostedSessions: ReadonlySet<string>,
  sessionName: string
): boolean {
  return hostedSessions.has(sessionName)
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
 *  that won between our has-session check and this call. */
function isDuplicateSessionError(err: unknown): boolean {
  const stderr =
    err != null && typeof err === 'object' ? (err as { stderr?: unknown }).stderr : null
  return typeof stderr === 'string' && stderr.includes('duplicate session')
}

/**
 * Create the tmux session for a workspace if one isn't already running.
 * Composes the launch EXACTLY the way the libghostty path does —
 * composeClaudeLaunch + buildMountEnv, see orpheusSurfaceAdapter.ts's own doc
 * comment — so the two hosts can never drift on flags/settings/auth env.
 * Both are dynamically imported (see the module doc comment above) so this
 * file stays importable outside Electron.
 */
export async function hostWorkspace(
  params: HostWorkspaceParams,
  cmdServer?: { sockPath: string; token: string }
): Promise<WorkspaceHostResult> {
  const socketName = resolveTmuxSocketName()
  const sessionName = tmuxSessionName(params.workspaceName, params.workspaceId)

  if (await hasSession(socketName, sessionName)) {
    return { sessionName, socketName, created: false, alreadyRunning: true }
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
      command
    ])
  } catch (err) {
    if (isDuplicateSessionError(err)) {
      invalidateHostedSessionsCache()
      return { sessionName, socketName, created: false, alreadyRunning: true }
    }
    throw err
  }

  // Secret scrub MUST run before anything else touches the new session so no
  // window exists where `tmux show-environment` can leak a credential longer
  // than necessary; window-size follows since it's cosmetic, not security.
  await scrubSecretEnvironment(socketName, sessionName, env)
  await runTmux(socketName, ['set-option', '-t', sessionName, 'window-size', 'latest'])

  invalidateHostedSessionsCache()
  return { sessionName, socketName, created: true, alreadyRunning: false }
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
  try {
    await runTmux(socketName, ['kill-session', '-t', sessionName])
    invalidateHostedSessionsCache()
    return { killed: true }
  } catch (err) {
    if (err instanceof TmuxNotAvailableError) throw err
    return { killed: false } // session already gone — tolerate, mirrors D2
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
    sortOrder: ws.sortOrder,
    tmuxHosted: shouldBlockNativeMount(hostedSessions, sessionName),
    lastActivityAt: ws.lastActivityAt ?? ws.lastOpenedAt ?? null
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
