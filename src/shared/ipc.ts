// ---------------------------------------------------------------------------
// Typed IPC channel maps (DUP-3, chunk A — foundation only).
//
// This file is the single source of truth for the *shape* of IPC traffic
// between main and renderer. It imports ONLY from `./types` — nothing from
// `src/main`, `src/preload`, or `src/renderer` (enforced by the
// `shared-not-to-*` depcruise rules; keep it that way).
//
// Two maps:
//   - `InvokeChannelMap`  — request/response channels driven via
//     `ipcMain.handle` / `ipcRenderer.invoke`.
//   - `RendererPushMap`   — fire-and-forget channels main pushes to the
//     renderer via `webContents.send` / consumed via `ipcRenderer.on`.
//
// Error-shape convention (documented here for future migration commits,
// NOT enforced/migrated yet):
//   - A thrown error crossing the invoke boundary means a PROGRAMMER error
//     (bad input, invariant violation, unexpected exception) — the renderer
//     is not expected to recover gracefully, it's a bug to fix.
//   - An `ActionResult` (see `./types`) return value means an EXPECTED
//     outcome the UI should branch on (success/failure the user can act on,
//     e.g. "workspace is dirty, confirm force"). Do not conflate the two:
//     don't throw for expected outcomes, and don't return an `ActionResult`
//     shape to paper over a real bug.
// ---------------------------------------------------------------------------

import type {
  ProjectRecord,
  PinnedItem,
  DoctorResult,
  HealthReport,
  WorkspaceRecord,
  WorkspaceStatus,
  WorkspaceActivityDetail,
  AppUiState,
  GitStatus,
  GhPullRequest,
  ClaudeStatusSnapshot,
  UpdateProgress,
  UpdateCheckResult,
  KeepAwakeState,
  OverlayEvent,
  CreateWorktreeParams,
  ClaudeWorkspaceSettings,
  ClaudeEffort,
  SessionRecord,
  SessionStatus,
  SessionsPagedRequest,
  SessionsPagedResult,
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsPatch,
  GhosttyUserConfig,
  DiscoveredMcpServer,
  McpServerDraft,
  ClaudeSlashCommand,
  ClaudeSlashCommandDraft,
  ClaudeSubagent,
  ClaudeSubagentDraft,
  ClaudeHookEntry,
  ClaudeHookDraft,
  ClaudeAuthState,
  ClaudeAuthPatch,
  ClaudeAuthTestResult,
  ClaudeProjectSettings,
  ClaudeProjectSettingsOverrides,
  ClaudeWorkspaceSettingsOverrides,
  GitBranchInfo,
  GitCommit
} from './types'

// ---------------------------------------------------------------------------
// Invoke channels (request/response)
// ---------------------------------------------------------------------------

/**
 * Channel name -> { req: [...tuple of args after the IpcMainInvokeEvent],
 * res: return type }. Seeded with a handful of simple, zero/low-arg reads.
 * The remaining ~100+ invoke channels stay untyped (permissive fallback
 * overload) and are migrated domain-by-domain in follow-up commits.
 */
export interface InvokeChannelMap {
  'app:getVersion': { req: []; res: string }
  'app:getPaths': { req: []; res: { userData: string; logs: string } }
  'projects:list': { req: []; res: ProjectRecord[] }
  'pins:listAll': { req: []; res: PinnedItem[] }
  'doctor:check': { req: []; res: DoctorResult }
  'health:get': { req: []; res: HealthReport }
  'window:openDevTools': { req: []; res: void }
  'window:reload': { req: []; res: void }
  'config:openFolder': { req: []; res: string | null }
  'orpheusConfig:get': {
    req: [{ projectId: string }]
    res: { allowLocal: boolean; allowWorktree: boolean }
  }
  'orpheusConfig:setOverride': {
    req: [{ projectId: string; patch: Partial<{ allowLocal: boolean; allowWorktree: boolean }> }]
    res: { allowLocal: boolean; allowWorktree: boolean }
  }
  'diag:openConsole': { req: []; res: void }
  'diag:export': {
    req: [{ sinceMs: number }]
    res:
      | { ok: true; path: string; txtPath: string; jsonPath: string }
      | { ok: false; error: string }
  }
  'projects:add': { req: [{ path: string }]; res: ProjectRecord }
  'projects:pickAndAdd': { req: []; res: ProjectRecord | null }
  'projects:open': { req: [{ id: string }]; res: ProjectRecord }
  'projects:remove': {
    req: [{ id: string; deleteWorktrees?: boolean; force?: boolean }]
    res: { deleted: boolean; dirtyWorktrees: number }
  }
  'projects:worktreeSummary': { req: [{ projectId: string }]; res: { count: number } }
  'projects:rename': { req: [{ id: string; name: string }]; res: void }
  'projects:setExpandedInSidebar': {
    req: [{ id: string; expanded: boolean }]
    res: void
  }
  'projects:reorder': { req: [{ orderedIds: string[] }]; res: void }
  'projects:setPinned': { req: [{ id: string; pinned: boolean }]; res: ProjectRecord }
  'projects:refreshGithub': { req: [string]; res: void }
  'workspaces:listForProject': {
    req: [{ projectId: string; scope?: 'active' | 'archived' | 'all' }]
    res: WorkspaceRecord[]
  }
  'workspaces:create': {
    req: [{ projectId: string; name: string; cwd: string }]
    res: WorkspaceRecord
  }
  'workspaces:createWorktree': {
    req: [{ projectId: string; params: CreateWorktreeParams }]
    res: WorkspaceRecord
  }
  'worktrees:branchExists': { req: [{ projectId: string; branch: string }]; res: boolean }
  'workspaces:open': { req: [{ id: string }]; res: WorkspaceRecord }
  'workspaces:setPinned': { req: [{ id: string; pinned: boolean }]; res: WorkspaceRecord }
  'workspaces:archive': {
    req: [{ id: string; force?: boolean }]
    res: { archived: boolean; wasDirty: boolean }
  }
  'workspace:close': {
    req: [{ id: string }]
    res: { ok: true; workspace: WorkspaceRecord | null } | { ok: false; error: 'busy' }
  }
  'workspace:reopen': {
    req: [{ id: string }]
    res: { ok: true; workspace: WorkspaceRecord | null }
  }
  'workspaces:rename': { req: [{ id: string; name: string }]; res: WorkspaceRecord }
  'workspaces:convertToLocal': { req: [{ id: string }]; res: WorkspaceRecord }
  'workspaces:reorder': {
    req: [{ projectId: string; orderedIds: string[] }]
    res: void
  }
  'workspace:isDirty': { req: [{ workspaceId: string }]; res: boolean }
  'workspace:getTitle': { req: [{ workspaceId: string }]; res: string | null }
  'workspace:setModel': {
    req: [{ workspaceId: string; model: string }]
    res: ClaudeWorkspaceSettings
  }
  'workspace:getEffectiveModel': { req: [{ workspaceId: string }]; res: { model: string } }
  'workspace:setEffort': {
    req: [{ workspaceId: string; effort: ClaudeEffort }]
    res: ClaudeWorkspaceSettings
  }
  'workspace:getEffectiveEffort': { req: [{ workspaceId: string }]; res: { effort: string } }
  'sessions:listForProject': {
    req: [{ projectId: string; includeArchived?: boolean }]
    res: SessionRecord[]
  }
  'sessions:listAll': { req: [{ status?: SessionStatus } | undefined]; res: SessionRecord[] }
  'sessions:setStatus': { req: [{ id: string; status: SessionStatus }]; res: void }
  'sessions:listForProjectPaged': { req: [SessionsPagedRequest]; res: SessionsPagedResult }
  'sessions:resumeInNewWorkspace': {
    req: [{ sessionId: string; projectId: string }]
    res: WorkspaceRecord
  }
  'sessions:resumeInWorktreeWorkspace': {
    req: [{ sessionId: string; projectId: string }]
    res: WorkspaceRecord
  }
  'sessions:refreshMetadata': { req: [{ projectId: string }]; res: void }
  'sessions:delete': { req: [{ id: string }]; res: void }
  'sessions:getContextBudget': {
    req: [{ workspaceId: string }]
    res: { contextBudget: number; modelId: string }
  }
  'claudeSettings:get': { req: []; res: ClaudeGlobalSettings }
  'claudeSettings:update': { req: [ClaudeGlobalSettingsPatch]; res: ClaudeGlobalSettings }
  'ghosttySettings:get': { req: []; res: GhosttyUserConfig }
  'ghosttySettings:update': { req: [Partial<GhosttyUserConfig>]; res: GhosttyUserConfig }
  'mcp:listServers': { req: []; res: DiscoveredMcpServer[] }
  'mcp:add': { req: [McpServerDraft]; res: void }
  'mcp:update': {
    req: [
      {
        filePath: string
        oldName: string
        draft: Omit<McpServerDraft, 'source' | 'projectId'>
      }
    ]
    res: void
  }
  'mcp:delete': { req: [{ filePath: string; name: string }]; res: void }
  'claudeAgents:listSlashCommands': { req: []; res: ClaudeSlashCommand[] }
  'claudeAgents:listSubagents': { req: []; res: ClaudeSubagent[] }
  'claudeAgents:addSlashCommand': { req: [ClaudeSlashCommandDraft]; res: void }
  'claudeAgents:updateSlashCommand': {
    req: [{ filePath: string; draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'> }]
    res: void
  }
  'claudeAgents:deleteSlashCommand': { req: [{ filePath: string }]; res: void }
  'claudeAgents:addSubagent': { req: [ClaudeSubagentDraft]; res: void }
  'claudeAgents:updateSubagent': {
    req: [{ filePath: string; draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'> }]
    res: void
  }
  'claudeAgents:deleteSubagent': { req: [{ filePath: string }]; res: void }
  'claudeHooks:list': { req: []; res: ClaudeHookEntry[] }
  'claudeHooks:openFile': { req: [{ filePath: string }]; res: void }
  'claudeHooks:add': { req: [ClaudeHookDraft]; res: void }
  'claudeHooks:update': {
    req: [
      {
        filePath: string
        event: string
        matcherEntryIdx: number
        hookIdx: number
        draft: Omit<ClaudeHookDraft, 'source' | 'projectId'>
      }
    ]
    res: void
  }
  'claudeHooks:delete': {
    req: [{ filePath: string; event: string; matcherEntryIdx: number; hookIdx: number }]
    res: void
  }
  'claudeAuth:get': { req: []; res: ClaudeAuthState }
  'claudeAuth:update': { req: [ClaudeAuthPatch]; res: ClaudeAuthState }
  'claudeAuth:testConnection': { req: []; res: ClaudeAuthTestResult }
  'claudeProjectSettings:get': { req: [{ projectId: string }]; res: ClaudeProjectSettings }
  'claudeProjectSettings:update': {
    req: [{ projectId: string; patch: ClaudeProjectSettingsOverrides }]
    res: ClaudeProjectSettings
  }
  'claudeWorkspaceSettings:get': { req: [{ workspaceId: string }]; res: ClaudeWorkspaceSettings }
  'claudeWorkspaceSettings:update': {
    req: [{ workspaceId: string; patch: ClaudeWorkspaceSettingsOverrides }]
    res: ClaudeWorkspaceSettings
  }
  'git:status': { req: [{ cwd: string }]; res: GitStatus | null }
  'git:branches': { req: [{ cwd: string }]; res: GitBranchInfo[] }
  'git:log': {
    req: [
      {
        cwd: string
        branch?: string
        limit?: number
        offset?: number
        sinceMs?: number
        untilMs?: number
        grep?: string
      }
    ]
    res: GitCommit[]
  }
  'git:count': {
    req: [{ cwd: string; branch?: string; sinceMs?: number; untilMs?: number; grep?: string }]
    res: number
  }
  'github:prForBranch': { req: [{ cwd: string; branch: string }]; res: GhPullRequest | null }
  // … migrated domain-by-domain in follow-up commits.
}

export type InvokeChannel = keyof InvokeChannelMap
export type Req<C extends InvokeChannel> = InvokeChannelMap[C]['req']
export type Res<C extends InvokeChannel> = InvokeChannelMap[C]['res']

// ---------------------------------------------------------------------------
// Renderer push channels (main -> renderer, fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Channel name -> event payload type, for every channel main currently
 * pushes to the renderer main window via `webContents.send` and the
 * renderer listens for via `ipcRenderer.on` in `src/preload/index.ts`.
 * (The separate overlay-window preload, `src/preload/overlay.ts`, has its
 * own `overlayRenderer:*` channels and is out of scope here.)
 */
export interface RendererPushMap {
  'addon:actionTrace': { tagName: string }
  'terminal:canInjectChanged': { workspaceId: string; canInject: boolean }
  'terminal:sleepStateChanged': { workspaceId: string; sleeping: boolean }
  'terminal:liveness': {
    workspaceId: string
    inputTick: number
    liveTick: number
    occluded: boolean
  }
  'terminal:activeWorkspaceChanged': { workspaceId: string | null }
  'projects:githubDataUpdated': {
    projectId: string
    githubOwner: string | null
    githubRepo: string | null
    githubAvatarUrl: string | null
    githubCheckedAt: number
  }
  'workspace:dirtyChanged': { workspaceId: string; dirty: boolean }
  'workspace:titleChanged': { workspaceId: string; title: string | null }
  'workspace:activityBatch': Array<{
    workspaceId: string
    status: WorkspaceStatus
    detail: WorkspaceActivityDetail
  }>
  'workspace:navigateTo': { workspaceId: string; projectId?: string }
  'workspace:requestOpen': { workspaceId: string; focus?: boolean }
  'workspaces:created': { workspace: WorkspaceRecord }
  'workspaces:archived': { workspaceId: string; projectId: string }
  'workspaces:changed': { workspace: WorkspaceRecord }
  'uiState:changed': AppUiState
  'git:statusChanged': { workspaceId: string; status: GitStatus }
  'github:prChanged': { workspaceId: string; pr: GhPullRequest | null }
  'updates:progress': UpdateProgress
  'updates:done': { success: boolean; code: number | null }
  'updates:checkResult': UpdateCheckResult
  'status:change': ClaudeStatusSnapshot
  'actions:subscription-update': { subscriptionId: string; value: unknown }
  'diag:stream': unknown[]
  'keepAwake:state': KeepAwakeState
  'overlay:event': OverlayEvent
}

export type PushChannel = keyof RendererPushMap
export type PushPayload<C extends PushChannel> = RendererPushMap[C]

/**
 * MDB-10: the single place the 25 push-channel literals are spelled. Main
 * (`webContents.send`) and preload (`ipcRenderer.on` via `subscribe`) both
 * import from here so a typo on either side is a compile error instead of a
 * silently-dead channel. Keys match `RendererPushMap` — `keyof` below fails
 * to compile if the two ever drift apart.
 */
export const PUSH_CHANNELS = {
  addonActionTrace: 'addon:actionTrace',
  terminalCanInjectChanged: 'terminal:canInjectChanged',
  terminalSleepStateChanged: 'terminal:sleepStateChanged',
  terminalLiveness: 'terminal:liveness',
  terminalActiveWorkspaceChanged: 'terminal:activeWorkspaceChanged',
  projectsGithubDataUpdated: 'projects:githubDataUpdated',
  workspaceDirtyChanged: 'workspace:dirtyChanged',
  workspaceTitleChanged: 'workspace:titleChanged',
  workspaceActivityBatch: 'workspace:activityBatch',
  workspaceNavigateTo: 'workspace:navigateTo',
  workspaceRequestOpen: 'workspace:requestOpen',
  workspacesCreated: 'workspaces:created',
  workspacesArchived: 'workspaces:archived',
  workspacesChanged: 'workspaces:changed',
  uiStateChanged: 'uiState:changed',
  gitStatusChanged: 'git:statusChanged',
  githubPrChanged: 'github:prChanged',
  updatesProgress: 'updates:progress',
  updatesDone: 'updates:done',
  updatesCheckResult: 'updates:checkResult',
  statusChange: 'status:change',
  actionsSubscriptionUpdate: 'actions:subscription-update',
  diagStream: 'diag:stream',
  keepAwakeState: 'keepAwake:state',
  overlayEvent: 'overlay:event'
} satisfies Record<string, PushChannel>

// Exhaustiveness check: every PushChannel must appear as a value above (the
// `satisfies` above already guarantees the converse — no value can be an
// invalid PushChannel). If a channel is added to RendererPushMap but not to
// PUSH_CHANNELS, `_PushChannelsCoverAllKeys` narrows to `never` and this
// assignment fails to compile. Exported (not just declared) so it's an
// actual checked assertion, not a dead, unevaluated type alias.
type _PushChannelsCoverAllKeys =
  PushChannel extends (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS] ? true : never
export const _assertPushChannelsExhaustive: _PushChannelsCoverAllKeys = true
