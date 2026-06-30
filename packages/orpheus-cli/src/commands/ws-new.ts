/**
 * commands/ws-new.ts — `ws new` command implementation.
 *
 * Creates a new interactive workspace. The workspace is always visible in the
 * Orpheus GUI — there is no headless mode. The command sends a 'workspace.create'
 * action over the command socket and returns the created WorkspaceRecord.
 *
 * FLAGS
 * -----
 *   --fork              Inherit parent session history (--fork-session). The parent is
 *                       the caller's workspace (ORPHEUS_WORKSPACE_ID) unless overridden.
 *   --task <text>       After creating, open the workspace in the GUI and inject this
 *                       text as the initial prompt. Requires the app window to be visible.
 *   --model <model>     Workspace-level model override (stored in claude_workspace_settings).
 *   --permission-mode   Workspace-level permission mode (default|acceptEdits|plan|bypassPermissions).
 *   --effort <level>    Workspace-level effort override (auto|low|medium|high|xhigh|max).
 *   --name <name>       Workspace name. Defaults to 'New workspace'.
 *   --project <val>     Project context override (global flag: id, name, or path).
 *
 * GUARDRAILS
 * ----------
 * The server enforces maxWorkspaceDepth and maxWorkspaceChildren from global settings.
 * If either cap would be exceeded, the command fails with a guiding error message.
 *
 * FORK
 * ----
 * With --fork, the parent workspace's claudeSessionId is passed as forkedFromSessionId.
 * composeClaudeLaunch emits --session-id <new-uuid> --resume <parent-uuid> --fork-session
 * on the new workspace's first launch so claude creates an independent branch.
 *
 * AUTO-LAUNCH
 * -----------
 * This is NOT a read command (isRead is unset), so AppNotRunningError triggers the
 * standard auto-launch + retry loop in cli.ts.
 */

import { registerCommand } from '../registry.js'
import { openDb } from '../reads/db.js'
import { resolveContext, noProjectMessage } from '../context.js'
import { sendCommand } from '../socket-client.js'
import { printResult, printKeyValue, printError, printUsageError, printLines } from '../output.js'
import type { WorkspaceRecord } from '../reads/db.js'

registerCommand('ws new', {
  flags: {
    fork: 'boolean',
    task: 'string',
    model: 'string',
    'permission-mode': 'string',
    effort: 'string',
    name: 'string'
    // --project is the global flag; cli.ts parses it as ctx.project
  },
  handler: async (ctx) => {
    // Resolve project context
    const db = openDb()
    let projectId: string
    let projectCwd: string
    try {
      const resolved = resolveContext({ project: ctx.project }, db)
      if (resolved.projectId == null) {
        printUsageError(noProjectMessage())
        return
      }
      projectId = resolved.projectId
      projectCwd = resolved.projectPath ?? resolved.cwd
    } finally {
      db.close()
    }

    // Build args for workspace.create
    const args: Record<string, unknown> = {
      projectId,
      cwd: projectCwd
    }

    const name = typeof ctx.flags.name === 'string' ? ctx.flags.name : undefined
    if (name != null && name !== '') {
      args.name = name
    }

    if (ctx.flags.fork === true) {
      args.fork = true
    }

    if (typeof ctx.flags.task === 'string' && ctx.flags.task !== '') {
      args.task = ctx.flags.task
    }

    if (typeof ctx.flags.model === 'string' && ctx.flags.model !== '') {
      args.model = ctx.flags.model
    }

    if (typeof ctx.flags['permission-mode'] === 'string' && ctx.flags['permission-mode'] !== '') {
      args.permissionMode = ctx.flags['permission-mode']
    }

    if (typeof ctx.flags.effort === 'string' && ctx.flags.effort !== '') {
      args.effort = ctx.flags.effort
    }

    // Send to the app. context is auto-injected with ORPHEUS_WORKSPACE_ID
    // (from socket-client.ts), which the server uses as the fallback parentWorkspaceId.
    let result: unknown
    try {
      result = await sendCommand('workspace.create', args)
    } catch (err) {
      printError(err)
      return
    }

    // The server returns { workspace: WorkspaceRecord, seedWarning: string | null }
    const data = result as { workspace: WorkspaceRecord; seedWarning: string | null } | null

    if (data == null || data.workspace == null) {
      printError('unexpected response from server: missing workspace record')
      return
    }

    const ws = data.workspace

    printResult(data, () => {
      printKeyValue({
        id: ws.id,
        name: ws.name,
        projectId: ws.projectId,
        cwd: ws.cwd,
        parentWorkspaceId: ws.parentWorkspaceId ?? '(none)',
        forkedFromSessionId: ws.forkedFromSessionId ?? '(none)',
        claudeSessionId: ws.claudeSessionId ?? '(none)'
      })
    })

    // Surface seed warning separately so it's visible even in pretty mode
    if (data.seedWarning != null) {
      printLines('', `warning: ${data.seedWarning}`)
    }
  }
})
