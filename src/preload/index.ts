import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  DoctorResult,
  ProjectRecord,
  SessionRecord,
  SessionStatus,
  WorkspaceRecord,
  PinnedItem
} from '../shared/types'

// Custom APIs for renderer
const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion')
  },
  config: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('config:openFolder')
  },
  doctor: {
    check: (): Promise<DoctorResult> => ipcRenderer.invoke('doctor:check')
  },
  projects: {
    list: (): Promise<ProjectRecord[]> => ipcRenderer.invoke('projects:list'),
    add: (path: string): Promise<ProjectRecord> => ipcRenderer.invoke('projects:add', { path }),
    pickAndAdd: (): Promise<ProjectRecord | null> => ipcRenderer.invoke('projects:pickAndAdd'),
    open: (id: string): Promise<ProjectRecord> => ipcRenderer.invoke('projects:open', { id }),
    archive: (id: string): Promise<void> => ipcRenderer.invoke('projects:archive', { id }),
    rename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke('projects:rename', { id, name })
  },
  sessions: {
    listForProject: (
      projectId: string,
      options?: { includeArchived?: boolean }
    ): Promise<SessionRecord[]> =>
      ipcRenderer.invoke('sessions:listForProject', { projectId, ...options }),
    listAll: (opts?: { status?: SessionStatus }): Promise<SessionRecord[]> =>
      ipcRenderer.invoke('sessions:listAll', opts),
    setStatus: (id: string, status: SessionStatus): Promise<void> =>
      ipcRenderer.invoke('sessions:setStatus', { id, status })
  },
  workspaces: {
    listForProject: (
      projectId: string,
      options?: { includeArchived?: boolean }
    ): Promise<WorkspaceRecord[]> =>
      ipcRenderer.invoke('workspaces:listForProject', { projectId, ...options }),
    create: (args: { projectId: string; name: string; cwd: string }): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:create', args),
    open: (id: string): Promise<WorkspaceRecord> => ipcRenderer.invoke('workspaces:open', { id }),
    setPinned: (id: string, pinned: boolean): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:setPinned', { id, pinned }),
    archive: (id: string): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:archive', { id }),
    rename: (id: string, name: string): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:rename', { id, name })
  },
  pins: {
    listAll: (): Promise<PinnedItem[]> => ipcRenderer.invoke('pins:listAll')
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
