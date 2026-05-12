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
  ClaudeGlobalSettingsPatch,
  ClaudeProjectSettings,
  ClaudeProjectSettingsOverrides,
  AppUiState,
  AppUiStatePatch,
  GitStatus,
  ClaudeAuthState,
  ClaudeAuthPatch,
  DiscoveredMcpServer
} from '../shared/types'

type TerminalRect = { x: number; y: number; w: number; h: number }

// Custom APIs for renderer
const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion')
  },
  terminal: {
    mount: (
      workspaceId: string,
      rect: TerminalRect,
      scaleFactor: number,
      cwd?: string
    ): Promise<{ workspaceId: string; created: boolean }> =>
      ipcRenderer.invoke('terminal:mount', { workspaceId, rect, scaleFactor, cwd }),
    hide: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke('terminal:hide', { workspaceId }),
    resize: (workspaceId: string, rect: TerminalRect, scaleFactor: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', { workspaceId, rect, scaleFactor }),
    destroy: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke('terminal:destroy', { workspaceId })
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
      ipcRenderer.invoke('projects:rename', { id, name }),
    setExpandedInSidebar: (id: string, expanded: boolean): Promise<void> =>
      ipcRenderer.invoke('projects:setExpandedInSidebar', { id, expanded })
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
  },
  claudeAuth: {
    get: (): Promise<ClaudeAuthState> => ipcRenderer.invoke('claudeAuth:get'),
    update: (patch: ClaudeAuthPatch): Promise<ClaudeAuthState> =>
      ipcRenderer.invoke('claudeAuth:update', patch)
  },
  claudeProjectSettings: {
    get: (projectId: string): Promise<ClaudeProjectSettings> =>
      ipcRenderer.invoke('claudeProjectSettings:get', { projectId }),
    update: (projectId: string, patch: ClaudeProjectSettingsOverrides): Promise<ClaudeProjectSettings> =>
      ipcRenderer.invoke('claudeProjectSettings:update', { projectId, patch })
  },
  uiState: {
    get: (): Promise<AppUiState> => ipcRenderer.invoke('uiState:get'),
    update: (patch: AppUiStatePatch): Promise<AppUiState> =>
      ipcRenderer.invoke('uiState:update', patch)
  },
  git: {
    status: (cwd: string): Promise<GitStatus | null> =>
      ipcRenderer.invoke('git:status', { cwd })
  },
  mcp: {
    listServers: (): Promise<DiscoveredMcpServer[]> =>
      ipcRenderer.invoke('mcp:listServers')
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
