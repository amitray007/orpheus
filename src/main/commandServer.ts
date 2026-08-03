import * as http from 'node:http'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import * as crypto from 'node:crypto'
import { app } from 'electron'
import { logDiagMain } from './diagnostics'
import { DIAG_EVENTS } from '../shared/diagEvents'
import { getWorkspace, listChildWorkspaces, listWorkspacesForProject } from './workspaces'
import { updateClaudeWorkspaceSettings } from './claudeWorkspaceSettings'
import { getProject, listProjects } from './projects'
import { withReconciledEffort } from './effortReconciliation'
import { CLAUDE_EFFORT_VALUES } from '../shared/types'
import type {
  WorkspaceRecord,
  ClaudePermissionMode,
  ClaudeEffort,
  TreeFrame,
  WorkspaceHostResult,
  WorkspaceUnhostResult
} from '../shared/types'
import { onWorkspaceStatusChange } from './orpheusNotify'
import { getWorkspaceFileInfo } from './sessionState'
import { resolveEffectiveModelAndEffort } from './claudeSettings'
import { getCurrentBranch } from './git'
import {
  hostWorkspace,
  unhostWorkspace,
  listHostedSessionsCached,
  buildTreeFrame,
  tmuxSessionName,
  resolveTmuxSocketName,
  shouldBlockTmuxHost,
  type TreeSourceWorkspace
} from './tmuxHost'
import {
  commandReviewContext,
  invokeReviewList,
  invokeReviewSetResolved,
  resolveCommandReviewListInput,
  resolveCommandReviewSetResolvedInput
} from './reviewControlAdapter'
import type { ClaudeRuntimeBinding, RuntimeLeaseRegistry } from './controlPlane/runtimeLeases'
import { RuntimeControlGrantPolicy } from './controlPlane/runtimeGrants'
import type {
  ControlContext,
  ControlDescription,
  ControlInvoker,
  ControlPermission,
  TrustedRuntimeBinding
} from './controlPlane/types'
import type { WorkspaceOperationActor } from './workspaceOrchestration/types'
import type { WorkspaceOrchestrationService } from './workspaceOrchestration/service'
import { legacyWaitReason, type MainWorkspaceWaitEngine } from './workspaceOrchestration/waitEngine'
import { parseCommandAction } from './commandAction'
import { redactErrorForLog, redactLogString } from './logRedaction'
import { resolveSubscribeTimeoutMs } from './subscribeTimeout'

// ---------------------------------------------------------------------------
// Deps injected from index.ts (these live as locals there, so we receive them
// as callbacks rather than importing them directly).
// ---------------------------------------------------------------------------

export type CommandServerDeps = {
  runtimeLeases: RuntimeLeaseRegistry
  workspaceOrchestration: WorkspaceOrchestrationService
  workspaceWaitEngine: MainWorkspaceWaitEngine
  runtimeControlGrants: RuntimeControlGrantPolicy
  listControl: (context: ControlContext) => ControlDescription[]
  invokeControl: ControlInvoker
  getControlCatalogRevision: () => number
  waitForControlCatalogRevision: (
    afterRevision: number,
    timeoutMs: number,
    signal: AbortSignal
  ) => Promise<{ revision: number; changed: boolean }>
  /** Destroy the libghostty surface for a workspace (no-op if not mounted). */
  destroySurface: (workspaceId: string) => void
  /**
   * Evict all per-workspace in-memory state (launch snapshot, dirty flag,
   * activity, overlay, git watcher, etc.). Mirrors teardownWorkspaceResources
   * in index.ts.
   */
  teardownWorkspaceResources: (workspaceId: string, cwd: string | null) => void
  /**
   * Destroy surface + teardown + DB closeWorkspace in one shot.
   * Mirrors performClose in index.ts.
   */
  performClose: (workspaceId: string) => WorkspaceRecord | undefined
  /**
   * Destroy surface + teardown + DB archiveWorkspace in one shot. Forces the
   * archive (dirty worktrees are torn down without a confirmation round-trip)
   * since the CLI/command-server caller has already decided to archive.
   * Mirrors performArchive in index.ts.
   */
  performArchive: (workspaceId: string) => Promise<{ archived: boolean; wasDirty: boolean }>
  /**
   * Send 'workspace:requestOpen' to the renderer so it opens/mounts the given
   * workspace. Used by U8/U12 and by `ws open`.
   *
   * `focus` (default true) controls whether the renderer NAVIGATES the UI to
   * the workspace (handleSelectWorkspace: setView + mount — steals focus) or
   * performs a BACKGROUND MOUNT (mounts the terminal surface so it becomes
   * injectable without changing what the user is looking at). See the
   * background-mount design note in Dashboard.tsx's onWorkspaceRequestOpen
   * handler.
   */
  requestOpenWorkspace: (workspaceId: string, focus?: boolean) => void
  /**
   * Open a workspace and inject a seed task once the surface is injectable.
   * Implemented in index.ts using requestOpenWorkspace + a bounded poll on
   * getSurfacePhase + canInject + isWorkspaceSessionReady (waits for claude
   * itself to have booted and registered its session, not just the terminal
   * surface to be mounted) + terminalActions.sendInput/submit. Returns a
   * warning string if the workspace never became ready within the timeout
   * (task not injected), null on success. The workspace is always created
   * regardless; only the injection may be skipped.
   *
   * `focus` (default true) is forwarded to requestOpenWorkspace: true
   * navigates the UI to the workspace, false performs a background mount.
   *
   * `submit` (default true) controls whether the task is submitted (typed +
   * Enter) after being staged. false leaves the text staged in claude's input
   * box unsent (for user review/editing) — sendInput still runs, only the
   * SUBMIT_DELAY_MS delay + submit() call is skipped.
   */
  openAndSeed: (
    workspaceId: string,
    taskText: string,
    focus?: boolean,
    submit?: boolean
  ) => Promise<string | null>
  /**
   * Send text, a named key, and/or submit to a running workspace. If the
   * workspace surface is not yet injectable, opens it (requestOpenWorkspace)
   * and polls canInject up to a bounded timeout (10 s) before injecting.
   * Returns { ok: true } on success or { ok: false, error: string } on failure
   * (surface not ready, timeout, send error).
   *
   * `focus` (default true) is forwarded to the auto-open path: true navigates
   * the UI to the workspace, false performs a background mount (the workspace
   * becomes injectable without stealing the user's view).
   */
  sendToWorkspace: (
    workspaceId: string,
    payload: { text?: string; submit?: boolean; key?: string },
    focus?: boolean
  ) => Promise<{ ok: boolean; error?: string }>
  /**
   * Native libghostty surface phase for a workspace ('none' when no live
   * entry exists). Mirrors index.ts's getNativeSurfacePhase() — injected
   * rather than imported directly so this module never needs to load the
   * terminal addon itself. Used ONLY by workspace.host's pre-create guard
   * (see that handler below) to detect "this workspace is already open
   * natively on the desktop" before ever touching tmux.
   */
  getSurfacePhase: (workspaceId: string) => 'none' | 'hidden' | 'attached' | 'visible' | 'freeing'
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

const BODY_SIZE_LIMIT = 10 * 1024 * 1024 // 10 MB

// Shared validation-error message for the many dispatch handlers that require
// a string args.id — hoisted since it's repeated verbatim across them.
const ARGS_ID_REQUIRED_ERROR = 'args.id is required'

type CmdBody = {
  action: string
  args?: Record<string, unknown>
  context?: { workspaceId?: string }
}

type ControlRequest =
  | { protocolVersion: 1; op: 'catalog' }
  | { protocolVersion: 1; op: 'catalog.wait'; afterRevision: number }
  | { protocolVersion: 1; op: 'invoke'; id: string; input: unknown }

const CONTROL_CATALOG_WAIT_MS = 25_000
const EMPTY_RUNTIME_RESOURCE_SCOPE = Object.freeze({
  selfOnly: true as const,
  layoutIds: Object.freeze([]),
  surfaceIds: Object.freeze([])
})

const COMMAND_SOCKET_PERMISSIONS = Object.freeze([
  'identity.read',
  'projects.read',
  'workspaces.read',
  'workspaces.create',
  'workspaces.open',
  'workspaces.send',
  'workspaces.wait',
  'workspaces.close',
  'workspaces.rename',
  'workspaces.archive',
  'reviews.read'
] satisfies ControlPermission[])

// The value a dispatch handler resolves to — always fed straight into
// JSON.stringify({ ok: true, data }) by the /cmd envelope, so it's
// constrained to JSON-serializable shapes rather than bare `unknown`.
type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue }

type DispatchFn = (
  args: Record<string, unknown>,
  context: { workspaceId?: string },
  deps: CommandServerDeps
) => Promise<JsonValue> | JsonValue

// ---------------------------------------------------------------------------
// /subscribe — --until modes (see ws-wait.ts's DURATION PARSING / --UNTIL doc
// comment for the full behavioral spec). Passed through from the CLI's
// `subscribe({ workspaceIds, timeoutMs, until })` body.
// ---------------------------------------------------------------------------

type UntilMode = 'done' | 'input' | 'idle'

function isValidUntilMode(v: string): v is UntilMode {
  return v === 'done' || v === 'input' || v === 'idle'
}

// Repeated wait-outcome literal — hoisted since it's returned from several
// branches of the ws-wait status resolution below.
const BLOCKED_INPUT = 'blocked-input'

/**
 * Build the workspace-level settings override (model / permissionMode /
 * effort) from `workspace.create`'s args, validating each field exactly as
 * the original inline code did. Stored in claude_workspace_settings and
 * picked up by composeClaudeLaunch. Returns an empty object when no valid
 * override fields were supplied (caller skips the updateClaudeWorkspaceSettings
 * call in that case, matching the original `Object.keys(...).length > 0` gate).
 */
function buildWorkspaceSettingsOverride(args: Record<string, unknown>): {
  model?: string
  permissionMode?: ClaudePermissionMode
  effort?: ClaudeEffort
} {
  const settingsOverride: {
    model?: string
    permissionMode?: ClaudePermissionMode
    effort?: ClaudeEffort
  } = {}
  if (typeof args.model === 'string' && args.model !== '') {
    settingsOverride.model = args.model
  }
  const VALID_PERMISSION_MODES: ClaudePermissionMode[] = [
    'default',
    'acceptEdits',
    'plan',
    'bypassPermissions'
  ]
  if (
    typeof args.permissionMode === 'string' &&
    VALID_PERMISSION_MODES.includes(args.permissionMode as ClaudePermissionMode)
  ) {
    settingsOverride.permissionMode = args.permissionMode as ClaudePermissionMode
  }
  // Sourced from CLAUDE_EFFORT_VALUES (src/shared/types.ts's single
  // canonical list, model-routing unit 11) rather than a re-declared
  // literal — without this, a CLI-created workspace passing effort:
  // 'minimal'/'none' would silently have that field DROPPED here (fails the
  // includes() check, so it's just omitted from settingsOverride — no
  // error, no signal to the caller).
  if (
    typeof args.effort === 'string' &&
    CLAUDE_EFFORT_VALUES.includes(args.effort as ClaudeEffort)
  ) {
    settingsOverride.effort = args.effort as ClaudeEffort
  }
  return settingsOverride
}

function commandWorkspaceActor(
  args: Record<string, unknown>,
  context: { workspaceId?: string }
): WorkspaceOperationActor {
  const explicitProjectId = typeof args.projectId === 'string' ? args.projectId : null
  const targetWorkspaceId =
    typeof args.id === 'string'
      ? args.id
      : typeof args.workspaceId === 'string'
        ? args.workspaceId
        : context.workspaceId
  const targetProjectId =
    explicitProjectId ??
    (targetWorkspaceId == null ? null : (getWorkspace(targetWorkspaceId)?.projectId ?? null))
  return {
    requestId: crypto.randomUUID(),
    consumer: 'command-socket',
    principal: { kind: 'cli', runtimeId: null },
    boundProjectId: targetProjectId,
    boundWorkspaceId: context.workspaceId ?? null,
    permissions: COMMAND_SOCKET_PERMISSIONS
  }
}

function orchestrationMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function activateLegacyCreatedWorkspace(
  deps: CommandServerDeps,
  actor: WorkspaceOperationActor,
  workspaceId: string,
  taskText: string | null,
  submit: boolean,
  focus: boolean
): Promise<string | null> {
  const presentation = focus ? 'focus' : 'background'
  try {
    if (taskText == null) {
      // A taskless legacy create still activates the workspace, but it has no
      // requested terminal-input effect whose readiness must be proven before
      // returning. Preserve the historical fire-and-forget renderer request so
      // `ws new --empty` and fork-only creation return immediately instead of
      // waiting for the bounded task-readiness deadline and reporting a
      // misleading seed warning.
      deps.requestOpenWorkspace(workspaceId, focus)
    } else if (submit) {
      await deps.workspaceOrchestration.startTask(
        { workspaceId, text: taskText, presentation },
        actor
      )
    } else {
      await deps.workspaceOrchestration.send(
        { workspaceId, text: taskText, submit: false, presentation },
        actor
      )
    }
    return null
  } catch (error) {
    return orchestrationMessage(error)
  }
}

async function handleLegacyWorkspaceCreate(
  args: Record<string, unknown>,
  context: { workspaceId?: string },
  deps: CommandServerDeps
): Promise<JsonValue> {
  if (typeof args.projectId !== 'string') throw new Error('args.projectId is required')
  if (typeof args.cwd !== 'string') throw new Error('args.cwd is required')
  if (getProject(args.projectId) == null) throw new Error(`project not found: ${args.projectId}`)

  const actor = commandWorkspaceActor(args, context)
  const created = await deps.workspaceOrchestration.create(
    {
      mode: 'local',
      ...(typeof args.name === 'string' && args.name !== '' ? { name: args.name } : {}),
      ...(typeof args.parentWorkspaceId === 'string'
        ? { parentWorkspaceId: args.parentWorkspaceId }
        : {}),
      ...(args.fork === true ? { fork: true } : {})
    },
    actor
  )
  const workspaceId = created.value.workspace.workspaceId
  let workspace = getWorkspace(workspaceId)
  if (workspace == null) throw new Error(`workspace not found: ${workspaceId}`)

  const settingsOverride = withReconciledEffort(
    buildWorkspaceSettingsOverride(args),
    workspace.projectId,
    workspace.id
  )
  if (Object.keys(settingsOverride).length > 0) {
    updateClaudeWorkspaceSettings(workspace.id, settingsOverride)
  }

  const taskText = typeof args.task === 'string' && args.task !== '' ? args.task : null
  const seedWarning = await activateLegacyCreatedWorkspace(
    deps,
    actor,
    workspaceId,
    taskText,
    args.submit !== false,
    args.focus !== false
  )

  workspace = getWorkspace(workspaceId) ?? workspace
  return { workspace, seedWarning }
}

function collectWorkspaceSubtreeIds(rootId: string): string[] {
  const order: string[] = []
  const visited = new Set<string>()
  const visit = (workspaceId: string): void => {
    if (visited.has(workspaceId)) return
    visited.add(workspaceId)
    for (const child of listChildWorkspaces(workspaceId)) visit(child.id)
    order.push(workspaceId)
  }
  visit(rootId)
  return order
}

// ---------------------------------------------------------------------------
// Tree frame — full-snapshot `tree` frame for the TUI's `/subscribe`
// consumers (docs/TUI_SPEC.md D5). Module-level (not per-connection) since
// there is exactly one command server per process and every active
// tree-mode /subscribe connection shares the same underlying snapshot.
//
// CHANGE DETECTION: reorderWorkspaces()/renameWorkspace()/setProjectPinned()
// etc. (workspaces.ts/projects.ts) don't currently emit a "structure changed"
// event of their own, and adding one there would mean workspaces.ts/
// projects.ts importing this module back — a circular import `check:arch`
// forbids (main-not-to-... layering aside, dependency-cruiser's no-circular
// rule is unconditional). So structural/ordering changes are covered by a
// bounded poll (TREE_POLL_MS) that only runs while at least one tree-mode
// subscriber is connected; status transitions (the much more frequent case)
// are covered instantly via the existing onWorkspaceStatusChange observer.
// Both paths funnel through the same debounced scheduleTreeFrameEmit(), so a
// burst of either kind of change still coalesces into one emission.
//
// IDLE COST: the poll ALWAYS recomputes a candidate frame (a couple of cheap
// SQLite SELECTs + listHostedSessionsCached(), which is itself short-TTL
// cached — see tmuxHost.ts — so it does NOT spawn a `tmux list-sessions`
// subprocess on every single tick), but only bumps `treeRevision` and fans
// out to subscribers when the candidate's CONTENT actually differs from the
// last emitted frame (see treeFrameContentKey). An idle TUI therefore costs
// zero bytes on the wire and a meaningless-`revision` churn never happens —
// `revision` only ever advances on a real change. `lastTreeFrame` doubles as
// the immediate reply for a newly-joining subscriber (see handleSubscribe),
// so a late joiner never waits out a poll tick just to see the current state.
// ---------------------------------------------------------------------------

const TREE_DEBOUNCE_MS = 50
const TREE_POLL_MS = 1000

let treeRevision = 0
let treeDebounceTimer: NodeJS.Timeout | null = null
let treePollInterval: NodeJS.Timeout | null = null
/** The last frame actually broadcast (or null before the very first one) —
 *  reused both to detect "nothing meaningful changed" and to reply
 *  immediately to a subscriber that joins between polls. */
let lastTreeFrame: TreeFrame | null = null
const treeFrameSubscribers = new Set<(frame: TreeFrame) => void>()

// ---------------------------------------------------------------------------
// Current-branch cache for the tree frame's `gitBranch` overlay field.
//
// computeCandidateTreeFrame runs on EVERY tree poll tick (TREE_POLL_MS =
// 1000ms, see below) for EVERY active workspace across EVERY project, via
// collectTreeSourceWorkspaces -> withLiveTreeOverlay. A `git rev-parse`
// subprocess per workspace per tick would mean N workspaces * 1 subprocess/
// sec, blocking frame emission on subprocess latency — unacceptable, mirrors
// the exact concern listHostedSessionsCached() (tmuxHost.ts) already solves
// for `tmux list-sessions`.
//
// getCachedCurrentBranch() is a SYNCHRONOUS read: cache hit -> return
// immediately, zero subprocess cost. Cache miss/stale -> kick off a
// background refresh (fire-and-forget, de-duped per in-flight cwd so
// concurrent calls during one refresh — e.g. several workspaces sharing a
// cwd — never spawn duplicate subprocesses) and return the last-known value
// (or null if never resolved) for THIS frame. The frame-build loop therefore
// never awaits a fresh git subprocess call inline.
//
// Cache key is the workspace's cwd AS-IS (already an absolute, stable path
// from WorkspaceRecord — unlike git.ts's own gitWatchers map this doesn't
// need a separate nodePath.resolve() normalization pass since cwd is never
// relative here) — workspaces sharing a cwd share one cache entry, so the
// worst case is one in-flight subprocess per DISTINCT cwd per TTL window,
// never one per workspace.
// ---------------------------------------------------------------------------

const CURRENT_BRANCH_CACHE_TTL_MS = 4000

type CurrentBranchCacheEntry = {
  branch: string | null
  expiresAt: number
  refreshing: boolean
}

const currentBranchCache = new Map<string, CurrentBranchCacheEntry>()

/** Logged at most once (not per-tick) so a persistently-missing/broken git
 *  binary doesn't spam the log every TTL cycle. */
let currentBranchErrorLogged = false

function refreshCurrentBranch(cwd: string): void {
  const entry = currentBranchCache.get(cwd)
  if (entry?.refreshing) return // already in flight for this cwd — de-duped
  const placeholder: CurrentBranchCacheEntry = entry
    ? { ...entry, refreshing: true }
    : { branch: null, expiresAt: 0, refreshing: true }
  currentBranchCache.set(cwd, placeholder)

  getCurrentBranch(cwd)
    .then((branch) => {
      currentBranchCache.set(cwd, {
        branch,
        expiresAt: Date.now() + CURRENT_BRANCH_CACHE_TTL_MS,
        refreshing: false
      })
    })
    .catch((err) => {
      // getCurrentBranch already swallows its own subprocess failures and
      // resolves null rather than rejecting — this catch is an extra safety
      // net only, matching the same defensive pattern git.ts's own
      // refreshGitForDir uses around getGitStatus.
      if (!currentBranchErrorLogged) {
        currentBranchErrorLogged = true
        console.warn(
          '[commandServer] getCurrentBranch failed cwd=%s: %s',
          cwd,
          err instanceof Error ? err.message : String(err)
        )
      }
      currentBranchCache.set(cwd, {
        branch: null,
        expiresAt: Date.now() + CURRENT_BRANCH_CACHE_TTL_MS,
        refreshing: false
      })
    })
}

/** Synchronous, non-blocking read of the current-branch cache for `cwd` —
 *  see the module comment above. Never spawns a subprocess inline; a
 *  miss/stale entry only schedules a background refresh and returns the
 *  last-known value (or null) for this call. */
function getCachedCurrentBranch(cwd: string): string | null {
  if (!cwd) return null
  const now = Date.now()
  const entry = currentBranchCache.get(cwd)
  if (entry == null || entry.expiresAt <= now) {
    refreshCurrentBranch(cwd)
    return entry?.branch ?? null
  }
  return entry.branch
}

/** Live overlay on top of the DB-persisted WorkspaceRecord: `waitingFor`
 *  (only meaningful while `status === 'attention'`) and a best-effort
 *  `lastActivityAt`, both sourced from the same live session-file info
 *  `ws ls`/`ws status` already read (getWorkspaceFileInfo — see
 *  sessionState.ts). Falls back to the DB's own lastOpenedAt when no live
 *  file info is available (session not currently running). Also resolves
 *  `gitBranch` — the workspace cwd's actual current git branch — via the
 *  synchronous, short-TTL-cached getCachedCurrentBranch() above; distinct
 *  from `worktreeBranch` (WorkspaceRecord's own persisted field). */
function withLiveTreeOverlay(ws: WorkspaceRecord): TreeSourceWorkspace {
  const info = getWorkspaceFileInfo(ws.id)
  // Effective (global -> project -> workspace layered) model/effort — see
  // claudeSettings.ts's resolveEffectiveModelAndEffort doc comment for why
  // this cheap resolution (not composeClaudeLaunch) is used here, on every
  // poll tick, for every workspace.
  const { model, effort } = resolveEffectiveModelAndEffort(ws.projectId, ws.id)
  return {
    ...ws,
    ...(ws.status === 'attention' && info.waitingFor != null
      ? { waitingFor: info.waitingFor }
      : {}),
    lastActivityAt: info.statusUpdatedAt ?? ws.lastOpenedAt ?? null,
    model,
    effort,
    gitBranch: getCachedCurrentBranch(ws.cwd)
  }
}

function collectTreeSourceWorkspaces(): TreeSourceWorkspace[] {
  const out: TreeSourceWorkspace[] = []
  for (const project of listProjects()) {
    for (const ws of listWorkspacesForProject(project.id)) {
      out.push(withLiveTreeOverlay(ws))
    }
  }
  return out
}

/** Stable content signature for change detection — deliberately EXCLUDES
 *  `revision` (that's the output of this comparison, not an input to it).
 *  `projects`/`workspaces` are always built in the same field/insertion
 *  order by buildTreeFrame, so JSON.stringify is a safe, cheap equality
 *  check here (no key-ordering nondeterminism to worry about). */
function treeFrameContentKey(frame: Pick<TreeFrame, 'projects'>): string {
  return JSON.stringify(frame.projects)
}

/** Recompute the tree frame's CANDIDATE revision (current + 1) — the caller
 *  (scheduleTreeFrameEmit) decides whether that candidate actually differs
 *  from `lastTreeFrame` before committing the revision bump. Uses the
 *  short-TTL `listHostedSessionsCached()` (not the raw listHostedSessions())
 *  so a poll tick does not unconditionally spawn a `tmux list-sessions`
 *  subprocess. */
async function computeCandidateTreeFrame(): Promise<TreeFrame> {
  const projects = listProjects()
  const workspaces = collectTreeSourceWorkspaces()
  let hostedSessions: Set<string>
  try {
    hostedSessions = await listHostedSessionsCached()
  } catch {
    // tmux missing/unavailable — degrade to "nothing hosted" rather than
    // failing the whole tree snapshot over an optional feature.
    hostedSessions = new Set()
  }
  const candidateRevision = treeRevision >= Number.MAX_SAFE_INTEGER ? 1 : treeRevision + 1
  return buildTreeFrame(projects, workspaces, hostedSessions, candidateRevision)
}

function ensureTreePolling(): void {
  if (treePollInterval != null) return
  treePollInterval = setInterval(() => scheduleTreeFrameEmit(), TREE_POLL_MS)
  treePollInterval.unref?.()
}

function stopTreePollingIfIdle(): void {
  if (treeFrameSubscribers.size === 0 && treePollInterval != null) {
    clearInterval(treePollInterval)
    treePollInterval = null
  }
}

/** Debounced (~50ms) tree-frame rebuild + fan-out to every connected
 *  tree-mode /subscribe connection — but ONLY when the rebuilt content
 *  actually differs from the last emitted frame (see treeFrameContentKey);
 *  otherwise this is a no-op that neither bumps `revision` nor touches the
 *  wire. A no-op outright when nobody is currently asking for tree frames. */
function scheduleTreeFrameEmit(): void {
  if (treeFrameSubscribers.size === 0) return
  if (treeDebounceTimer != null) return
  treeDebounceTimer = setTimeout(() => {
    treeDebounceTimer = null
    void (async () => {
      const candidate = await computeCandidateTreeFrame()
      if (
        lastTreeFrame != null &&
        treeFrameContentKey(candidate) === treeFrameContentKey(lastTreeFrame)
      ) {
        return // nothing meaningful changed — do not bump revision or resend
      }
      treeRevision = candidate.revision
      lastTreeFrame = candidate
      for (const send of treeFrameSubscribers) send(candidate)
    })()
  }, TREE_DEBOUNCE_MS)
}

// ---------------------------------------------------------------------------
// Dispatch table — one entry per supported CLI action.
// ---------------------------------------------------------------------------

function makeDispatchTable(
  deps: CommandServerDeps,
  serverIdentity: { sockPath: string; token: string }
): Record<string, DispatchFn> {
  const dispatch: Record<string, DispatchFn> = {
    // Create a new workspace inside a project.
    // Args:
    //   projectId (required) — the project to create the workspace under
    //   cwd (required)       — working directory for the workspace
    //   name?                — workspace name; defaults to 'New workspace'
    //   fork? (boolean)      — if true, inherit parent session history via --fork-session
    //   parentWorkspaceId?   — explicit parent id; falls back to context.workspaceId
    //   model?               — workspace-level model override
    //   permissionMode?      — workspace-level permission mode override
    //   effort?              — workspace-level effort override
    //   task?                — seed text to inject after opening the workspace in the GUI
    //   submit? (boolean)    — whether a seeded task is submitted (typed + Enter) after
    //                          staging, vs left staged/unsent for review. Default true
    //                          (omitted → submit). Only meaningful together with task.
    'workspace.create': handleLegacyWorkspaceCreate,

    // Archive (permanently delete) a workspace — mirrors the workspaces:archive IPC
    // handler in index.ts via the shared performArchive dep.
    // With recursive:true, archives the entire subtree (children-before-parent) so
    // teardown ordering is safe and no workspace is left with a missing parent.
    //
    // DATA-INTEGRITY FIX (QA #3): archiveWorkspace() in workspaces.ts is a silent
    // no-op DELETE — it never throws for a nonexistent id, so previously this
    // dispatch reported { archived: true } even when args.id never existed. The
    // caller (a script) would see success and move on, masking a typo'd or
    // already-archived id. Fix: getWorkspace(id) FIRST; a null result throws a
    // 'workspace not found: <id>' error, which the /cmd envelope turns into
    // { ok: false, error: '...' } and which the CLI's not-found heuristic maps
    // to exit 3. The same check applies to the recursive root — if the root
    // itself doesn't exist, refuse before doing any BFS/teardown work.
    'workspace.archive': async (args, context, innerDeps) => {
      if (typeof args.id !== 'string') throw new Error(ARGS_ID_REQUIRED_ERROR)
      if (getWorkspace(args.id) == null) throw new Error(`workspace not found: ${args.id}`)
      const recursive = args.recursive === true
      const targets = recursive ? collectWorkspaceSubtreeIds(args.id) : [args.id]
      if (context.workspaceId != null && targets.includes(context.workspaceId)) {
        throw new Error('cannot archive the workspace running this command')
      }
      const result = await innerDeps.workspaceOrchestration.archive(
        { workspaceId: args.id, recursive },
        commandWorkspaceActor(args, context)
      )
      if (result.status === 'partial') {
        throw new Error('workspace archive completed partially')
      }
      return recursive
        ? { archived: true, count: result.value.workspaces.length }
        : { archived: true }
    },

    // Close a workspace (sets closed_at). The CLI caller is headless and
    // deliberately closing — no busy-status guard (unlike the GUI handler).
    // Self-action guard: refuse if the caller's own workspace is being closed.
    //
    // DATA-INTEGRITY FIX (mirrors workspace.archive): performClose (→
    // closeWorkspace in workspaces.ts) is a silent no-op UPDATE — it returns
    // undefined for a nonexistent id instead of throwing, so previously this
    // dispatch reported { workspace: null } (success-shaped) even when args.id
    // never existed. Fix: getWorkspace(id) FIRST; existence-before-self-guard
    // so a genuine not-found isn't masked as a self-action refusal.
    'workspace.close': async (args, context, innerDeps) => {
      if (typeof args.id !== 'string') throw new Error(ARGS_ID_REQUIRED_ERROR)
      if (getWorkspace(args.id) == null) throw new Error(`workspace not found: ${args.id}`)
      if (context.workspaceId === args.id) {
        throw new Error('cannot close the workspace running this command')
      }
      await innerDeps.workspaceOrchestration.close(
        { workspaceId: args.id },
        commandWorkspaceActor(args, context)
      )
      return { workspace: getWorkspace(args.id) }
    },

    // Reopen a previously-closed workspace (clears closed_at).
    //
    // DATA-INTEGRITY FIX (mirrors workspace.archive): reopenWorkspace is a
    // silent no-op UPDATE — it returns undefined for a nonexistent id instead
    // of throwing, so previously this dispatch reported { workspace: null }
    // (success-shaped) even when args.id never existed. Fix: getWorkspace(id)
    // FIRST.
    'workspace.reopen': async (args, context, innerDeps) => {
      if (typeof args.id !== 'string') throw new Error(ARGS_ID_REQUIRED_ERROR)
      await innerDeps.workspaceOrchestration.reopen(
        { workspaceId: args.id },
        commandWorkspaceActor(args, context)
      )
      return { workspace: getWorkspace(args.id) }
    },

    // Rename a workspace.
    // NOTE: no explicit existence guard needed here — renameWorkspace() in
    // workspaces.ts already throws `workspace not found: <id>` when the
    // UPDATE...RETURNING matches zero rows, so a nonexistent id already
    // surfaces as a real error (not a false success). Adding a redundant
    // getWorkspace() check here would just duplicate that. renameWorkspace()
    // also sanitizes/caps the name (see sanitizeWorkspaceName in workspaces.ts:
    // strips control chars, collapses whitespace, trims, caps at 200 chars
    // with an ellipsis, and rejects an empty-after-trim name).
    'workspace.rename': async (args, context, innerDeps) => {
      if (typeof args.id !== 'string') throw new Error(ARGS_ID_REQUIRED_ERROR)
      if (typeof args.name !== 'string') throw new Error('args.name is required')
      await innerDeps.workspaceOrchestration.rename(
        { workspaceId: args.id, name: args.name },
        commandWorkspaceActor(args, context)
      )
      const workspace = getWorkspace(args.id)
      if (workspace == null) throw new Error(`workspace not found: ${args.id}`)
      return workspace
    },

    // Ask the renderer to open (and mount) a workspace. Used by U8 (ws new
    // --task) and U12 (ws send to an unmounted workspace), and directly by
    // `ws open`.
    // args.focus: true (default) navigates the UI to the workspace (explicit
    // "open this" intent); false performs a background mount (mounts the
    // surface so it becomes injectable without changing what the user is
    // looking at).
    'workspace.open': async (args, context, innerDeps) => {
      if (typeof args.id !== 'string') throw new Error(ARGS_ID_REQUIRED_ERROR)
      // DATA-INTEGRITY FIX (QA — mirrors workspace.archive/close/reopen): previously
      // this dispatch never checked existence, so `ws open <nonexistent-id>` reported
      // { requested: true } (success-shaped) and exit 0 even though nothing was opened.
      // Fix: getWorkspace(id) FIRST; a null result throws 'workspace not found: <id>',
      // which the CLI's not-found heuristic maps to exit 3 — consistent with archive/
      // close/reopen/rename.
      const workspace = getWorkspace(args.id)
      if (workspace == null) {
        throw new Error(`workspace not found: ${args.id}`)
      }
      const focus = args.focus !== false
      const actor = commandWorkspaceActor(args, context)
      if (workspace.closedAt != null) {
        await innerDeps.workspaceOrchestration.reopen({ workspaceId: args.id }, actor)
      }
      await innerDeps.workspaceOrchestration.open(
        { workspaceId: args.id, presentation: focus ? 'focus' : 'background' },
        actor
      )
      return { requested: true }
    },

    // Send text / key / submit to a running workspace surface.
    // Args:
    //   id     (required) — workspace to send to
    //   text?  (string)   — UTF-8 text to write into the PTY
    //   submit?(boolean)  — if true, send Return after text (or alone if no text)
    //   key?   (string)   — named key to send ('enter','escape','up','down','tab', etc.)
    //                       When both text and key are present: text is sent first, then key.
    //                       When both text and submit are present: text is sent, then Return.
    //                       key and submit together: key is sent, then Return.
    // If the surface is not yet injectable, requestOpenWorkspace is called and
    // the dep polls canInject for up to 10 s before injecting.
    'workspace.send': async (args, _context, innerDeps) => {
      if (typeof args.id !== 'string') throw new Error(ARGS_ID_REQUIRED_ERROR)
      const text = typeof args.text === 'string' && args.text !== '' ? args.text : undefined
      const submit = args.submit === true
      const key = typeof args.key === 'string' && args.key !== '' ? args.key : undefined
      if (text == null && key == null && !submit) {
        throw new Error('at least one of args.text, args.key, or args.submit is required')
      }
      // focus: whether an auto-open (workspace not yet mounted) navigates the
      // UI to the workspace (true) or background-mounts it (false). Defaults
      // to true; ws-send.ts defaults --background and always passes an
      // explicit boolean.
      const focus = args.focus !== false
      const result =
        key != null || text == null
          ? await innerDeps.sendToWorkspace(args.id, { text, submit, key }, focus)
          : await innerDeps.workspaceOrchestration
              .send(
                {
                  workspaceId: args.id,
                  text,
                  submit,
                  presentation: focus ? 'focus' : 'background'
                },
                commandWorkspaceActor(args, _context)
              )
              .then(() => ({ ok: true as const }))
              .catch((error: unknown) => ({
                ok: false as const,
                error: orchestrationMessage(error)
              }))
      if (!result.ok) {
        throw new Error(result.error ?? 'send failed')
      }
      return { ok: true }
    },

    // Host a workspace's `claude` inside a detached tmux session (docs/TUI_SPEC.md).
    // Args: id (required) — workspace to host.
    // Mirrors the existence-before-action fix applied to every other id-scoped
    // action above (workspace.archive/close/reopen/open): getWorkspace(id)
    // FIRST, so a nonexistent id throws 'workspace not found: <id>' (→ CLI
    // exit 3) instead of a success-shaped response for nothing.
    'workspace.host': async (args): Promise<WorkspaceHostResult> => {
      if (typeof args.id !== 'string') throw new Error(ARGS_ID_REQUIRED_ERROR)
      const workspace = getWorkspace(args.id)
      if (workspace == null) throw new Error(`workspace not found: ${args.id}`)

      // ── Cross-host double-launch guard (MIRROR of index.ts's
      // willMountCreateSurface — protects the OPPOSITE direction) ─────────
      // willMountCreateSurface (index.ts) stops the DESKTOP from creating a
      // tmux session onto a workspace already tmux-hosted. This stops the
      // TUI/CLI (this action) from creating a tmux session onto a workspace
      // that is CURRENTLY OPEN NATIVELY on the desktop with NO tmux session
      // backing it (pre-conversion, or via the tmux-missing-fallback path)
      // — whose `claude` is already live and writing the same transcript a
      // fresh `--resume` here would race against. Three signals feed
      // shouldBlockTmuxHost (see its doc comment in tmuxHost.ts for the full
      // truth table):
      //   1. deps.getSurfacePhase — is there a live libghostty surface ENTRY
      //      for this workspace in the CURRENT process's addon surface map.
      //   2. getWorkspaceFileInfo — is `claude`'s OWN on-disk session
      //      registry (~/.claude/sessions/<pid>.json, sessionState.ts)
      //      reporting this workspace's session as alive right now
      //      (independent of which host started it — this is the
      //      authoritative "is claude actually running" signal used
      //      everywhere else in the app per CLAUDE.md's "Workspace activity
      //      status" section).
      //   3. listHostedSessionsCached — is there ALREADY a tmux session for
      //      this workspace. If so, attaching is always safe (a second tmux
      //      CLIENT on an existing session, not a second `claude` writer),
      //      so this signal short-circuits (1) and (2) to an allow — see
      //      hostWorkspace()'s own has-session→reuse-or-create idempotency,
      //      which is what actually attaches here. FAIL SAFE: if the tmux
      //      query itself throws (TmuxNotAvailableError or otherwise),
      //      treat it as "no session exists" rather than let an unknown
      //      tmux state turn into a spurious allow — the cost of a wrong
      //      allow is transcript corruption, the cost of a wrong refuse is
      //      just a confusing message the user can retry.
      const nativeSurfaceLive = deps.getSurfacePhase(workspace.id) !== 'none'
      const claudeSessionLive = getWorkspaceFileInfo(workspace.id).availability === 'available'
      const sessionName = tmuxSessionName(workspace.name, workspace.id)
      let tmuxSessionExists = false
      try {
        const hostedSessions = await listHostedSessionsCached()
        tmuxSessionExists = hostedSessions.has(sessionName)
      } catch {
        // Fail safe: unknown tmux state must never look like "already
        // hosted" — leave tmuxSessionExists false so the existing
        // native/claude-liveness guard still applies below.
      }
      if (shouldBlockTmuxHost(nativeSurfaceLive, claudeSessionLive, tmuxSessionExists)) {
        return {
          sessionName,
          socketName: resolveTmuxSocketName(),
          created: false,
          alreadyRunning: false,
          refused: {
            reason: 'open-on-desktop',
            message:
              'This workspace is already open natively on the desktop with no tmux session yet. ' +
              'Close it there (or wait for it to finish converting to tmux hosting) and try again.'
          }
        }
      }

      const result = await hostWorkspace(
        {
          workspaceId: workspace.id,
          projectId: workspace.projectId,
          workspaceName: workspace.name,
          cwd: workspace.cwd
        },
        serverIdentity
      )
      scheduleTreeFrameEmit() // tmuxHosted flipped for this workspace
      return result
    },

    // Kill a workspace's tmux session ONLY — the workspace itself is left
    // resumable via `--resume` (docs/TUI_SPEC.md D2: `x` kills tmux only).
    // D2 also specifies that archiving (`a`) kills the tmux session too
    // (archive is terminal — an orphaned session is a leak); this action is
    // the primitive that gives the TUI/CLI side what it needs to do that
    // (call workspace.unhost then workspace.archive) — workspace.archive
    // itself is unchanged here, out of this feature's scope.
    // Args: id (required) — workspace whose tmux session should be killed.
    'workspace.unhost': async (args): Promise<WorkspaceUnhostResult> => {
      if (typeof args.id !== 'string') throw new Error(ARGS_ID_REQUIRED_ERROR)
      const workspace = getWorkspace(args.id)
      if (workspace == null) throw new Error(`workspace not found: ${args.id}`)
      const result = await unhostWorkspace({
        workspaceId: workspace.id,
        workspaceName: workspace.name
      })
      scheduleTreeFrameEmit() // tmuxHosted flipped for this workspace
      return result
    },

    // Return identity context for the given workspaceId so the CLI can display
    // the current project name / cwd without querying SQLite directly.
    'whoami.resolve': (args, context) => {
      const workspaceId =
        context?.workspaceId ?? (typeof args?.workspaceId === 'string' ? args.workspaceId : null)
      if (!workspaceId) {
        return { workspaceId: null, projectId: null, projectName: null, cwd: null }
      }
      const ws = getWorkspace(workspaceId)
      if (!ws) throw new Error(`workspace not found: ${workspaceId}`)
      const project = getProject(ws.projectId)
      return {
        workspaceId,
        projectId: ws.projectId,
        projectName: project?.name ?? null,
        cwd: ws.cwd
      }
    },

    // Workbench Git tab, Phase 4d — THE agent-readable hook for the LOCAL
    // review-comment store (Epic G2). Surfaces the SAME data reviewStore.ts's
    // reviews:list IPC returns to the renderer, over the existing `orpheus`
    // CLI/HTTP command channel — so an agent can read local review comments
    // without needing direct SQLite access (though that always works too,
    // since the store is just the `review_comments` table — see
    // reviewStore.ts's own header). Read-only by design for this phase; a
    // future `reviews.add`/`reviews.resolve` write action would slot in here
    // alongside this one using the same reviewStore.ts functions.
    // Args:
    //   workspaceId — falls back to context.workspaceId (the same
    //                 caller-identity convention whoami.resolve above uses),
    //                 so a workspace-scoped agent doesn't need to pass it.
    'reviews.list': async (args, context) => {
      return invokeReviewList(
        deps.invokeControl,
        resolveCommandReviewListInput(args, context),
        commandReviewContext(context?.workspaceId ?? null)
      )
    },

    // Resolve-back — the write-side counterpart to reviews.list, mirrored
    // shape/auth/error handling exactly (same workspaceId convention as
    // reviews.list/whoami.resolve, same reviewStore.ts function the
    // reviews:setResolved IPC handler uses). This closes the CLI/command-server
    // parity gap flagged in reviewStore.ts's own header comment and in
    // docs/learnings/agent-review-loop.md — an agent can now flip a local
    // review comment's resolved flag from outside the renderer, completing
    // the read -> act (ws send) -> resolve loop.
    // Args:
    //   id         (required) — the review comment id to update
    //   resolved   (required, boolean) — the new resolved value
    // Comment ids are globally unique (randomUUID), so — unlike reviews.list —
    // there is no workspaceId to resolve/scope by here; mirrors the
    // reviews:setResolved IPC handler, which also takes only { id, resolved }.
    'reviews.setResolved': async (args, context) => {
      return invokeReviewSetResolved(
        deps.invokeControl,
        resolveCommandReviewSetResolvedInput(args, ARGS_ID_REQUIRED_ERROR),
        commandReviewContext(context?.workspaceId ?? null)
      )
    }
  }
  return dispatch
}

// ---------------------------------------------------------------------------
// Shared HTTP plumbing — auth + body read, used by both /subscribe and /cmd.
// ---------------------------------------------------------------------------

/**
 * Constant-time bearer-token check shared by /subscribe and /cmd. Writes a
 * 401 JSON response and returns false on any failure (missing header, wrong
 * length, or mismatched bytes); returns true (writes nothing) on success.
 *
 * Behavior-identical to both endpoints' original inline checks: a missing/
 * non-string header is rejected without any buffer comparison, and length is
 * checked before timingSafeEqual (which throws on a length mismatch) so a
 * short-circuited `false` — not an early accept — is what decides length
 * mismatches.
 */
function authenticate(req: http.IncomingMessage, res: http.ServerResponse, token: string): boolean {
  const incomingToken = req.headers['x-orpheus-token']
  if (typeof incomingToken !== 'string') {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
    return false
  }
  const incomingBuf = Buffer.from(incomingToken, 'utf-8')
  const expectedBuf = Buffer.from(token, 'utf-8')
  const tokenValid =
    incomingBuf.length === expectedBuf.length && crypto.timingSafeEqual(incomingBuf, expectedBuf)
  if (!tokenValid) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
    return false
  }
  return true
}

/**
 * Read+accumulate the request body, enforcing BODY_SIZE_LIMIT. Unified on
 * /cmd's STRICTER original behavior (a safe hardening — see the Batch 2
 * commit message):
 *   - Upfront Content-Length check: if the header already declares a size
 *     over the limit, reject immediately with 413 before reading any bytes.
 *     /subscribe previously lacked this pre-check.
 *   - Streaming guard: if accumulated bytes exceed the limit mid-stream,
 *     destroy the request AND respond 413. /subscribe previously destroyed
 *     the request on overflow but never wrote a response (the connection was
 *     just dropped, leaving the client to observe a reset rather than a
 *     structured 413).
 * Resolves to the concatenated body Buffer on success, or null if the
 * request was rejected (a response has already been written/ended in that
 * case — callers must return without writing anything further).
 */
function readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
    if (!isNaN(contentLength) && contentLength > BODY_SIZE_LIMIT) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'request too large' }))
      resolve(null)
      return
    }

    const chunks: Buffer[] = []
    let accumulated = 0
    let oversized = false

    req.on('data', (chunk: Buffer) => {
      if (oversized) return
      accumulated += chunk.length
      if (accumulated > BODY_SIZE_LIMIT) {
        oversized = true
        req.destroy()
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'request too large' }))
        resolve(null)
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (oversized) return // already responded
      resolve(Buffer.concat(chunks))
    })
  })
}

function writeJsonResponse(res: http.ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded) return
  try {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  } catch {
    /* client disconnected */
  }
}

function writeControlError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string
): void {
  writeJsonResponse(res, status, { ok: false, error: { code, message } })
}

const COMMAND_FAILED_ERROR = 'Command failed.'

/**
 * Keep useful domain-error messages in the authenticated command protocol
 * without stringifying arbitrary thrown values. `String(error)` can invoke a
 * custom `toString()` and expose stack text; a standard Error's message does
 * not automatically contain its stack, so retain only its redacted first line.
 */
function clientSafeCommandErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return COMMAND_FAILED_ERROR
  const firstLine = error.message.split(/\r?\n/u, 1)[0]?.trim()
  return firstLine ? redactLogString(firstLine) : COMMAND_FAILED_ERROR
}

function resolveRuntimeLease(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  runtimeLeases: RuntimeLeaseRegistry
): ClaudeRuntimeBinding | null {
  const token = req.headers['x-orpheus-runtime-lease']
  if (typeof token !== 'string') {
    writeControlError(res, 401, 'unauthorized', 'A valid runtime lease is required.')
    return null
  }
  const binding = runtimeLeases.resolve(token)
  if (binding == null) {
    writeControlError(res, 401, 'unauthorized', 'A valid runtime lease is required.')
    return null
  }
  return binding
}

function trustedRuntimeBinding(
  binding: ClaudeRuntimeBinding,
  grants: RuntimeControlGrantPolicy,
  includeResourceScope: boolean
): TrustedRuntimeBinding {
  return Object.freeze({
    runtimeId: binding.runtimeId,
    runtimeKind: binding.runtimeKind,
    surfaceId: binding.surfaceId,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    claudeConversationId: binding.claudeConversationId,
    issuedAt: binding.issuedAt,
    permissions: grants.permissionsFor(binding),
    resourceScope: includeResourceScope ? grants.scopeFor(binding) : EMPTY_RUNTIME_RESOURCE_SCOPE
  })
}

function runtimeControlContext(
  binding: ClaudeRuntimeBinding,
  grants: RuntimeControlGrantPolicy,
  includeResourceScope = true
): ControlContext {
  const trustedRuntime = trustedRuntimeBinding(binding, grants, includeResourceScope)
  return {
    principal: { type: 'workspace-agent', id: binding.runtimeId },
    consumer: 'mcp',
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    requestId: crypto.randomUUID(),
    trustedRuntime
  }
}

function parseControlRequest(value: unknown): ControlRequest | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record['protocolVersion'] !== 1) return null
  if (record['op'] === 'catalog') {
    return Object.keys(record).every((key) => key === 'protocolVersion' || key === 'op')
      ? { protocolVersion: 1, op: 'catalog' }
      : null
  }
  if (
    record['op'] === 'catalog.wait' &&
    Number.isSafeInteger(record['afterRevision']) &&
    (record['afterRevision'] as number) >= 1 &&
    Object.keys(record).every(
      (key) => key === 'protocolVersion' || key === 'op' || key === 'afterRevision'
    )
  ) {
    return {
      protocolVersion: 1,
      op: 'catalog.wait',
      afterRevision: record['afterRevision'] as number
    }
  }
  if (
    record['op'] === 'invoke' &&
    typeof record['id'] === 'string' &&
    record['id'].length > 0 &&
    Object.hasOwn(record, 'input') &&
    Object.keys(record).every(
      (key) => key === 'protocolVersion' || key === 'op' || key === 'id' || key === 'input'
    )
  ) {
    return {
      protocolVersion: 1,
      op: 'invoke',
      id: record['id'],
      input: record['input']
    }
  }
  return null
}

function publishedControlDescription(description: ControlDescription): {
  id: string
  version: 1
  kind: 'query' | 'mutation'
  description: string
  inputSchema: Readonly<Record<string, unknown>>
  outputSchema: Readonly<Record<string, unknown>>
} {
  return {
    id: description.id,
    version: description.version,
    kind: description.kind,
    description: description.description,
    inputSchema: description.inputSchema,
    outputSchema: description.outputSchema
  }
}

// ---------------------------------------------------------------------------
// Subscription cap — prevents unbounded open /subscribe connections.
// ---------------------------------------------------------------------------

/** Maximum concurrent /subscribe connections allowed. */
const MAX_CONCURRENT_SUBSCRIPTIONS = 32
/** Current count of active /subscribe connections. */
let activeSubscriptionCount = 0
/** Guarded decrement — never lets the counter go negative. */
function releaseSubscriptionSlot(): void {
  activeSubscriptionCount = Math.max(0, activeSubscriptionCount - 1)
}

// Result of parsing/validating a /subscribe request body — either the fields
// handleSubscribe needs to proceed, or the (status, error) pair to respond
// with (the caller writes the response; this function has no res access).
type SubscribeRequestParseResult =
  | {
      ok: true
      workspaceIds: string[]
      until: UntilMode
      effectiveTimeoutMs: number
      includeTree: boolean
    }
  | { ok: false; status: number; error: string }

/**
 * Parse and validate a /subscribe request body: JSON-parse, extract+validate
 * workspaceIds (non-empty string[] UNLESS `tree: true` opts into the TUI's
 * tree-only mode — see `includeTree` below), resolve --until (falls back to
 * 'done' on anything invalid/missing — the CLI already validates client-side),
 * and compute the effective server-side timeout via resolveSubscribeTimeoutMs
 * (see subscribeTimeout.ts for the full resolution table). Behavior-identical
 * to the original inline logic for existing ws-wait callers (omitted/NaN/
 * negative → 5 min default, explicit positive → capped at 1 hour); an
 * explicit `timeoutMs: 0` (any subscription) or an omitted `timeoutMs` on a
 * tree-only subscription now resolve to a 24h no-deadline ceiling instead —
 * see subscribeTimeout.ts. Only the response-writing was left to the caller
 * since this function doesn't have access to `res`.
 */
function parseSubscribeRequestBody(raw: Buffer): SubscribeRequestParseResult {
  let body: { workspaceIds?: unknown; timeoutMs?: unknown; until?: unknown; tree?: unknown }
  try {
    body = JSON.parse(raw.toString('utf-8')) as {
      workspaceIds?: unknown
      timeoutMs?: unknown
      until?: unknown
      tree?: unknown
    }
  } catch {
    return { ok: false, status: 400, error: 'invalid JSON body' }
  }

  const workspaceIds = Array.isArray(body.workspaceIds)
    ? (body.workspaceIds as unknown[]).filter((x): x is string => typeof x === 'string')
    : []

  // `tree: true` (docs/TUI_SPEC.md D5) opts this connection into the
  // full-snapshot `tree` frame stream, alongside whatever ws-wait status
  // frames `workspaceIds` also requests (both can be present at once; a
  // tree-only TUI subscription typically omits workspaceIds entirely, which
  // is why the emptiness check below is gated on `!includeTree`).
  const includeTree = body.tree === true

  if (workspaceIds.length === 0 && !includeTree) {
    return { ok: false, status: 400, error: 'workspaceIds must be a non-empty string[]' }
  }

  // --until — how specific a terminal state the caller wants to block for.
  // 'done' (default) preserves the historical behavior exactly: any non-running
  // state (awaiting_input, idle, blocked-permission, blocked-input) resolves.
  // 'input' blocks past awaiting_input/idle until the workspace is genuinely
  // blocked on the user. 'idle' blocks past awaiting_input until the workspace
  // is fully idle. The CLI already validates this client-side (exit 2 on a bad
  // value), so an invalid/missing value here just falls back to the default
  // rather than erroring the whole subscription.
  const until: UntilMode =
    typeof body.until === 'string' && isValidUntilMode(body.until) ? body.until : 'done'

  // Server-side timeout policy (resolveSubscribeTimeoutMs, subscribeTimeout.ts
  // — see that file's header for the full table + reasoning):
  //   - Exactly 0 (any subscription): explicit "no deadline requested" —
  //     resolves to SERVER_NO_DEADLINE_TIMEOUT_MS (24h), a long-but-finite
  //     ceiling, NOT Infinity and NOT passed through the 1-hour cap (that cap
  //     is for explicit positive values only). Never silently overridden —
  //     this is the literal caller-stated value. This is what makes the
  //     TUI's long-lived tree-mode subscriptions (`{ tree: true, timeoutMs: 0 }`
  //     — see tui/entry.ts) actually stay open
  //     indefinitely instead of being silently downgraded to the 5-minute
  //     default; the real protection against a leaked-forever subscription
  //     is the MAX_CONCURRENT_SUBSCRIPTIONS cap above (bounded fan-out), not
  //     this duration.
  //   - Omitted/non-number/NaN/negative on a tree-only (includeTree)
  //     subscription: also resolves to the no-deadline ceiling (a live tree
  //     view has no workspaceIds terminal condition to wait for) — but this
  //     is a narrower UX-only nicety, distinct from the primary explicit-zero
  //     rule, and is NOT applied to workspaceIds-based (ws-wait) subscriptions.
  //   - Omitted/non-number/NaN/negative on a workspaceIds-based subscription:
  //     5 minutes (SERVER_DEFAULT_TIMEOUT_MS) — unchanged from the original
  //     behavior; "didn't say" is not a deliberate signal from ws-wait callers.
  //   - Explicit positive value (any subscription): respected, capped at 1
  //     hour (SERVER_MAX_TIMEOUT_MS) — unchanged from the original behavior.
  const effectiveTimeoutMs = resolveSubscribeTimeoutMs(body.timeoutMs, includeTree)

  return { ok: true, workspaceIds, until, effectiveTimeoutMs, includeTree }
}

// ---------------------------------------------------------------------------
// /cmd — one-shot request/response dispatch helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the dispatch handler for `action`, mirroring the original inline
 * lookup exactly: only an own-property hit that is actually a function
 * counts as a handler (guards against action strings colliding with
 * Object.prototype members like 'toString').
 */
function resolveCmdHandler(
  dispatch: Record<string, DispatchFn>,
  action: string
): DispatchFn | undefined {
  const handlerCandidate = Object.prototype.hasOwnProperty.call(dispatch, action)
    ? dispatch[action]
    : undefined
  return typeof handlerCandidate === 'function' ? handlerCandidate : undefined
}

/**
 * Invoke a resolved /cmd dispatch handler and write its response envelope —
 * `{ ok: true, data }` on success, `{ ok: false, error }` on a thrown error.
 * Wrapped in try/catch so a throwing domain function never crashes the
 * socket; matches the original inline try/catch exactly, including writing
 * the error envelope with a 200 status (the /cmd contract puts success/
 * failure in the JSON body, not the HTTP status).
 */
async function dispatchCmdAndRespond(
  handler: DispatchFn,
  args: Record<string, unknown>,
  context: { workspaceId?: string },
  deps: CommandServerDeps,
  res: http.ServerResponse
): Promise<void> {
  try {
    const data = await handler(args, context, deps)
    writeJsonResponse(res, 200, { ok: true, data })
  } catch (err) {
    const message = clientSafeCommandErrorMessage(err)
    console.error('[commandServer] handler error:', redactErrorForLog(err))
    writeJsonResponse(res, 200, { ok: false, error: message })
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the command server on a Unix-domain socket. Returns the socket path,
 * auth token (written to cmd.token), and a close() function.
 *
 * Called unconditionally at startup (not gated on hooks integration) so the
 * CLI always has a channel even when hooks are disabled.
 */
export function startCommandServer(deps: CommandServerDeps): {
  sockPath: string
  token: string
  ready: Promise<void>
  close: () => void
} {
  const userData = app.getPath('userData')
  const sockPath = nodePath.join(userData, 'cmd.sock')
  const tokenPath = nodePath.join(userData, 'cmd.token')

  if (sockPath.length > 104) {
    throw new Error(
      `[commandServer] socket path too long for macOS (${sockPath.length} > 104 chars): ${sockPath}`
    )
  }

  // Generate a fresh random token each time the app starts.
  // Written to cmd.token (0o600) so only the current user can read it.
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(tokenPath, token, { mode: 0o600 })
  // Belt-and-suspenders chmod in case writeFileSync's mode argument is masked by umask.
  try {
    fs.chmodSync(tokenPath, 0o600)
  } catch {
    /* ignore — the writeFileSync mode should have set it */
  }

  // Remove stale socket file so listen() doesn't hit EADDRINUSE on a clean start.
  try {
    fs.unlinkSync(sockPath)
  } catch {
    /* ignore — file may not exist */
  }

  const dispatch = makeDispatchTable(deps, { sockPath, token })
  const catalogWaitControllers = new Set<AbortController>()

  // Global (not per-connection) status-change hook for the tree frame: any
  // workspace status transition schedules a debounced tree rebuild for every
  // connected tree-mode /subscribe consumer. Registered once for the life of
  // the server; unsubscribed in close() below.
  const unsubscribeTreeStatusObserver = onWorkspaceStatusChange(() => scheduleTreeFrameEmit())

  let listening = false
  let readySettled = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })

  // --------------------------------------------------------------------------
  // POST /control — runtime-lease-scoped Phase 2 MCP control protocol
  // --------------------------------------------------------------------------
  function handleControl(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Runtime authentication is intentionally separate from the legacy global
    // command token. A missing, invalid, or revoked runtime lease never falls
    // back to x-orpheus-token.
    const binding = resolveRuntimeLease(req, res, deps.runtimeLeases)
    if (binding == null) return

    void (async () => {
      try {
        const raw = await readBody(req, res)
        if (raw == null) return

        let parsedJson: unknown
        try {
          parsedJson = JSON.parse(raw.toString('utf-8'))
        } catch {
          writeControlError(res, 400, 'invalid', 'Invalid JSON body.')
          return
        }

        const request = parseControlRequest(parsedJson)
        if (request == null) {
          writeControlError(res, 400, 'invalid', 'Invalid or unsupported control request.')
          return
        }

        const context = runtimeControlContext(
          binding,
          deps.runtimeControlGrants,
          request.op === 'invoke' &&
            (request.id.startsWith('workbench.') ||
              request.id.startsWith('panes.') ||
              request.id.startsWith('terminals.'))
        )
        if (request.op === 'catalog') {
          const capabilities = deps.listControl(context).map(publishedControlDescription)
          writeJsonResponse(res, 200, {
            ok: true,
            data: {
              protocolVersion: 1,
              revision: deps.getControlCatalogRevision(),
              capabilities
            }
          })
          return
        }
        if (request.op === 'catalog.wait') {
          if (request.afterRevision > deps.getControlCatalogRevision()) {
            writeControlError(res, 400, 'invalid', 'Control catalog revision is invalid.')
            return
          }
          const controller = new AbortController()
          catalogWaitControllers.add(controller)
          const abortWait = (): void => controller.abort()
          res.once('close', abortWait)
          try {
            const result = await deps.waitForControlCatalogRevision(
              request.afterRevision,
              CONTROL_CATALOG_WAIT_MS,
              controller.signal
            )
            if (!controller.signal.aborted && !res.destroyed) {
              writeJsonResponse(res, 200, {
                ok: true,
                data: { protocolVersion: 1, ...result }
              })
            }
          } catch (error) {
            if (!controller.signal.aborted) throw error
          } finally {
            catalogWaitControllers.delete(controller)
            res.removeListener('close', abortWait)
          }
          return
        }

        const result = await deps.invokeControl({
          id: request.id,
          input: request.input,
          context
        })
        if (result.ok) {
          writeJsonResponse(res, 200, { ok: true, data: result.value })
        } else {
          writeControlError(res, 200, result.code, result.error)
        }
      } catch {
        writeControlError(res, 500, 'failed', 'Control request failed.')
      }
    })()

    req.on('error', () => {
      // Connection reset or early destroy — nothing to respond to.
    })
  }

  // --------------------------------------------------------------------------
  // POST /subscribe — long-lived streaming subscription endpoint (U11)
  // --------------------------------------------------------------------------
  function handleSubscribe(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!authenticate(req, res, token)) return
    // /subscribe owns its validated deadline (up to one hour). Disable the
    // server's 30-second idle socket timeout for this long-lived NDJSON route.
    req.socket.setTimeout(0)

    // --- Concurrent subscription cap ---
    if (activeSubscriptionCount >= MAX_CONCURRENT_SUBSCRIPTIONS) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: false,
          error: `too many concurrent subscriptions (max ${MAX_CONCURRENT_SUBSCRIPTIONS})`
        })
      )
      return
    }
    activeSubscriptionCount++
    // Guards against a double-release of this request's slot: the early
    // req.on('error') below and the async IIFE's own validation-failure
    // returns are mutually exclusive in practice (readBody never resolves
    // once the socket has errored — see readBody's implementation), but the
    // flag makes that guarantee explicit rather than relying on the timing.
    let slotReleased = false
    function releaseSlotOnce(): void {
      if (slotReleased) return
      slotReleased = true
      releaseSubscriptionSlot()
    }

    req.on('error', () => {
      releaseSlotOnce()
      if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
    })

    void (async () => {
      const raw = await readBody(req, res)
      if (raw == null) {
        releaseSlotOnce() // readBody already responded (413)
        return
      }

      const parsed = parseSubscribeRequestBody(raw)
      if (!parsed.ok) {
        releaseSlotOnce()
        if (!res.writableEnded) {
          res.writeHead(parsed.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: parsed.error }))
        }
        return
      }
      const { workspaceIds, until, effectiveTimeoutMs, includeTree } = parsed
      const waitSession = deps.workspaceWaitEngine.createSession(workspaceIds)

      // Start streaming response — keep connection open
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache'
      })

      // Tree-mode registration (docs/TUI_SPEC.md D5) — the callback writes
      // straight to this connection's own `res`, reusing writeFrame (defined
      // below): TreeFrame is a plain JSON-serializable shape, structurally
      // assignable to writeFrame's Record<string, unknown> parameter.
      let treeUnsubscribe: (() => void) | null = null
      if (includeTree) {
        const sendTreeFrame = (frame: TreeFrame): void => {
          writeFrame(frame)
        }
        treeFrameSubscribers.add(sendTreeFrame)
        ensureTreePolling()
        treeUnsubscribe = () => {
          treeFrameSubscribers.delete(sendTreeFrame)
          stopTreePollingIfIdle()
        }
        // "Emitted on: initial subscribe" (docs/TUI_SPEC.md) — a NEWLY joining
        // connection must see the current snapshot right away, regardless of
        // whether anything has changed since the last broadcast (this
        // connection has no prior frame to diff against). Replay the last
        // known-good frame synchronously when one exists; only the very
        // first tree subscriber ever (lastTreeFrame still null) falls
        // through to a real compute via the debounced path.
        if (lastTreeFrame != null) {
          sendTreeFrame(lastTreeFrame)
        } else {
          scheduleTreeFrameEmit()
        }
      }

      // Track which workspace ids have resolved to a terminal reason
      const resolved = new Map<string, string>() // workspaceId → reason

      // Track workspaces that have been observed alive at least once (busy/idle/waiting).
      // Used to distinguish "not yet started" (grace period) from "truly died": a workspace
      // is only mapped to 'died' when it transitions from a known-alive state to unknown.
      // This prevents ws-wait from falsely dying for a just-created workspace whose session
      // file hasn't appeared yet (startup race: ws new --task → ws wait <id> → 'died').

      // NOT-FOUND VALIDATION (QA fix — `ws wait <nonexistent-id>` was resolving as
      // 'died', conflating "genuinely dead" with "never existed"). Validate every
      // requested id against the DB RIGHT NOW, before any grace-window/deriveReason
      // machinery runs. A null getWorkspace() here means the id never existed at
      // subscribe time — resolve it immediately as 'not-found' and never enter the
      // wait loop for it. This also guards a multi-id batch: `ws wait <real> <fake>`
      // must report the fake id as 'not-found' without blocking or poisoning the
      // real id's eventual 'done'/'died'/etc — each id resolves independently via
      // the `resolved` map, so marking the fake one here just removes it from every
      // later loop (`checkAllResolved`, the observer, the initial-check loop, and the
      // timeout sweep all skip ids already in `resolved`).
      for (const workspaceId of workspaceIds) {
        if (getWorkspace(workspaceId) == null) {
          resolved.set(workspaceId, 'not-found')
          writeFrame({ id: workspaceId, reason: 'not-found', status: 'unknown' })
        }
      }

      // GRACE WINDOW (fixes: `ws send --submit` immediately followed by `ws wait`
      // reporting 'died' for a workspace that is actively booting/running).
      //
      // Root cause: right after `ws send --submit`, claude has just rewritten its
      // ~/.claude/sessions/<pid>.json to 'busy', but sessionState.ts's fs.watch +
      // 75ms debounce + reconcile() hasn't run yet, so liveSessionMap (and therefore
      // getWorkspaceFileInfo) still reads 'unknown'. The DB workspace.status is ALSO
      // stale at that instant (setStatusFromFile hasn't committed the busy transition
      // yet), so the old code fell through every DB-status branch to a final `died`.
      //
      // Fix, in order:
      //   1. Never trust a single 'unknown' read — force a synchronous reconcile
      //      (forceReconcile) and re-derive from a fresh read before concluding
      //      anything terminal. This closes the debounce gap directly.
      //   2. Cross-check with a second, independent ground-truth source
      //      (getWorkspaceFileStatusSync — reads the session file straight off disk,
      //      bypassing liveSessionMap entirely) in case the map is still cold even
      //      after a forced reconcile (e.g. the file only appeared mid-reconcile).
      //   3. For the first SUBSCRIPTION_GRACE_MS of a subscription's lifetime, an
      //      'unknown' status that survives both ground-truth checks is treated as
      //      "still starting/transitioning", never 'died'. A workspace that was just
      //      sent input needs a moment for claude to flush its status file; this is
      //      exactly that moment.
      //   4. 'died' is only ever concluded once the grace window has elapsed AND the
      //      ground-truth re-reads still can't find a live session — i.e. genuinely
      //      dead (session file gone / pid not alive), not just "the debounced cache
      //      hasn't caught up yet".
      // Derive terminal exit reason for a workspace from its live session file info.
      // Returns '' (empty string) when the workspace is still busy (not yet terminal).
      // Async: may force a reconcile() pass to get a ground-truth read before
      // concluding 'died' (see grace-window comment above).
      //
      // STARTUP GRACE: 'unknown' is only terminal ('died') when everSeenAlive contains
      // the workspace id — meaning it was previously observed alive and then disappeared.
      // If the workspace has never been seen alive, 'unknown' is treated as non-terminal
      // (the session file simply hasn't been written yet). The subscription timeout is the
      // backstop for a workspace that never starts.
      //
      // DB CROSS-CHECK (QA #4 — false 'died' on a just-completed turn):
      // getWorkspaceFileInfo can legitimately read 'unknown' for a workspace that is
      // very much alive/finished-cleanly: the window between claude finishing a turn
      // (session file rewritten to 'idle'/'waiting') and sessionState.ts's fs.watch
      // debounce settling can transiently drop liveSessionMap's view of the session,
      // or the on-disk file can be caught mid-write. Naively mapping every 'unknown'
      // (once everSeenAlive) to 'died' meant a workspace that had just gone
      // awaiting_input got misreported as 'died' on the FIRST wait, only to read
      // correctly as 'done' on a re-run once the race settled.
      //
      // Fix: before concluding 'died' for fileStatus === 'unknown', consult the
      // persisted DB workspace.status (the same field the GUI and `ws status` read).
      // That status is written synchronously by setStatusFromFile → dispatch →
      // setWorkspaceStatus, so it reflects the *last known-good* transition even
      // during a session-file read race:
      //   - workspace missing entirely (row deleted)          → 'died' if it was ever
      //     seen alive during this subscription (genuinely destroyed mid-wait), else
      //     'not-found' (it never existed in the first place — though the subscribe-
      //     start validation above should have already caught that case before this
      //     function is ever called for it; this branch is a defensive fallback for
      //     an id that somehow slipped past, e.g. a race with the DB row appearing
      //     and then vanishing between the start-of-subscribe check and here).
      //   - archivedAt != null                                → died (workspace is gone)
      //   - closedAt != null (deliberately closed by the user/CLI) → died (not live)
      //   - status === 'awaiting_input' or status === 'idle'  → 'done' — the DB already
      //     recorded the terminal, non-died outcome of the turn; surface that instead
      //     of re-deriving from a momentarily-stale file.
      //   - status === 'attention'                             → blocked-permission/input,
      //     derived from the DB's own detail (file's waitingFor is unavailable, so we
      //     fall back to blocked-input, the more common case).
      //   - status === 'in_progress'                           → still live, not yet
      //     terminal — 'unknown' here is the read race described above; keep waiting.
      // Only when NONE of the above apply (e.g. the DB row's status is somehow neither
      // live nor a resolvable terminal state) do we force a ground-truth reconcile and,
      // failing that, apply the grace window before ever concluding 'died'.
      // Resolve deriveReason()'s outcome for the fileStatus === 'unknown' case —
      // extracted verbatim (see the big comment block above deriveReason for the
      // full rationale: DB cross-check, ground-truth reconcile, grace window).
      // Mutates `everSeenAlive` in place exactly as the inline code did (same
      // Set instance, passed through).
      async function deriveReason(workspaceId: string, fromTransition: boolean): Promise<string> {
        void fromTransition
        const observation = await waitSession.observe(workspaceId)
        if (observation == null) return 'not-found'
        return legacyWaitReason(until, observation) ?? ''
      }

      // Apply the caller's --until mode to a raw reason from deriveReason().
      //
      // deriveReason() always computes the DEFAULT ('done') notion of terminal —
      // the workspace stopped running for ANY reason (awaiting_input, idle, or
      // blocked-*). --until narrows what counts as resolved for a 'done' reason
      // specifically; blocked-permission/blocked-input/died/not-found are always
      // terminal in every mode (a dead/missing/timed-out/blocked-on-user workspace
      // always resolves, regardless of --until).
      //
      // 'input' mode: a raw 'done' means the workspace reached awaiting_input/idle
      // WITHOUT being blocked on the user — that's exactly what 'input' mode wants
      // to wait PAST. So 'done' is downgraded to '' (keep waiting) under 'input'.
      //
      // 'idle' mode: a raw 'done' could mean either awaiting_input (turn-end, but
      // not fully settled) or idle (fully settled) — deriveReason() collapses both
      // into 'done'. To distinguish them we consult the DB's own workspace.status
      // column (WorkspaceStatus has distinct 'awaiting_input' and 'idle' values;
      // see getWorkspace()/rowToWorkspaceRecord in workspaces.ts), which is the same
      // source deriveReason() itself already falls back to during its race-window
      // handling. Only a DB status of exactly 'idle' resolves under 'idle' mode;
      // 'awaiting_input' (or anything else) is downgraded to '' (keep waiting).
      function applyUntilFilter(reason: string, workspaceId: string): string {
        if (reason !== 'done') return reason // blocked-*/died/not-found always terminal

        if (until === 'done') return reason // default — unchanged behavior

        if (until === 'input') {
          // 'done' here means non-blocked (awaiting_input/idle) — not what 'input' wants.
          return ''
        }

        // until === 'idle': only a genuine DB status of 'idle' counts.
        const ws = getWorkspace(workspaceId)
        if (ws?.status === 'idle') return 'done'
        return '' // awaiting_input (or unresolved) — keep waiting
      }

      function isTerminalReason(reason: string): boolean {
        return (
          reason === 'done' ||
          reason === 'blocked-permission' ||
          reason === BLOCKED_INPUT ||
          reason === 'died' ||
          reason === 'not-found'
        )
      }

      function writeFrame(frame: Record<string, unknown>): void {
        if (!res.writableEnded) {
          try {
            res.write(JSON.stringify(frame) + '\n')
          } catch {
            /* client disconnected */
          }
        }
      }

      function checkAllResolved(): boolean {
        return workspaceIds.every((id) => resolved.has(id))
      }

      // Cleanup state — must be called on EVERY exit path to prevent observer leaks
      let unsubscribe: (() => void) | null = null
      let timeoutHandle: NodeJS.Timeout | null = null
      let cleanedUp = false

      function cleanup(): void {
        if (cleanedUp) return
        cleanedUp = true
        activeSubscriptionCount = Math.max(0, activeSubscriptionCount - 1)
        if (timeoutHandle != null) {
          clearTimeout(timeoutHandle)
          timeoutHandle = null
        }
        // Unregister the status observer — CRITICAL leak prevention
        if (unsubscribe != null) {
          unsubscribe()
          unsubscribe = null
        }
        if (treeUnsubscribe != null) {
          treeUnsubscribe()
          treeUnsubscribe = null
        }
        waitSession.dispose()
        if (!res.writableEnded) {
          try {
            res.end()
          } catch {
            /* ignore */
          }
        }
      }

      // Register status change observer for the requested workspace ids.
      // onWorkspaceStatusChange returns the unsubscribe function.
      // We derive the reason from getWorkspaceFileInfo, so the old/new status
      // args are unused — omit them (a narrower callback is assignable).
      // deriveReason is async (it may force a reconcile pass for ground truth), but
      // onWorkspaceStatusChange's observer callback is synchronous by type. Fire the
      // async work from inside a void-returning wrapper; resolved.has(workspaceId) is
      // re-checked after the await resolves to guard against another observer firing
      // (or the initial check completing) while this one was awaiting forceReconcile.
      unsubscribe = onWorkspaceStatusChange((workspaceId) => {
        if (!workspaceIds.includes(workspaceId)) return
        if (resolved.has(workspaceId)) return

        void (async () => {
          // fromTransition=true: this is a real status-change event, so 'unknown'
          // means the workspace was alive and its session file just disappeared → 'died'.
          const rawReason = await deriveReason(workspaceId, true)
          if (resolved.has(workspaceId)) return // resolved by another path while awaiting
          // Narrow a raw 'done' per the caller's --until mode (see applyUntilFilter).
          // blocked-*/died/not-found pass through unchanged in every mode.
          const reason = applyUntilFilter(rawReason, workspaceId)
          if (!isTerminalReason(reason)) return // still busy, not yet terminal per --until

          resolved.set(workspaceId, reason)
          const info = getWorkspaceFileInfo(workspaceId)
          writeFrame({ id: workspaceId, reason, status: info.status })

          if (checkAllResolved()) {
            cleanup()
          }
        })()
      })

      // Initial check: emit immediately for any workspace already in a terminal state.
      // This handles the case where a workspace was already idle/waiting before subscribe.
      // fromTransition=false: use startup grace — 'unknown' here means the session file
      // hasn't been written yet (workspace just created), not that the process died.
      // Sequential await (not Promise.all) keeps this simple; each iteration is cheap
      // unless it hits the forceReconcile ground-truth path, and even then bounded.
      for (const workspaceId of workspaceIds) {
        if (resolved.has(workspaceId)) continue
        const rawReason = await deriveReason(workspaceId, false)
        if (resolved.has(workspaceId)) continue // resolved by a transition while awaiting
        // Narrow a raw 'done' per the caller's --until mode (see applyUntilFilter).
        const reason = applyUntilFilter(rawReason, workspaceId)
        if (isTerminalReason(reason)) {
          resolved.set(workspaceId, reason)
          const info = getWorkspaceFileInfo(workspaceId)
          writeFrame({ id: workspaceId, reason, status: info.status })
        }
      }

      // workspaceIds.length === 0 (a tree-only subscription — see includeTree
      // above) would make checkAllResolved() vacuously true via .every() on
      // an empty array; guard on a non-empty list so a tree-only connection
      // isn't torn down immediately after its initial snapshot is scheduled.
      if (workspaceIds.length > 0 && checkAllResolved()) {
        cleanup()
        return
      }

      // Arm server-side timeout — fires if not all ids resolve within effectiveTimeoutMs.
      timeoutHandle = setTimeout(() => {
        timeoutHandle = null
        // Emit timeout frames for any still-unresolved ids
        for (const workspaceId of workspaceIds) {
          if (!resolved.has(workspaceId)) {
            resolved.set(workspaceId, 'timeout')
            writeFrame({ id: workspaceId, reason: 'timeout', status: 'unknown' })
          }
        }
        cleanup()
      }, effectiveTimeoutMs)

      // Client disconnect cleanup — CRITICAL: unsubscribe must fire here too
      req.on('close', () => {
        cleanup()
      })

      req.on('error', () => {
        cleanup()
      })
    })()
  }

  // --------------------------------------------------------------------------
  // POST /cmd — one-shot request/response command dispatch
  // --------------------------------------------------------------------------
  function handleCmd(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    dispatch: Record<string, DispatchFn>
  ): void {
    if (!authenticate(req, res, token)) return

    void (async () => {
      try {
        const raw = await readBody(req, res)
        if (raw == null) return // readBody already responded (413)

        // --- Parse JSON body ---
        let body: unknown
        try {
          body = JSON.parse(raw.toString('utf-8')) as unknown
        } catch {
          writeJsonResponse(res, 400, { ok: false, error: 'invalid JSON body' })
          return
        }

        const action = parseCommandAction(body)
        if (action == null) {
          writeJsonResponse(res, 400, { ok: false, error: 'invalid action' })
          return
        }
        const { args = {}, context = {} } = body as CmdBody
        // --- Dispatch ---
        const handler = resolveCmdHandler(dispatch, action)
        if (!handler) {
          writeJsonResponse(res, 400, { ok: false, error: `unknown action: ${action}` })
          return
        }

        await dispatchCmdAndRespond(handler, args, context, deps, res)
      } catch (err) {
        // Outer catch: unexpected error in the request handler — swallow to
        // prevent an unhandled rejection from crashing the process.
        logDiagMain({
          category: 'error',
          level: 'error',
          event: DIAG_EVENTS.CMD_SERVER_HANDLER_FAILED,
          data: { err: String(err) }
        })
      }
    })()

    req.on('error', () => {
      // Connection reset or early destroy — nothing to respond to.
    })
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/control') {
      handleControl(req, res)
      return
    }

    if (req.method === 'POST' && req.url === '/subscribe') {
      handleSubscribe(req, res)
      return
    }

    // Only accept POST /cmd — anything else gets a 404.
    if (req.method !== 'POST' || req.url !== '/cmd') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
      return
    }

    handleCmd(req, res, dispatch)
  })

  server.setTimeout(30000)

  server.listen(sockPath, () => {
    listening = true
    // Restrict the socket to the current user only (matches notify.sock).
    try {
      fs.chmodSync(sockPath, 0o600)
    } catch (err) {
      console.error('[commandServer] could not chmod cmd.sock to 0600:', redactErrorForLog(err))
      if (!readySettled) {
        readySettled = true
        rejectReady(new Error('Command socket permissions could not be secured.'))
      }
      server.close()
      listening = false
      try {
        fs.unlinkSync(sockPath)
      } catch {
        /* ignore */
      }
      return
    }
    console.log('[commandServer] listening on', sockPath)
    readySettled = true
    resolveReady()
  })

  server.on('error', (err) => {
    console.error('[commandServer] server error:', redactErrorForLog(err))
    // Clean up the socket file so a subsequent start doesn't hit EADDRINUSE.
    try {
      fs.unlinkSync(sockPath)
    } catch {
      /* ignore — file may not exist if listen never bound */
    }
    if (!readySettled) {
      readySettled = true
      rejectReady(err)
    }
  })

  return {
    sockPath,
    token,
    ready,
    close(): void {
      unsubscribeTreeStatusObserver()
      if (treePollInterval != null) {
        clearInterval(treePollInterval)
        treePollInterval = null
      }
      if (treeDebounceTimer != null) {
        clearTimeout(treeDebounceTimer)
        treeDebounceTimer = null
      }
      treeFrameSubscribers.clear()
      lastTreeFrame = null
      for (const controller of catalogWaitControllers) controller.abort()
      catalogWaitControllers.clear()
      if (
        typeof (server as http.Server & { closeAllConnections?: () => void })
          .closeAllConnections === 'function'
      ) {
        ;(server as http.Server & { closeAllConnections: () => void }).closeAllConnections()
      }
      if (listening) {
        server.close()
      }
      try {
        fs.unlinkSync(sockPath)
      } catch {
        /* ignore */
      }
    }
  }
}
