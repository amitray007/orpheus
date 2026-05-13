import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
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
  ClaudeWorkspaceSettings,
  ClaudeWorkspaceSettingsOverrides,
  AppUiState,
  AppUiStatePatch,
  GitStatus,
  ClaudeAuthState,
  ClaudeAuthPatch,
  ClaudeAuthTestResult,
  DiscoveredMcpServer,
  ClaudeSlashCommand,
  ClaudeSubagent,
  ClaudeHookEntry
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
      ipcRenderer.invoke('projects:setExpandedInSidebar', { id, expanded }),
    reorder: (orderedIds: string[]): Promise<void> =>
      ipcRenderer.invoke('projects:reorder', { orderedIds })
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
      ipcRenderer.invoke('workspaces:rename', { id, name }),
    reorder: (projectId: string, orderedIds: string[]): Promise<void> =>
      ipcRenderer.invoke('workspaces:reorder', { projectId, orderedIds }),
    isDirty: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('workspace:isDirty', { workspaceId: id }),
    onDirtyChanged: (
      cb: (e: { workspaceId: string; dirty: boolean }) => void
    ): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { workspaceId: string; dirty: boolean }): void =>
        cb(e)
      ipcRenderer.on('workspace:dirtyChanged', listener)
      return () => ipcRenderer.removeListener('workspace:dirtyChanged', listener)
    }
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
      ipcRenderer.invoke('claudeAuth:update', patch),
    testConnection: (): Promise<ClaudeAuthTestResult> =>
      ipcRenderer.invoke('claudeAuth:testConnection')
  },
  claudeProjectSettings: {
    get: (projectId: string): Promise<ClaudeProjectSettings> =>
      ipcRenderer.invoke('claudeProjectSettings:get', { projectId }),
    update: (projectId: string, patch: ClaudeProjectSettingsOverrides): Promise<ClaudeProjectSettings> =>
      ipcRenderer.invoke('claudeProjectSettings:update', { projectId, patch })
  },
  claudeWorkspaceSettings: {
    get: (workspaceId: string): Promise<ClaudeWorkspaceSettings> =>
      ipcRenderer.invoke('claudeWorkspaceSettings:get', { workspaceId }),
    update: (workspaceId: string, patch: ClaudeWorkspaceSettingsOverrides): Promise<ClaudeWorkspaceSettings> =>
      ipcRenderer.invoke('claudeWorkspaceSettings:update', { workspaceId, patch })
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
  },
  claudeAgents: {
    listSlashCommands: (): Promise<ClaudeSlashCommand[]> =>
      ipcRenderer.invoke('claudeAgents:listSlashCommands'),
    listSubagents: (): Promise<ClaudeSubagent[]> =>
      ipcRenderer.invoke('claudeAgents:listSubagents')
  },
  claudeHooks: {
    list: (): Promise<ClaudeHookEntry[]> => ipcRenderer.invoke('claudeHooks:list'),
    openFile: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('claudeHooks:openFile', { filePath })
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
