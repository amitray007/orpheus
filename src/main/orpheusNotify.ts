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
  'notification': 'attention',
  'stop': 'awaiting_input',
  'session-end': 'idle'
}

// Heartbeat events keep an in_progress workspace alive without changing status.
// They reset the inactivity watchdog so we don't falsely demote a still-working
// session. Claude Code has no interrupt hook — these heartbeats plus the
// watchdog are how we recover from Ctrl-C / Esc interruptions.
const HEARTBEAT_EVENTS: ReadonlySet<WorkspaceActivityEvent> = new Set([
  'pretool',
  'posttool',
  'precompact',
  'subagent-stop'
])

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

type DetailState = { toolStack: number; compacting: boolean }

const activityMap = new Map<string, WorkspaceStatus>()
const detailMap = new Map<string, DetailState>()
const lastBroadcastDetail = new Map<string, WorkspaceActivityDetail>()
const listeners = new Set<(workspaceId: string, status: WorkspaceStatus, detail: WorkspaceActivityDetail) => void>()
const watchdogs = new Map<string, NodeJS.Timeout>()

function getDetailState(workspaceId: string): DetailState {
  let s = detailMap.get(workspaceId)
  if (!s) {
    s = { toolStack: 0, compacting: false }
    detailMap.set(workspaceId, s)
  }
  return s
}

export function computeDetail(workspaceId: string, status: WorkspaceStatus): WorkspaceActivityDetail {
  if (status === 'in_progress') {
    const s = detailMap.get(workspaceId)
    if (s?.compacting) return 'compacting'
    if (s && s.toolStack > 0) return 'tool'
    return 'thinking'
  }
  if (status === 'awaiting_input') return 'ready'
  if (status === 'attention') return 'attention'
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
    try { cb(workspaceId, status, detail) } catch {}
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

export function resetWorkspaceActivity(workspaceId: string): void {
  clearWatchdog(workspaceId)
  dispatch(workspaceId, 'awaiting_input')
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
      console.warn('[orpheusNotify] could not read ~/.claude/settings.json — skipping hook install:', err)
      return
    }
  }

  if (typeof parsed['hooks'] !== 'object' || parsed['hooks'] === null || Array.isArray(parsed['hooks'])) {
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

    cleaned.push({
      hooks: [{ type: 'command', command: managedCommand(activityEvent) }]
    })

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
  try { fs.unlinkSync(sockPath) } catch {}

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/notify') {
      res.writeHead(404)
      res.end()
      return
    }

    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(204)
      res.end()

      let body: { workspaceId?: unknown; event?: unknown }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
      } catch {
        return
      }

      const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : null
      const eventName = typeof body.event === 'string' ? body.event : null
      if (!workspaceId || !eventName) return

      const ev = eventName as WorkspaceActivityEvent
      if (HEARTBEAT_EVENTS.has(ev)) {
        const ds = getDetailState(workspaceId)
        if (ev === 'pretool') {
          ds.toolStack++
        } else if (ev === 'posttool') {
          ds.toolStack = Math.max(0, ds.toolStack - 1)
        } else if (ev === 'precompact') {
          ds.compacting = true
        }
        // subagent-stop: no state mutation
        heartbeat(workspaceId)
        broadcastDetailIfChanged(workspaceId)
        return
      }

      // Status-transitioning events — apply pre-dispatch state mutations first.
      if (ev === 'user-prompt') {
        const ds = getDetailState(workspaceId)
        ds.toolStack = 0
        ds.compacting = false
      } else if (ev === 'stop') {
        const ds = getDetailState(workspaceId)
        ds.toolStack = 0
        ds.compacting = false
      } else if (ev === 'notification') {
        const ds = getDetailState(workspaceId)
        ds.compacting = false
      } else if (ev === 'session-end') {
        const ds = getDetailState(workspaceId)
        ds.toolStack = 0
        ds.compacting = false
      }
      // session-start: leave state as-is

      const status = EVENT_TO_STATUS[ev]
      if (!status) return

      dispatch(workspaceId, status)
    })
  })

  server.listen(sockPath)

  return {
    sockPath,
    close(): void {
      server.close()
      try { fs.unlinkSync(sockPath) } catch {}
    }
  }
}
