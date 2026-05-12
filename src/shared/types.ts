export type GitStatus = {
  insertions: number
  deletions: number
  hasChanges: boolean
  branch: string | null
}

export type ExistingProject = {
  encodedName: string // e.g. "-Users-maverick-code-projects-orpheus"
  path: string // decoded absolute path, e.g. "/Users/maverick/code/projects/orpheus"
  name: string // basename, e.g. "orpheus"
  sessionCount: number // number of .jsonl files inside the dir
  lastActivity: number | null // ms timestamp of most recent .jsonl mtime, or null
}

export type DoctorResult = {
  claudeInstalled: boolean
  claudeVersion: string | null // e.g. "1.2.3" extracted from `claude --version`
  claudePath: string | null // e.g. "/usr/local/bin/claude"
  existingProjects: ExistingProject[]
}

// ---------------------------------------------------------------------------
// Persistence types (SQLite-backed)
// ---------------------------------------------------------------------------

export type ProjectRecord = {
  id: string
  path: string
  name: string
  claudeEncodedName: string | null
  addedAt: number
  lastOpenedAt: number | null
  expandedInSidebar: boolean
}

export type WorkspaceRecord = {
  id: string
  projectId: string
  name: string
  nameIsAuto: boolean
  cwd: string
  pinnedAt: number | null
  createdAt: number
  lastOpenedAt: number | null
  archivedAt: number | null
}

// For Pinned section: a pinned workspace with its project for context
export type PinnedItem = {
  workspace: WorkspaceRecord
  project: ProjectRecord
}

// ---------------------------------------------------------------------------
// Claude global settings
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App UI state
// ---------------------------------------------------------------------------

export type AppViewKind = 'dashboard' | 'sessions' | 'project' | 'workspace'

export type AppUiState = {
  sidebarCollapsed: boolean
  lastViewKind: AppViewKind
  lastProjectId: string | null
  lastWorkspaceId: string | null
  windowX: number | null
  windowY: number | null
  windowWidth: number | null
  windowHeight: number | null
  windowFullscreen: boolean
  updatedAt: number
}

export type AppUiStatePatch = Partial<Omit<AppUiState, 'updatedAt'>>

// ---------------------------------------------------------------------------
// Claude global settings
// ---------------------------------------------------------------------------

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
export type ClaudeEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ClaudeOutputStyle = 'default' | 'explanatory' | 'proactive' | 'learning'
export type ClaudeTuiMode = 'default' | 'fullscreen'
export type ClaudeEditorMode = 'normal' | 'vim'
export type ClaudeLogLevel = 'debug' | 'info' | 'warn' | 'error'

export type ClaudeGlobalSettings = {
  model: string // free-form string (e.g., 'sonnet', 'opus', 'haiku', or a full model ID)
  permissionMode: ClaudePermissionMode
  effort: ClaudeEffort
  autoMemory: boolean
  alwaysThinking: boolean
  // B2 Display additions:
  outputStyle: ClaudeOutputStyle
  tuiMode: ClaudeTuiMode
  editorMode: ClaudeEditorMode
  reduceMotion: boolean
  nativeCursor: boolean
  hideCwd: boolean

  // Memory section
  disableGitInstructions: boolean
  maxOutputTokens: number | null
  maxContextTokens: number | null
  compactionThreshold: number | null

  // Developer section
  debugLogging: boolean
  logLevel: ClaudeLogLevel
  disableTelemetry: boolean
  disableErrorReporting: boolean
  disableAutoupdater: boolean
  experimentalAgentTeams: boolean
  experimentalForkedSubagents: boolean
  simpleSystemPrompt: boolean

  // Permissions section
  autoApproveEdits: boolean
  askDestructiveBash: boolean
  planModeDefault: boolean
  permissionAllowRules: string[]
  permissionAskRules: string[]
  permissionDenyRules: string[]
  permissionAdditionalDirs: string[]

  updatedAt: number
}

export type ClaudeGlobalSettingsPatch = Partial<Omit<ClaudeGlobalSettings, 'updatedAt'>>

// ---------------------------------------------------------------------------
// Per-project Claude settings overrides
// ---------------------------------------------------------------------------

export type ClaudeProjectSettingsOverrides = {
  model?: string
  permissionMode?: ClaudePermissionMode
  effort?: ClaudeEffort
}

export type ClaudeProjectSettings = {
  projectId: string
  overrides: ClaudeProjectSettingsOverrides
  updatedAt: number
}

export type SessionStatus = 'in_progress' | 'in_review' | 'archived'

export type SessionRecord = {
  id: string
  projectId: string
  jsonlPath: string
  title: string | null
  status: SessionStatus
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  model: string | null
  lastMessageRole: string | null
}
