import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  DoctorResult,
  ProjectRecord,
  SessionRecord,
  SessionStatus,
  WorkspaceRecord,
  PinnedItem,
  ClaudeGlobalSettings,
  ClaudeGlobalSettingsPatch,
  AppUiState,
  AppUiStatePatch
} from '../shared/types'

type TerminalRect = { x: number; y: number; w: number; h: number }

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      app: {
        getVersion: () => Promise<string>
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
      }
      sessions: {
        listForProject: (
          projectId: string,
          options?: { includeArchived?: boolean }
        ) => Promise<SessionRecord[]>
        listAll: (opts?: { status?: SessionStatus }) => Promise<SessionRecord[]>
        setStatus: (id: string, status: SessionStatus) => Promise<void>
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
      }
      pins: {
        listAll: () => Promise<PinnedItem[]>
      }
      claudeSettings: {
        get: () => Promise<ClaudeGlobalSettings>
        update: (patch: ClaudeGlobalSettingsPatch) => Promise<ClaudeGlobalSettings>
      }
      uiState: {
        get: () => Promise<AppUiState>
        update: (patch: AppUiStatePatch) => Promise<AppUiState>
      }
    }
  }
}
