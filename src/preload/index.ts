import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { PUSH_CHANNELS } from '../shared/ipc'
import type { InvokeChannel, Req, Res, PushChannel, PushPayload } from '../shared/ipc'
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
  PinnedItem,
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsPatch,
  ClaudeProjectSettings,
  ClaudeProjectSettingsOverrides,
  ClaudeWorkspaceSettings,
  ClaudeWorkspaceSettingsOverrides,
  ClaudeEffort,
  AppUiState,
  AppUiStatePatch,
  GitStatus,
  GitBranchInfo,
  GitCommit,
  FilesListing,
  GitStatusEntry,
  FileContents,
  WriteFileResult,
  FilesMutationResult,
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
  KeepAwakeBaseMode,
  OverlayDescriptor,
  OverlayShowResult,
  OverlayEvent,
  TerminalMountResult,
  TerminalRect
} from '../shared/types'

// ---------------------------------------------------------------------------
// Generic typed IPC helpers. `invoke` and `subscribe` are typed against the
// shared ChannelMap (src/shared/ipc.ts) — there is no permissive `string`
// fallback, so an unmapped channel is a compile error (DUP-3 finalize,
// commit 3/3).
// ---------------------------------------------------------------------------

function invoke<C extends InvokeChannel>(channel: C, ...args: Req<C>): Promise<Res<C>> {
  return ipcRenderer.invoke(channel, ...args)
}

function subscribe<C extends PushChannel>(
  channel: C,
  cb: (payload: PushPayload<C>) => void
): () => void {
  const listener = (_evt: IpcRendererEvent, payload: PushPayload<C>): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Custom APIs for renderer
const api = {
  app: {
    getVersion: (): Promise<string> => invoke('app:getVersion'),
    getPaths: (): Promise<{ userData: string; logs: string }> => invoke('app:getPaths'),
    offeredModes: (projectId: string): Promise<{ local: boolean; worktree: boolean }> =>
      invoke('app:offeredModes', { projectId })
  },
  window: {
    openDevTools: (): Promise<void> => invoke('window:openDevTools'),
    reload: (): Promise<void> => invoke('window:reload')
  },
  debug: {
    onActionTrace: (cb: (e: { tagName: string }) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.addonActionTrace, cb)
  },
  terminal: {
    // NOTE: this previously declared its resolved value as
    // `{ workspaceId: string; created: boolean }`, which was already stale —
    // the real terminal:mount handler has returned the 3-variant
    // TerminalMountResult union (success / aborted / worktreeError) since the
    // Phase-4 worktree-reconcile work. src/preload/index.d.ts had the correct
    // union; this runtime wrapper's declared type had drifted from it. The
    // only two call sites (WorkspaceView.tsx, Dashboard.tsx) already narrow
    // via `'aborted' in result` / `'worktreeError' in result`, so they were
    // relying on index.d.ts's (correct) ambient type, not this file's stale
    // one — retyping here just makes the two agree.
    mount: (
      workspaceId: string,
      rect: TerminalRect,
      scaleFactor: number,
      cwd?: string
    ): Promise<TerminalMountResult> =>
      invoke('terminal:mount', { workspaceId, rect, scaleFactor, cwd }),
    hide: (workspaceId: string): Promise<void> => invoke('terminal:hide', { workspaceId }),
    resize: (workspaceId: string, rect: TerminalRect, scaleFactor: number): Promise<void> =>
      invoke('terminal:resize', { workspaceId, rect, scaleFactor }),
    destroy: (workspaceId: string): Promise<void> => invoke('terminal:destroy', { workspaceId }),
    sendInput: (workspaceId: string, text: string): Promise<ActionResult> =>
      invoke('terminal:sendInput', { workspaceId, text }),
    sendKeys: (workspaceId: string, keys: TerminalSendKeyDescriptor[]): Promise<ActionResult> =>
      invoke('terminal:sendKeys', { workspaceId, keys }),
    submit: (workspaceId: string): Promise<ActionResult> =>
      invoke('terminal:submit', { workspaceId }),
    clearInput: (workspaceId: string): Promise<ActionResult> =>
      invoke('terminal:clearInput', { workspaceId }),
    canInject: (workspaceId: string): Promise<boolean> =>
      invoke('terminal:canInject', { workspaceId }),
    onCanInjectChanged: (
      cb: (e: { workspaceId: string; canInject: boolean }) => void
    ): (() => void) => subscribe(PUSH_CHANNELS.terminalCanInjectChanged, cb),
    focus: (workspaceId: string): Promise<void> => invoke('terminal:focus', { workspaceId }),
    getSurfacePhase: (
      workspaceId: string
    ): Promise<'none' | 'hidden' | 'attached' | 'visible' | 'freeing'> =>
      invoke('terminal:getSurfacePhase', { workspaceId }),
    onSleepStateChanged: (
      cb: (data: { workspaceId: string; sleeping: boolean }) => void
    ): (() => void) => subscribe(PUSH_CHANNELS.terminalSleepStateChanged, cb),
    onLiveness: (
      cb: (data: {
        workspaceId: string
        inputTick: number
        liveTick: number
        occluded: boolean
      }) => void
    ): (() => void) => subscribe(PUSH_CHANNELS.terminalLiveness, cb)
  },
  // Workbench Terminal-tab surface(s) — plain-$SHELL libghostty surfaces
  // scoped to a claude workspace, keyed `workbench:<workspaceId>` (single
  // shell, U6b) or `workbench:<workspaceId>:<terminalId>` (a strip of ad-hoc
  // terminals, U8) in the native addon. `workspaceId` here is always the
  // owning claude workspace's id (the main process derives the slot key
  // internally); `terminalId` is the renderer's monotonic per-terminal id,
  // omitted for a single-shell caller.
  workbench: {
    mount: (
      workspaceId: string,
      rect: TerminalRect,
      scaleFactor: number,
      terminalId?: number
    ): Promise<{ workspaceId: string; created: boolean }> =>
      invoke('workbench:mount', { workspaceId, rect, scaleFactor, terminalId }),
    resize: (
      workspaceId: string,
      rect: TerminalRect,
      scaleFactor: number,
      terminalId?: number
    ): Promise<void> => invoke('workbench:resize', { workspaceId, rect, scaleFactor, terminalId }),
    hide: (workspaceId: string, terminalId?: number): Promise<void> =>
      invoke('workbench:hide', { workspaceId, terminalId }),
    destroy: (workspaceId: string, terminalId?: number): Promise<void> =>
      invoke('workbench:destroy', { workspaceId, terminalId }),
    // Fires whenever a program running inside a Workbench ad-hoc terminal
    // sets its OSC title (e.g. running `claude` inside one) — mirrors
    // workspaces.onTitleChanged but scoped per-terminal via {workspaceId,
    // terminalId} instead of just the claude workspace id, since a single
    // claude workspace can own many ad-hoc terminals at once.
    onTerminalTitleChanged: (
      cb: (e: { workspaceId: string; terminalId: number; title: string | null }) => void
    ): (() => void) => subscribe(PUSH_CHANNELS.workbenchTerminalTitleChanged, cb)
  },
  config: {
    openFolder: (): Promise<string | null> => invoke('config:openFolder')
  },
  doctor: {
    check: (): Promise<DoctorResult> => invoke('doctor:check')
  },
  projects: {
    list: (): Promise<ProjectRecord[]> => invoke('projects:list'),
    add: (path: string): Promise<ProjectRecord> => invoke('projects:add', { path }),
    pickAndAdd: (): Promise<ProjectRecord | null> => invoke('projects:pickAndAdd'),
    open: (id: string): Promise<ProjectRecord> => invoke('projects:open', { id }),
    remove: (
      id: string,
      opts: { deleteWorktrees?: boolean; force?: boolean } = {}
    ): Promise<{ deleted: boolean; dirtyWorktrees: number }> =>
      invoke('projects:remove', {
        id,
        deleteWorktrees: opts.deleteWorktrees ?? false,
        force: opts.force ?? false
      }),
    worktreeSummary: (projectId: string): Promise<{ count: number }> =>
      invoke('projects:worktreeSummary', { projectId }),
    rename: (id: string, name: string): Promise<void> => invoke('projects:rename', { id, name }),
    setExpandedInSidebar: (id: string, expanded: boolean): Promise<void> =>
      invoke('projects:setExpandedInSidebar', { id, expanded }),
    reorder: (orderedIds: string[]): Promise<void> => invoke('projects:reorder', { orderedIds }),
    setPinned: (id: string, pinned: boolean): Promise<ProjectRecord> =>
      invoke('projects:setPinned', { id, pinned }),
    refreshGithub: (projectId: string): Promise<void> =>
      invoke('projects:refreshGithub', projectId),
    onGithubDataUpdated: (
      cb: (e: {
        projectId: string
        githubOwner: string | null
        githubRepo: string | null
        githubAvatarUrl: string | null
        githubCheckedAt: number
      }) => void
    ): (() => void) => subscribe(PUSH_CHANNELS.projectsGithubDataUpdated, cb)
  },
  sessions: {
    listForProject: (
      projectId: string,
      options?: { includeArchived?: boolean }
    ): Promise<SessionRecord[]> => invoke('sessions:listForProject', { projectId, ...options }),
    listAll: (opts?: { status?: SessionStatus }): Promise<SessionRecord[]> =>
      invoke('sessions:listAll', opts),
    setStatus: (id: string, status: SessionStatus): Promise<void> =>
      invoke('sessions:setStatus', { id, status }),
    listForProjectPaged: (req: SessionsPagedRequest): Promise<SessionsPagedResult> =>
      invoke('sessions:listForProjectPaged', req),
    resumeInNewWorkspace: (sessionId: string, projectId: string): Promise<WorkspaceRecord> =>
      invoke('sessions:resumeInNewWorkspace', { sessionId, projectId }),
    resumeInWorktreeWorkspace: (sessionId: string, projectId: string): Promise<WorkspaceRecord> =>
      invoke('sessions:resumeInWorktreeWorkspace', { sessionId, projectId }),
    refreshMetadata: (projectId: string): Promise<void> =>
      invoke('sessions:refreshMetadata', { projectId }),
    delete: (id: string): Promise<void> => invoke('sessions:delete', { id }),
    getContextBudget: (workspaceId: string): Promise<{ contextBudget: number; modelId: string }> =>
      invoke('sessions:getContextBudget', { workspaceId })
  },
  workspaces: {
    listForProject: (
      projectId: string,
      options?: { scope?: 'active' | 'archived' | 'all' }
    ): Promise<WorkspaceRecord[]> => invoke('workspaces:listForProject', { projectId, ...options }),
    create: (args: { projectId: string; name: string; cwd: string }): Promise<WorkspaceRecord> =>
      invoke('workspaces:create', args),
    createWorktree: (projectId: string, params: CreateWorktreeParams): Promise<WorkspaceRecord> =>
      invoke('workspaces:createWorktree', { projectId, params }),
    open: (id: string): Promise<WorkspaceRecord> => invoke('workspaces:open', { id }),
    setPinned: (id: string, pinned: boolean): Promise<WorkspaceRecord> =>
      invoke('workspaces:setPinned', { id, pinned }),
    // "Archive" is a hard delete in v34+. The IPC name + label stay for
    // user-facing continuity even though there's no soft-archive anymore.
    // For worktree-backed workspaces, pass force:true to override a dirty check.
    // Returns { archived, wasDirty } — if wasDirty:true and archived:false,
    // the caller should confirm and re-invoke with force:true.
    archive: (
      id: string,
      opts: { force?: boolean } = {}
    ): Promise<{ archived: boolean; wasDirty: boolean }> =>
      invoke('workspaces:archive', { id, force: opts.force ?? false }),
    rename: (id: string, name: string): Promise<WorkspaceRecord> =>
      invoke('workspaces:rename', { id, name }),
    reorder: (projectId: string, orderedIds: string[]): Promise<void> =>
      invoke('workspaces:reorder', { projectId, orderedIds }),
    isDirty: (id: string): Promise<boolean> => invoke('workspace:isDirty', { workspaceId: id }),
    onDirtyChanged: (cb: (e: { workspaceId: string; dirty: boolean }) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.workspaceDirtyChanged, cb),
    getTitle: (id: string): Promise<string | null> =>
      invoke('workspace:getTitle', { workspaceId: id }),
    onTitleChanged: (
      cb: (e: { workspaceId: string; title: string | null }) => void
    ): (() => void) => subscribe(PUSH_CHANNELS.workspaceTitleChanged, cb),
    onActivityBatch: (
      cb: (
        updates: Array<{
          workspaceId: string
          status: WorkspaceStatus
          detail: WorkspaceActivityDetail
        }>
      ) => void
    ): (() => void) => subscribe(PUSH_CHANNELS.workspaceActivityBatch, cb),
    setCurrentlyViewed: (workspaceId: string | null): void => {
      ipcRenderer.send('workspace:setCurrentlyViewed', { workspaceId })
    },
    onNavigateTo: (cb: (workspaceId: string, projectId?: string) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.workspaceNavigateTo, (e) => cb(e.workspaceId, e.projectId)),
    onCreated: (cb: (workspace: WorkspaceRecord) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.workspacesCreated, (e) => cb(e.workspace)),
    onArchived: (cb: (e: { workspaceId: string; projectId: string }) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.workspacesArchived, cb),
    // NOTE (MDB-9): the busy-reject leg was `{ ok: false, reason: 'busy' }`
    // pre-migration -- renamed to `error` here to match the ActionResult
    // convention (`ok` + `error`). The only renderer call site
    // (Dashboard.tsx `workspaces.close(...).catch(...)`) discards the
    // resolved value entirely, so this is a safe rename with no follow-up
    // renderer changes required.
    close: (
      id: string
    ): Promise<{ ok: true; workspace: WorkspaceRecord | null } | { ok: false; error: 'busy' }> =>
      invoke('workspace:close', { id }),
    reopen: (id: string): Promise<{ ok: true; workspace: WorkspaceRecord | null }> =>
      invoke('workspace:reopen', { id }),
    onChanged: (cb: (e: { workspace: WorkspaceRecord }) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.workspacesChanged, cb),
    onActiveWorkspaceChanged: (cb: (e: { workspaceId: string | null }) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.terminalActiveWorkspaceChanged, cb),
    onWorkspaceRequestOpen: (
      cb: (e: { workspaceId: string; focus: boolean }) => void
    ): (() => void) =>
      subscribe(PUSH_CHANNELS.workspaceRequestOpen, (e) =>
        cb({ workspaceId: e.workspaceId, focus: e.focus !== false })
      ),
    convertToLocal: (id: string): Promise<WorkspaceRecord> =>
      invoke('workspaces:convertToLocal', { id }),
    // Footer Model chip: persists a model override and suppresses the
    // resulting dirty delta (see setWorkspaceModelAndSuppressDirty in
    // src/main/index.ts) since the caller injects `/model <value>` into the
    // terminal live right after this resolves.
    setModel: (workspaceId: string, model: string): Promise<ClaudeWorkspaceSettings> =>
      invoke('workspace:setModel', { workspaceId, model }),
    // Footer Model chip: reads the effective model a workspace would launch
    // with right now (workspace override → project override → global
    // setting), via composeClaudeLaunch — the single source of truth.
    getEffectiveModel: (workspaceId: string): Promise<{ model: string }> =>
      invoke('workspace:getEffectiveModel', { workspaceId }),
    // Footer Effort chip: persists an effort override and suppresses the
    // resulting dirty delta (see setWorkspaceSettingAndSuppressDirty in
    // src/main/index.ts) since the caller injects `/effort <value>` into the
    // terminal live right after this resolves.
    setEffort: (workspaceId: string, effort: ClaudeEffort): Promise<ClaudeWorkspaceSettings> =>
      invoke('workspace:setEffort', { workspaceId, effort }),
    // Footer Effort chip: reads the effective effort a workspace would launch
    // with right now, via composeClaudeLaunch — the single source of truth.
    getEffectiveEffort: (workspaceId: string): Promise<{ effort: string }> =>
      invoke('workspace:getEffectiveEffort', { workspaceId })
  },
  worktrees: {
    branchExists: (projectId: string, branch: string): Promise<boolean> =>
      invoke('worktrees:branchExists', { projectId, branch })
  },
  pins: {
    listAll: (): Promise<PinnedItem[]> => invoke('pins:listAll')
  },
  claudeSettings: {
    get: (): Promise<ClaudeGlobalSettings> => invoke('claudeSettings:get'),
    update: (patch: ClaudeGlobalSettingsPatch): Promise<ClaudeGlobalSettings> =>
      invoke('claudeSettings:update', patch)
  },
  ghosttySettings: {
    get: (): Promise<GhosttyUserConfig> => invoke('ghosttySettings:get'),
    update: (patch: Partial<GhosttyUserConfig>): Promise<GhosttyUserConfig> =>
      invoke('ghosttySettings:update', patch)
  },
  claudeAuth: {
    get: (): Promise<ClaudeAuthState> => invoke('claudeAuth:get'),
    update: (patch: ClaudeAuthPatch): Promise<ClaudeAuthState> =>
      invoke('claudeAuth:update', patch),
    testConnection: (): Promise<ClaudeAuthTestResult> => invoke('claudeAuth:testConnection')
  },
  claudeProjectSettings: {
    get: (projectId: string): Promise<ClaudeProjectSettings> =>
      invoke('claudeProjectSettings:get', { projectId }),
    update: (
      projectId: string,
      patch: ClaudeProjectSettingsOverrides
    ): Promise<ClaudeProjectSettings> =>
      invoke('claudeProjectSettings:update', { projectId, patch })
  },
  claudeWorkspaceSettings: {
    get: (workspaceId: string): Promise<ClaudeWorkspaceSettings> =>
      invoke('claudeWorkspaceSettings:get', { workspaceId }),
    update: (
      workspaceId: string,
      patch: ClaudeWorkspaceSettingsOverrides
    ): Promise<ClaudeWorkspaceSettings> =>
      invoke('claudeWorkspaceSettings:update', { workspaceId, patch })
  },
  orpheusConfig: {
    get: (projectId: string): Promise<{ allowLocal: boolean; allowWorktree: boolean }> =>
      invoke('orpheusConfig:get', { projectId }),
    setOverride: (
      projectId: string,
      patch: Partial<{ allowLocal: boolean; allowWorktree: boolean }>
    ): Promise<{ allowLocal: boolean; allowWorktree: boolean }> =>
      invoke('orpheusConfig:setOverride', { projectId, patch })
  },
  uiState: {
    get: (): Promise<AppUiState> => invoke('uiState:get'),
    update: (patch: AppUiStatePatch): Promise<AppUiState> => invoke('uiState:update', patch),
    onChanged: (cb: (state: AppUiState) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.uiStateChanged, cb)
  },
  git: {
    status: (cwd: string): Promise<GitStatus | null> => invoke('git:status', { cwd }),
    branches: (cwd: string): Promise<GitBranchInfo[]> => invoke('git:branches', { cwd }),
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
    ): Promise<GitCommit[]> => invoke('git:log', { cwd, ...opts }),
    count: (
      cwd: string,
      opts?: { branch?: string; sinceMs?: number; untilMs?: number; grep?: string }
    ): Promise<number> => invoke('git:count', { cwd, ...opts }),
    onStatusChanged: (cb: (e: { workspaceId: string; status: GitStatus }) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.gitStatusChanged, cb)
  },
  // Workbench Files tab data sources (Stage A). All resolve the workspace's cwd
  // from `workspaceId` in the main process; see src/main/ipc/files.ts.
  files: {
    listDir: (workspaceId: string): Promise<FilesListing> =>
      invoke('files:listDir', { workspaceId }),
    gitStatus: (workspaceId: string): Promise<GitStatusEntry[]> =>
      invoke('files:gitStatus', { workspaceId }),
    readFile: (workspaceId: string, path: string): Promise<FileContents> =>
      invoke('files:readFile', { workspaceId, path }),
    writeFile: (workspaceId: string, path: string, contents: string): Promise<WriteFileResult> =>
      invoke('files:writeFile', { workspaceId, path, contents }),
    // Tree mutations (Phase 4). Each returns a typed FilesMutationResult.
    createFile: (workspaceId: string, path: string): Promise<FilesMutationResult> =>
      invoke('files:createFile', { workspaceId, path }),
    createDir: (workspaceId: string, path: string): Promise<FilesMutationResult> =>
      invoke('files:createDir', { workspaceId, path }),
    rename: (workspaceId: string, from: string, to: string): Promise<FilesMutationResult> =>
      invoke('files:rename', { workspaceId, from, to }),
    delete: (workspaceId: string, path: string): Promise<FilesMutationResult> =>
      invoke('files:delete', { workspaceId, path }),
    absolutePath: (workspaceId: string, path: string): Promise<string | null> =>
      invoke('files:absolutePath', { workspaceId, path }),
    // Working-tree watcher (main/filesWatcher.ts) — live tree refresh while
    // the Files tab is open. AT MOST ONE watcher is active app-wide; starting
    // a new workspace's watch stops any previous one.
    watchStart: (workspaceId: string): Promise<void> => invoke('files:watchStart', { workspaceId }),
    watchStop: (workspaceId: string): Promise<void> => invoke('files:watchStop', { workspaceId }),
    onFilesChanged: (cb: (e: { workspaceId: string }) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.filesChanged, cb)
  },
  github: {
    prForBranch: (cwd: string, branch: string): Promise<GhPullRequest | null> =>
      invoke('github:prForBranch', { cwd, branch }),
    onPrChanged: (
      cb: (e: { workspaceId: string; pr: GhPullRequest | null }) => void
    ): (() => void) => subscribe(PUSH_CHANNELS.githubPrChanged, cb)
  },
  shell: {
    revealInFinder: (path: string): Promise<void> => invoke('shell:revealInFinder', { path }),
    openInEditor: (path: string): Promise<void> => invoke('shell:openInEditor', { path }),
    openTerminal: (path: string): Promise<void> => invoke('shell:openTerminal', { path }),
    copyToClipboard: (text: string): Promise<void> => invoke('shell:copyToClipboard', { text }),
    listEditorApps: (): Promise<DetectedApp[]> => invoke('shell:listEditorApps'),
    listTerminalApps: (): Promise<DetectedApp[]> => invoke('shell:listTerminalApps')
  },
  mcp: {
    listServers: (): Promise<DiscoveredMcpServer[]> => invoke('mcp:listServers'),
    add: (draft: McpServerDraft): Promise<void> => invoke('mcp:add', draft),
    update: (
      filePath: string,
      oldName: string,
      draft: Omit<McpServerDraft, 'source' | 'projectId'>
    ): Promise<void> => invoke('mcp:update', { filePath, oldName, draft }),
    delete: (filePath: string, name: string): Promise<void> =>
      invoke('mcp:delete', { filePath, name })
  },
  claudeAgents: {
    listSlashCommands: (): Promise<ClaudeSlashCommand[]> =>
      invoke('claudeAgents:listSlashCommands'),
    listSubagents: (): Promise<ClaudeSubagent[]> => invoke('claudeAgents:listSubagents'),
    addSlashCommand: (draft: ClaudeSlashCommandDraft): Promise<void> =>
      invoke('claudeAgents:addSlashCommand', draft),
    updateSlashCommand: (
      filePath: string,
      draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'>
    ): Promise<void> => invoke('claudeAgents:updateSlashCommand', { filePath, draft }),
    deleteSlashCommand: (filePath: string): Promise<void> =>
      invoke('claudeAgents:deleteSlashCommand', { filePath }),
    addSubagent: (draft: ClaudeSubagentDraft): Promise<void> =>
      invoke('claudeAgents:addSubagent', draft),
    updateSubagent: (
      filePath: string,
      draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'>
    ): Promise<void> => invoke('claudeAgents:updateSubagent', { filePath, draft }),
    deleteSubagent: (filePath: string): Promise<void> =>
      invoke('claudeAgents:deleteSubagent', { filePath })
  },
  claudeHooks: {
    list: (): Promise<ClaudeHookEntry[]> => invoke('claudeHooks:list'),
    openFile: (filePath: string): Promise<void> => invoke('claudeHooks:openFile', { filePath }),
    add: (draft: ClaudeHookDraft): Promise<void> => invoke('claudeHooks:add', draft),
    update: (
      filePath: string,
      event: string,
      matcherEntryIdx: number,
      hookIdx: number,
      draft: { event: string; matcher: string | null; type: string; command: string }
    ): Promise<void> =>
      invoke('claudeHooks:update', {
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
    ): Promise<void> => invoke('claudeHooks:delete', { filePath, event, matcherEntryIdx, hookIdx })
  },
  contextMenu: {
    show: (items: ContextMenuNativeItem[]): Promise<string | null> =>
      invoke('contextMenu:show', items)
  },
  notifications: {
    test: (): Promise<void> => invoke('notifications:test')
  },
  updates: {
    check: (): Promise<UpdateCheckResult> => invoke('updates:check'),
    install: (): Promise<void> => invoke('updates:install'),
    restart: (): Promise<void> => invoke('updates:restart'),
    getState: (): Promise<UpdateSnapshot> => invoke('updates:getState'),
    onProgress: (cb: (e: UpdateProgress) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.updatesProgress, cb),
    onDone: (cb: (e: { success: boolean; code: number | null }) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.updatesDone, cb),
    onCheckResult: (cb: (result: UpdateCheckResult) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.updatesCheckResult, cb)
  },
  status: {
    get: (): Promise<ClaudeStatusSnapshot> => invoke('status:get'),
    refresh: (): Promise<ClaudeStatusSnapshot> => invoke('status:refresh'),
    openPage: (): Promise<void> => invoke('status:openPage'),
    onChange: (cb: (snapshot: ClaudeStatusSnapshot) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.statusChange, cb)
  },
  actions: {
    invoke: (
      invocation: { id: string; params: Record<string, unknown>; workspaceId: string },
      consumerHint?: string
    ): Promise<ActionResult> =>
      invoke('actions:invoke', {
        actionId: invocation.id,
        params: invocation.params,
        workspaceId: invocation.workspaceId,
        consumerHint: consumerHint ?? 'renderer'
      }),

    list: (): Promise<Array<{ id: string; kind: ActionKind }>> => invoke('actions:list'),

    history: (workspaceId: string, limit?: number): Promise<ActionAuditEntry[]> =>
      invoke('actions:history', { workspaceId, limit }),

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

      ipcRenderer.on(PUSH_CHANNELS.actionsSubscriptionUpdate, listener)
      const subP = invoke('actions:subscribe', {
        subscriptionId,
        actionId,
        params,
        workspaceId
      }).catch((e) => {
        console.error('actions:subscribe failed', e)
      })

      return {
        dispose: () => {
          ipcRenderer.removeListener(PUSH_CHANNELS.actionsSubscriptionUpdate, listener)
          subP
            .then(() => invoke('actions:unsubscribe', { subscriptionId }))
            .catch(() => {
              /* ignore cleanup errors */
            })
        }
      }
    }
  },
  footerActions: {
    listMerged: (workspaceId: string): Promise<FooterActionDescriptor[]> =>
      invoke('footerActions:listMerged', { workspaceId }),

    listAtScope: (scope: FooterActionScope, scopeId?: string): Promise<FooterActionDescriptor[]> =>
      invoke('footerActions:listAtScope', { scope, scopeId }),

    create: (
      scope: FooterActionScope,
      scopeId: string | null,
      draft: FooterActionDraft
    ): Promise<FooterActionDescriptor> => invoke('footerActions:create', { scope, scopeId, draft }),

    update: (id: string, patch: Partial<FooterActionDraft>): Promise<FooterActionDescriptor> =>
      invoke('footerActions:update', { id, patch }),

    remove: (id: string): Promise<void> => invoke('footerActions:remove', { id }),

    reorder: (
      scope: FooterActionScope,
      scopeId: string | null,
      orderedIds: string[]
    ): Promise<void> => invoke('footerActions:reorder', { scope, scopeId, orderedIds }),

    resetDefaults: (): Promise<void> => invoke('footerActions:resetDefaults')
  },
  hooks: {
    setEnabled: (enabled: boolean): Promise<{ enabled: boolean }> =>
      invoke('hooks:setEnabled', enabled),
    getStatus: (): Promise<{ enabled: boolean; installed: number }> => invoke('hooks:getStatus')
  },
  health: {
    get: (): Promise<HealthReport> => invoke('health:get')
  },
  diag: {
    event: (evt: DiagEvent): void => {
      try {
        ipcRenderer.send('diag:event', evt)
      } catch {
        /* never throw */
      }
    },
    openConsole: (): Promise<void> => invoke('diag:openConsole'),
    onStream: (cb: (batch: unknown[]) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.diagStream, cb),
    export: (opts: {
      sinceMs: number
    }): Promise<
      { ok: true; path: string; txtPath: string; jsonPath: string } | { ok: false; error: string }
    > => invoke('diag:export', opts)
  },
  keepAwake: {
    get: (): Promise<KeepAwakeState> => invoke('keepAwake:get'),
    setMode: (mode: KeepAwakeBaseMode): Promise<KeepAwakeState> =>
      invoke('keepAwake:setMode', mode),
    setDisplayOn: (on: boolean): Promise<KeepAwakeState> => invoke('keepAwake:setDisplayOn', on),
    startTimer: (minutes: number): Promise<KeepAwakeState> =>
      invoke('keepAwake:startTimer', minutes),
    onState: (cb: (state: KeepAwakeState) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.keepAwakeState, cb)
  },
  overlay: {
    show: (descriptor: OverlayDescriptor): Promise<OverlayShowResult> =>
      invoke('overlay:showDescriptor', { descriptor }),
    update: (id: string, props: Record<string, unknown>): Promise<void> =>
      invoke('overlay:update', { id, props }),
    hide: (id: string): Promise<void> => invoke('overlay:hide', { id }),
    onEvent: (cb: (e: OverlayEvent) => void): (() => void) =>
      subscribe(PUSH_CHANNELS.overlayEvent, cb)
  }
}

// DUP-3 finalize: the single source of truth for the renderer-facing
// `window.api` shape. `src/preload/index.d.ts` derives `Window.api` from
// this type instead of hand-maintaining a parallel twin — see that file.
export type OrpheusApi = typeof api

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
