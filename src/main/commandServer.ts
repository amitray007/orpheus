import * as http from 'node:http'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import * as crypto from 'node:crypto'
import { app } from 'electron'
import { getDb } from './db'
import {
  createWorkspace,
  getWorkspace,
  archiveWorkspace,
  reopenWorkspace,
  renameWorkspace,
  listChildWorkspaces,
  getWorkspaceLineage
} from './workspaces'
import { getClaudeGlobalSettings } from './claudeSettings'
import { updateClaudeWorkspaceSettings } from './claudeWorkspaceSettings'
import type { WorkspaceRecord, ClaudePermissionMode, ClaudeEffort } from '../shared/types'

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

      // Seed task: open the workspace in the GUI and inject the task text once injectable.
      let seedWarning: string | null = null
      const taskText = typeof args.task === 'string' && args.task !== '' ? args.task : null
      if (taskText != null) {
        seedWarning = await innerDeps.openAndSeed(ws.id, taskText)
      }

      return { workspace: ws, seedWarning }
    },

    // Archive (permanently delete) a workspace — mirrors the workspaces:archive IPC
    // handler in index.ts, including the same surface teardown sequence.
    'workspace.archive': (args) => {
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      const ws = getWorkspace(args.id)
      // Destroy the libghostty NSView before the DB row disappears (same as GUI path).
      try {
        deps.destroySurface(args.id)
      } catch {
        // Surface not mounted or already destroyed — ignore.
      }
      archiveWorkspace(args.id)
      // Evict all per-workspace in-memory state, matching GUI archive teardown.
      deps.teardownWorkspaceResources(args.id, ws?.cwd ?? null)
      return { archived: true }
    },

    // Close a workspace (sets closed_at). The CLI caller is headless and
    // deliberately closing — no busy-status guard (unlike the GUI handler).
    'workspace.close': (args) => {
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      const workspace = deps.performClose(args.id)
      return { workspace: workspace ?? null }
    },

    // Reopen a previously-closed workspace (clears closed_at).
    'workspace.reopen': (args) => {
      if (typeof args.id !== 'string') throw new Error('args.id is required')
      const workspace = reopenWorkspace(args.id)
      return { workspace: workspace ?? null }
    },

    // Rename a workspace.
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
      const project = getDb()
        .prepare('SELECT id, name, path FROM projects WHERE id = ?')
        .get(ws.projectId) as { id: string; name: string; path: string } | undefined
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
