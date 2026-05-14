import { Notification, BrowserWindow } from 'electron'
import { getAppUiState } from './uiState'
import { getWorkspace } from './workspaces'
import { getDb } from './db'
import type { WorkspaceStatus } from '../shared/types'

let currentlyViewedWorkspaceId: string | null = null

export function setCurrentlyViewedWorkspace(workspaceId: string | null): void {
  currentlyViewedWorkspaceId = workspaceId
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

export function notifyForTransition(
  workspaceId: string,
  prevStatus: WorkspaceStatus | undefined,
  nextStatus: WorkspaceStatus
): void {
  const state = getAppUiState()

  if (nextStatus === 'attention' && state.notifyAttention) {
    if (shouldSuppress(workspaceId)) return
    const label = resolveWorkspaceLabel(workspaceId)
    const notif = new Notification({
      title: 'Claude needs you',
      subtitle: label,
      body: 'Waiting on a permission decision',
      silent: false
    })
    notif.on('click', () => focusAndNavigate(workspaceId))
    notif.show()
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
