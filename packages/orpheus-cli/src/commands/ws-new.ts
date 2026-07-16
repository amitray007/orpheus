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
 *   --no-submit         Stage --task's text in claude's input box WITHOUT pressing
 *                       Enter, so it can be reviewed/edited before sending. Default
 *                       (flag omitted) is to submit (type + Enter) — the normal
 *                       "spawn a worker that starts working" behavior. Only meaningful
 *                       with --task; ignored (no-op) with --empty since there is
 *                       nothing to submit.
 *   --empty             Explicitly create a workspace with no initial task (see
 *                       STRICTNESS below). Alias: --blank.
 *   --model <model>     Workspace-level model override (stored in claude_workspace_settings).
 *   --permission-mode   Workspace-level permission mode (default|acceptEdits|plan|bypassPermissions).
 *   --effort <level>    Workspace-level effort override (auto|low|medium|high|xhigh|max).
 *   --name <name>       Workspace name. Defaults to 'New workspace'.
 *   --project <val>     Project context override (global flag: id, name, or path).
 *   --focus             Navigate the GUI to the new workspace (steals focus from
 *                       wherever the user currently is).
 *   --background         Activate the workspace (mount its terminal surface so it
 *                       becomes injectable) WITHOUT navigating the GUI to it —
 *                       the user's current view is undisturbed. This is the
 *                       DEFAULT for `ws new` (agent fan-out shouldn't yank the
 *                       user's view around); pass --focus to opt into navigating.
 *                       --focus and --background are mutually exclusive.
 *
 * STRICTNESS — --task XOR --empty is required
 * --------------------------------------------
 * `ws new` with NEITHER --task NOR --empty/--blank is a usage error (exit 2):
 * an agent calling this CLI must declare intent up front — either seed the
 * workspace with a task, or explicitly acknowledge it wants a blank one. This
 * makes empty-workspace creation intentional rather than an accident of
 * forgetting --task. Passing BOTH --task and --empty is also a usage error
 * (they're contradictory declarations of intent).
 *
 * An --empty workspace still goes through the normal create + activate path
 * (the server opens it in the GUI same as any other workspace) — --empty only
 * means no `task` field is sent to workspace.create, so no initial prompt is
 * injected.
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
 *
 * TEXT/JSON PARITY (QA fix #5)
 * -----------------------------
 * --json returns { workspace: WorkspaceRecord, seedWarning }. Text mode previously
 * showed only a hand-picked subset of WorkspaceRecord's fields (id/name/projectId/
 * cwd/parentWorkspaceId/forkedFromSessionId/claudeSessionId), silently omitting
 * nameIsAuto/pinnedAt/createdAt/lastOpenedAt/archivedAt/closedAt/status/sortOrder/
 * lastTitle that ARE present in --json. Text now surfaces the full field set under
 * the same key names as JSON, so a consumer gets the same logical data either way —
 * only formatting differs (timestamps are ISO strings in text, epoch ms in json,
 * same convention as `project show` — see commands/project.ts).
 */

import { registerCommand } from '../registry.js'
import { openDb } from '../reads/db.js'
import { resolveContext, noProjectMessage } from '../context.js'
import { sendCommand } from '../socket-client.js'
import { printResult, printKeyValue, printError, printUsageError, printLines } from '../output.js'
import { resolveFocus } from '../focus.js'
import type { WorkspaceRecord } from '../reads/db.js'

// ---------------------------------------------------------------------------
// ws new — helpers
// ---------------------------------------------------------------------------

type TaskIntentResult = { ok: true } | { ok: false; error: string }

/**
 * STRICTNESS: require --task XOR --empty/--blank (an agent must declare
 * intent — see module doc).
 *
 * --task is trimmed before the emptiness check: a whitespace-only value
 * ("   ") was explicitly passed but carries no real task text, so it is
 * treated as a usage error rather than silently falling through to
 * "no task declared" (which would produce a confusing generic message)
 * or silently being accepted as a blank-but-truthy task (which would
 * create a workspace with a whitespace-only seed prompt). The caller
 * clearly intended to provide a task — tell them it was blank and to
 * either provide real text or use --empty.
 */
function resolveTaskIntent(flags: Record<string, unknown>): TaskIntentResult {
  const rawTask = typeof flags.task === 'string' ? flags.task : undefined
  const trimmedTask = rawTask?.trim()
  const hasEmpty = flags.empty === true || flags.blank === true

  if (rawTask != null && trimmedTask === '') {
    return {
      ok: false,
      error:
        'ws new: --task was given but is blank (whitespace-only). ' +
        'Provide real task text, or use --empty (or --blank) to explicitly create an empty workspace.'
    }
  }

  const hasTask = trimmedTask != null && trimmedTask !== ''

  if (!hasTask && !hasEmpty) {
    return {
      ok: false,
      error:
        'ws new requires declaring intent: pass --task "<work>" to start with a task, ' +
        'or --empty (or --blank) to explicitly create an empty workspace.'
    }
  }
  if (hasTask && hasEmpty) {
    return { ok: false, error: 'ws new: pass either --task <text> or --empty/--blank, not both' }
  }

  return { ok: true }
}

/** Build the args object for the workspace.create socket call from flags. */
function buildCreateArgs(
  flags: Record<string, unknown>,
  projectId: string,
  projectCwd: string,
  focus: boolean
): Record<string, unknown> {
  const args: Record<string, unknown> = {
    projectId,
    cwd: projectCwd,
    focus
  }

  const name = typeof flags.name === 'string' ? flags.name : undefined
  if (name != null && name !== '') {
    args.name = name
  }

  if (flags.fork === true) {
    args.fork = true
  }

  if (typeof flags.task === 'string' && flags.task !== '') {
    args.task = flags.task
    // --no-submit only makes sense alongside --task (with --empty there is no
    // seeded text to submit or withhold) — only resolve/send it in this branch,
    // so passing --no-submit with --empty is silently ignored (documented above).
    if (flags['no-submit'] === true) {
      args.submit = false
    }
  }

  if (typeof flags.model === 'string' && flags.model !== '') {
    args.model = flags.model
  }

  if (typeof flags['permission-mode'] === 'string' && flags['permission-mode'] !== '') {
    args.permissionMode = flags['permission-mode']
  }

  if (typeof flags.effort === 'string' && flags.effort !== '') {
    args.effort = flags.effort
  }

  return args
}

/** Print the pretty-mode key/value summary for a newly created workspace. */
function printNewWorkspaceSummary(ws: WorkspaceRecord): void {
  // Same field NAMES as the --json `workspace` object (QA fix #5) — only
  // timestamp formatting differs (ISO string here vs epoch ms in json),
  // matching the convention `project show` already uses.
  printKeyValue({
    id: ws.id,
    name: ws.name,
    nameIsAuto: ws.nameIsAuto,
    projectId: ws.projectId,
    cwd: ws.cwd,
    status: ws.status,
    pinnedAt: ws.pinnedAt != null ? new Date(ws.pinnedAt).toISOString() : null,
    createdAt: new Date(ws.createdAt).toISOString(),
    lastOpenedAt: ws.lastOpenedAt != null ? new Date(ws.lastOpenedAt).toISOString() : null,
    archivedAt: ws.archivedAt != null ? new Date(ws.archivedAt).toISOString() : null,
    closedAt: ws.closedAt != null ? new Date(ws.closedAt).toISOString() : null,
    sortOrder: ws.sortOrder,
    parentWorkspaceId: ws.parentWorkspaceId,
    forkedFromSessionId: ws.forkedFromSessionId,
    claudeSessionId: ws.claudeSessionId,
    lastTitle: ws.lastTitle
  })
}

registerCommand('ws new', {
  usage:
    'ws new (--task <text> | --empty) [--no-submit] [--fork] [--name <n>] [--model <m>] [--permission-mode <p>] [--effort <e>] [--project <p>] [--focus | --background]',
  help: 'Create a new workspace (must declare --task <text> or --empty)',
  longDesc:
    'An Orpheus workspace IS a claude session — creating one always starts claude. ' +
    '--task seeds and submits an initial prompt; --empty/--blank explicitly creates ' +
    'a workspace with a running claude session but no seeded task (idle at the ' +
    "prompt). Exactly one of --task or --empty/--blank is required — ws new won't " +
    'guess your intent. The primary tool for agent fan-out: spawn a worker with ' +
    '--task for fresh work, or --fork to hand it your own session history.',
  maxPositionals: 0,
  flags: {
    task: {
      type: 'string',
      valueHint: '<text>',
      desc: 'Seed prompt: after the workspace is created, this text is typed into the new claude session and submitted (Enter pressed) automatically.',
      notes:
        'Mutually exclusive with --empty/--blank; exactly one is required. Pass --no-submit to stage the text without pressing Enter.'
    },
    'no-submit': {
      type: 'boolean',
      desc: "Stage --task's text in the new workspace's prompt WITHOUT pressing Enter, so it can be reviewed/edited before sending.",
      default: 'false (task text is submitted immediately)',
      notes: 'Only meaningful with --task; silently ignored with --empty (nothing to submit).'
    },
    empty: {
      type: 'boolean',
      desc: 'Explicitly create a workspace with a running claude session but no seeded task (idle at the prompt). Alias: --blank.',
      notes: 'Mutually exclusive with --task; exactly one is required.'
    },
    blank: {
      type: 'boolean',
      desc: 'Alias for --empty.',
      notes: 'Mutually exclusive with --task; exactly one is required.'
    },
    fork: {
      type: 'boolean',
      desc: "Inherit the parent workspace's claude session history via claude's --fork-session, instead of (or alongside) --task. The parent is the caller's own workspace (ORPHEUS_WORKSPACE_ID) unless the caller isn't itself a workspace.",
      default: 'false (new, independent session)'
    },
    name: {
      type: 'string',
      valueHint: '<name>',
      desc: 'Workspace display name.',
      default: "'New workspace' (or an auto-derived name from the session, if left unset)"
    },
    model: {
      type: 'string',
      valueHint: '<model>',
      desc: 'Workspace-level Claude model override, stored in claude_workspace_settings.',
      default: 'inherits the project/global model setting'
    },
    'permission-mode': {
      type: 'string',
      valueHint: '<mode>',
      desc: 'Workspace-level Claude permission mode override.',
      values: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
      default: 'inherits the project/global permission-mode setting'
    },
    effort: {
      type: 'string',
      valueHint: '<level>',
      desc: 'Workspace-level effort override.',
      values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
      default: 'inherits the project/global effort setting'
    },
    focus: {
      type: 'boolean',
      desc: 'Navigate the Orpheus GUI to the new workspace (steals focus from wherever the user currently is).',
      notes: 'Mutually exclusive with --background.'
    },
    background: {
      type: 'boolean',
      desc: "Activate the workspace (mount its terminal surface so it's injectable) WITHOUT navigating the GUI to it.",
      default: 'true — this is the default for ws new',
      notes:
        "Agent fan-out shouldn't yank the user's view around; pass --focus to opt into navigating instead. Mutually exclusive with --focus."
    }
    // --project is the global flag; cli.ts parses it as ctx.project
  },
  examples: [
    'orpheus ws new --task "Summarize the auth module and list TODOs"',
    'orpheus ws new --fork --name "reviewer" --permission-mode plan',
    'orpheus --json ws new --task "run the test suite" | jq -r .workspace.id'
  ],
  handler: async (ctx) => {
    // STRICTNESS: require --task XOR --empty/--blank (an agent must declare
    // intent — see module doc). Checked before any DB/socket work so the
    // usage error is fast and side-effect-free.
    const taskIntent = resolveTaskIntent(ctx.flags)
    if (!taskIntent.ok) {
      printUsageError(taskIntent.error)
      return
    }

    // --focus/--background: default BACKGROUND for `ws new` — agent fan-out
    // (spawning a worker workspace) shouldn't yank the user's view around;
    // --focus opts into navigating the GUI to the new workspace.
    const focusResult = resolveFocus(ctx.flags, false)
    if (!focusResult.ok) {
      printUsageError(focusResult.error)
      return
    }
    const focus = focusResult.focus

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
    const args = buildCreateArgs(ctx.flags, projectId, projectCwd, focus)

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
      printNewWorkspaceSummary(ws)
    })

    // Surface seed warning separately so it's visible even in pretty mode
    if (data.seedWarning != null) {
      printLines('', `warning: ${data.seedWarning}`)
    }
  }
})
