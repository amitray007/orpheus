import { Notification, BrowserWindow } from 'electron'
import { getAppUiState } from './uiState'
import { getWorkspace } from './workspaces'
import { getDb } from './db'
import { getBlockingTool } from './orpheusNotify'
import type { WorkspaceStatus } from '../shared/types'

function attentionCopy(workspaceId: string): { title: string; body: string } {
  const tool = getBlockingTool(workspaceId)
  if (tool === 'AskUserQuestion') {
    return { title: 'Claude is asking', body: 'Has a question for you' }
  }
  if (tool === 'ExitPlanMode') {
    return { title: 'Claude has a plan', body: 'Waiting for your review before continuing' }
  }
  return { title: 'Claude needs you', body: 'Waiting on a permission decision' }
}

let currentlyViewedWorkspaceId: string | null = null

// Exponential backoff between repeat attention notifications. After the index
// reaches the end the last delay plateaus, so larger user-configured max counts
// keep firing at 8-minute intervals rather than blowing up unboundedly.
const ATTENTION_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000]

type AttentionRetry = {
  count: number
  timer: NodeJS.Timeout
}
const attentionRetries = new Map<string, AttentionRetry>()

function cancelAttentionRetry(workspaceId: string): void {
  const r = attentionRetries.get(workspaceId)
  if (!r) return
  clearTimeout(r.timer)
  attentionRetries.delete(workspaceId)
}

export function setCurrentlyViewedWorkspace(workspaceId: string | null): void {
  currentlyViewedWorkspaceId = workspaceId
  if (workspaceId) cancelAttentionRetry(workspaceId)
}

function resolveWorkspaceLabel(workspaceId: string): string {
  const ws = getWorkspace(workspaceId)
  if (!ws) return workspaceId

  const db = getDb()
  const wsRow = db
    .prepare('SELECT last_title FROM workspaces WHERE id = ?')
    .get(workspaceId) as { last_title: string | null } | undefined
  const displayTitle = wsRow?.last_title || ws.name

  const projectRow = db
    .prepare('SELECT name FROM projects WHERE id = ?')
    .get(ws.projectId) as { name: string } | undefined
  const projectName = projectRow?.name ?? ws.projectId

  return `${projectName} · ${displayTitle}`
}

function shouldSuppress(workspaceId: string): boolean {
  const state = getAppUiState()
  if (state.notifyAlways) return false
  const wins = BrowserWindow.getAllWindows()
  const win = wins[0]
  if (!win) return false
  return win.isFocused() && currentlyViewedWorkspaceId === workspaceId
}

function focusAndNavigate(workspaceId: string): void {
  const wins = BrowserWindow.getAllWindows()
  const win = wins[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  win.webContents.send('workspace:navigateTo', { workspaceId })
}

function fireAttentionNotification(
  workspaceId: string,
  count: number,
  maxRepeats: number
): void {
  if (shouldSuppress(workspaceId)) return
  const label = resolveWorkspaceLabel(workspaceId)
  const copy = attentionCopy(workspaceId)
  const body =
    count === 0
      ? copy.body
      : `${copy.body} (${count + 1} of ${maxRepeats + 1})`
  const title = count === 0 ? copy.title : `${copy.title} (still)`
  const notif = new Notification({
    title,
    subtitle: label,
    body,
    silent: false
  })
  notif.on('click', () => focusAndNavigate(workspaceId))
  notif.show()
}

function scheduleAttentionRetry(workspaceId: string, nextCount: number, maxRepeats: number): void {
  if (nextCount > maxRepeats) return
  const delayIdx = Math.min(nextCount - 1, ATTENTION_BACKOFF_MS.length - 1)
  const delay = ATTENTION_BACKOFF_MS[delayIdx]
  const timer = setTimeout(() => {
    attentionRetries.delete(workspaceId)
    // Bail if the workspace is no longer in attention (status moved on while we waited).
    const ws = getWorkspace(workspaceId)
    if (!ws || ws.status !== 'attention') return
    const state = getAppUiState()
    if (!state.notifyAttention) return
    fireAttentionNotification(workspaceId, nextCount, maxRepeats)
    scheduleAttentionRetry(workspaceId, nextCount + 1, maxRepeats)
  }, delay)
  attentionRetries.set(workspaceId, { count: nextCount, timer })
}

export function notifyForTransition(
  workspaceId: string,
  prevStatus: WorkspaceStatus | undefined,
  nextStatus: WorkspaceStatus
): void {
  const state = getAppUiState()

  if (nextStatus !== 'attention') {
    cancelAttentionRetry(workspaceId)
  }

  if (nextStatus === 'attention' && state.notifyAttention) {
    cancelAttentionRetry(workspaceId)
    const maxRepeats = Math.max(0, state.notifyMaxAttentionRepeats ?? 0)
    fireAttentionNotification(workspaceId, 0, maxRepeats)
    if (maxRepeats > 0) {
      scheduleAttentionRetry(workspaceId, 1, maxRepeats)
    }
    return
  }

  if (
    nextStatus === 'awaiting_input' &&
    prevStatus === 'in_progress' &&
    state.notifyStop
  ) {
    if (shouldSuppress(workspaceId)) return
    const label = resolveWorkspaceLabel(workspaceId)
    const notif = new Notification({
      title: 'Claude finished',
      subtitle: label,
      body: 'Ready for your next message',
      silent: true
    })
    notif.on('click', () => focusAndNavigate(workspaceId))
    notif.show()
    return
  }
}

export function fireTestNotification(): void {
  const notif = new Notification({
    title: 'Test notification',
    subtitle: 'Orpheus',
    body: 'If you see this, notifications are working.',
    silent: false
  })
  notif.show()
}
