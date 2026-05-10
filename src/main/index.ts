import { app, shell, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// ---------------------------------------------------------------------------
// API key persistence via Electron safeStorage (macOS Keychain)
// ---------------------------------------------------------------------------

interface ConfigFile {
  apiKey?: string // base64 of the encrypted bytes
}

function getConfigPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function readConfig(): ConfigFile {
  try {
    const raw = readFileSync(getConfigPath(), 'utf-8')
    return JSON.parse(raw) as ConfigFile
  } catch {
    return {}
  }
}

function writeConfig(data: ConfigFile): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  writeFileSync(getConfigPath(), JSON.stringify(data, null, 2), 'utf-8')
}

function getApiKey(): string | null {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[orpheus] safeStorage encryption not available — cannot decrypt API key')
    return null
  }
  const config = readConfig()
  if (!config.apiKey) return null
  try {
    const encrypted = Buffer.from(config.apiKey, 'base64')
    return safeStorage.decryptString(encrypted)
  } catch (err) {
    console.error('[orpheus] failed to decrypt API key', err)
    return null
  }
}

function setApiKey(key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[orpheus] safeStorage encryption not available — cannot store API key')
    return
  }
  const encrypted = safeStorage.encryptString(key)
  const config = readConfig()
  config.apiKey = Buffer.from(encrypted).toString('base64')
  writeConfig(config)
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
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.handle('config:getApiKey', () => getApiKey())

ipcMain.handle('config:setApiKey', (_event, key: string) => {
  setApiKey(key)
  return true
})

ipcMain.handle('config:openFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled) return null
  const chosen = result.filePaths[0]
  console.log('[orpheus] folder selected:', chosen)
  return chosen ?? null
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
