import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import type {
  DoctorResult,
  ProjectRecord,
  SessionRecord,
  SessionStatus,
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
} from './shared/types'

type TerminalRect = { x: number; y: number; w: number; h: number }

// Helper: subscribe to a Tauri event and return a sync cleanup function.
function tauriListen<T>(
  event: string,
  cb: (payload: T) => void
): () => void {
  let unlisten: UnlistenFn | null = null
  listen<T>(event, (evt) => cb(evt.payload)).then((fn) => {
    unlisten = fn
  })
  return () => {
    if (unlisten) unlisten()
  }
}

const api = {
  app: {
    getVersion: (): Promise<string> => invoke('app_get_version')
  },

  window: {
    openDevTools: (): Promise<void> => invoke('window_open_dev_tools'),
    reload: (): Promise<void> => invoke('window_reload')
  },

  debug: {
    onActionTrace: (cb: (e: { tagName: string }) => void): (() => void) =>
      tauriListen<{ tagName: string }>('addon:actionTrace', cb)
  },

  terminal: {
    mount: (
      workspaceId: string,
      rect: TerminalRect,
      scaleFactor: number,
      cwd?: string
    ): Promise<{ workspaceId: string; created: boolean }> =>
      invoke('terminal_mount', { workspaceId, rect, scaleFactor, cwd }),
    hide: (workspaceId: string): Promise<void> =>
      invoke('terminal_hide', { workspaceId }),
    resize: (workspaceId: string, rect: TerminalRect, scaleFactor: number): Promise<void> =>
      invoke('terminal_resize', { workspaceId, rect, scaleFactor }),
    destroy: (workspaceId: string): Promise<void> =>
      invoke('terminal_destroy', { workspaceId })
  },

  config: {
    openFolder: (): Promise<string | null> => invoke('config_open_folder')
  },

  doctor: {
    check: (): Promise<DoctorResult> => invoke('doctor_check')
  },

  projects: {
    list: (): Promise<ProjectRecord[]> => invoke('projects_list'),
    add: (path: string): Promise<ProjectRecord> => invoke('projects_add', { path }),
    pickAndAdd: (): Promise<ProjectRecord | null> => invoke('projects_pick_and_add'),
    open: (id: string): Promise<ProjectRecord> => invoke('projects_open', { id }),
    remove: (id: string): Promise<void> => invoke('projects_remove', { id }),
    rename: (id: string, name: string): Promise<void> =>
      invoke('projects_rename', { id, name }),
    setExpandedInSidebar: (id: string, expanded: boolean): Promise<void> =>
      invoke('projects_set_expanded_in_sidebar', { id, expanded }),
    reorder: (orderedIds: string[]): Promise<void> =>
      invoke('projects_reorder', { orderedIds })
  },

  sessions: {
    listForProject: (
      projectId: string,
      options?: { includeArchived?: boolean }
    ): Promise<SessionRecord[]> =>
      invoke('sessions_list_for_project', { projectId, ...options }),
    listAll: (opts?: { status?: SessionStatus }): Promise<SessionRecord[]> =>
      invoke('sessions_list_all', opts ?? {}),
    setStatus: (id: string, status: SessionStatus): Promise<void> =>
      invoke('sessions_set_status', { id, status })
  },

  workspaces: {
    listForProject: (
      projectId: string,
      options?: { scope?: 'active' | 'archived' | 'all' }
    ): Promise<WorkspaceRecord[]> =>
      invoke('workspaces_list_for_project', { projectId, ...options }),
    create: (args: { projectId: string; name: string; cwd: string }): Promise<WorkspaceRecord> =>
      invoke('workspaces_create', args),
    open: (id: string): Promise<WorkspaceRecord> =>
      invoke('workspaces_open', { id }),
    setPinned: (id: string, pinned: boolean): Promise<WorkspaceRecord> =>
      invoke('workspaces_set_pinned', { id, pinned }),
    archive: (id: string): Promise<WorkspaceRecord> =>
      invoke('workspaces_archive', { id }),
    unarchive: (id: string): Promise<WorkspaceRecord> =>
      invoke('workspaces_unarchive', { id }),
    rename: (id: string, name: string): Promise<WorkspaceRecord> =>
      invoke('workspaces_rename', { id, name }),
    reorder: (projectId: string, orderedIds: string[]): Promise<void> =>
      invoke('workspaces_reorder', { projectId, orderedIds }),
    isDirty: (id: string): Promise<boolean> =>
      invoke('workspace_is_dirty', { workspaceId: id }),
    onDirtyChanged: (
      cb: (e: { workspaceId: string; dirty: boolean }) => void
    ): (() => void) =>
      tauriListen<{ workspaceId: string; dirty: boolean }>('workspace:dirtyChanged', cb),
    getTitle: (id: string): Promise<string | null> =>
      invoke('workspace_get_title', { workspaceId: id }),
    onTitleChanged: (
      cb: (e: { workspaceId: string; title: string | null }) => void
    ): (() => void) =>
      tauriListen<{ workspaceId: string; title: string | null }>('workspace:titleChanged', cb),
    onActivityChanged: (
      cb: (e: {
        workspaceId: string
        status: WorkspaceStatus
        detail: WorkspaceActivityDetail
      }) => void
    ): (() => void) =>
      tauriListen<{
        workspaceId: string
        status: WorkspaceStatus
        detail: WorkspaceActivityDetail
      }>('workspace:activityChanged', cb),
    setCurrentlyViewed: (workspaceId: string | null): void => {
      invoke('workspace_set_currently_viewed', { workspaceId }).catch((err) =>
        console.error('[api] workspace_set_currently_viewed failed', err)
      )
    },
    resetActivity: (workspaceId: string): Promise<void> =>
      invoke('workspace_reset_activity', { workspaceId }),
    onNavigateTo: (cb: (workspaceId: string) => void): (() => void) =>
      tauriListen<{ workspaceId: string }>('workspace:navigateTo', (e) =>
        cb(e.workspaceId)
      )
  },

  pins: {
    listAll: (): Promise<PinnedItem[]> => invoke('pins_list_all')
  },

  claudeSettings: {
    get: (): Promise<ClaudeGlobalSettings> => invoke('claude_settings_get'),
    update: (patch: ClaudeGlobalSettingsPatch): Promise<ClaudeGlobalSettings> =>
      invoke('claude_settings_update', { patch })
  },

  claudeAuth: {
    get: (): Promise<ClaudeAuthState> => invoke('claude_auth_get'),
    update: (patch: ClaudeAuthPatch): Promise<ClaudeAuthState> =>
      invoke('claude_auth_update', { patch }),
    testConnection: (): Promise<ClaudeAuthTestResult> =>
      invoke('claude_auth_test_connection')
  },

  claudeProjectSettings: {
    get: (projectId: string): Promise<ClaudeProjectSettings> =>
      invoke('claude_project_settings_get', { projectId }),
    update: (
      projectId: string,
      patch: ClaudeProjectSettingsOverrides
    ): Promise<ClaudeProjectSettings> =>
      invoke('claude_project_settings_update', { projectId, patch })
  },

  claudeWorkspaceSettings: {
    get: (workspaceId: string): Promise<ClaudeWorkspaceSettings> =>
      invoke('claude_workspace_settings_get', { workspaceId }),
    update: (
      workspaceId: string,
      patch: ClaudeWorkspaceSettingsOverrides
    ): Promise<ClaudeWorkspaceSettings> =>
      invoke('claude_workspace_settings_update', { workspaceId, patch })
  },

  uiState: {
    get: (): Promise<AppUiState> => invoke('ui_state_get'),
    update: (patch: AppUiStatePatch): Promise<AppUiState> =>
      invoke('ui_state_update', { patch })
  },

  git: {
    status: (cwd: string): Promise<GitStatus | null> =>
      invoke('git_status', { cwd })
  },

  mcp: {
    listServers: (): Promise<DiscoveredMcpServer[]> => invoke('mcp_list_servers'),
    add: (draft: McpServerDraft): Promise<void> => invoke('mcp_add', { draft }),
    update: (
      filePath: string,
      oldName: string,
      draft: Omit<McpServerDraft, 'source' | 'projectId'>
    ): Promise<void> => invoke('mcp_update', { filePath, oldName, draft }),
    delete: (filePath: string, name: string): Promise<void> =>
      invoke('mcp_delete', { filePath, name })
  },

  claudeAgents: {
    listSlashCommands: (): Promise<ClaudeSlashCommand[]> =>
      invoke('claude_agents_list_slash_commands'),
    listSubagents: (): Promise<ClaudeSubagent[]> =>
      invoke('claude_agents_list_subagents'),
    addSlashCommand: (draft: ClaudeSlashCommandDraft): Promise<void> =>
      invoke('claude_agents_add_slash_command', { draft }),
    updateSlashCommand: (
      filePath: string,
      draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'>
    ): Promise<void> => invoke('claude_agents_update_slash_command', { filePath, draft }),
    deleteSlashCommand: (filePath: string): Promise<void> =>
      invoke('claude_agents_delete_slash_command', { filePath }),
    addSubagent: (draft: ClaudeSubagentDraft): Promise<void> =>
      invoke('claude_agents_add_subagent', { draft }),
    updateSubagent: (
      filePath: string,
      draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'>
    ): Promise<void> => invoke('claude_agents_update_subagent', { filePath, draft }),
    deleteSubagent: (filePath: string): Promise<void> =>
      invoke('claude_agents_delete_subagent', { filePath })
  },

  claudeHooks: {
    list: (): Promise<ClaudeHookEntry[]> => invoke('claude_hooks_list'),
    openFile: (filePath: string): Promise<void> =>
      invoke('claude_hooks_open_file', { filePath }),
    add: (draft: ClaudeHookDraft): Promise<void> => invoke('claude_hooks_add', { draft }),
    update: (
      filePath: string,
      event: string,
      matcherEntryIdx: number,
      hookIdx: number,
      draft: { event: string; matcher: string | null; type: string; command: string }
    ): Promise<void> =>
      invoke('claude_hooks_update', {
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
      invoke('claude_hooks_delete', { filePath, event, matcherEntryIdx, hookIdx })
  },

  contextMenu: {
    show: (items: ContextMenuNativeItem[]): Promise<string | null> =>
      invoke('context_menu_show', { items })
  },

  notifications: {
    test: (): Promise<void> => invoke('notifications_test')
  }
}

// Expose as window.api so existing components can reference it without change.
declare global {
  interface Window {
    api: typeof api
    electron: {
      ipcRenderer: {
        on: (channel: string, cb: (...args: unknown[]) => void) => () => void
        removeListener: (channel: string, cb: (...args: unknown[]) => void) => void
        removeAllListeners: (channel: string) => void
      }
    }
  }
}

window.api = api

// Minimal window.electron.ipcRenderer adapter for any component that calls it directly.
// In practice the renderer source has zero window.electron references, but this guards
// against future accidental imports of the Electron pattern.
window.electron = {
  ipcRenderer: {
    on: (channel: string, cb: (...args: unknown[]) => void): (() => void) => {
      let unlisten: UnlistenFn | null = null
      listen(channel, (evt) => cb(evt, evt.payload)).then((fn) => {
        unlisten = fn
      })
      return () => {
        if (unlisten) unlisten()
      }
    },
    removeListener: () => {},
    removeAllListeners: () => {}
  }
}
