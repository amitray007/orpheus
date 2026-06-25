import { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { subscribeDiag } from './diagnostics'
import type { DiagEvent } from '../shared/types'

// Single-instance diagnostics console window. Opening it is what attaches the
// diag subscriber (so liveSubscriberCount rises only while open); closing fully
// unsubscribes. The window is a plain renderer — it must NEVER create a ghostty
// native surface.

let win: BrowserWindow | null = null
let unsub: (() => void) | null = null
let flushTimer: ReturnType<typeof setInterval> | null = null
let buffer: DiagEvent[] = []
let droppedForBackpressure = 0 // eslint-disable-line @typescript-eslint/no-unused-vars

const FLUSH_INTERVAL_MS = 150
const SEND_BATCH_MAX = 500
const BUFFER_CAP = 5000

function teardown(): void {
  // Idempotent: a renderer crash then a close (or vice-versa) both call this.
  if (!unsub && !flushTimer) return
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  if (unsub) {
    try {
      unsub()
    } catch {
      /* never throw */
    }
    unsub = null
  }
  buffer = []
  droppedForBackpressure = 0
}

function startStreaming(target: BrowserWindow): void {
  // Attach the subscriber only once the renderer is ready to receive.
  unsub = subscribeDiag((e) => {
    if (buffer.length >= BUFFER_CAP) {
      buffer.shift()
      droppedForBackpressure++
    }
    buffer.push(e)
  })
  flushTimer = setInterval(() => {
    try {
      if (target.isDestroyed()) return
      if (buffer.length === 0) return
      const batch = buffer.splice(0, SEND_BATCH_MAX)
      target.webContents.send('diag:stream', batch)
    } catch {
      /* never throw out of the flush loop */
    }
  }, FLUSH_INTERVAL_MS)
  if (typeof flushTimer.unref === 'function') flushTimer.unref()
}

export function openDiagConsole(): void {
  try {
    if (win && !win.isDestroyed()) {
      win.focus()
      return
    }
    win = new BrowserWindow({
      width: 960,
      height: 640,
      minWidth: 640,
      minHeight: 400,
      show: false,
      title: 'Orpheus Diagnostics',
      backgroundColor: '#0b0b0c',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        backgroundThrottling: false
      }
    })

    const created = win

    created.on('ready-to-show', () => {
      if (!created.isDestroyed()) created.show()
    })

    // Attach + start the batched stream once the renderer has loaded so no
    // events are sent before the listener is wired.
    created.webContents.on('did-finish-load', () => {
      if (created.isDestroyed()) return
      if (unsub) {
        // Reload of an already-streaming window: the renderer's in-memory feed
        // is gone, so drop any buffered events to start the reload clean.
        buffer = []
        droppedForBackpressure = 0
        return // already subscribed — don't double-subscribe
      }
      startStreaming(created)
    })

    created.webContents.on('render-process-gone', () => {
      teardown()
    })

    created.on('closed', () => {
      teardown()
      if (win === created) win = null
    })

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      created.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?view=diag-console`)
    } else {
      created.loadFile(join(__dirname, '../renderer/index.html'), { search: 'view=diag-console' })
    }
  } catch (err) {
    console.error('[diagConsole] failed to open console window:', err)
  }
}

export function closeDiagConsole(): void {
  try {
    if (win && !win.isDestroyed()) win.close()
  } catch {
    /* never throw */
  }
}
