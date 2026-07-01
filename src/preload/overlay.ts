import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

// Custom APIs for the overlay renderer.
// U3 owns the real descriptor/event contract; this is a placeholder surface.
const overlayApi = {
  ping: (): Promise<string> => ipcRenderer.invoke('overlay:ping'),
  onPing: (cb: (e: { message: string }) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, e: { message: string }): void => cb(e)
    ipcRenderer.on('overlay:ping', listener)
    return () => ipcRenderer.removeListener('overlay:ping', listener)
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
