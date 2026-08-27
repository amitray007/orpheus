import type { BrowserWindow } from 'electron'
import { PUSH_CHANNELS } from '../../shared/ipc'
import type { RendererControlRequest } from '../../shared/workbenchControl'
import type {
  RendererCommandBroker,
  RendererCommandTransport
} from '../workbenchControl/rendererCommandBroker'
import { handle } from './handle'

let readyWebContentsId: number | null = null
const observedContents = new WeakSet<Electron.WebContents>()

// Push-style companion to the readyWebContentsId poll above (isAvailable()).
// activityBootBuffer's boot-seed delivery fix (index.ts's onActivityBatch
// listener) needs to know the INSTANT the renderer becomes ready, not just
// be able to ask later — a poll can't wake anyone up. Callbacks fire once
// per control:rendererReady event and stay registered for the next one (a
// dev HMR reload or crash-recovery reload re-arms readyWebContentsId, and
// the same listeners should fire again then), so this is a subscribe list,
// not a one-shot.
const rendererReadyListeners = new Set<() => void>()

/** Subscribe to every future control:rendererReady event (initial boot AND
 *  any later reload). Returns an unsubscribe fn. */
export function onRendererReady(cb: () => void): () => void {
  rendererReadyListeners.add(cb)
  return () => rendererReadyListeners.delete(cb)
}

export function registerWorkbenchControlIpc(deps: {
  broker: RendererCommandBroker
  getMainWindow: () => BrowserWindow | null
}): void {
  handle('control:rendererReady', (event) => {
    const window = deps.getMainWindow()
    if (window == null || window.isDestroyed() || event.sender.id !== window.webContents.id) return
    if (readyWebContentsId != null && readyWebContentsId !== event.sender.id) {
      deps.broker.rejectAll('Renderer was replaced.')
    }
    readyWebContentsId = event.sender.id
    rendererReadyListeners.forEach((cb) => {
      try {
        cb()
      } catch (err) {
        console.error('[workbenchControl] rendererReady listener error:', err)
      }
    })
    if (!observedContents.has(event.sender)) {
      observedContents.add(event.sender)
      event.sender.on('did-start-loading', () => {
        if (readyWebContentsId === event.sender.id) readyWebContentsId = null
        deps.broker.rejectAll()
      })
      event.sender.on('render-process-gone', () => {
        if (readyWebContentsId === event.sender.id) readyWebContentsId = null
        deps.broker.rejectAll()
      })
      event.sender.on('destroyed', () => {
        if (readyWebContentsId === event.sender.id) readyWebContentsId = null
        deps.broker.rejectAll()
      })
    }
  })
  handle('control:ackRendererCommand', (event, ack) => {
    const window = deps.getMainWindow()
    if (window == null || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      return false
    }
    return deps.broker.acknowledge(ack)
  })
}

export function createRendererCommandTransport(
  getMainWindow: () => BrowserWindow | null
): RendererCommandTransport {
  return {
    isAvailable: (): boolean => {
      const window = getMainWindow()
      return (
        window != null &&
        !window.isDestroyed() &&
        !window.webContents.isLoading() &&
        readyWebContentsId === window.webContents.id
      )
    },
    send: (request: RendererControlRequest): boolean => {
      const window = getMainWindow()
      if (
        window == null ||
        window.isDestroyed() ||
        window.webContents.isLoading() ||
        readyWebContentsId !== window.webContents.id
      ) {
        return false
      }
      window.webContents.send(PUSH_CHANNELS.controlRendererCommand, request)
      return true
    }
  }
}
