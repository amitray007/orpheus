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
  CreateWorktreeParams,
  TerminalMountResult,
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
  DiagEvent,
  HealthReport,
  KeepAwakeState,
  KeepAwakeBaseMode
} from '../shared/types'

type TerminalRect = { x: number; y: number; w: number; h: number }

declare global {
  interface Window {
    api: {
      app: {
        getVersion: () => Promise<string>
        getPaths: () => Promise<{ userData: string; logs: string }>
        offeredModes: (projectId: string) => Promise<{ local: boolean; worktree: boolean }>
      }
      window: {
        openDevTools: () => Promise<void>
        reload: () => Promise<void>
      }
      debug: {
        onActionTrace: (cb: (e: { tagName: string }) => void) => () => void
      }
      terminal: {
        mount: (
          workspaceId: string,
          rect: TerminalRect,
          scaleFactor: number,
          cwd?: string
        ) => Promise<TerminalMountResult>
        hide: (workspaceId: string) => Promise<void>
        resize: (workspaceId: string, rect: TerminalRect, scaleFactor: number) => Promise<void>
        destroy: (workspaceId: string) => Promise<void>
        sendInput: (workspaceId: string, text: string) => Promise<ActionResult>
        sendKeys: (workspaceId: string, keys: TerminalSendKeyDescriptor[]) => Promise<ActionResult>
        submit: (workspaceId: string) => Promise<ActionResult>
        clearInput: (workspaceId: string) => Promise<ActionResult>
        canInject: (workspaceId: string) => Promise<boolean>
        onCanInjectChanged: (
          cb: (e: { workspaceId: string; canInject: boolean }) => void
        ) => () => void
        focus: (workspaceId: string) => Promise<void>
        getSurfacePhase: (
          workspaceId: string
        ) => Promise<'none' | 'hidden' | 'attached' | 'visible' | 'freeing'>
        onSleepStateChanged: (
          cb: (data: { workspaceId: string; sleeping: boolean }) => void
        ) => () => void
        onLiveness: (
          cb: (data: {
            workspaceId: string
            inputTick: number
            liveTick: number
            occluded: boolean
          }) => void
        ) => () => void
        // Native popover chassis (Phase A)
        showPopover: (
          workspaceId: string,
          kind: string,
          anchorRect: { x: number; y: number; w: number; h: number },
          data: Record<string, unknown>,
          fontDir?: string
        ) => Promise<void>
        updatePopover: (workspaceId: string, data: Record<string, unknown>) => Promise<void>
        hidePopover: (workspaceId: string) => Promise<void>
        onPopoverAction: (cb: (e: { identifier: string }) => void) => () => void
      }
      config: {
        openFolder: () => Promise<string | null>
      }
      doctor: {
        check: () => Promise<DoctorResult>
      }
      projects: {
        list: () => Promise<ProjectRecord[]>
        add: (path: string) => Promise<ProjectRecord>
        pickAndAdd: () => Promise<ProjectRecord | null>
        open: (id: string) => Promise<ProjectRecord>
        remove: (
          id: string,
          opts?: { deleteWorktrees?: boolean; force?: boolean }
        ) => Promise<{ deleted: boolean; dirtyWorktrees: number }>
        worktreeSummary: (projectId: string) => Promise<{ count: number }>
        rename: (id: string, name: string) => Promise<void>
        setExpandedInSidebar: (id: string, expanded: boolean) => Promise<void>
        reorder: (orderedIds: string[]) => Promise<void>
        setPinned: (id: string, pinned: boolean) => Promise<ProjectRecord>
        refreshGithub: (projectId: string) => Promise<void>
        onGithubDataUpdated: (
          cb: (e: {
            projectId: string
            githubOwner: string | null
            githubRepo: string | null
            githubAvatarUrl: string | null
            githubCheckedAt: number
          }) => void
        ) => () => void
      }
      sessions: {
        listForProject: (
          projectId: string,
          options?: { includeArchived?: boolean }
        ) => Promise<SessionRecord[]>
        listAll: (opts?: { status?: SessionStatus }) => Promise<SessionRecord[]>
        setStatus: (id: string, status: SessionStatus) => Promise<void>
        listForProjectPaged: (req: SessionsPagedRequest) => Promise<SessionsPagedResult>
        resumeInNewWorkspace: (sessionId: string, projectId: string) => Promise<WorkspaceRecord>
        resumeInWorktreeWorkspace: (
          sessionId: string,
          projectId: string
        ) => Promise<WorkspaceRecord>
        refreshMetadata: (projectId: string) => Promise<void>
        delete: (id: string) => Promise<void>
        getContextBudget: (
          workspaceId: string
        ) => Promise<{ contextBudget: number; modelId: string }>
      }
      workspaces: {
        listForProject: (
          projectId: string,
          options?: { scope?: 'active' | 'archived' | 'all' }
        ) => Promise<WorkspaceRecord[]>
        create: (args: { projectId: string; name: string; cwd: string }) => Promise<WorkspaceRecord>
        createWorktree: (
          projectId: string,
          params: CreateWorktreeParams
        ) => Promise<WorkspaceRecord>
        open: (id: string) => Promise<WorkspaceRecord>
        setPinned: (id: string, pinned: boolean) => Promise<WorkspaceRecord>
        archive: (
          id: string,
          opts?: { force?: boolean }
        ) => Promise<{ archived: boolean; wasDirty: boolean }>
        rename: (id: string, name: string) => Promise<WorkspaceRecord>
        reorder: (projectId: string, orderedIds: string[]) => Promise<void>
        isDirty: (id: string) => Promise<boolean>
        onDirtyChanged: (cb: (e: { workspaceId: string; dirty: boolean }) => void) => () => void
        getTitle: (id: string) => Promise<string | null>
        onTitleChanged: (
          cb: (e: { workspaceId: string; title: string | null }) => void
        ) => () => void
        onActivityChanged: (
          cb: (e: {
            workspaceId: string
            status: WorkspaceStatus
            detail: WorkspaceActivityDetail
          }) => void
        ) => () => void
        onActivityBatch: (
          cb: (
            updates: Array<{
              workspaceId: string
              status: WorkspaceStatus
              detail: WorkspaceActivityDetail
            }>
          ) => void
        ) => () => void
        setCurrentlyViewed: (workspaceId: string | null) => void
        onNavigateTo: (cb: (workspaceId: string) => void) => () => void
        onCreated: (cb: (workspace: WorkspaceRecord) => void) => () => void
        onArchived: (cb: (e: { workspaceId: string; projectId: string }) => void) => () => void
        close: (
          id: string
        ) => Promise<{ ok: boolean; reason?: string; workspace?: WorkspaceRecord | null }>
        reopen: (id: string) => Promise<{ ok: boolean; workspace?: WorkspaceRecord | null }>
        onChanged: (cb: (e: { workspace: WorkspaceRecord }) => void) => () => void
        onActiveWorkspaceChanged: (cb: (e: { workspaceId: string | null }) => void) => () => void
        convertToLocal: (id: string) => Promise<WorkspaceRecord>
      }
      worktrees: {
        branchExists: (projectId: string, branch: string) => Promise<boolean>
      }
      pins: {
        listAll: () => Promise<PinnedItem[]>
      }
      claudeSettings: {
        get: () => Promise<ClaudeGlobalSettings>
        update: (patch: ClaudeGlobalSettingsPatch) => Promise<ClaudeGlobalSettings>
      }
      ghosttySettings: {
        get: () => Promise<GhosttyUserConfig>
        update: (patch: Partial<GhosttyUserConfig>) => Promise<GhosttyUserConfig>
      }
      claudeAuth: {
        get: () => Promise<ClaudeAuthState>
        update: (patch: ClaudeAuthPatch) => Promise<ClaudeAuthState>
        testConnection: () => Promise<ClaudeAuthTestResult>
      }
      claudeProjectSettings: {
        get: (projectId: string) => Promise<ClaudeProjectSettings>
        update: (
          projectId: string,
          patch: ClaudeProjectSettingsOverrides
        ) => Promise<ClaudeProjectSettings>
      }
      claudeWorkspaceSettings: {
        get: (workspaceId: string) => Promise<ClaudeWorkspaceSettings>
        update: (
          workspaceId: string,
          patch: ClaudeWorkspaceSettingsOverrides
        ) => Promise<ClaudeWorkspaceSettings>
      }
      uiState: {
        get: () => Promise<AppUiState>
        update: (patch: AppUiStatePatch) => Promise<AppUiState>
        onChanged: (cb: (state: AppUiState) => void) => () => void
      }
      git: {
        status: (cwd: string) => Promise<GitStatus | null>
        branches: (cwd: string) => Promise<GitBranchInfo[]>
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
        ) => Promise<GitCommit[]>
        count: (
          cwd: string,
          opts?: { branch?: string; sinceMs?: number; untilMs?: number; grep?: string }
        ) => Promise<number>
        onStatusChanged: (cb: (e: { workspaceId: string; status: GitStatus }) => void) => () => void
      }
      github: {
        prForBranch: (cwd: string, branch: string) => Promise<GhPullRequest | null>
        onPrChanged: (
          cb: (e: { workspaceId: string; pr: GhPullRequest | null }) => void
        ) => () => void
      }
      shell: {
        revealInFinder: (path: string) => Promise<void>
        openInEditor: (path: string) => Promise<void>
        openTerminal: (path: string) => Promise<void>
        copyToClipboard: (text: string) => Promise<void>
        listEditorApps: () => Promise<DetectedApp[]>
        listTerminalApps: () => Promise<DetectedApp[]>
      }
      mcp: {
        listServers: () => Promise<DiscoveredMcpServer[]>
        add: (draft: McpServerDraft) => Promise<void>
        update: (
          filePath: string,
          oldName: string,
          draft: Omit<McpServerDraft, 'source' | 'projectId'>
        ) => Promise<void>
        delete: (filePath: string, name: string) => Promise<void>
      }
      claudeAgents: {
        listSlashCommands: () => Promise<ClaudeSlashCommand[]>
        listSubagents: () => Promise<ClaudeSubagent[]>
        addSlashCommand: (draft: ClaudeSlashCommandDraft) => Promise<void>
        updateSlashCommand: (
          filePath: string,
          draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'>
        ) => Promise<void>
        deleteSlashCommand: (filePath: string) => Promise<void>
        addSubagent: (draft: ClaudeSubagentDraft) => Promise<void>
        updateSubagent: (
          filePath: string,
          draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'>
        ) => Promise<void>
        deleteSubagent: (filePath: string) => Promise<void>
      }
      claudeHooks: {
        list: () => Promise<ClaudeHookEntry[]>
        openFile: (filePath: string) => Promise<void>
        add: (draft: ClaudeHookDraft) => Promise<void>
        update: (
          filePath: string,
          event: string,
          matcherEntryIdx: number,
          hookIdx: number,
          draft: { event: string; matcher: string | null; type: string; command: string }
        ) => Promise<void>
        delete: (
          filePath: string,
          event: string,
          matcherEntryIdx: number,
          hookIdx: number
        ) => Promise<void>
      }
      contextMenu: {
        show: (items: ContextMenuNativeItem[]) => Promise<string | null>
      }
      notifications: {
        test: () => Promise<void>
      }
      updates: {
        check: () => Promise<UpdateCheckResult>
        install: () => Promise<void>
        restart: () => Promise<void>
        getState: () => Promise<UpdateSnapshot>
        onProgress: (cb: (e: UpdateProgress) => void) => () => void
        onDone: (cb: (e: { success: boolean; code: number | null }) => void) => () => void
        onCheckResult: (cb: (result: UpdateCheckResult) => void) => () => void
      }
      status: {
        get: () => Promise<ClaudeStatusSnapshot>
        refresh: () => Promise<ClaudeStatusSnapshot>
        openPage: () => Promise<void>
        onChange: (cb: (snapshot: ClaudeStatusSnapshot) => void) => () => void
      }
      actions: {
        invoke: (
          invocation: { id: string; params: Record<string, unknown>; workspaceId: string },
          consumerHint?: string
        ) => Promise<ActionResult>
        list: () => Promise<Array<{ id: string; kind: ActionKind }>>
        history: (workspaceId: string, limit?: number) => Promise<ActionAuditEntry[]>
        subscribe: (
          actionId: string,
          params: Record<string, unknown>,
          workspaceId: string,
          onUpdate: (value: unknown) => void
        ) => { dispose: () => void }
      }
      footerActions: {
        listMerged: (workspaceId: string) => Promise<FooterActionDescriptor[]>
        listAtScope: (
          scope: FooterActionScope,
          scopeId?: string
        ) => Promise<FooterActionDescriptor[]>
        create: (
          scope: FooterActionScope,
          scopeId: string | null,
          draft: FooterActionDraft
        ) => Promise<FooterActionDescriptor>
        update: (id: string, patch: Partial<FooterActionDraft>) => Promise<FooterActionDescriptor>
        remove: (id: string) => Promise<void>
        reorder: (
          scope: FooterActionScope,
          scopeId: string | null,
          orderedIds: string[]
        ) => Promise<void>
        resetDefaults: () => Promise<void>
      }
      hooks: {
        setEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>
        getStatus: () => Promise<{ enabled: boolean; installed: number }>
      }
      health: {
        get: () => Promise<HealthReport>
      }
      diag: {
        event: (evt: DiagEvent) => void
        openConsole: () => Promise<void>
        onStream: (cb: (batch: unknown[]) => void) => () => void
        export: (opts: { sinceMs: number }) => Promise<{
          ok: boolean
          path?: string
          txtPath?: string
          jsonPath?: string
          error?: string
        }>
      }
      keepAwake: {
        get: () => Promise<KeepAwakeState>
        setMode: (mode: KeepAwakeBaseMode) => Promise<KeepAwakeState>
        setDisplayOn: (on: boolean) => Promise<KeepAwakeState>
        startTimer: (minutes: number) => Promise<KeepAwakeState>
        onState: (cb: (state: KeepAwakeState) => void) => () => void
      }
    }
  }
}
