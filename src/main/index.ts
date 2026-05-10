import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join, resolve, dirname } from 'path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// ---------------------------------------------------------------------------
// Native addon loader
// ---------------------------------------------------------------------------
// electron-vite outputs main to out/main/index.js; __dirname is out/main/.
// In packaged mode, app.asar.unpacked holds the .node file.
// ---------------------------------------------------------------------------
const _require = createRequire(import.meta.url)
const _dirname = dirname(fileURLToPath(import.meta.url))

function resolveAddonPath(): string {
  const addonRelative = 'native-spike-zorder/build/Release/native_spike_zorder.node'
  if (app.isPackaged) {
    // asarUnpack places unpacked files under Contents/Resources/app.asar.unpacked/
    return resolve(process.resourcesPath, 'app.asar.unpacked', 'packages', addonRelative)
  }
  // Dev / build:unpack (not packaged yet, but electron-vite wrote out/main/index.js)
  // project root is two levels up from out/main/
  return resolve(_dirname, '..', '..', 'packages', addonRelative)
}

let addon: { mount: (handle: Buffer, rect: { x: number; y: number; w: number; h: number }) => void; unmount: () => void } | null = null

try {
  addon = _require(resolveAddonPath())
} catch (err) {
  console.warn('[spike-zorder] native addon not found or failed to load:', err)
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
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

  // Mount the spike NSView once the page has fully loaded
  mainWindow.webContents.once('did-finish-load', () => {
    if (addon && process.platform === 'darwin') {
      const handle = mainWindow.getNativeWindowHandle() as Buffer
      // rect in logical (CSS) coords; y=80 is safely below the 36px drag strip
      addon.mount(handle, { x: 80, y: 80, w: 400, h: 300 })
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('spike:zorder:unmount', () => {
  addon?.unmount()
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
