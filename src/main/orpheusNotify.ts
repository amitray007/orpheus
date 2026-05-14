import * as fs from 'node:fs'
import * as http from 'node:http'
import * as nodePath from 'node:path'
import * as os from 'node:os'
import { app } from 'electron'
import { setWorkspaceStatus } from './workspaces'
import { notifyForTransition } from './osNotifications'
import type { WorkspaceStatus } from '../shared/types'

export type WorkspaceActivityEvent =
  | 'session-start'
  | 'user-prompt'
  | 'notification'
  | 'stop'
  | 'session-end'

const EVENT_TO_STATUS: Record<WorkspaceActivityEvent, WorkspaceStatus> = {
  'session-start': 'awaiting_input',
  'user-prompt': 'in_progress',
  'notification': 'attention',
  'stop': 'awaiting_input',
  'session-end': 'idle'
}

// Maps claude hook event names (PascalCase) to our kebab-case event names.
const HOOK_EVENT_MAP: Record<string, WorkspaceActivityEvent> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt',
  Notification: 'notification',
  Stop: 'stop',
  SessionEnd: 'session-end'
}

const activityMap = new Map<string, WorkspaceStatus>()
const listeners = new Set<(workspaceId: string, status: WorkspaceStatus) => void>()

function dispatch(workspaceId: string, status: WorkspaceStatus): void {
  const prev = activityMap.get(workspaceId)
  if (prev === status) return
  activityMap.set(workspaceId, status)
  try {
    setWorkspaceStatus(workspaceId, status)
  } catch (err) {
    console.warn('[orpheusNotify] setWorkspaceStatus failed for', workspaceId, err)
  }
  for (const cb of listeners) {
    try { cb(workspaceId, status) } catch {}
  }
  notifyForTransition(workspaceId, prev, status)
}

export function getWorkspaceActivity(workspaceId: string): WorkspaceStatus {
  return activityMap.get(workspaceId) ?? 'idle'
}

export function onActivityChange(
  cb: (workspaceId: string, status: WorkspaceStatus) => void
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

      const status = EVENT_TO_STATUS[eventName as WorkspaceActivityEvent]
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
