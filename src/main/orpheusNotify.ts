import * as fs from 'node:fs'
import * as http from 'node:http'
import * as nodePath from 'node:path'
import * as os from 'node:os'
import { app } from 'electron'
import { setWorkspaceStatus } from './workspaces'
import { notifyForTransition } from './osNotifications'
import { getAppUiState } from './uiState'
import type { WorkspaceStatus, WorkspaceActivityDetail } from '../shared/types'

export type WorkspaceActivityEvent =
  | 'session-start'
  | 'user-prompt'
  | 'notification'
  | 'stop'
  | 'session-end'
  | 'pretool'
  | 'posttool'
  | 'precompact'
  | 'subagent-stop'

const EVENT_TO_STATUS: Partial<Record<WorkspaceActivityEvent, WorkspaceStatus>> = {
  'session-start': 'awaiting_input',
  'user-prompt': 'in_progress',
  notification: 'attention',
  stop: 'awaiting_input',
  'session-end': 'idle'
}

const HOOK_EVENT_MAP: Record<string, WorkspaceActivityEvent> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt',
  Notification: 'notification',
  Stop: 'stop',
  SessionEnd: 'session-end',
  PreToolUse: 'pretool',
  PostToolUse: 'posttool',
  PreCompact: 'precompact',
  SubagentStop: 'subagent-stop'
}

// Notification fires for several sub-types: permission_prompt, idle_prompt,
// auth_success, elicitation_*. Without a matcher, every idle-input timeout
// (60s+) surfaces as a macOS "permission required" notification during
// active chats. Restrict to permission_prompt so only real permission
// decisions wake the user.
// https://code.claude.com/docs/en/hooks
const HOOK_MATCHER: Partial<Record<string, string>> = {
  Notification: 'permission_prompt'
}

type DetailState = {
  toolStack: number
  compacting: boolean
  // When set, claude is blocked on a tool that needs user input
  // (AskUserQuestion, ExitPlanMode). The string is the tool_name from
  // the PreToolUse payload so PostToolUse can unblock the matching tool.
  blockingTool: string | null
}

// Tools that block claude until the user answers them. Treated as a
// status=attention transition with detail=asking, so macOS notifications
// fire and the user sees a distinct glyph.
const BLOCKING_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

const activityMap = new Map<string, WorkspaceStatus>()
const detailMap = new Map<string, DetailState>()
const lastBroadcastDetail = new Map<string, WorkspaceActivityDetail>()
const listeners = new Set<
  (workspaceId: string, status: WorkspaceStatus, detail: WorkspaceActivityDetail) => void
>()
const watchdogs = new Map<string, NodeJS.Timeout>()

function getDetailState(workspaceId: string): DetailState {
  let s = detailMap.get(workspaceId)
  if (!s) {
    s = { toolStack: 0, compacting: false, blockingTool: null }
    detailMap.set(workspaceId, s)
  }
  return s
}

export function getBlockingTool(workspaceId: string): string | null {
  return detailMap.get(workspaceId)?.blockingTool ?? null
}

export function computeDetail(
  workspaceId: string,
  status: WorkspaceStatus
): WorkspaceActivityDetail {
  const s = detailMap.get(workspaceId)
  if (status === 'attention') {
    return s?.blockingTool ? 'asking' : 'attention'
  }
  if (status === 'in_progress') {
    if (s?.compacting) return 'compacting'
    if (s && s.toolStack > 0) return 'tool'
    return 'thinking'
  }
  if (status === 'awaiting_input') return 'ready'
  if (status === 'idle') return 'idle'
  return 'archived'
}

function broadcastDetailIfChanged(workspaceId: string): void {
  const status = activityMap.get(workspaceId)
  if (!status) return
  const detail = computeDetail(workspaceId, status)
  const last = lastBroadcastDetail.get(workspaceId)
  if (last === detail) return
  lastBroadcastDetail.set(workspaceId, detail)
  for (const cb of listeners) {
    try {
      cb(workspaceId, status, detail)
    } catch {
      /* ignore */
    }
  }
}

function clearWatchdog(workspaceId: string): void {
  const t = watchdogs.get(workspaceId)
  if (!t) return
  clearTimeout(t)
  watchdogs.delete(workspaceId)
}

function armWatchdog(workspaceId: string): void {
  clearWatchdog(workspaceId)
  const userSec = getAppUiState().inProgressWatchdogSec ?? 120
  if (userSec <= 0) return
  const s = detailMap.get(workspaceId)
  const seconds = s?.compacting ? Math.max(userSec, 300) : userSec
  const t = setTimeout(() => {
    watchdogs.delete(workspaceId)
    if (activityMap.get(workspaceId) === 'in_progress') {
      console.log('[orpheusNotify] watchdog fired — demoting', workspaceId, 'after', seconds, 's')
      dispatch(workspaceId, 'awaiting_input')
    }
  }, seconds * 1000)
  watchdogs.set(workspaceId, t)
}

function dispatch(workspaceId: string, status: WorkspaceStatus): void {
  const prev = activityMap.get(workspaceId)
  if (prev === status) return
  activityMap.set(workspaceId, status)
  try {
    setWorkspaceStatus(workspaceId, status)
  } catch (err) {
    console.warn('[orpheusNotify] setWorkspaceStatus failed for', workspaceId, err)
  }
  notifyForTransition(workspaceId, prev, status)

  if (status === 'in_progress') {
    armWatchdog(workspaceId)
  } else {
    clearWatchdog(workspaceId)
  }

  broadcastDetailIfChanged(workspaceId)
}

function heartbeat(workspaceId: string): void {
  if (activityMap.get(workspaceId) === 'in_progress') {
    armWatchdog(workspaceId)
  }
}

// Called from index.ts when a raw title begins with a spinner glyph, re-arming
// the watchdog during pure-think turns where no tool events fire.
export function heartbeatFromTitle(workspaceId: string): void {
  heartbeat(workspaceId)
}

// Permission-prompt messages contain "permission" (e.g. "Claude needs your
// permission to use Bash"). Idle/auth/elicitation messages don't. The matcher
// in settings.json is the primary filter; this string check is defense in
// depth for Claude versions that ignore the matcher field.
function isPermissionMessage(payload: Record<string, unknown>): boolean {
  const msg = typeof payload.message === 'string' ? payload.message : ''
  return /permission/i.test(msg)
}

function handleHookEvent(
  workspaceId: string,
  ev: WorkspaceActivityEvent,
  payload: Record<string, unknown>
): void {
  const ds = getDetailState(workspaceId)
  const tn = typeof payload.tool_name === 'string' ? payload.tool_name : null
  const msg = typeof payload.message === 'string' ? payload.message : null
  console.log('[orpheusNotify] hook', { ev, workspaceId, tool_name: tn, message: msg })

  switch (ev) {
    case 'pretool': {
      const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null
      if (toolName && BLOCKING_TOOLS.has(toolName)) {
        ds.blockingTool = toolName
        dispatch(workspaceId, 'attention')
        return
      }
      ds.toolStack++
      heartbeat(workspaceId)
      broadcastDetailIfChanged(workspaceId)
      return
    }
    case 'posttool': {
      const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null
      if (toolName && toolName === ds.blockingTool) {
        ds.blockingTool = null
        dispatch(workspaceId, 'in_progress')
        return
      }
      ds.toolStack = Math.max(0, ds.toolStack - 1)
      heartbeat(workspaceId)
      broadcastDetailIfChanged(workspaceId)
      return
    }
    case 'precompact':
      ds.compacting = true
      heartbeat(workspaceId)
      broadcastDetailIfChanged(workspaceId)
      return
    case 'subagent-stop':
      heartbeat(workspaceId)
      return
    case 'user-prompt':
    case 'stop':
    case 'session-end':
      ds.toolStack = 0
      ds.compacting = false
      ds.blockingTool = null
      break
    case 'notification':
      ds.compacting = false
      // Suppress idle_prompt / auth_success / elicitation_* — only permission
      // prompts should wake the user. Without this guard, every 60s of user
      // think-time fires a "Waiting on a permission decision" macOS toast.
      if (!isPermissionMessage(payload)) {
        broadcastDetailIfChanged(workspaceId)
        return
      }
      break
    case 'session-start':
      break
  }

  const status = EVENT_TO_STATUS[ev]
  if (!status) return
  dispatch(workspaceId, status)
}

export function resetWorkspaceActivity(workspaceId: string): void {
  clearWatchdog(workspaceId)
  dispatch(workspaceId, 'awaiting_input')
}

/**
 * After unarchive: forget any stale runtime activity for this workspace.
 * Without this the in-memory activityMap (and renderer's cache) may still
 * report 'archived', so the workspace renders without an activity dot even
 * though it's now active again.
 */
export function clearWorkspaceActivity(workspaceId: string): void {
  clearWatchdog(workspaceId)
  // Force a fresh 'idle' broadcast even if the current cached value is also
  // archived → avoid dispatch's early-return when prev === status.
  activityMap.delete(workspaceId)
  detailMap.delete(workspaceId)
  lastBroadcastDetail.delete(workspaceId)
  dispatch(workspaceId, 'idle')
}

export function getWorkspaceActivity(workspaceId: string): WorkspaceStatus {
  return activityMap.get(workspaceId) ?? 'idle'
}

export function onActivityChange(
  cb: (workspaceId: string, status: WorkspaceStatus, detail: WorkspaceActivityDetail) => void
): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function shimPath(): string {
  return nodePath.join(process.resourcesPath, 'bin', 'orpheus-notify')
}

// Hook commands resolve $ORPHEUS_NOTIFY at runtime from the env injected at
// terminal:mount, so the absolute path never bakes into ~/.claude/settings.json.
// Outside Orpheus the env is empty, the test chain short-circuits, and the
// trailing `|| true` swallows any non-zero so claude never sees a failed hook.
function managedCommand(event: WorkspaceActivityEvent): string {
  return `[ -n "$ORPHEUS_NOTIFY" ] && [ -x "$ORPHEUS_NOTIFY" ] && "$ORPHEUS_NOTIFY" ${event} || true`
}

// Anything mentioning our env var is ours; the legacy absolute-path form is
// also recognized so first-run after this change cleans up the old entries.
function isManagedCommand(cmd: string): boolean {
  if (cmd.includes('$ORPHEUS_NOTIFY')) return true
  if (cmd.startsWith(shimPath())) return true
  return false
}

export function ensureManagedHooks(): void {
  const settingsPath = nodePath.join(os.homedir(), '.claude', 'settings.json')
  const dir = nodePath.dirname(settingsPath)
  fs.mkdirSync(dir, { recursive: true })

  let parsed: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const p = JSON.parse(raw)
    if (typeof p === 'object' && p !== null && !Array.isArray(p)) {
      parsed = p as Record<string, unknown>
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(
        '[orpheusNotify] could not read ~/.claude/settings.json — skipping hook install:',
        err
      )
      return
    }
  }

  if (
    typeof parsed['hooks'] !== 'object' ||
    parsed['hooks'] === null ||
    Array.isArray(parsed['hooks'])
  ) {
    parsed['hooks'] = {}
  }
  const hooksObj = parsed['hooks'] as Record<string, unknown>

  for (const [hookEvent, activityEvent] of Object.entries(HOOK_EVENT_MAP)) {
    if (!Array.isArray(hooksObj[hookEvent])) {
      hooksObj[hookEvent] = []
    }
    const eventArr = hooksObj[hookEvent] as Array<Record<string, unknown>>

    const cleaned = eventArr.filter((entry) => {
      if (typeof entry !== 'object' || entry === null) return true
      const hookList = entry['hooks']
      if (!Array.isArray(hookList)) return true
      const hasOurs = hookList.some(
        (h) =>
          typeof h === 'object' &&
          h !== null &&
          typeof (h as Record<string, unknown>)['command'] === 'string' &&
          isManagedCommand((h as Record<string, unknown>)['command'] as string)
      )
      return !hasOurs
    })

    const newEntry: Record<string, unknown> = {
      hooks: [{ type: 'command', command: managedCommand(activityEvent) }]
    }
    const matcher = HOOK_MATCHER[hookEvent]
    if (matcher) newEntry['matcher'] = matcher
    cleaned.push(newEntry)

    hooksObj[hookEvent] = cleaned
  }

  const tmp = settingsPath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2), 'utf-8')
  fs.renameSync(tmp, settingsPath)
}

export function startNotifyServer(): { sockPath: string; close: () => void } {
  const sockPath = nodePath.join(app.getPath('userData'), 'notify.sock')

  if (sockPath.length > 104) {
    throw new Error(
      `[orpheusNotify] socket path too long for macOS (${sockPath.length} > 104 chars): ${sockPath}`
    )
  }

  // Remove stale socket file if it exists
  try {
    fs.unlinkSync(sockPath)
  } catch {
    /* ignore */
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404)
      res.end()
      return
    }

    const headerWorkspaceId = req.headers['x-workspace-id']
    const headerEvent = req.headers['x-event']

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(204)
      res.end()

      const bodyText = Buffer.concat(chunks).toString('utf-8')

      // v2 protocol: workspaceId + event in headers, body is claude's hook payload.
      // Fallback to v1 (metadata in body) so a stale shim still works during upgrade.
      let workspaceId: string | null = null
      let eventName: string | null = null
      let payload: Record<string, unknown> = {}

      if (typeof headerWorkspaceId === 'string' && typeof headerEvent === 'string') {
        workspaceId = headerWorkspaceId
        eventName = headerEvent
        if (bodyText.trim()) {
          try {
            const parsed = JSON.parse(bodyText)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              payload = parsed as Record<string, unknown>
            }
          } catch {
            /* ignore */
          }
        }
      } else if (bodyText.trim()) {
        try {
          const body = JSON.parse(bodyText) as { workspaceId?: unknown; event?: unknown }
          if (typeof body.workspaceId === 'string') workspaceId = body.workspaceId
          if (typeof body.event === 'string') eventName = body.event
        } catch {
          /* ignore */
        }
      }

      if (!workspaceId || !eventName) return
      handleHookEvent(workspaceId, eventName as WorkspaceActivityEvent, payload)
    })
  })

  server.listen(sockPath)

  return {
    sockPath,
    close(): void {
      server.close()
      try {
        fs.unlinkSync(sockPath)
      } catch {
        /* ignore */
      }
    }
  }
}
