import { app, shell, BrowserWindow, ipcMain, dialog, screen } from 'electron'
import { join } from 'path'
import { createRequire } from 'module'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DoctorResult, ExistingProject, GitStatus } from '../shared/types'
import { getGitStatus } from './git'
import { getDb } from './db'
import {
  listProjects,
  addProject,
  openProject,
  deleteProject,
  renameProject,
  setProjectExpandedInSidebar
} from './projects'
import { listSessionsForProject, listAllSessions, setSessionStatus } from './sessions'
import {
  listWorkspacesForProject,
  createWorkspace,
  openWorkspace,
  getWorkspace,
  setWorkspacePinned,
  archiveWorkspace,
  unarchiveWorkspace,
  renameWorkspace,
  listAllPinned
} from './workspaces'
import { getClaudeGlobalSettings, updateClaudeGlobalSettings, composeClaudeLaunch } from './claudeSettings'
import { getClaudeProjectSettings, updateClaudeProjectSettings } from './claudeProjectSettings'
import { getAppUiState, updateAppUiState } from './uiState'
import type { SessionStatus, ClaudeGlobalSettingsPatch, AppUiStatePatch, ClaudeProjectSettingsOverrides } from '../shared/types'

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
  // ---------------------------------------------------------------------------
  // Restore saved window geometry
  // ---------------------------------------------------------------------------
  const savedState = getAppUiState()

  // Validate saved bounds against currently-connected displays. If the saved
  // position is on an unplugged monitor, fall back to defaults.
  function isWithinSomeDisplay(x: number, y: number): boolean {
    const displays = screen.getAllDisplays()
    // Window is "within a display" if at least its top-left corner is inside
    // one of the displays' workAreas. Electron clamps the rest to screen edges.
    return displays.some((d) => {
      const a = d.workArea
      return x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height
    })
  }

  let restoredBounds: { x?: number; y?: number; width: number; height: number } = {
    width: 1280,
    height: 800
  }

  if (
    (savedState.restoreGeometry ?? true) &&
    savedState.windowX !== null &&
    savedState.windowY !== null &&
    savedState.windowWidth !== null &&
    savedState.windowHeight !== null &&
    isWithinSomeDisplay(savedState.windowX, savedState.windowY)
  ) {
    restoredBounds = {
      x: savedState.windowX,
      y: savedState.windowY,
      width: Math.max(savedState.windowWidth, 960),  // clamp to minWidth
      height: Math.max(savedState.windowHeight, 600)
    }
  }

  const mainWindow = new BrowserWindow({
    ...restoredBounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0c',
    titleBarStyle: 'hiddenInset',
    // Traffic lights vertically centered in the 44px (h-11) sidebar top strip:
    // (44 - 14) / 2 = 15
    trafficLightPosition: { x: 16, y: 15 },
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Restore fullscreen state before the window is shown
  if (savedState.windowFullscreen) {
    mainWindow.setFullScreen(true)
  }

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
  //
  // closeHides is read fresh from DB on each close event so that toggling the
  // setting in the UI takes effect without a restart.
  if (process.platform === 'darwin') {
    mainWindow.on('close', (e) => {
      const state = getAppUiState()
      if (!isQuitting && (state.closeHides ?? true)) {
        e.preventDefault()
        app.hide()
      }
      // else: let close proceed → window-all-closed fires → app.quit() not
      // called on darwin by default, so the process stays alive but windowless.
      // That's acceptable; user can re-open via the Dock or ⌘Q.
    })
    // 'minimize' fires after the window has been minimized; hide the app
    // immediately after so the previous app gains focus.
    mainWindow.on('minimize', () => {
      app.hide()
    })
  }

  // ---------------------------------------------------------------------------
  // Persist window geometry
  // ---------------------------------------------------------------------------

  let saveTimer: NodeJS.Timeout | null = null

  function scheduleBoundsSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      flushBoundsSave()
    }, 500)
  }

  function flushBoundsSave(): void {
    if (mainWindow.isDestroyed()) return
    // Don't save bounds while fullscreen — they reflect the pre-fullscreen geometry
    // that AppKit auto-restores on exit, and saving them here would clobber that.
    if (mainWindow.isFullScreen()) return
    const b = mainWindow.getBounds()
    updateAppUiState({
      windowX: b.x,
      windowY: b.y,
      windowWidth: b.width,
      windowHeight: b.height
    })
  }

  mainWindow.on('resize', scheduleBoundsSave)
  mainWindow.on('move', scheduleBoundsSave)

  mainWindow.on('enter-full-screen', () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    updateAppUiState({ windowFullscreen: true })
  })

  mainWindow.on('leave-full-screen', () => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    updateAppUiState({ windowFullscreen: false })
    // After exiting fullscreen, AppKit restores the pre-fullscreen geometry.
    // Capture it for next launch.
    // Use a slight delay because getBounds inside the leave-full-screen callback
    // may still report fullscreen bounds.
    setTimeout(() => {
      if (mainWindow.isDestroyed()) return
      const b = mainWindow.getBounds()
      updateAppUiState({ windowX: b.x, windowY: b.y, windowWidth: b.width, windowHeight: b.height })
    }, 250)
  })

  mainWindow.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      flushBoundsSave()
    }
  })

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

// ---------------------------------------------------------------------------
// Claude Settings IPC
// ---------------------------------------------------------------------------

ipcMain.handle('claudeSettings:get', () => getClaudeGlobalSettings())

ipcMain.handle('claudeSettings:update', (_e, patch: ClaudeGlobalSettingsPatch) =>
  updateClaudeGlobalSettings(patch)
)

// ---------------------------------------------------------------------------
// Per-project Claude Settings IPC
// ---------------------------------------------------------------------------

ipcMain.handle('claudeProjectSettings:get', (_e, { projectId }: { projectId: string }) =>
  getClaudeProjectSettings(projectId)
)

ipcMain.handle(
  'claudeProjectSettings:update',
  (_e, args: { projectId: string; patch: ClaudeProjectSettingsOverrides }) =>
    updateClaudeProjectSettings(args.projectId, args.patch)
)

// ---------------------------------------------------------------------------
// UI State IPC
// ---------------------------------------------------------------------------

ipcMain.handle('uiState:get', () => getAppUiState())

ipcMain.handle('uiState:update', (_e, patch: AppUiStatePatch) => updateAppUiState(patch))

ipcMain.handle(
  'projects:setExpandedInSidebar',
  (_e, { id, expanded }: { id: string; expanded: boolean }) =>
    setProjectExpandedInSidebar(id, expanded)
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
// Git IPC
// ---------------------------------------------------------------------------

ipcMain.handle('git:status', (_e, { cwd }: { cwd: string }): GitStatus | null =>
  getGitStatus(cwd)
)

// ---------------------------------------------------------------------------
// Terminal IPC — ghostty-native lifecycle
// ---------------------------------------------------------------------------

type TerminalRect = { x: number; y: number; w: number; h: number }
type GhosttyNativeAddon = {
  mount: (
    handle: Buffer,
    opts: {
      workspaceId: string
      rect: TerminalRect
      scaleFactor: number
      cwd?: string
      env?: Record<string, string>
    }
  ) => { workspaceId: string; created: boolean }
  hide: (workspaceId: string) => void
  resize: (workspaceId: string, rect: TerminalRect, scaleFactor: number) => void
  destroy: (workspaceId: string) => void
}

let terminalAddon: GhosttyNativeAddon | null = null
let terminalAddonError: string | null = null

function loadTerminalAddon(): GhosttyNativeAddon {
  if (terminalAddon) return terminalAddon
  if (terminalAddonError) throw new Error(terminalAddonError)

  // Set GHOSTTY_RESOURCES_DIR before the addon is loaded so ghostty_init
  // can find the terminfo / shell-integration resources bundled at:
  //   (packaged) Contents/Resources/ghostty
  //   (dev)      resources/ghostty/ghostty
  const resDir = app.isPackaged
    ? join(process.resourcesPath, 'ghostty')
    : join(__dirname, '../../resources/ghostty/ghostty')
  process.env['GHOSTTY_RESOURCES_DIR'] = resDir
  console.log('[terminal] GHOSTTY_RESOURCES_DIR set to', resDir)

  const addonPath = app.isPackaged
    ? join(process.resourcesPath, 'packages/ghostty-native/ghostty_native.node')
    : join(__dirname, '../../packages/ghostty-native/build/Release/ghostty_native.node')

  console.log('[terminal] loading addon from:', addonPath)
  try {
    terminalAddon = createRequire(import.meta.url)(addonPath) as GhosttyNativeAddon
    console.log('[terminal] addon loaded OK')
    return terminalAddon
  } catch (err) {
    const msg = String(err)
    terminalAddonError = msg
    console.error('[terminal] addon load FAILED:', msg)
    throw err
  }
}

ipcMain.handle(
  'terminal:mount',
  (
    e,
    {
      workspaceId,
      rect,
      scaleFactor,
      cwd
    }: { workspaceId: string; rect: TerminalRect; scaleFactor: number; cwd?: string }
  ): { workspaceId: string; created: boolean } => {
    const addon = loadTerminalAddon()
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('terminal:mount — no BrowserWindow for sender')
    const handle = win.getNativeWindowHandle()

    // Look up the workspace's projectId for per-project override resolution
    const ws = getWorkspace(workspaceId)
    const projectId = ws?.projectId

    // Compose claude settings into env vars for the wrapper script.
    const launch = composeClaudeLaunch(projectId)
    const surfaceEnv: Record<string, string> = {
      ...launch.env,
      ...(launch.flags ? { ORPHEUS_CLAUDE_FLAGS: launch.flags } : {}),
      ...(launch.settingsJson ? { ORPHEUS_CLAUDE_SETTINGS_JSON: launch.settingsJson } : {})
    }
    console.log(
      '[terminal] mount workspaceId=%s flags=%s settingsJson=%s env=%s',
      workspaceId,
      launch.flags || '(none)',
      launch.settingsJson || '(none)',
      JSON.stringify(launch.env)
    )

    return addon.mount(handle, {
      workspaceId,
      rect,
      scaleFactor,
      cwd,
      env: surfaceEnv
    })
  }
)

ipcMain.handle('terminal:hide', (_e, { workspaceId }: { workspaceId: string }): void => {
  const addon = loadTerminalAddon()
  addon.hide(workspaceId)
})

ipcMain.handle(
  'terminal:resize',
  (
    _e,
    {
      workspaceId,
      rect,
      scaleFactor
    }: { workspaceId: string; rect: TerminalRect; scaleFactor: number }
  ): void => {
    const addon = loadTerminalAddon()
    addon.resize(workspaceId, rect, scaleFactor)
  }
)

ipcMain.handle('terminal:destroy', (_e, { workspaceId }: { workspaceId: string }): void => {
  const addon = loadTerminalAddon()
  addon.destroy(workspaceId)
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

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
