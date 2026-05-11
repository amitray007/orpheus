import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'
import type { DoctorResult, ExistingProject } from '../shared/types'

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
    trafficLightPosition: { x: 16, y: 16 },
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

// Main process inherits the launching user's shell environment, so PATH-based
// lookups (e.g. brew-installed `claude`) should resolve automatically.
// We augment PATH defensively for common install locations just in case.
const augmentedEnv = {
  ...process.env,
  PATH: `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ''}`
}

function checkClaude(): { installed: boolean; version: string | null; path: string | null } {
  let claudePath: string | null = null

  try {
    claudePath = childProcess
      .execSync('which claude', { encoding: 'utf-8', env: augmentedEnv })
      .trim()
  } catch {
    // `which` failed — claude not on PATH
    return { installed: false, version: null, path: null }
  }

  let version: string | null = null
  try {
    const versionOutput = childProcess.execSync('claude --version', {
      encoding: 'utf-8',
      env: augmentedEnv
    })
    const match = versionOutput.match(/(\d+\.\d+\.\d+)/)
    version = match ? match[1] : null
  } catch {
    // `claude --version` failed but `which` succeeded — installed, version unknown
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
