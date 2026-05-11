import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { createRequire } from 'module'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DoctorResult, ExistingProject } from '../shared/types'
import { getDb } from './db'
import { listProjects, addProject, openProject, deleteProject, renameProject } from './projects'
import { listSessionsForProject, listAllSessions, setSessionStatus } from './sessions'
import {
  listWorkspacesForProject,
  createWorkspace,
  openWorkspace,
  setWorkspacePinned,
  archiveWorkspace,
  unarchiveWorkspace,
  renameWorkspace,
  listAllPinned
} from './workspaces'
import type { SessionStatus } from '../shared/types'

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

// Track when the user explicitly quits (Cmd+Q / app.quit()) so the close
// handler below can let the window actually close instead of hiding.
let isQuitting = false
app.on('before-quit', () => {
  isQuitting = true
})

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0c',
    titleBarStyle: 'hiddenInset',
    // Traffic lights vertically centered in the 48px (h-12) topbar:
    // y=18 puts the ~12px light's vertical center at 24px = topbar midline.
    trafficLightPosition: { x: 16, y: 18 },
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // On macOS, standard Electron behavior keeps the app frontmost when the
  // user clicks close or minimize — the menu bar stays "Orpheus" and apps
  // behind remain darkened. We call app.hide() instead so the previous app
  // regains focus naturally (same as Cmd+H). Cmd+Q still quits because
  // before-quit sets isQuitting=true, letting the close event pass through.
  if (process.platform === 'darwin') {
    mainWindow.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault()
        app.hide()
      }
    })
    // 'minimize' fires after the window has been minimized; hide the app
    // immediately after so the previous app gains focus.
    mainWindow.on('minimize', () => {
      app.hide()
    })
  }

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// Doctor helpers
// ---------------------------------------------------------------------------

// Finder-launched Electron apps get a stripped-down PATH that doesn't include
// the user's shell customizations (`.zshrc`, brew paths, npm-global, etc.).
// To match what the user sees in their actual terminal, we spawn a login +
// interactive subshell once on first check, capture its $PATH, and cache it.
let cachedShellPath: string | null = null
function getUserShellPath(): string {
  if (cachedShellPath !== null) return cachedShellPath
  try {
    const shell = process.env.SHELL ?? '/bin/zsh'
    const output = childProcess.execSync(
      `${shell} -ilc 'printf "%s" "$PATH"'`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    cachedShellPath = output.trim()
  } catch (err) {
    console.warn('[orpheus] failed to read user shell PATH:', err)
    cachedShellPath = ''
  }
  return cachedShellPath
}

function checkClaude(): { installed: boolean; version: string | null; path: string | null } {
  // PATH comes from the user's actual shell (cached). No hardcoded fallbacks:
  // if `claude` isn't on the user's shell PATH, it isn't installed for them.
  const userPath = getUserShellPath()
  const env = { ...process.env, PATH: userPath || process.env.PATH || '' }

  let claudePath: string
  try {
    claudePath = childProcess
      .execSync('which claude', { encoding: 'utf-8', env, timeout: 3000 })
      .trim()
    if (!claudePath) return { installed: false, version: null, path: null }
  } catch {
    return { installed: false, version: null, path: null }
  }

  let version: string | null = null
  try {
    const versionOutput = childProcess.execSync('claude --version', {
      encoding: 'utf-8',
      env,
      timeout: 3000
    })
    const match = versionOutput.match(/(\d+\.\d+\.\d+)/)
    version = match ? match[1] : null
  } catch {
    // `which` succeeded but `--version` failed; treat as installed, version unknown
  }
  return { installed: true, version, path: claudePath }
}

function readClaudeProjects(): ExistingProject[] {
  const projectsDir = nodePath.join(os.homedir(), '.claude', 'projects')

  if (!fs.existsSync(projectsDir)) return []

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory())

  const projects: ExistingProject[] = dirs.map((dir) => {
    const encodedName = dir.name
    // TODO: handle paths with literal dashes — naive decode treats every `-` as `/`,
    // so a path like `/Users/foo/my-cool-repo` (encoded: `-Users-foo-my-cool-repo`)
    // decodes ambiguously. Acceptable for v0 minimal.
    const decoded = encodedName.replace(/-/g, '/')
    const name = nodePath.basename(decoded)

    const dirPath = nodePath.join(projectsDir, encodedName)
    const jsonlFiles = fs
      .readdirSync(dirPath)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => nodePath.join(dirPath, f))

    const sessionCount = jsonlFiles.length

    let lastActivity: number | null = null
    for (const file of jsonlFiles) {
      try {
        const mtime = fs.statSync(file).mtimeMs
        if (lastActivity === null || mtime > lastActivity) {
          lastActivity = mtime
        }
      } catch {
        // skip unreadable files
      }
    }

    return { encodedName, path: decoded, name, sessionCount, lastActivity }
  })

  // Sort by lastActivity descending; null sinks to bottom
  return projects.sort((a, b) => {
    if (a.lastActivity === null && b.lastActivity === null) return 0
    if (a.lastActivity === null) return 1
    if (b.lastActivity === null) return -1
    return b.lastActivity - a.lastActivity
  })
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('config:openFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled) return null
  const chosen = result.filePaths[0]
  console.log('[orpheus] folder selected:', chosen)
  return chosen ?? null
})

ipcMain.handle('app:getVersion', () => app.getVersion())

// ---------------------------------------------------------------------------
// Projects IPC
// ---------------------------------------------------------------------------

ipcMain.handle('projects:list', () => listProjects())

ipcMain.handle('projects:add', (_e, { path }: { path: string }) => addProject(path))

ipcMain.handle('projects:pickAndAdd', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  const chosen = result.filePaths[0]
  console.log('[orpheus] project folder selected:', chosen)
  return addProject(chosen)
})

ipcMain.handle('projects:open', (_e, { id }: { id: string }) => openProject(id))

ipcMain.handle('projects:remove', (_e, { id }: { id: string }) => deleteProject(id))

ipcMain.handle('projects:rename', (_e, { id, name }: { id: string; name: string }) =>
  renameProject(id, name)
)

// ---------------------------------------------------------------------------
// Workspaces IPC
// ---------------------------------------------------------------------------

ipcMain.handle(
  'workspaces:listForProject',
  (_e, { projectId, scope }: { projectId: string; scope?: 'active' | 'archived' | 'all' }) =>
    listWorkspacesForProject(projectId, { scope })
)

ipcMain.handle(
  'workspaces:create',
  (_e, args: { projectId: string; name: string; cwd: string }) => createWorkspace(args)
)

ipcMain.handle('workspaces:open', (_e, { id }: { id: string }) => openWorkspace(id))

ipcMain.handle('workspaces:setPinned', (_e, { id, pinned }: { id: string; pinned: boolean }) =>
  setWorkspacePinned(id, pinned)
)

ipcMain.handle('workspaces:archive', (_e, { id }: { id: string }) => archiveWorkspace(id))

ipcMain.handle('workspaces:unarchive', (_e, { id }: { id: string }) => unarchiveWorkspace(id))

ipcMain.handle('workspaces:rename', (_e, { id, name }: { id: string; name: string }) =>
  renameWorkspace(id, name)
)

// ---------------------------------------------------------------------------
// Pins IPC
// ---------------------------------------------------------------------------

ipcMain.handle('pins:listAll', () => listAllPinned())

// ---------------------------------------------------------------------------
// Sessions IPC
// ---------------------------------------------------------------------------

ipcMain.handle(
  'sessions:listForProject',
  (_e, { projectId, includeArchived }: { projectId: string; includeArchived?: boolean }) =>
    listSessionsForProject(projectId, { includeArchived })
)

ipcMain.handle('sessions:listAll', (_e, opts?: { status?: SessionStatus }) =>
  listAllSessions(opts)
)

ipcMain.handle(
  'sessions:setStatus',
  (_e, { id, status }: { id: string; status: SessionStatus }) => setSessionStatus(id, status)
)

ipcMain.handle('doctor:check', (): DoctorResult => {
  const { installed, version, path: claudePath } = checkClaude()
  return {
    claudeInstalled: installed,
    claudeVersion: version,
    claudePath,
    existingProjects: readClaudeProjects()
  }
})

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.orpheus.app')

  // Initialize / migrate the SQLite database early, before any IPC can fire.
  getDb()

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // ---------------------------------------------------------------------------
  // Spike 1 — libghostty NAPI main-thread compatibility test
  // Only runs when SPIKE1=1 is set in the environment.
  // ---------------------------------------------------------------------------
  if (process.env['SPIKE1']) {
    const mainWin = BrowserWindow.getAllWindows()[0]
    if (mainWin) {
      mainWin.webContents.once('did-finish-load', () => {
        console.log('[spike1] did-finish-load fired, loading addon...')
        try {
          // Resolve the .node path: dev = project-relative, packaged = resourcesPath
          const addonPath = app.isPackaged
            ? join(process.resourcesPath, 'packages/ghostty-spike1/ghostty_spike1.node')
            : join(__dirname, '../../packages/ghostty-spike1/build/Release/ghostty_spike1.node')
          console.log('[spike1] loading addon from:', addonPath)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const addon = createRequire(import.meta.url)(addonPath) as { runSpike: () => string }
          console.log('[spike1] addon loaded OK, calling runSpike()...')
          const result = addon.runSpike()
          console.log('[spike1] runSpike result:\n' + result)
        } catch (err) {
          console.error('[spike1] addon load or runSpike threw:', err)
        }
      })
    }
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
