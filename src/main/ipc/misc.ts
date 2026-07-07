// ---------------------------------------------------------------------------
// src/main/ipc/misc.ts
//
// Grab-bag of small, self-contained IPC handlers moved verbatim out of
// index.ts (STR-1): pins:listAll, contextMenu:show, notifications:test,
// config:openFolder, app:getVersion/getPaths/offeredModes,
// window:openDevTools/reload. None of these close over index.ts-local
// mutable state; app:offeredModes and contextMenu:show only need a couple
// of read-only lookups passed in via deps.
// ---------------------------------------------------------------------------

import { app, BrowserWindow, dialog } from 'electron'
import type { ProjectRecord, ContextMenuNativeItem } from '../../shared/types'
import { listAllPinned } from '../workspaces'
import { showContextMenu } from '../contextMenu'
import { fireTestNotification } from '../osNotifications'
import { resolveMainWorktree, NotAGitRepoError } from '../worktrees'
import { resolveOfferedModes } from '../orpheusConfig'
import { getCachedAvatar } from '../avatarCache'
import { handle } from './handle'

export interface MiscIpcDeps {
  getProject: (id: string) => ProjectRecord | null
}

export function registerMiscIpc(deps: MiscIpcDeps): void {
  // ---------------------------------------------------------------------------
  // Pins IPC
  // ---------------------------------------------------------------------------

  handle('pins:listAll', () => listAllPinned())

  // ---------------------------------------------------------------------------
  // Config / app / window IPC
  // ---------------------------------------------------------------------------

  handle('config:openFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (result.canceled) return null
    const chosen = result.filePaths[0]
    console.log('[orpheus] folder selected:', chosen)
    return chosen ?? null
  })

  handle('app:getVersion', () => app.getVersion())

  handle('app:getPaths', () => ({
    userData: app.getPath('userData'),
    logs: app.getPath('logs')
  }))

  // Which workspace-creation modes the UI should offer for this project. Computes
  // is-git-repo authoritatively (resolveMainWorktree throws NotAGitRepoError for a
  // non-git cwd) and narrows the resolver result to the bare {local, worktree} the
  // renderer needs. Non-NotAGitRepo errors propagate.
  handle('app:offeredModes', async (_e, { projectId }: { projectId: string }) => {
    const project = deps.getProject(projectId)
    if (!project) throw new Error(`app:offeredModes: project not found: ${projectId}`)

    let isGit = true
    try {
      await resolveMainWorktree(project.path)
    } catch (err) {
      if (err instanceof NotAGitRepoError) {
        isGit = false
      } else {
        throw err
      }
    }

    const modes = await resolveOfferedModes(project.path, isGit)
    return { local: modes.local, worktree: modes.worktree }
  })

  handle('window:openDevTools', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.webContents.openDevTools({ mode: 'detach' })
  })

  handle('window:reload', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    win.webContents.reload()
  })

  // ---------------------------------------------------------------------------
  // Notifications IPC
  // ---------------------------------------------------------------------------

  handle('notifications:test', () => {
    fireTestNotification()
  })

  // ---------------------------------------------------------------------------
  // Context menu IPC (native Electron menu — renders above NSView)
  // ---------------------------------------------------------------------------

  handle('contextMenu:show', async (e, items: ContextMenuNativeItem[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return null
    return showContextMenu(items, win)
  })

  // ---------------------------------------------------------------------------
  // Avatar cache IPC (Git tab Avatar.tsx — fetch-once, disk-cached avatars)
  // ---------------------------------------------------------------------------

  handle('avatar:get', (_e, { url }: { url: string }) => getCachedAvatar(url))
}
