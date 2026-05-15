import { ElectronAPI } from '@electron-toolkit/preload'
import type {
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
  ContextMenuNativeItem
} from '../shared/types'

type TerminalRect = { x: number; y: number; w: number; h: number }

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      app: {
        getVersion: () => Promise<string>
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
        ) => Promise<{ workspaceId: string; created: boolean }>
        hide: (workspaceId: string) => Promise<void>
        resize: (workspaceId: string, rect: TerminalRect, scaleFactor: number) => Promise<void>
        destroy: (workspaceId: string) => Promise<void>
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
        remove: (id: string) => Promise<void>
        rename: (id: string, name: string) => Promise<void>
        setExpandedInSidebar: (id: string, expanded: boolean) => Promise<void>
        reorder: (orderedIds: string[]) => Promise<void>
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
      }
      workspaces: {
        listForProject: (
          projectId: string,
          options?: { scope?: 'active' | 'archived' | 'all' }
        ) => Promise<WorkspaceRecord[]>
        create: (args: { projectId: string; name: string; cwd: string }) => Promise<WorkspaceRecord>
        open: (id: string) => Promise<WorkspaceRecord>
        setPinned: (id: string, pinned: boolean) => Promise<WorkspaceRecord>
        archive: (id: string) => Promise<WorkspaceRecord>
        unarchive: (id: string) => Promise<WorkspaceRecord>
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
        setCurrentlyViewed: (workspaceId: string | null) => void
        resetActivity: (workspaceId: string) => Promise<void>
        onNavigateTo: (cb: (workspaceId: string) => void) => () => void
      }
      pins: {
        listAll: () => Promise<PinnedItem[]>
      }
      claudeSettings: {
        get: () => Promise<ClaudeGlobalSettings>
        update: (patch: ClaudeGlobalSettingsPatch) => Promise<ClaudeGlobalSettings>
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
      }
      git: {
        status: (cwd: string) => Promise<GitStatus | null>
        branches: (cwd: string) => Promise<GitBranchInfo[]>
        log: (
          cwd: string,
          opts?: { branch?: string; limit?: number; offset?: number }
        ) => Promise<GitCommit[]>
      }
      shell: {
        revealInFinder: (path: string) => Promise<void>
        openInEditor: (path: string) => Promise<void>
        openTerminal: (path: string) => Promise<void>
        copyToClipboard: (text: string) => Promise<void>
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
    }
  }
}
