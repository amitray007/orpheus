import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  DetectedApp,
  DoctorResult,
  ProjectRecord,
  SessionRecord,
  SessionStatus,
  SessionsPagedRequest,
  SessionsPagedResult,
  WorkspaceRecord,
  WorkspaceStatus,
  WorkspaceActivityDetail,
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
  GitBranchInfo,
  GitCommit,
  GhPullRequest,
  ClaudeAuthState,
  ClaudeAuthPatch,
  ClaudeAuthTestResult,
  DiscoveredMcpServer,
  McpServerDraft,
  ClaudeSlashCommand,
  ClaudeSlashCommandDraft,
  ClaudeSubagent,
  ClaudeSubagentDraft,
  ClaudeHookEntry,
  ClaudeHookDraft,
  ContextMenuNativeItem,
  UpdateCheckResult,
  ClaudeStatusSnapshot,
  ActionResult,
  TerminalSendKeyDescriptor
} from '../shared/types'

type TerminalRect = { x: number; y: number; w: number; h: number }

// Custom APIs for renderer
const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion')
  },
  window: {
    openDevTools: (): Promise<void> => ipcRenderer.invoke('window:openDevTools'),
    reload: (): Promise<void> => ipcRenderer.invoke('window:reload')
  },
  debug: {
    onActionTrace: (cb: (e: { tagName: string }) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { tagName: string }): void => cb(e)
      ipcRenderer.on('addon:actionTrace', listener)
      return () => ipcRenderer.removeListener('addon:actionTrace', listener)
    }
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
      ipcRenderer.invoke('terminal:destroy', { workspaceId }),
    setOverlay: (workspaceId: string, on: boolean): Promise<void> =>
      ipcRenderer.invoke('terminal:setOverlay', { workspaceId, on }),
    sendInput: (workspaceId: string, text: string): Promise<ActionResult> =>
      ipcRenderer.invoke('terminal:sendInput', { workspaceId, text }),
    sendKeys: (workspaceId: string, keys: TerminalSendKeyDescriptor[]): Promise<ActionResult> =>
      ipcRenderer.invoke('terminal:sendKeys', { workspaceId, keys }),
    submit: (workspaceId: string): Promise<ActionResult> =>
      ipcRenderer.invoke('terminal:submit', { workspaceId }),
    clearInput: (workspaceId: string): Promise<ActionResult> =>
      ipcRenderer.invoke('terminal:clearInput', { workspaceId }),
    canInject: (workspaceId: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:canInject', { workspaceId })
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
      ipcRenderer.invoke('projects:reorder', { orderedIds }),
    refreshGithub: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('projects:refreshGithub', projectId),
    onGithubDataUpdated: (
      cb: (e: {
        projectId: string
        githubOwner: string | null
        githubRepo: string | null
        githubAvatarUrl: string | null
        githubCheckedAt: number
      }) => void
    ): (() => void) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: {
          projectId: string
          githubOwner: string | null
          githubRepo: string | null
          githubAvatarUrl: string | null
          githubCheckedAt: number
        }
      ): void => cb(payload)
      ipcRenderer.on('projects:githubDataUpdated', listener)
      return () => ipcRenderer.off('projects:githubDataUpdated', listener)
    }
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
      ipcRenderer.invoke('sessions:setStatus', { id, status }),
    listForProjectPaged: (req: SessionsPagedRequest): Promise<SessionsPagedResult> =>
      ipcRenderer.invoke('sessions:listForProjectPaged', req),
    resumeInNewWorkspace: (sessionId: string, projectId: string): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('sessions:resumeInNewWorkspace', { sessionId, projectId }),
    refreshMetadata: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('sessions:refreshMetadata', { projectId }),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', { id })
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
    // "Archive" is a hard delete in v34+. The IPC name + label stay for
    // user-facing continuity even though there's no soft-archive anymore.
    archive: (id: string): Promise<void> => ipcRenderer.invoke('workspaces:archive', { id }),
    rename: (id: string, name: string): Promise<WorkspaceRecord> =>
      ipcRenderer.invoke('workspaces:rename', { id, name }),
    reorder: (projectId: string, orderedIds: string[]): Promise<void> =>
      ipcRenderer.invoke('workspaces:reorder', { projectId, orderedIds }),
    isDirty: (id: string): Promise<boolean> =>
      ipcRenderer.invoke('workspace:isDirty', { workspaceId: id }),
    onDirtyChanged: (cb: (e: { workspaceId: string; dirty: boolean }) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { workspaceId: string; dirty: boolean }): void =>
        cb(e)
      ipcRenderer.on('workspace:dirtyChanged', listener)
      return () => ipcRenderer.removeListener('workspace:dirtyChanged', listener)
    },
    getTitle: (id: string): Promise<string | null> =>
      ipcRenderer.invoke('workspace:getTitle', { workspaceId: id }),
    onTitleChanged: (
      cb: (e: { workspaceId: string; title: string | null }) => void
    ): (() => void) => {
      const listener = (
        _evt: IpcRendererEvent,
        e: { workspaceId: string; title: string | null }
      ): void => cb(e)
      ipcRenderer.on('workspace:titleChanged', listener)
      return () => ipcRenderer.removeListener('workspace:titleChanged', listener)
    },
    onActivityChanged: (
      cb: (e: {
        workspaceId: string
        status: WorkspaceStatus
        detail: WorkspaceActivityDetail
      }) => void
    ): (() => void) => {
      const listener = (
        _evt: IpcRendererEvent,
        e: { workspaceId: string; status: WorkspaceStatus; detail: WorkspaceActivityDetail }
      ): void => cb(e)
      ipcRenderer.on('workspace:activityChanged', listener)
      return () => ipcRenderer.removeListener('workspace:activityChanged', listener)
    },
    setCurrentlyViewed: (workspaceId: string | null): void => {
      ipcRenderer.send('workspace:setCurrentlyViewed', { workspaceId })
    },
    onNavigateTo: (cb: (workspaceId: string) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { workspaceId: string }): void =>
        cb(e.workspaceId)
      ipcRenderer.on('workspace:navigateTo', listener)
      return () => ipcRenderer.removeListener('workspace:navigateTo', listener)
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
    update: (
      projectId: string,
      patch: ClaudeProjectSettingsOverrides
    ): Promise<ClaudeProjectSettings> =>
      ipcRenderer.invoke('claudeProjectSettings:update', { projectId, patch })
  },
  claudeWorkspaceSettings: {
    get: (workspaceId: string): Promise<ClaudeWorkspaceSettings> =>
      ipcRenderer.invoke('claudeWorkspaceSettings:get', { workspaceId }),
    update: (
      workspaceId: string,
      patch: ClaudeWorkspaceSettingsOverrides
    ): Promise<ClaudeWorkspaceSettings> =>
      ipcRenderer.invoke('claudeWorkspaceSettings:update', { workspaceId, patch })
  },
  uiState: {
    get: (): Promise<AppUiState> => ipcRenderer.invoke('uiState:get'),
    update: (patch: AppUiStatePatch): Promise<AppUiState> =>
      ipcRenderer.invoke('uiState:update', patch)
  },
  git: {
    status: (cwd: string): Promise<GitStatus | null> => ipcRenderer.invoke('git:status', { cwd }),
    branches: (cwd: string): Promise<GitBranchInfo[]> =>
      ipcRenderer.invoke('git:branches', { cwd }),
    log: (
      cwd: string,
      opts?: {
        branch?: string
        limit?: number
        offset?: number
        sinceMs?: number
        untilMs?: number
        grep?: string
      }
    ): Promise<GitCommit[]> => ipcRenderer.invoke('git:log', { cwd, ...opts }),
    count: (
      cwd: string,
      opts?: { branch?: string; sinceMs?: number; untilMs?: number; grep?: string }
    ): Promise<number> => ipcRenderer.invoke('git:count', { cwd, ...opts })
  },
  github: {
    prForBranch: (cwd: string, branch: string): Promise<GhPullRequest | null> =>
      ipcRenderer.invoke('github:prForBranch', { cwd, branch })
  },
  shell: {
    revealInFinder: (path: string): Promise<void> =>
      ipcRenderer.invoke('shell:revealInFinder', { path }),
    openInEditor: (path: string): Promise<void> =>
      ipcRenderer.invoke('shell:openInEditor', { path }),
    openTerminal: (path: string): Promise<void> =>
      ipcRenderer.invoke('shell:openTerminal', { path }),
    copyToClipboard: (text: string): Promise<void> =>
      ipcRenderer.invoke('shell:copyToClipboard', { text }),
    listEditorApps: (): Promise<DetectedApp[]> => ipcRenderer.invoke('shell:listEditorApps'),
    listTerminalApps: (): Promise<DetectedApp[]> => ipcRenderer.invoke('shell:listTerminalApps')
  },
  mcp: {
    listServers: (): Promise<DiscoveredMcpServer[]> => ipcRenderer.invoke('mcp:listServers'),
    add: (draft: McpServerDraft): Promise<void> => ipcRenderer.invoke('mcp:add', draft),
    update: (
      filePath: string,
      oldName: string,
      draft: Omit<McpServerDraft, 'source' | 'projectId'>
    ): Promise<void> => ipcRenderer.invoke('mcp:update', { filePath, oldName, draft }),
    delete: (filePath: string, name: string): Promise<void> =>
      ipcRenderer.invoke('mcp:delete', { filePath, name })
  },
  claudeAgents: {
    listSlashCommands: (): Promise<ClaudeSlashCommand[]> =>
      ipcRenderer.invoke('claudeAgents:listSlashCommands'),
    listSubagents: (): Promise<ClaudeSubagent[]> =>
      ipcRenderer.invoke('claudeAgents:listSubagents'),
    addSlashCommand: (draft: ClaudeSlashCommandDraft): Promise<void> =>
      ipcRenderer.invoke('claudeAgents:addSlashCommand', draft),
    updateSlashCommand: (
      filePath: string,
      draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'>
    ): Promise<void> => ipcRenderer.invoke('claudeAgents:updateSlashCommand', { filePath, draft }),
    deleteSlashCommand: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('claudeAgents:deleteSlashCommand', { filePath }),
    addSubagent: (draft: ClaudeSubagentDraft): Promise<void> =>
      ipcRenderer.invoke('claudeAgents:addSubagent', draft),
    updateSubagent: (
      filePath: string,
      draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'>
    ): Promise<void> => ipcRenderer.invoke('claudeAgents:updateSubagent', { filePath, draft }),
    deleteSubagent: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('claudeAgents:deleteSubagent', { filePath })
  },
  claudeHooks: {
    list: (): Promise<ClaudeHookEntry[]> => ipcRenderer.invoke('claudeHooks:list'),
    openFile: (filePath: string): Promise<void> =>
      ipcRenderer.invoke('claudeHooks:openFile', { filePath }),
    add: (draft: ClaudeHookDraft): Promise<void> => ipcRenderer.invoke('claudeHooks:add', draft),
    update: (
      filePath: string,
      event: string,
      matcherEntryIdx: number,
      hookIdx: number,
      draft: { event: string; matcher: string | null; type: string; command: string }
    ): Promise<void> =>
      ipcRenderer.invoke('claudeHooks:update', {
        filePath,
        event,
        matcherEntryIdx,
        hookIdx,
        draft
      }),
    delete: (
      filePath: string,
      event: string,
      matcherEntryIdx: number,
      hookIdx: number
    ): Promise<void> =>
      ipcRenderer.invoke('claudeHooks:delete', { filePath, event, matcherEntryIdx, hookIdx })
  },
  contextMenu: {
    show: (items: ContextMenuNativeItem[]): Promise<string | null> =>
      ipcRenderer.invoke('contextMenu:show', items)
  },
  notifications: {
    test: (): Promise<void> => ipcRenderer.invoke('notifications:test')
  },
  updates: {
    check: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
    install: (): Promise<void> => ipcRenderer.invoke('updates:install'),
    restart: (): Promise<void> => ipcRenderer.invoke('updates:restart'),
    onProgress: (cb: (e: { line: string }) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { line: string }): void => cb(e)
      ipcRenderer.on('updates:progress', listener)
      return () => ipcRenderer.removeListener('updates:progress', listener)
    },
    onDone: (cb: (e: { success: boolean; code: number | null }) => void): (() => void) => {
      const listener = (
        _evt: IpcRendererEvent,
        e: { success: boolean; code: number | null }
      ): void => cb(e)
      ipcRenderer.on('updates:done', listener)
      return () => ipcRenderer.removeListener('updates:done', listener)
    },
    onCheckResult: (cb: (result: UpdateCheckResult) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, result: UpdateCheckResult): void => cb(result)
      ipcRenderer.on('updates:checkResult', listener)
      return () => ipcRenderer.removeListener('updates:checkResult', listener)
    }
  },
  status: {
    get: (): Promise<ClaudeStatusSnapshot> => ipcRenderer.invoke('status:get'),
    refresh: (): Promise<ClaudeStatusSnapshot> => ipcRenderer.invoke('status:refresh'),
    openPage: (): Promise<void> => ipcRenderer.invoke('status:openPage'),
    onChange: (cb: (snapshot: ClaudeStatusSnapshot) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, snapshot: ClaudeStatusSnapshot): void =>
        cb(snapshot)
      ipcRenderer.on('status:change', listener)
      return () => ipcRenderer.removeListener('status:change', listener)
    }
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
