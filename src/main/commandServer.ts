import * as http from 'node:http'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import * as crypto from 'node:crypto'
import { app } from 'electron'
import { getDb } from './db'
import {
  createWorkspace,
  getWorkspace,
  reopenWorkspace,
  renameWorkspace,
  listChildWorkspaces,
  getWorkspaceLineage
} from './workspaces'
import { getClaudeGlobalSettings } from './claudeSettings'
import { updateClaudeWorkspaceSettings } from './claudeWorkspaceSettings'
import { getProjectById } from './projects'
import type { WorkspaceRecord, ClaudePermissionMode, ClaudeEffort } from '../shared/types'
import { onWorkspaceStatusChange } from './orpheusNotify'
import { getWorkspaceFileInfo, getWorkspaceFileStatusSync, forceReconcile } from './sessionState'

// ---------------------------------------------------------------------------
// Deps injected from index.ts (these live as locals there, so we receive them
// as callbacks rather than importing them directly).
// ---------------------------------------------------------------------------

export type CommandServerDeps = {
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
   * Destroy surface + teardown + DB archiveWorkspace in one shot.
   * Mirrors performArchive in index.ts.
   */
  performArchive: (workspaceId: string) => void
  /**
   * Send 'workspace:requestOpen' to the renderer so it opens and mounts the
   * given workspace via the normal handleSelectWorkspace path. Used by U8/U12.
   */
  requestOpenWorkspace: (workspaceId: string) => void
  /**
   * Open a workspace in the GUI and inject a seed task once the surface is
   * injectable. Implemented in index.ts using requestOpenWorkspace + a bounded
   * poll on canInject + terminalActions.sendInput/submit. Returns a warning
   * string if the surface failed to become injectable within the timeout, null
   * on success. The workspace is always created regardless; only the injection
   * may be skipped.
   */
  openAndSeed: (workspaceId: string, taskText: string) => Promise<string | null>
  /**
   * Send text, a named key, and/or submit to a running workspace. If the
   * workspace surface is not yet injectable, opens it (requestOpenWorkspace)
   * and polls canInject up to a bounded timeout (10 s) before injecting.
   * Returns { ok: true } on success or { ok: false, error: string } on failure
   * (surface not ready, timeout, send error).
   */
  sendToWorkspace: (
    workspaceId: string,
    payload: { text?: string; submit?: boolean; key?: string }
  ) => Promise<{ ok: boolean; error?: string }>
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

const BODY_SIZE_LIMIT = 10 * 1024 * 1024 // 10 MB

type CmdBody = {
  action: string
  args?: Record<string, unknown>
  context?: { workspaceId?: string }
}

type DispatchFn = (
  args: Record<string, unknown>,
  context: { workspaceId?: string },
  deps: CommandServerDeps
) => Promise<unknown> | unknown

// ---------------------------------------------------------------------------
// Dispatch table — one entry per supported CLI action.
// ---------------------------------------------------------------------------

function makeDispatchTable(deps: CommandServerDeps): Record<string, DispatchFn> {
  return {
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
    'workspace.create': async (args, context, innerDeps) => {
      if (typeof args.projectId !== 'string') throw new Error('args.projectId is required')
      if (typeof args.cwd !== 'string') throw new Error('args.cwd is required')
      const projectExists = getDb()
        .prepare('SELECT id FROM projects WHERE id = ?')
        .get(args.projectId)
      if (!projectExists) throw new Error(`project not found: ${args.projectId}`)

      // Determine parent workspace id: explicit arg > caller's context workspace
      const parentId: string | null =
        typeof args.parentWorkspaceId === 'string'
          ? args.parentWorkspaceId
          : (context?.workspaceId ?? null)

      // CROSS-PROJECT VALIDATION — explicit parentWorkspaceId must belong to the same project.
      // A crafted parent from a different project could bypass depth/children caps (the
      // lineage and children queries are project-unaware). context.workspaceId is trusted
      // as the real caller; only an explicitly supplied parentWorkspaceId is validated.
      if (
        typeof args.parentWorkspaceId === 'string' &&
        args.parentWorkspaceId !== context?.workspaceId
      ) {
        const parentRow = getDb()
          .prepare('SELECT id, project_id FROM workspaces WHERE id = ? AND archived_at IS NULL')
          .get(args.parentWorkspaceId) as { id: string; project_id: string } | undefined
        if (!parentRow) {
          throw new Error(`parent workspace not found or archived: ${args.parentWorkspaceId}`)
        }
        if (parentRow.project_id !== args.projectId) {
          throw new Error(
            `parent workspace ${args.parentWorkspaceId} belongs to a different project — ` +
              `cross-project parenting is not allowed`
          )
        }
      }

      // GUARDRAIL CHECK — only when there is an explicit parent
      if (parentId != null) {
        const globalSettings = getClaudeGlobalSettings()
        const maxChildren = globalSettings.maxWorkspaceChildren ?? 10
        const maxDepth = globalSettings.maxWorkspaceDepth ?? 3

        // Children check: how many non-archived children does the parent already have?
        const existingChildren = listChildWorkspaces(parentId)
        if (existingChildren.length >= maxChildren) {
          throw new Error(
            `Max children (${maxChildren}) reached for this workspace. Don't spawn more workspaces — ` +
              `use subagents (Agent tool) or teammates within an existing workspace instead, ` +
              `or archive finished workers to free slots.`
          )
        }

        // Depth check: how deep in the lineage would the new workspace be?
        // getWorkspaceLineage returns root→parent chain (inclusive of parent).
        // The new workspace would be at depth lineage.length + 1.
        const lineage = getWorkspaceLineage(parentId)
        const newDepth = lineage.length + 1
        if (newDepth > maxDepth) {
          throw new Error(
            `Max workspace depth (${maxDepth}) would be exceeded. Don't nest workspaces further — ` +
              `use subagents (Agent tool) or teammates within an existing workspace instead.`
          )
        }
      }

      // Fork support: look up parent's claudeSessionId when --fork is requested
      let forkedFromSessionId: string | null = null
      if (args.fork === true) {
        if (parentId == null) {
          throw new Error(
            '--fork requires a parent workspace. Run from inside a workspace (ORPHEUS_WORKSPACE_ID) or pass --parent.'
          )
        }
        const parentWs = getWorkspace(parentId)
        if (parentWs == null) {
          throw new Error(`parent workspace not found: ${parentId}`)
        }
        if (parentWs.claudeSessionId == null) {
          throw new Error(
            `parent workspace ${parentId} has no claude session yet — cannot fork before a session is established`
          )
        }
        forkedFromSessionId = parentWs.claudeSessionId
      }

      const name = typeof args.name === 'string' && args.name !== '' ? args.name : 'New workspace'
      const ws = createWorkspace({
        projectId: args.projectId,
        name,
        cwd: args.cwd,
        forkedFromSessionId,
        parentWorkspaceId: parentId
      })

      // Apply workspace-level settings overrides (model / permissionMode / effort)
      // These are stored in claude_workspace_settings and picked up by composeClaudeLaunch.
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
      const VALID_EFFORTS: ClaudeEffort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max']
      if (typeof args.effort === 'string' && VALID_EFFORTS.includes(args.effort as ClaudeEffort)) {
        settingsOverride.effort = args.effort as ClaudeEffort
      }
      if (Object.keys(settingsOverride).length > 0) {
        updateClaudeWorkspaceSettings(ws.id, settingsOverride)
      }

      // ACTIVATION (user directive): a newly created workspace must never be left
      // created-but-closed. Previously requestOpenWorkspace only fired via
      // openAndSeed, and only when --task was given — a task-less `ws new` just
      // inserted the DB row and returned, leaving the workspace looking CLOSED/
      // inactive in the UI (closedAt is null by default, but the renderer never
      // mounts+selects it, so nothing about the workspace is "live" until the
      // user manually clicks it). Fix: ALWAYS activate.
      //   - task present    → openAndSeed (opens via requestOpenWorkspace internally,
      //                       then injects the task once the surface is injectable).
      //   - task absent     → requestOpenWorkspace directly (opens/mounts, no injection).
      // Either way the renderer receives the open signal and mounts the workspace;
      // closedAt is never set on a freshly created workspace (createWorkspace doesn't
      // touch it), so this only affects whether the surface is actually live.
      let seedWarning: string | null = null
      const taskText = typeof args.task === 'string' && args.task !== '' ? args.task : null
      if (taskText != null) {
        seedWarning = await innerDeps.openAndSeed(ws.id, taskText)
      } else {
        innerDeps.requestOpenWorkspace(ws.id)
      }

      return { workspace: ws, seedWarning }
    },

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
    'workspace.archive': (args, context) => {
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      const recursive = args.recursive === true

      // Root-must-exist check (single AND recursive) — see comment above.
      const root = getWorkspace(args.id)
      if (root == null) {
        throw new Error(`workspace not found: ${args.id}`)
      }

      if (recursive) {
        // Collect the full subtree rooted at args.id (BFS), then archive leaves-up.
        // Self-action guard: refuse if the caller's own workspace is within the subtree.
        // visited Set prevents infinite loops from corrupted parent_workspace_id cycles.
        const subtreeIds: string[] = []
        const visited = new Set<string>()
        const queue: string[] = [args.id]
        while (queue.length > 0) {
          const current = queue.shift()!
          if (visited.has(current)) continue // cycle guard
          visited.add(current)
          subtreeIds.push(current)
          const children = listChildWorkspaces(current)
          for (const child of children) {
            if (!visited.has(child.id)) {
              queue.push(child.id)
            }
          }
        }

        if (context?.workspaceId != null && subtreeIds.includes(context.workspaceId)) {
          throw new Error(
            `cannot archive your own workspace (id=${context.workspaceId}): it is within the requested subtree`
          )
        }

        // Archive leaves-up: reverse the BFS order so children come before parents.
        // Each subtree member is guaranteed to exist (it was discovered via
        // listChildWorkspaces from a live parent), so no per-id existence check
        // is needed here — only the root needed the explicit check above.
        for (let i = subtreeIds.length - 1; i >= 0; i--) {
          deps.performArchive(subtreeIds[i]!)
        }

        return { archived: true, count: subtreeIds.length }
      }

      // Non-recursive (single) archive.
      // Self-action guard: refuse if caller is archiving their own workspace.
      if (context?.workspaceId != null && args.id === context.workspaceId) {
        throw new Error(`cannot archive your own workspace (id=${args.id})`)
      }

      deps.performArchive(args.id)
      return { archived: true }
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
    'workspace.close': (args, context) => {
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      if (getWorkspace(args.id) == null) {
        throw new Error(`workspace not found: ${args.id}`)
      }
      if (context?.workspaceId != null && args.id === context.workspaceId) {
        throw new Error(`cannot close your own workspace (id=${args.id})`)
      }
      const workspace = deps.performClose(args.id)
      return { workspace: workspace ?? null }
    },

    // Reopen a previously-closed workspace (clears closed_at).
    //
    // DATA-INTEGRITY FIX (mirrors workspace.archive): reopenWorkspace is a
    // silent no-op UPDATE — it returns undefined for a nonexistent id instead
    // of throwing, so previously this dispatch reported { workspace: null }
    // (success-shaped) even when args.id never existed. Fix: getWorkspace(id)
    // FIRST.
    'workspace.reopen': (args) => {
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      if (getWorkspace(args.id) == null) {
        throw new Error(`workspace not found: ${args.id}`)
      }
      const workspace = reopenWorkspace(args.id)
      return { workspace: workspace ?? null }
    },

    // Rename a workspace.
    // NOTE: no explicit existence guard needed here — renameWorkspace() in
    // workspaces.ts already throws `renameWorkspace: workspace not found: <id>`
    // when the UPDATE...RETURNING matches zero rows, so a nonexistent id
    // already surfaces as a real error (not a false success). Adding a
    // redundant getWorkspace() check here would just duplicate that.
    'workspace.rename': (args) => {
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      if (typeof args.name !== 'string') throw new Error('args.name is required')
      return renameWorkspace(args.id, args.name)
    },

    // Ask the renderer to open (and mount) a workspace via the normal
    // handleSelectWorkspace path. Used by U8 (ws new --task) and U12 (ws send
    // to an unmounted workspace) after this plumbing lands in U14.
    'workspace.open': (args) => {
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      deps.requestOpenWorkspace(args.id)
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
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      const text = typeof args.text === 'string' && args.text !== '' ? args.text : undefined
      const submit = args.submit === true
      const key = typeof args.key === 'string' && args.key !== '' ? args.key : undefined
      if (text == null && key == null && !submit) {
        throw new Error('at least one of args.text, args.key, or args.submit is required')
      }
      const result = await innerDeps.sendToWorkspace(args.id, { text, submit, key })
      if (!result.ok) {
        throw new Error(result.error ?? 'send failed')
      }
      return { ok: true }
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
      const project = getProjectById(ws.projectId)
      return {
        workspaceId,
        projectId: ws.projectId,
        projectName: project?.name ?? null,
        cwd: ws.cwd
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Subscription cap — prevents unbounded open /subscribe connections.
// ---------------------------------------------------------------------------

/** Maximum concurrent /subscribe connections allowed. */
const MAX_CONCURRENT_SUBSCRIPTIONS = 32
/** Current count of active /subscribe connections. */
let activeSubscriptionCount = 0

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

  const dispatch = makeDispatchTable(deps)

  let listening = false

  const server = http.createServer((req, res) => {
    // --------------------------------------------------------------------------
    // POST /subscribe — long-lived streaming subscription endpoint (U11)
    // --------------------------------------------------------------------------
    if (req.method === 'POST' && req.url === '/subscribe') {
      // --- Token authentication (same as /cmd) ---
      const incomingToken = req.headers['x-orpheus-token']
      if (typeof incomingToken !== 'string') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
        return
      }
      const incomingBuf = Buffer.from(incomingToken, 'utf-8')
      const expectedBuf = Buffer.from(token, 'utf-8')
      const tokenValid =
        incomingBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(incomingBuf, expectedBuf)
      if (!tokenValid) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
        return
      }

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

      // --- Read body ---
      const subChunks: Buffer[] = []
      let subAccumulated = 0
      let subOversized = false

      req.on('data', (chunk: Buffer) => {
        if (subOversized) return
        subAccumulated += chunk.length
        if (subAccumulated > BODY_SIZE_LIMIT) {
          subOversized = true
          req.destroy()
          return
        }
        subChunks.push(chunk)
      })

      req.on('end', async () => {
        if (subOversized) return

        let body: { workspaceIds?: unknown; timeoutMs?: unknown }
        try {
          body = JSON.parse(Buffer.concat(subChunks).toString('utf-8')) as {
            workspaceIds?: unknown
            timeoutMs?: unknown
          }
        } catch {
          if (!res.writableEnded) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
          }
          return
        }

        const workspaceIds = Array.isArray(body.workspaceIds)
          ? (body.workspaceIds as unknown[]).filter((x): x is string => typeof x === 'string')
          : []

        if (workspaceIds.length === 0) {
          if (!res.writableEnded) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(
              JSON.stringify({ ok: false, error: 'workspaceIds must be a non-empty string[]' })
            )
          }
          return
        }

        // Server-side timeout policy:
        //   - Default (timeoutMs omitted or zero): 5 minutes (300 000 ms)
        //   - Explicit caller value: respected up to 1 hour hard cap
        //   - 1 hour cap still accessible for callers that explicitly opt in
        const SERVER_MAX_TIMEOUT_MS = 60 * 60 * 1000
        const SERVER_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
        const requestedTimeout =
          typeof body.timeoutMs === 'number' && body.timeoutMs > 0
            ? body.timeoutMs
            : SERVER_DEFAULT_TIMEOUT_MS
        const effectiveTimeoutMs = Math.min(requestedTimeout, SERVER_MAX_TIMEOUT_MS)

        // Start streaming response — keep connection open
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-cache'
        })

        // Track which workspace ids have resolved to a terminal reason
        const resolved = new Map<string, string>() // workspaceId → reason

        // Track workspaces that have been observed alive at least once (busy/idle/waiting).
        // Used to distinguish "not yet started" (grace period) from "truly died": a workspace
        // is only mapped to 'died' when it transitions from a known-alive state to unknown.
        // This prevents ws-wait from falsely dying for a just-created workspace whose session
        // file hasn't appeared yet (startup race: ws new --task → ws wait <id> → 'died').
        const everSeenAlive = new Set<string>()

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
        const SUBSCRIPTION_GRACE_MS = 5000
        const subscriptionStartedAt = Date.now()

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
        //   - workspace missing entirely (row deleted)          → died (can't be live)
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
        async function deriveReason(workspaceId: string, fromTransition: boolean): Promise<string> {
          const info = getWorkspaceFileInfo(workspaceId)
          const fileStatus = info.status
          const waitingFor = info.waitingFor ?? ''

          if (fileStatus === 'busy' || fileStatus === 'idle' || fileStatus === 'waiting') {
            everSeenAlive.add(workspaceId)
          }

          if (fileStatus === 'unknown') {
            const ws = getWorkspace(workspaceId)

            if (ws == null) {
              // Workspace row is gone entirely — cannot be live.
              return 'died'
            }
            if (ws.archivedAt != null) {
              // Archived — teardown already happened; treat as died (not a live wait target).
              return 'died'
            }
            if (ws.closedAt != null) {
              // Deliberately closed — not live, but not a crash either. 'died' is the
              // closest terminal bucket ws-wait has; the caller closed it on purpose.
              return 'died'
            }
            if (ws.status === 'awaiting_input' || ws.status === 'idle') {
              // The DB already recorded the turn's terminal outcome (awaiting_input/idle)
              // via setStatusFromFile before this file read raced past it. Report the
              // real outcome — never 'died' — even though the file momentarily reads
              // 'unknown'.
              return 'done'
            }
            if (ws.status === 'attention') {
              // DB says the workspace is blocked on something; file's waitingFor detail
              // isn't available in this race, so default to the more common case.
              return waitingFor.toLowerCase().includes('permission')
                ? 'blocked-permission'
                : 'blocked-input'
            }
            if (ws.status === 'in_progress') {
              // DB says the workspace is still actively running — 'unknown' here is a
              // transient file-read race, not a death. Keep waiting.
              return ''
            }

            // GROUND TRUTH before any 'died' conclusion: force a synchronous reconcile
            // (refreshes liveSessionMap from disk right now, not on the next debounce
            // tick) and re-read. If the workspace is actually busy/idle/waiting, use
            // that — it was never dead, just a cold cache.
            await forceReconcile()
            const refreshedInfo = getWorkspaceFileInfo(workspaceId)
            if (refreshedInfo.status === 'busy') {
              everSeenAlive.add(workspaceId)
              return ''
            }
            if (refreshedInfo.status === 'idle') {
              everSeenAlive.add(workspaceId)
              return 'done'
            }
            if (refreshedInfo.status === 'waiting') {
              everSeenAlive.add(workspaceId)
              const refreshedWaitingFor = (refreshedInfo.waitingFor ?? '').toLowerCase()
              return refreshedWaitingFor.includes('permission')
                ? 'blocked-permission'
                : 'blocked-input'
            }

            // Second, independent ground-truth source: read the session file straight
            // off disk, bypassing liveSessionMap entirely, in case the map is still
            // cold even right after a forced reconcile (e.g. the file only appeared
            // mid-reconcile, or the pid/sessionId pairing hasn't been observed yet).
            const syncStatus = getWorkspaceFileStatusSync(workspaceId)
            if (syncStatus === 'busy') {
              everSeenAlive.add(workspaceId)
              return ''
            }
            if (syncStatus === 'idle') {
              everSeenAlive.add(workspaceId)
              return 'done'
            }
            if (syncStatus === 'waiting') {
              everSeenAlive.add(workspaceId)
              return 'blocked-input'
            }

            // Still genuinely unknown after BOTH ground-truth refreshes. Only now
            // consider 'died' — and only once the subscription's startup grace window
            // has elapsed. A workspace that was just created/sent-to is transitioning;
            // giving it a few seconds to flush its first status file prevents the
            // false-died race this fix targets.
            const withinGraceWindow = Date.now() - subscriptionStartedAt < SUBSCRIPTION_GRACE_MS
            if (withinGraceWindow) {
              return '' // still within grace — not yet terminal
            }

            // Genuine death = confirmed gone even after ground-truth refresh, AND
            // either this is a real transition event (the workspace was live and its
            // status observably changed) or it was previously seen alive and has now
            // disappeared. Otherwise (initial check, workspace never observed alive,
            // grace window elapsed with no session ever appearing) keep waiting — the
            // subscription timeout is the backstop for a workspace that never starts.
            if (fromTransition || everSeenAlive.has(workspaceId)) {
              return 'died'
            }
            return '' // startup grace — not yet terminal
          }
          if (fileStatus === 'idle') {
            return 'done'
          }
          if (fileStatus === 'waiting') {
            if (waitingFor.toLowerCase().includes('permission')) {
              return 'blocked-permission'
            }
            return 'blocked-input'
          }
          // fileStatus === 'busy' — still running; not yet terminal
          return ''
        }

        function isTerminalReason(reason: string): boolean {
          return (
            reason === 'done' ||
            reason === 'blocked-permission' ||
            reason === 'blocked-input' ||
            reason === 'died'
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
            const reason = await deriveReason(workspaceId, true)
            if (resolved.has(workspaceId)) return // resolved by another path while awaiting
            if (!isTerminalReason(reason)) return // still busy, not yet terminal

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
          const reason = await deriveReason(workspaceId, false)
          if (resolved.has(workspaceId)) continue // resolved by a transition while awaiting
          if (isTerminalReason(reason)) {
            resolved.set(workspaceId, reason)
            const info = getWorkspaceFileInfo(workspaceId)
            writeFrame({ id: workspaceId, reason, status: info.status })
          }
        }

        if (checkAllResolved()) {
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
      })

      req.on('error', () => {
        if (!res.writableEnded) {
          try {
            res.end()
          } catch {
            /* ignore */
          }
        }
      })

      return
    }

    // Only accept POST /cmd — anything else gets a 404.
    if (req.method !== 'POST' || req.url !== '/cmd') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
      return
    }

    // --- Token authentication (constant-time comparison) ---
    const incomingToken = req.headers['x-orpheus-token']
    if (typeof incomingToken !== 'string') {
      // Missing token — reject without any comparison.
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
      return
    }
    const incomingBuf = Buffer.from(incomingToken, 'utf-8')
    const expectedBuf = Buffer.from(token, 'utf-8')
    // Guard: timingSafeEqual throws if the two buffers differ in length,
    // so we check lengths first and short-circuit as false (not as an early accept).
    const tokenValid =
      incomingBuf.length === expectedBuf.length && crypto.timingSafeEqual(incomingBuf, expectedBuf)
    if (!tokenValid) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
      return
    }

    // --- Body-size cap (checked early via Content-Length, then guarded on stream) ---
    const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
    if (!isNaN(contentLength) && contentLength > BODY_SIZE_LIMIT) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'request too large' }))
      return
    }

    const chunks: Buffer[] = []
    let accumulated = 0
    let oversized = false

    req.on('data', (chunk: Buffer) => {
      if (oversized) return
      accumulated += chunk.length
      if (accumulated > BODY_SIZE_LIMIT) {
        // Streaming body exceeded the cap — abort and respond.
        oversized = true
        req.destroy()
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'request too large' }))
        return
      }
      chunks.push(chunk)
    })

    req.on('end', async () => {
      if (oversized) return // already responded

      try {
        // --- Parse JSON body ---
        let body: CmdBody
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as CmdBody
        } catch {
          if (!res.writableEnded) {
            try {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }))
            } catch {
              /* client disconnected */
            }
          }
          return
        }

        const { action, args = {}, context = {} } = body

        // --- Dispatch ---
        const handlerCandidate = Object.prototype.hasOwnProperty.call(dispatch, action)
          ? dispatch[action]
          : undefined
        const handler =
          typeof handlerCandidate === 'function' ? (handlerCandidate as DispatchFn) : undefined
        if (!handler) {
          if (!res.writableEnded) {
            try {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: `unknown action: ${action}` }))
            } catch {
              /* client disconnected */
            }
          }
          return
        }

        try {
          // Wrap in try/catch so a throwing domain function never crashes the socket.
          const data = await handler(args, context, deps)
          if (!res.writableEnded) {
            try {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: true, data }))
            } catch {
              /* client disconnected */
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (!res.writableEnded) {
            try {
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: message }))
            } catch {
              /* client disconnected */
            }
          }
        }
      } catch {
        // Outer catch: unexpected error in the request handler — swallow to
        // prevent an unhandled rejection from crashing the process.
      }
    })

    req.on('error', () => {
      // Connection reset or early destroy — nothing to respond to.
    })
  })

  server.setTimeout(30000)

  server.listen(sockPath, () => {
    listening = true
    // Restrict the socket to the current user only (matches notify.sock).
    try {
      fs.chmodSync(sockPath, 0o600)
    } catch (err) {
      console.warn('[commandServer] could not chmod cmd.sock to 0600:', err)
    }
    console.log('[commandServer] listening on', sockPath)
  })

  server.on('error', (err) => {
    console.error('[commandServer] server error:', err)
    // Clean up the socket file so a subsequent start doesn't hit EADDRINUSE.
    try {
      fs.unlinkSync(sockPath)
    } catch {
      /* ignore — file may not exist if listen never bound */
    }
  })

  return {
    sockPath,
    token,
    close(): void {
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
