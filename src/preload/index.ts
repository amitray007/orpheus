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
  UpdateProgress,
  UpdateSnapshot,
  ClaudeStatusSnapshot,
  ActionResult,
  ActionAuditEntry,
  ActionKind,
  TerminalSendKeyDescriptor,
  FooterActionDescriptor,
  FooterActionDraft,
  FooterActionScope,
  GhosttyUserConfig,
  DiagEvent
} from '../shared/types'

type TerminalRect = { x: number; y: number; w: number; h: number }

// Custom APIs for renderer
const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
    getPaths: (): Promise<{ userData: string; logs: string }> => ipcRenderer.invoke('app:getPaths')
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
    sendInput: (workspaceId: string, text: string): Promise<ActionResult> =>
      ipcRenderer.invoke('terminal:sendInput', { workspaceId, text }),
    sendKeys: (workspaceId: string, keys: TerminalSendKeyDescriptor[]): Promise<ActionResult> =>
      ipcRenderer.invoke('terminal:sendKeys', { workspaceId, keys }),
    submit: (workspaceId: string): Promise<ActionResult> =>
      ipcRenderer.invoke('terminal:submit', { workspaceId }),
    clearInput: (workspaceId: string): Promise<ActionResult> =>
      ipcRenderer.invoke('terminal:clearInput', { workspaceId }),
    canInject: (workspaceId: string): Promise<boolean> =>
      ipcRenderer.invoke('terminal:canInject', { workspaceId }),
    onCanInjectChanged: (
      cb: (e: { workspaceId: string; canInject: boolean }) => void
    ): (() => void) => {
      const listener = (
        _evt: IpcRendererEvent,
        e: { workspaceId: string; canInject: boolean }
      ): void => cb(e)
      ipcRenderer.on('terminal:canInjectChanged', listener)
      return () => ipcRenderer.removeListener('terminal:canInjectChanged', listener)
    },
    focus: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke('terminal:focus', { workspaceId }),
    getSurfacePhase: (workspaceId: string): Promise<string> =>
      ipcRenderer.invoke('terminal:getSurfacePhase', { workspaceId }),
    onSleepStateChanged: (
      cb: (data: { workspaceId: string; sleeping: boolean }) => void
    ): (() => void) => {
      const listener = (_e: unknown, data: { workspaceId: string; sleeping: boolean }): void =>
        cb(data)
      ipcRenderer.on('terminal:sleepStateChanged', listener)
      return () => ipcRenderer.removeListener('terminal:sleepStateChanged', listener)
    },
    onLiveness: (
      cb: (data: {
        workspaceId: string
        inputTick: number
        liveTick: number
        occluded: boolean
      }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        data: { workspaceId: string; inputTick: number; liveTick: number; occluded: boolean }
      ): void => cb(data)
      ipcRenderer.on('terminal:liveness', listener)
      return () => ipcRenderer.removeListener('terminal:liveness', listener)
    },
    // Native popover chassis (Phase A)
    showPopover: (
      workspaceId: string,
      kind: string,
      anchorRect: { x: number; y: number; w: number; h: number },
      data: Record<string, unknown>,
      fontDir?: string
    ): Promise<void> =>
      ipcRenderer.invoke('terminal:showPopover', { workspaceId, kind, anchorRect, data, fontDir }),
    updatePopover: (workspaceId: string, data: Record<string, unknown>): Promise<void> =>
      ipcRenderer.invoke('terminal:updatePopover', { workspaceId, data }),
    hidePopover: (workspaceId: string): Promise<void> =>
      ipcRenderer.invoke('terminal:hidePopover', { workspaceId }),
    onPopoverAction: (cb: (e: { identifier: string }) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { identifier: string }): void => cb(e)
      ipcRenderer.on('popover:actionClicked', listener)
      return () => ipcRenderer.removeListener('popover:actionClicked', listener)
    }
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
    delete: (id: string): Promise<void> => ipcRenderer.invoke('sessions:delete', { id }),
    getContextBudget: (workspaceId: string): Promise<{ contextBudget: number; modelId: string }> =>
      ipcRenderer.invoke('sessions:getContextBudget', { workspaceId })
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
    onActivityBatch: (
      cb: (
        updates: Array<{
          workspaceId: string
          status: WorkspaceStatus
          detail: WorkspaceActivityDetail
        }>
      ) => void
    ): (() => void) => {
      const listener = (
        _evt: IpcRendererEvent,
        updates: Array<{
          workspaceId: string
          status: WorkspaceStatus
          detail: WorkspaceActivityDetail
        }>
      ): void => cb(updates)
      ipcRenderer.on('workspace:activityBatch', listener)
      return () => ipcRenderer.removeListener('workspace:activityBatch', listener)
    },
    setCurrentlyViewed: (workspaceId: string | null): void => {
      ipcRenderer.send('workspace:setCurrentlyViewed', { workspaceId })
    },
    onNavigateTo: (cb: (workspaceId: string) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { workspaceId: string }): void =>
        cb(e.workspaceId)
      ipcRenderer.on('workspace:navigateTo', listener)
      return () => ipcRenderer.removeListener('workspace:navigateTo', listener)
    },
    onCreated: (cb: (workspace: WorkspaceRecord) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { workspace: WorkspaceRecord }): void =>
        cb(e.workspace)
      ipcRenderer.on('workspaces:created', listener)
      return () => ipcRenderer.removeListener('workspaces:created', listener)
    },
    onArchived: (cb: (e: { workspaceId: string; projectId: string }) => void): (() => void) => {
      const listener = (
        _evt: IpcRendererEvent,
        e: { workspaceId: string; projectId: string }
      ): void => cb(e)
      ipcRenderer.on('workspaces:archived', listener)
      return () => ipcRenderer.removeListener('workspaces:archived', listener)
    },
    close: (
      id: string
    ): Promise<{ ok: boolean; reason?: string; workspace?: WorkspaceRecord | null }> =>
      ipcRenderer.invoke('workspace:close', { id }),
    reopen: (id: string): Promise<{ ok: boolean; workspace?: WorkspaceRecord | null }> =>
      ipcRenderer.invoke('workspace:reopen', { id }),
    onChanged: (cb: (e: { workspace: WorkspaceRecord }) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: { workspace: WorkspaceRecord }): void => cb(e)
      ipcRenderer.on('workspaces:changed', listener)
      return () => ipcRenderer.removeListener('workspaces:changed', listener)
    },
    onActiveWorkspaceChanged: (cb: (e: { workspaceId: string | null }) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, payload: { workspaceId: string | null }): void =>
        cb(payload)
      ipcRenderer.on('terminal:activeWorkspaceChanged', listener)
      return () => ipcRenderer.removeListener('terminal:activeWorkspaceChanged', listener)
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
  ghosttySettings: {
    get: (): Promise<GhosttyUserConfig> => ipcRenderer.invoke('ghosttySettings:get'),
    update: (patch: Partial<GhosttyUserConfig>): Promise<GhosttyUserConfig> =>
      ipcRenderer.invoke('ghosttySettings:update', patch)
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
      ipcRenderer.invoke('uiState:update', patch),
    onChanged: (cb: (state: AppUiState) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, state: AppUiState): void => cb(state)
      ipcRenderer.on('uiState:changed', handler)
      return () => ipcRenderer.removeListener('uiState:changed', handler)
    }
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
    ): Promise<number> => ipcRenderer.invoke('git:count', { cwd, ...opts }),
    onStatusChanged: (
      cb: (e: { workspaceId: string; status: GitStatus }) => void
    ): (() => void) => {
      const listener = (
        _evt: IpcRendererEvent,
        e: { workspaceId: string; status: GitStatus }
      ): void => cb(e)
      ipcRenderer.on('git:statusChanged', listener)
      return () => ipcRenderer.removeListener('git:statusChanged', listener)
    }
  },
  github: {
    prForBranch: (cwd: string, branch: string): Promise<GhPullRequest | null> =>
      ipcRenderer.invoke('github:prForBranch', { cwd, branch }),
    onPrChanged: (
      cb: (e: { workspaceId: string; pr: GhPullRequest | null }) => void
    ): (() => void) => {
      const listener = (
        _evt: IpcRendererEvent,
        e: { workspaceId: string; pr: GhPullRequest | null }
      ): void => cb(e)
      ipcRenderer.on('github:prChanged', listener)
      return () => ipcRenderer.removeListener('github:prChanged', listener)
    }
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
    getState: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('updates:getState'),
    onProgress: (cb: (e: UpdateProgress) => void): (() => void) => {
      const listener = (_evt: IpcRendererEvent, e: UpdateProgress): void => cb(e)
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
  },
  actions: {
    invoke: (
      invocation: { id: string; params: Record<string, unknown>; workspaceId: string },
      consumerHint?: string
    ): Promise<ActionResult> =>
      ipcRenderer.invoke('actions:invoke', {
        actionId: invocation.id,
        params: invocation.params,
        workspaceId: invocation.workspaceId,
        consumerHint: consumerHint ?? 'renderer'
      }),

    list: (): Promise<Array<{ id: string; kind: ActionKind }>> =>
      ipcRenderer.invoke('actions:list'),

    history: (workspaceId: string, limit?: number): Promise<ActionAuditEntry[]> =>
      ipcRenderer.invoke('actions:history', { workspaceId, limit }),

    subscribe: (
      actionId: string,
      params: Record<string, unknown>,
      workspaceId: string,
      onUpdate: (value: unknown) => void
    ): { dispose: () => void } => {
      const subscriptionId = crypto.randomUUID()

      const listener = (
        _evt: IpcRendererEvent,
        payload: { subscriptionId: string; value: unknown }
      ): void => {
        if (payload.subscriptionId === subscriptionId) {
          onUpdate(payload.value)
        }
      }

      ipcRenderer.on('actions:subscription-update', listener)
      ipcRenderer.invoke('actions:subscribe', { subscriptionId, actionId, params, workspaceId })

      return {
        dispose: () => {
          ipcRenderer.removeListener('actions:subscription-update', listener)
          ipcRenderer.invoke('actions:unsubscribe', { subscriptionId }).catch(() => {
            /* ignore cleanup errors */
          })
        }
      }
    }
  },
  footerActions: {
    listMerged: (workspaceId: string): Promise<FooterActionDescriptor[]> =>
      ipcRenderer.invoke('footerActions:listMerged', { workspaceId }),

    listAtScope: (scope: FooterActionScope, scopeId?: string): Promise<FooterActionDescriptor[]> =>
      ipcRenderer.invoke('footerActions:listAtScope', { scope, scopeId }),

    create: (
      scope: FooterActionScope,
      scopeId: string | null,
      draft: FooterActionDraft
    ): Promise<FooterActionDescriptor> =>
      ipcRenderer.invoke('footerActions:create', { scope, scopeId, draft }),

    update: (id: string, patch: Partial<FooterActionDraft>): Promise<FooterActionDescriptor> =>
      ipcRenderer.invoke('footerActions:update', { id, patch }),

    remove: (id: string): Promise<void> => ipcRenderer.invoke('footerActions:remove', { id }),

    reorder: (
      scope: FooterActionScope,
      scopeId: string | null,
      orderedIds: string[]
    ): Promise<void> => ipcRenderer.invoke('footerActions:reorder', { scope, scopeId, orderedIds }),

    resetDefaults: (): Promise<void> => ipcRenderer.invoke('footerActions:resetDefaults')
  },
  hooks: {
    setEnabled: (enabled: boolean): Promise<{ enabled: boolean }> =>
      ipcRenderer.invoke('hooks:setEnabled', enabled),
    getStatus: (): Promise<{ enabled: boolean; installed: number }> =>
      ipcRenderer.invoke('hooks:getStatus')
  },
  diag: {
    event: (evt: DiagEvent): void => {
      try {
        ipcRenderer.send('diag:event', evt)
      } catch {
        /* never throw */
      }
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
