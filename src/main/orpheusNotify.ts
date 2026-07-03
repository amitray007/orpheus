import * as fs from 'node:fs'
import * as http from 'node:http'
import * as nodePath from 'node:path'
import * as os from 'node:os'
import { app } from 'electron'
import { setWorkspaceStatus } from './workspaces'
import { notifyForTransition } from './osNotifications'
import { getAppUiState } from './uiState'
import type { WorkspaceStatus, WorkspaceActivityDetail } from '../shared/types'
import { logDiagMain } from './diagnostics'
import { DIAG_EVENTS } from '../shared/diagEvents'
import { stageActivityUpdate } from './activitySink'
import { UI_STATE_DEFAULTS } from '../shared/uiStateDefaults'

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

const activityMap = new Map<string, WorkspaceStatus>()
const lastBroadcastDetail = new Map<string, WorkspaceActivityDetail>()

type StatusObserver = (
  workspaceId: string,
  oldStatus: WorkspaceStatus | undefined,
  newStatus: WorkspaceStatus
) => void

const statusObservers = new Set<StatusObserver>()

/** Subscribe to every committed workspace status transition. Returns an unsubscribe fn. */
export function onWorkspaceStatusChange(cb: StatusObserver): () => void {
  statusObservers.add(cb)
  return () => statusObservers.delete(cb)
}

/** Snapshot of current in-memory per-workspace statuses. */
export function getAllWorkspaceStatuses(): Map<string, WorkspaceStatus> {
  return new Map(activityMap)
}

let cachedStaleMinutes: number | null = null
let cachedAutoCloseMinutes: number | null = null

/** Call this after updating inProgressWatchdogSec so the next arm picks up the new value. */
export function invalidateWatchdogCache(): void {
  cachedStaleMinutes = null
  cachedAutoCloseMinutes = null
}

let autoCloseHandler: ((workspaceId: string) => void) | null = null
let fileStatusProvider: ((workspaceId: string) => 'busy' | 'idle' | 'waiting' | 'unknown') | null =
  null

const idleWatchdogs = new Map<string, NodeJS.Timeout>()
const autoCloseWatchdogs = new Map<string, NodeJS.Timeout>()

export function computeDetail(
  _workspaceId: string,
  status: WorkspaceStatus
): WorkspaceActivityDetail {
  if (status === 'attention') return 'attention'
  if (status === 'in_progress') return 'working'
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
  stageActivityUpdate({ workspaceId, status, detail })
}

function clearIdleWatchdog(workspaceId: string): void {
  const t = idleWatchdogs.get(workspaceId)
  if (!t) return
  clearTimeout(t)
  idleWatchdogs.delete(workspaceId)
}

function clearAutoCloseWatchdog(workspaceId: string): void {
  const t = autoCloseWatchdogs.get(workspaceId)
  if (!t) return
  clearTimeout(t)
  autoCloseWatchdogs.delete(workspaceId)
}

function armIdleWatchdog(workspaceId: string): void {
  clearIdleWatchdog(workspaceId)
  if (cachedStaleMinutes === null) {
    cachedStaleMinutes = getAppUiState().staleAfterMinutes ?? UI_STATE_DEFAULTS.staleAfterMinutes
  }
  const minutes = cachedStaleMinutes
  if (minutes <= 0) return
  const t = setTimeout(
    () => {
      idleWatchdogs.delete(workspaceId)
      if (activityMap.get(workspaceId) === 'awaiting_input') {
        console.log(
          '[orpheusNotify] idle watchdog — ready→idle',
          workspaceId,
          'after',
          minutes,
          'min'
        )
        logDiagMain({
          category: 'anomaly',
          level: 'warn',
          event: DIAG_EVENTS.ACTIVITY_WATCHDOG_FIRED,
          workspaceId,
          message: 'ready→idle (stale)',
          data: { afterMinutes: minutes }
        })
        dispatch(workspaceId, 'idle')
      }
    },
    minutes * 60 * 1000
  )
  idleWatchdogs.set(workspaceId, t)
}

function armAutoCloseWatchdog(workspaceId: string): void {
  clearAutoCloseWatchdog(workspaceId)
  if (cachedAutoCloseMinutes === null) {
    cachedAutoCloseMinutes = getAppUiState().autoCloseAfterMinutes ?? 120
  }
  const minutes = cachedAutoCloseMinutes
  if (minutes <= 0) return
  const t = setTimeout(
    () => {
      autoCloseWatchdogs.delete(workspaceId)
      const status = activityMap.get(workspaceId)
      if (status === 'idle' || status === 'awaiting_input') {
        console.log(
          '[orpheusNotify] auto-close watchdog — closing',
          workspaceId,
          'after',
          minutes,
          'min'
        )
        autoCloseHandler?.(workspaceId)
      }
    },
    minutes * 60 * 1000
  )
  autoCloseWatchdogs.set(workspaceId, t)
}

function dispatch(workspaceId: string, status: WorkspaceStatus): void {
  // File-authoritative veto: if the session file says the main process is still
  // busy or waiting (e.g. AskUserQuestion/ExitPlanMode), suppress premature
  // demotion to awaiting_input or idle from hooks or the watchdog.
  // attention and in_progress are never blocked — the drive step's attention
  // dispatch must still pass through.
  if (status === 'awaiting_input' || status === 'idle') {
    const fileStatus = fileStatusProvider?.(workspaceId)
    if (fileStatus === 'busy' || fileStatus === 'waiting') return
  }
  const prev = activityMap.get(workspaceId)
  if (prev === status) return
  activityMap.set(workspaceId, status)
  // Fan out to keep-awake / future observers. Errors are isolated.
  statusObservers.forEach((obs) => {
    try {
      obs(workspaceId, prev, status)
    } catch (err) {
      console.error('[orpheusNotify] status observer error:', err)
    }
  })
  logDiagMain({
    category: 'lifecycle',
    level: 'debug',
    event: DIAG_EVENTS.HOOK_ACTIVITY,
    workspaceId,
    message: status,
    data: { prev }
  })
  try {
    setWorkspaceStatus(workspaceId, status)
  } catch (err) {
    console.warn('[orpheusNotify] setWorkspaceStatus failed for', workspaceId, err)
    logDiagMain({
      category: 'anomaly',
      level: 'warn',
      event: DIAG_EVENTS.STATUS_PERSIST_FAILED,
      workspaceId,
      data: { err: String(err) }
    })
  }
  notifyForTransition(workspaceId, prev, status)

  // Auto-demote ready→idle after staleAfterMinutes of sitting in awaiting_input.
  if (status === 'awaiting_input') {
    armIdleWatchdog(workspaceId)
  } else {
    clearIdleWatchdog(workspaceId)
  }
  // Auto-close workspace after autoCloseAfterMinutes of sitting idle.
  if (status === 'idle') {
    armAutoCloseWatchdog(workspaceId)
  } else {
    clearAutoCloseWatchdog(workspaceId)
  }

  broadcastDetailIfChanged(workspaceId)
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
  if (process.env['ORPHEUS_DEBUG_HOOKS'] === '1') {
    const tn = typeof payload.tool_name === 'string' ? payload.tool_name : null
    const msg = typeof payload.message === 'string' ? payload.message : null
    console.log('[orpheusNotify] hook', { ev, workspaceId, tool_name: tn, message: msg })
  }

  switch (ev) {
    case 'pretool':
    case 'posttool':
    case 'precompact':
    case 'subagent-stop':
    case 'stop':
    case 'user-prompt':
    case 'session-end':
      return
    case 'notification':
      // Suppress idle_prompt / auth_success / elicitation_* — only permission
      // prompts should wake the user. Without this guard, every 60s of user
      // think-time fires a "Waiting on a permission decision" macOS toast.
      if (!isPermissionMessage(payload)) {
        broadcastDetailIfChanged(workspaceId)
        return
      }
      // Fall through to fire OS notification via notifyForTransition (called
      // from dispatch). We don't dispatch status here — file owns attention.
      // Instead just broadcast detail so notification metadata is fresh.
      broadcastDetailIfChanged(workspaceId)
      return
    case 'session-start':
      // Hook plumbing kept intact — no-op; overlay dismissal is now driven
      // by the session file reaching a concrete status (sessionState.ts).
      return
  }
}

/**
 * After unarchive: forget any stale runtime activity for this workspace.
 * Without this the in-memory activityMap (and renderer's cache) may still
 * report 'archived', so the workspace renders without an activity dot even
 * though it's now active again.
 */
export function clearWorkspaceActivity(workspaceId: string): void {
  clearIdleWatchdog(workspaceId)
  clearAutoCloseWatchdog(workspaceId)
  // Force a fresh 'idle' broadcast even if the current cached value is also
  // archived → avoid dispatch's early-return when prev === status.
  activityMap.delete(workspaceId)
  lastBroadcastDetail.delete(workspaceId)
  dispatch(workspaceId, 'idle')
  // dispatch('idle') re-arms the auto-close watchdog — defuse it for teardown.
  clearAutoCloseWatchdog(workspaceId)
}

export function getWorkspaceActivity(workspaceId: string): WorkspaceStatus {
  return activityMap.get(workspaceId) ?? 'idle'
}

export function setAutoCloseHandler(fn: (workspaceId: string) => void): void {
  autoCloseHandler = fn
}

export function setFileStatusProvider(
  fn: (workspaceId: string) => 'busy' | 'idle' | 'waiting' | 'unknown'
): void {
  fileStatusProvider = fn
}

/** Drive a status update from the session file. Runs through dispatch so
 *  persistence, broadcast, and watchdog-arming all happen consistently.
 *  The Half-1 veto inside dispatch still applies (which is correct — if the
 *  file just reported idle/waiting, the veto won't block it). */
export function setStatusFromFile(workspaceId: string, status: WorkspaceStatus): void {
  dispatch(workspaceId, status)
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
export function isManagedCommand(cmd: string): boolean {
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
    } else {
      // Valid JSON but not a plain object (array/string/number/null) — bail
      // without writing so we don't clobber whatever this file legitimately is.
      logDiagMain({
        category: 'anomaly',
        level: 'warn',
        event: DIAG_EVENTS.MANAGED_HOOKS_BAILED_NONOBJECT
      })
      console.warn(
        '[orpheusNotify] ~/.claude/settings.json is valid JSON but not an object — skipping hook install to avoid clobbering it'
      )
      return
    }
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(
        '[orpheusNotify] could not read ~/.claude/settings.json — skipping hook install:',
        err
      )
      logDiagMain({
        category: 'anomaly',
        level: 'warn',
        event: DIAG_EVENTS.HOOK_INSTALL_FAILED,
        data: { err: String(err) }
      })
      return
    }
    // ENOENT: parsed stays {} — proceed to create fresh.
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

  const newContent = JSON.stringify(parsed, null, 2)

  // Skip the write + rename if the file already matches — avoids unnecessary
  // disk I/O and atime bumps on every Orpheus launch.
  try {
    const existing = fs.readFileSync(settingsPath, 'utf-8').trim()
    if (existing === newContent.trim()) return
  } catch {
    // File doesn't exist or is unreadable — proceed with write.
  }

  const tmp = settingsPath + '.tmp'
  fs.writeFileSync(tmp, newContent, 'utf-8')
  fs.renameSync(tmp, settingsPath)
}

/**
 * Count the number of Orpheus-managed hook entries currently present in
 * ~/.claude/settings.json. Returns 0 if the file is absent or unreadable.
 */
export function countManagedHooks(): number {
  const settingsPath = nodePath.join(os.homedir(), '.claude', 'settings.json')
  let count = 0
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0
    const hooksObj = (parsed as Record<string, unknown>)['hooks']
    if (!hooksObj || typeof hooksObj !== 'object' || Array.isArray(hooksObj)) return 0
    for (const eventArr of Object.values(hooksObj as Record<string, unknown>)) {
      if (!Array.isArray(eventArr)) continue
      for (const entry of eventArr) {
        if (typeof entry !== 'object' || entry === null) continue
        const hookList = (entry as Record<string, unknown>)['hooks']
        if (!Array.isArray(hookList)) continue
        for (const h of hookList) {
          if (
            typeof h === 'object' &&
            h !== null &&
            typeof (h as Record<string, unknown>)['command'] === 'string' &&
            isManagedCommand((h as Record<string, unknown>)['command'] as string)
          ) {
            count++
          }
        }
      }
    }
  } catch {
    // ENOENT or parse error — zero is correct
  }
  return count
}

/**
 * Remove ONLY Orpheus-managed hook entries from ~/.claude/settings.json.
 * User-added hooks are never touched. Tolerates ENOENT (silent no-op) and
 * parse errors (warns + returns). Is the clean-without-re-add twin of
 * ensureManagedHooks.
 */
export function uninstallManagedHooks(): void {
  const settingsPath = nodePath.join(os.homedir(), '.claude', 'settings.json')

  let raw: string
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return // nothing to clean
    console.warn('[orpheusNotify] uninstallManagedHooks: could not read settings.json:', err)
    logDiagMain({
      category: 'anomaly',
      level: 'warn',
      event: DIAG_EVENTS.HOOK_UNINSTALL_FAILED,
      data: { err: String(err) }
    })
    return
  }

  let parsed: Record<string, unknown>
  try {
    const p = JSON.parse(raw)
    if (typeof p !== 'object' || p === null || Array.isArray(p)) {
      console.warn(
        '[orpheusNotify] uninstallManagedHooks: settings.json is not an object — skipping'
      )
      logDiagMain({
        category: 'anomaly',
        level: 'warn',
        event: DIAG_EVENTS.HOOK_UNINSTALL_FAILED
      })
      return
    }
    parsed = p as Record<string, unknown>
  } catch (err) {
    console.warn('[orpheusNotify] uninstallManagedHooks: failed to parse settings.json:', err)
    logDiagMain({
      category: 'anomaly',
      level: 'warn',
      event: DIAG_EVENTS.HOOK_UNINSTALL_FAILED,
      data: { err: String(err) }
    })
    return
  }

  if (
    typeof parsed['hooks'] !== 'object' ||
    parsed['hooks'] === null ||
    Array.isArray(parsed['hooks'])
  ) {
    return // no hooks section — nothing to remove
  }

  const hooksObj = parsed['hooks'] as Record<string, unknown>
  let changed = false

  for (const hookEvent of Object.keys(hooksObj)) {
    if (!Array.isArray(hooksObj[hookEvent])) continue
    const eventArr = hooksObj[hookEvent] as Array<unknown>

    const filtered = eventArr.filter((entry) => {
      if (typeof entry !== 'object' || entry === null) return true
      const hookList = (entry as Record<string, unknown>)['hooks']
      if (!Array.isArray(hookList)) return true
      // Remove the entry if ALL of its hooks are managed by Orpheus.
      // If an entry mixes Orpheus hooks with user hooks, remove only the
      // managed hooks from that entry's hooks array.
      const remaining = hookList.filter(
        (h) =>
          !(
            typeof h === 'object' &&
            h !== null &&
            typeof (h as Record<string, unknown>)['command'] === 'string' &&
            isManagedCommand((h as Record<string, unknown>)['command'] as string)
          )
      )
      if (remaining.length === hookList.length) return true // nothing removed
      changed = true
      if (remaining.length === 0)
        return false // drop the whole matcher entry
      ;(entry as Record<string, unknown>)['hooks'] = remaining
      return true
    })

    if (filtered.length !== eventArr.length) changed = true
    if (filtered.length === 0) {
      delete hooksObj[hookEvent]
    } else {
      hooksObj[hookEvent] = filtered
    }
  }

  // Drop the hooks key entirely if it became empty.
  if (Object.keys(hooksObj).length === 0) {
    delete parsed['hooks']
    changed = true
  }

  if (!changed) return

  const newContent = JSON.stringify(parsed, null, 2)
  const tmp = settingsPath + '.tmp'
  try {
    fs.writeFileSync(tmp, newContent, 'utf-8')
    fs.renameSync(tmp, settingsPath)
  } catch (err) {
    console.warn('[orpheusNotify] uninstallManagedHooks: failed to write settings.json:', err)
    logDiagMain({
      category: 'anomaly',
      level: 'warn',
      event: DIAG_EVENTS.HOOK_UNINSTALL_FAILED,
      data: { err: String(err) }
    })
  }
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

  // TODO(security): a per-session token (generated at mount time, injected via
  // ORPHEUS_NOTIFY_TOKEN env var into orpheus-claude.sh, forwarded by the
  // orpheus-notify shim as an Authorization header, and validated here) would
  // add a second layer on top of the filesystem permission below. The plumbing
  // is mostly in place (ORPHEUS_WORKSPACE_ID is already injected at mount time
  // in the same env-var merge; adding a token would follow the same path through
  // composeClaudeLaunch → terminal:mount → orpheus-claude.sh → shim). Not
  // wiring it here because it requires coordinated changes to resources/bin/orpheus-notify
  // and src/main/index.ts (the mount handler), which are out of scope for this pass.
  server.listen(sockPath, () => {
    try {
      fs.chmodSync(sockPath, 0o600)
    } catch (err) {
      console.warn(
        '[orpheusNotify] could not chmod notify.sock to 0600 — socket is accessible to all local users:',
        err
      )
    }
  })

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
