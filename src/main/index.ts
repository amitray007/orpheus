import { app, shell, BrowserWindow, ipcMain, dialog, screen, globalShortcut } from 'electron'
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
  setProjectExpandedInSidebar,
  reorderProjects
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
  reorderWorkspaces,
  listAllPinned,
  setWorkspaceStatus,
  setWorkspaceClaudeSessionId,
  setWorkspaceLastTitle,
  getAllWorkspaceLastTitles
} from './workspaces'
import { getClaudeGlobalSettings, updateClaudeGlobalSettings, composeClaudeLaunch } from './claudeSettings'
import { getClaudeProjectSettings, updateClaudeProjectSettings } from './claudeProjectSettings'
import { getClaudeWorkspaceSettings, updateClaudeWorkspaceSettings } from './claudeWorkspaceSettings'
import { getAppUiState, updateAppUiState } from './uiState'
import { getClaudeAuthState, updateClaudeAuth, getClaudeAuthEnv, testAnthropicConnection } from './claudeAuth'
import { listMcpServers, addMcpServer, updateMcpServer, deleteMcpServer } from './mcp'
import {
  listSlashCommands,
  listSubagents,
  addSlashCommand,
  updateSlashCommand,
  deleteSlashCommand,
  addSubagent,
  updateSubagent,
  deleteSubagent
} from './claudeAgents'
import { listClaudeHooks, addHook, updateHook, deleteHook } from './claudeHooks'
import { showContextMenu } from './contextMenu'
import type {
  SessionStatus,
  WorkspaceStatus,
  ClaudeGlobalSettingsPatch,
  AppUiStatePatch,
  ClaudeProjectSettingsOverrides,
  ClaudeWorkspaceSettingsOverrides,
  ClaudeAuthPatch,
  ClaudeHookDraft,
  McpServerDraft,
  ClaudeSlashCommandDraft,
  ClaudeSubagentDraft,
  ContextMenuNativeItem
} from '../shared/types'
import type { ClaudeLaunch } from './claudeSettings'

// ---------------------------------------------------------------------------
// Launch snapshot + dirty tracking
// ---------------------------------------------------------------------------

// Keyed by workspaceId — snapshot of the ClaudeLaunch used at terminal:mount time.
const launchSnapshots = new Map<string, ClaudeLaunch>()
const dirtyWorkspaces = new Set<string>()

// Keyed by workspaceId — most recent terminal title from OSC 0/2.
const workspaceTitles = new Map<string, string>()

let titleCallbackRegistered = false

function ensureTitleCallback(addon: GhosttyNativeAddon): void {
  if (titleCallbackRegistered) return
  titleCallbackRegistered = true
  addon.setTitleCallback((workspaceId: string, title: string) => {
    console.log('[title] native fired', { workspaceId, title })
    if (title) {
      workspaceTitles.set(workspaceId, title)
    } else {
      workspaceTitles.delete(workspaceId)
    }
    // Persist so the next launch can seed from the DB and the sidebar/header
    // shows the prior title instead of the default workspace name.
    try {
      setWorkspaceLastTitle(workspaceId, title || null)
    } catch (err) {
      console.error('[title] failed to persist last_title', err)
    }
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('workspace:titleChanged', { workspaceId, title: title || null })
    }
  })
  // Diagnostic: also forward every action_cb tag to the renderer for visibility
  // via DevTools console. Routed through a separate IPC so it doesn't pollute
  // the title flow.
  addon.setActionTraceCallback((tagName: string) => {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('addon:actionTrace', { tagName })
    }
  })
}

function launchEquals(a: ClaudeLaunch, b: ClaudeLaunch): boolean {
  if (a.flags !== b.flags || a.settingsJson !== b.settingsJson) return false
  const ak = Object.keys(a.env).sort()
  const bk = Object.keys(b.env).sort()
  if (ak.length !== bk.length) return false
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false
    if (a.env[ak[i] as string] !== b.env[ak[i] as string]) return false
  }
  return true
}

function broadcastDirty(workspaceId: string, dirty: boolean): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('workspace:dirtyChanged', { workspaceId, dirty })
  }
}

function setDirty(workspaceId: string, dirty: boolean): void {
  const was = dirtyWorkspaces.has(workspaceId)
  if (dirty) dirtyWorkspaces.add(workspaceId)
  else dirtyWorkspaces.delete(workspaceId)
  if (was !== dirty) broadcastDirty(workspaceId, dirty)
}

function recomputeDirty(): void {
  for (const [workspaceId, snap] of launchSnapshots.entries()) {
    const ws = getWorkspace(workspaceId)
    if (!ws) continue
    const fresh = composeClaudeLaunch(ws.projectId, workspaceId)
    setDirty(workspaceId, !launchEquals(snap, fresh))
  }
}

// ---------------------------------------------------------------------------
// Claude session-ID capture (v26)
// ---------------------------------------------------------------------------

/**
 * Encode an absolute cwd path into the format claude uses for its project
 * directory names under ~/.claude/projects/: slashes become dashes.
 * e.g. "/Users/maverick/code/orpheus" → "-Users-maverick-code-orpheus"
 */
function encodedClaudeCwd(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/**
 * After a new workspace mounts (no session ID stored yet), poll the
 * ~/.claude/projects/<encoded-cwd>/ directory until a .jsonl appears,
 * then persist the session ID so subsequent mounts can pass --resume.
 * Also re-snapshots the launch so the --resume flag doesn't look like drift.
 */
async function captureWorkspaceSessionId(workspaceId: string, cwd: string): Promise<void> {
  const claudeProjectsDir = nodePath.join(
    os.homedir(),
    '.claude',
    'projects',
    encodedClaudeCwd(cwd)
  )

  // Poll with increasing back-off — claude may not write the .jsonl immediately.
  for (const delay of [2000, 5000, 12000]) {
    await new Promise((r) => setTimeout(r, delay))

    if (!fs.existsSync(claudeProjectsDir)) continue

    try {
      const entries = fs
        .readdirSync(claudeProjectsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))

      if (entries.length === 0) continue

      // Pick the newest by mtime — this workspace's session is the most recent.
      const withStats = entries.map((e) => {
        const full = nodePath.join(claudeProjectsDir, e.name)
        return { name: e.name, mtimeMs: fs.statSync(full).mtimeMs }
      })
      withStats.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const sessionId = withStats[0]!.name.replace(/\.jsonl$/, '')

      const current = getWorkspace(workspaceId)
      if (!current) return
      if (current.claudeSessionId === sessionId) return // already stored

      setWorkspaceClaudeSessionId(workspaceId, sessionId)
      console.log('[claude-session] captured', { workspaceId, sessionId })

      // Re-snapshot with the --resume flag so the dirty-tracker doesn't flag
      // the session_id addition as a phantom settings change.
      const fresh = composeClaudeLaunch(current.projectId, workspaceId)
      launchSnapshots.set(workspaceId, fresh)
      setDirty(workspaceId, false)
      return
    } catch (err) {
      console.error('[claude-session] capture attempt failed:', err)
    }
  }
}

// ---------------------------------------------------------------------------
// Launch at login + global hotkey helpers
// ---------------------------------------------------------------------------

function applyLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false })
}

let registeredHotkey: string = ''

function applyGlobalHotkey(hotkey: string): boolean {
  // Unregister previous if changed
  if (registeredHotkey && registeredHotkey !== hotkey) {
    globalShortcut.unregister(registeredHotkey)
    registeredHotkey = ''
  }
  if (!hotkey) return true
  if (registeredHotkey === hotkey) return true // already active
  try {
    const ok = globalShortcut.register(hotkey, () => {
      const wins = BrowserWindow.getAllWindows()
      const win = wins[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      app.focus({ steal: true })
    })
    if (!ok) {
      console.error('[shortcut] failed to register:', hotkey)
      return false
    }
    registeredHotkey = hotkey
    return true
  } catch (err) {
    console.error('[shortcut] register threw:', err)
    return false
  }
}

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

  // Auto-focus the current workspace's terminal whenever the window becomes
  // active again (Cmd-Tab back, dock click, etc.). Without this the focus
  // stays on whatever HTML element it was on, and typing won't reach claude.
  mainWindow.on('focus', () => {
    try {
      const state = getAppUiState()
      if (state.lastViewKind !== 'workspace' || !state.lastWorkspaceId) return
      const addon = loadTerminalAddon()
      addon.focus(state.lastWorkspaceId)
    } catch (err) {
      console.error('[focus] auto-focus terminal failed:', err)
    }
  })

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
  const shell = process.env.SHELL
  if (!shell) {
    console.warn('[orpheus] SHELL not set; user PATH cannot be derived')
    cachedShellPath = ''
    return cachedShellPath
  }
  try {
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

ipcMain.handle('window:openDevTools', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  win.webContents.openDevTools({ mode: 'detach' })
})

ipcMain.handle('window:reload', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  win.webContents.reload()
})

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

ipcMain.handle(
  'workspaces:reorder',
  (_e, { projectId, orderedIds }: { projectId: string; orderedIds: string[] }) =>
    reorderWorkspaces(projectId, orderedIds)
)

ipcMain.handle(
  'workspace:isDirty',
  (_e, { workspaceId }: { workspaceId: string }): boolean => dirtyWorkspaces.has(workspaceId)
)

ipcMain.handle(
  'workspaces:setStatus',
  (_e, { id, status }: { id: string; status: WorkspaceStatus }) => setWorkspaceStatus(id, status)
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

ipcMain.handle('claudeSettings:update', (_e, patch: ClaudeGlobalSettingsPatch) => {
  const result = updateClaudeGlobalSettings(patch)
  recomputeDirty()
  return result
})

// ---------------------------------------------------------------------------
// MCP IPC
// ---------------------------------------------------------------------------

ipcMain.handle('mcp:listServers', () => listMcpServers())
ipcMain.handle('mcp:add', (_e, draft: McpServerDraft) => addMcpServer(draft))
ipcMain.handle('mcp:update', (_e, args: { filePath: string; oldName: string; draft: Omit<McpServerDraft, 'source' | 'projectId'> }) =>
  updateMcpServer(args.filePath, args.oldName, args.draft)
)
ipcMain.handle('mcp:delete', (_e, args: { filePath: string; name: string }) =>
  deleteMcpServer(args.filePath, args.name)
)

// ---------------------------------------------------------------------------
// Claude Agents IPC
// ---------------------------------------------------------------------------

ipcMain.handle('claudeAgents:listSlashCommands', () => listSlashCommands())
ipcMain.handle('claudeAgents:listSubagents', () => listSubagents())

ipcMain.handle('claudeAgents:addSlashCommand', (_e, draft: ClaudeSlashCommandDraft) => addSlashCommand(draft))
ipcMain.handle('claudeAgents:updateSlashCommand', (_e, args: { filePath: string; draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'> }) =>
  updateSlashCommand(args.filePath, args.draft)
)
ipcMain.handle('claudeAgents:deleteSlashCommand', (_e, args: { filePath: string }) =>
  deleteSlashCommand(args.filePath)
)

ipcMain.handle('claudeAgents:addSubagent', (_e, draft: ClaudeSubagentDraft) => addSubagent(draft))
ipcMain.handle('claudeAgents:updateSubagent', (_e, args: { filePath: string; draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'> }) =>
  updateSubagent(args.filePath, args.draft)
)
ipcMain.handle('claudeAgents:deleteSubagent', (_e, args: { filePath: string }) =>
  deleteSubagent(args.filePath)
)

// ---------------------------------------------------------------------------
// Claude Hooks IPC
// ---------------------------------------------------------------------------

ipcMain.handle('claudeHooks:list', () => listClaudeHooks())
ipcMain.handle('claudeHooks:openFile', async (_e, { filePath }: { filePath: string }) => {
  await shell.openPath(filePath)
})
ipcMain.handle('claudeHooks:add', (_e, draft: ClaudeHookDraft) => addHook(draft))
ipcMain.handle('claudeHooks:update', (_e, args: {
  filePath: string
  event: string
  matcherEntryIdx: number
  hookIdx: number
  draft: Omit<ClaudeHookDraft, 'source' | 'projectId'>
}) => updateHook(args.filePath, args.event, args.matcherEntryIdx, args.hookIdx, args.draft))
ipcMain.handle('claudeHooks:delete', (_e, args: {
  filePath: string
  event: string
  matcherEntryIdx: number
  hookIdx: number
}) => deleteHook(args.filePath, args.event, args.matcherEntryIdx, args.hookIdx))

// ---------------------------------------------------------------------------
// Claude Auth IPC
// ---------------------------------------------------------------------------

ipcMain.handle('claudeAuth:get', () => getClaudeAuthState())

ipcMain.handle('claudeAuth:update', (_e, patch: ClaudeAuthPatch) => updateClaudeAuth(patch))

ipcMain.handle('claudeAuth:testConnection', () => testAnthropicConnection())

// ---------------------------------------------------------------------------
// Per-project Claude Settings IPC
// ---------------------------------------------------------------------------

ipcMain.handle('claudeProjectSettings:get', (_e, { projectId }: { projectId: string }) =>
  getClaudeProjectSettings(projectId)
)

ipcMain.handle(
  'claudeProjectSettings:update',
  (_e, args: { projectId: string; patch: ClaudeProjectSettingsOverrides }) => {
    const result = updateClaudeProjectSettings(args.projectId, args.patch)
    recomputeDirty()
    return result
  }
)

// ---------------------------------------------------------------------------
// Per-workspace Claude Settings IPC
// ---------------------------------------------------------------------------

ipcMain.handle('claudeWorkspaceSettings:get', (_e, { workspaceId }: { workspaceId: string }) =>
  getClaudeWorkspaceSettings(workspaceId)
)

ipcMain.handle(
  'claudeWorkspaceSettings:update',
  (_e, args: { workspaceId: string; patch: ClaudeWorkspaceSettingsOverrides }) => {
    const result = updateClaudeWorkspaceSettings(args.workspaceId, args.patch)
    recomputeDirty()
    return result
  }
)

// ---------------------------------------------------------------------------
// UI State IPC
// ---------------------------------------------------------------------------

ipcMain.handle('uiState:get', () => getAppUiState())

ipcMain.handle('uiState:update', (_e, patch: AppUiStatePatch) => {
  const result = updateAppUiState(patch)
  if (patch.launchAtLogin !== undefined) applyLaunchAtLogin(patch.launchAtLogin)
  if (patch.globalHotkey !== undefined) applyGlobalHotkey(patch.globalHotkey)
  return result
})

ipcMain.handle(
  'projects:setExpandedInSidebar',
  (_e, { id, expanded }: { id: string; expanded: boolean }) =>
    setProjectExpandedInSidebar(id, expanded)
)

ipcMain.handle('projects:reorder', (_e, { orderedIds }: { orderedIds: string[] }) =>
  reorderProjects(orderedIds)
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
// Context menu IPC (native Electron menu — renders above NSView)
// ---------------------------------------------------------------------------

ipcMain.handle('contextMenu:show', async (e, items: ContextMenuNativeItem[]) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return null
  return showContextMenu(items, win)
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
  focus: (workspaceId: string) => void
  setTitleCallback: (cb: (workspaceId: string, title: string) => void) => void
  setActionTraceCallback: (cb: (tagName: string) => void) => void
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
    ensureTitleCallback(addon)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('terminal:mount — no BrowserWindow for sender')
    const handle = win.getNativeWindowHandle()

    // Look up the workspace's projectId for per-project override resolution
    const ws = getWorkspace(workspaceId)
    const projectId = ws?.projectId

    // Compose claude settings into env vars for the wrapper script.
    const launch = composeClaudeLaunch(projectId, workspaceId)

    // Auth env vars (ANTHROPIC_API_KEY, provider routing flags, etc.).
    // Merged LAST so they win over any ambient settings-derived values.
    // NEVER log authEnv values — they contain plaintext secrets.
    const authEnv = getClaudeAuthEnv()

    const surfaceEnv: Record<string, string> = {
      ...launch.env,
      ...authEnv,  // auth env wins on conflict
      ...(launch.flags ? { ORPHEUS_CLAUDE_FLAGS: launch.flags } : {}),
      ...(launch.settingsJson ? { ORPHEUS_CLAUDE_SETTINGS_JSON: launch.settingsJson } : {})
    }

    // Build a redacted copy of env for logging — never log secret values
    const redactedEnv: Record<string, string> = {}
    const SECRET_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])
    for (const [k, v] of Object.entries(surfaceEnv)) {
      redactedEnv[k] = SECRET_KEYS.has(k) ? '[redacted]' : v
    }
    console.log(
      '[terminal] mount workspaceId=%s flags=%s settingsJson=%s env=%s',
      workspaceId,
      launch.flags || '(none)',
      launch.settingsJson || '(none)',
      JSON.stringify(redactedEnv)
    )

    const result = addon.mount(handle, {
      workspaceId,
      rect,
      scaleFactor,
      cwd,
      env: surfaceEnv
    })

    // Snapshot the composed launch so we can detect settings drift later.
    launchSnapshots.set(workspaceId, launch)
    setDirty(workspaceId, false)

    // Fire-and-forget: capture the claude session ID written to disk after this
    // mount. Only needed on the first mount (no stored session yet); subsequent
    // mounts pass --resume so the .jsonl already exists and we skip re-capture.
    const wsForCapture = getWorkspace(workspaceId)
    if (wsForCapture && !wsForCapture.claudeSessionId) {
      captureWorkspaceSessionId(workspaceId, cwd ?? wsForCapture.cwd).catch((err) =>
        console.error('[claude-session] capture failed:', err)
      )
    }

    return result
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
  // Clean up snapshot and dirty state before destroying the surface
  launchSnapshots.delete(workspaceId)
  if (dirtyWorkspaces.delete(workspaceId)) {
    broadcastDirty(workspaceId, false)
  }
  // Clear title and notify renderer so stale claude titles don't linger
  if (workspaceTitles.delete(workspaceId)) {
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('workspace:titleChanged', { workspaceId, title: null })
    }
  }
  const addon = loadTerminalAddon()
  addon.destroy(workspaceId)
})

ipcMain.handle(
  'workspace:getTitle',
  (_e, { workspaceId }: { workspaceId: string }): string | null =>
    workspaceTitles.get(workspaceId) ?? null
)

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.orpheus.app')

  // Initialize / migrate the SQLite database early, before any IPC can fire.
  getDb()

  // Seed the in-memory workspaceTitles map from the DB so the sidebar /
  // workspace header can show the last observed prompt title immediately on
  // launch — without waiting for Claude to re-emit an OSC title.
  try {
    for (const { id, title } of getAllWorkspaceLastTitles()) {
      workspaceTitles.set(id, title)
    }
  } catch (err) {
    console.error('[startup] failed to seed workspaceTitles from DB:', err)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // Apply OS-level settings after the window exists (hotkey callback needs it)
  try {
    const state = getAppUiState()
    applyLaunchAtLogin(state.launchAtLogin)
    applyGlobalHotkey(state.globalHotkey)
  } catch (err) {
    console.error('[startup] failed to apply launch/hotkey settings:', err)
  }

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
