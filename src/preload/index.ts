import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { DoctorResult } from '../shared/types'

// Custom APIs for renderer
const api = {
  config: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('config:openFolder'),
    getSetupCompleted: (): Promise<boolean> => ipcRenderer.invoke('config:getSetupCompleted'),
    setSetupCompleted: (value: boolean): Promise<boolean> =>
      ipcRenderer.invoke('config:setSetupCompleted', value)
  },
  doctor: {
    check: (): Promise<DoctorResult> => ipcRenderer.invoke('doctor:check')
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
