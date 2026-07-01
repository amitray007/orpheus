import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type {
  OverlayShowMessage,
  OverlayUpdateMessage,
  OverlaySizeReport,
  OverlayAck,
  OverlayEvent
} from '../shared/types'

// Custom APIs for the overlay renderer (the second React root that paints
// above the terminal NSView). See src/main/overlayLayer.ts (U4) for the
// main-process side of this contract.
const overlayApi = {
  onShow: (cb: (msg: OverlayShowMessage) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, msg: OverlayShowMessage): void => cb(msg)
    ipcRenderer.on('overlayRenderer:show', listener)
    return () => ipcRenderer.removeListener('overlayRenderer:show', listener)
  },
  onUpdate: (cb: (msg: OverlayUpdateMessage) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, msg: OverlayUpdateMessage): void => cb(msg)
    ipcRenderer.on('overlayRenderer:update', listener)
    return () => ipcRenderer.removeListener('overlayRenderer:update', listener)
  },
  onThemeChange: (cb: (theme: string) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, theme: string): void => cb(theme)
    ipcRenderer.on('overlayRenderer:theme', listener)
    return () => ipcRenderer.removeListener('overlayRenderer:theme', listener)
  },
  onHide: (cb: (msg: { id: string; generation: number }) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, msg: { id: string; generation: number }): void =>
      cb(msg)
    ipcRenderer.on('overlayRenderer:hide', listener)
    return () => ipcRenderer.removeListener('overlayRenderer:hide', listener)
  },
  ackPainted: (ack: OverlayAck): void => {
    ipcRenderer.send('overlayRenderer:ackPainted', ack)
  },
  reportSize: (report: OverlaySizeReport): void => {
    ipcRenderer.send('overlayRenderer:reportSize', report)
  },
  sendEvent: (e: OverlayEvent): void => {
    ipcRenderer.send('overlayRenderer:event', e)
  },
  ready: (): void => {
    ipcRenderer.send('overlayRenderer:ready')
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('overlayApi', overlayApi)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.overlayApi = overlayApi
}
