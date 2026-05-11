import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  DoctorResult,
  ProjectRecord,
  SessionRecord,
  SessionStatus,
  WorkspaceRecord,
  PinnedItem,
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsPatch
} from '../shared/types'

type TerminalRect = { x: number; y: number; w: number; h: number }

// Custom APIs for renderer
const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion')
  },
  terminal: {
    mount: (rect: TerminalRect, scaleFactor: number, cwd?: string): Promise<{ surfaceId: string }> =>
      ipcRenderer.invoke('terminal:mount', { rect, scaleFactor, cwd }),
    unmount: (surfaceId: string): Promise<void> =>
      ipcRenderer.invoke('terminal:unmount', { surfaceId }),
    resize: (surfaceId: string, rect: TerminalRect, scaleFactor: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', { surfaceId, rect, scaleFactor })
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
    remove: (id: string): Promise<void> => ipcRenderer.invoke('projects:remove', { id }),
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
      options?: { scope?: 'active' | 'archived' | 'all' }
    ): Promise<WorkspaceRecord[]> =>
      ipcRenderer.invoke('workspaces:listForProject', { projectId, ...options }),
    create: (args: { projectId: string; name: string; cwd: string }): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:create', args),
    open: (id: string): Promise<WorkspaceRecord> => ipcRenderer.invoke('workspaces:open', { id }),
    setPinned: (id: string, pinned: boolean): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:setPinned', { id, pinned }),
    archive: (id: string): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:archive', { id }),
    unarchive: (id: string): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:unarchive', { id }),
    rename: (id: string, name: string): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:rename', { id, name })
  },
  pins: {
    listAll: (): Promise<PinnedItem[]> => ipcRenderer.invoke('pins:listAll')
  },
  claudeSettings: {
    get: (): Promise<ClaudeGlobalSettings> => ipcRenderer.invoke('claudeSettings:get'),
    update: (patch: ClaudeGlobalSettingsPatch): Promise<ClaudeGlobalSettings> =>
      ipcRenderer.invoke('claudeSettings:update', patch)
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
