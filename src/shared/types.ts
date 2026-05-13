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
  sortOrder: number | null
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
  sortOrder: number | null
  status: WorkspaceStatus
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
  // Window behavior preferences (v11) — optional for back-compat with hardcoded fallbacks
  restoreGeometry?: boolean
  closeHides?: boolean
  openAtLastView?: boolean
  // Sidebar behavior preferences (v12)
  pinnedSectionVisible: boolean
  workspaceCountInline: boolean
  sidebarWidth: number
  defaultProjectExpanded: boolean
  // Launch + hotkey (v18)
  launchAtLogin: boolean
  globalHotkey: string
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

  // Fallback model (v11) — '' means no fallback (use claude's default behavior)
  fallbackModel: string

  // Tools section (v14)
  bashDefaultTimeoutMs: number | null
  bashMaxTimeoutMs: number | null
  bashMaxOutputLength: number | null
  toolConcurrency: number | null
  browserIntegration: boolean
  disabledMcpServers: string[]

  // Custom env vars (v22) — merged last at launch; user's keys win on conflict
  customEnvVars: Record<string, string>

  // Env-var controls (v23) — General
  disableThinking: boolean
  disableFastMode: boolean
  maxTurns: number | null

  // Env-var controls (v23) — Memory & Context
  maxThinkingTokens: number | null
  fileReadMaxOutputTokens: number | null
  disableClaudeMds: boolean

  // Env-var controls (v23) — Tools
  bashMaintainCwd: boolean
  perforceMode: boolean
  globHidden: boolean
  globNoIgnore: boolean
  globTimeoutSeconds: number | null

  // Env-var controls (v23) — Developer
  apiTimeoutMs: number | null
  maxRetries: number | null
  httpProxy: string
  httpsProxy: string
  disableNonessentialTraffic: boolean
  doNotTrack: boolean
  disableBackgroundTasks: boolean
  disableAgentView: boolean
  anthropicBetas: string
  extraBodyJson: string

  updatedAt: number
}

export type ClaudeGlobalSettingsPatch = Partial<Omit<ClaudeGlobalSettings, 'updatedAt'>>

// ---------------------------------------------------------------------------
// Discovered MCP servers (v14)
// ---------------------------------------------------------------------------

export type DiscoveredMcpServer = {
  name: string              // server key from mcpServers map
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  command?: string          // for stdio servers
  url?: string              // for http/sse servers
  source: 'user' | 'project'  // user = ~/.claude.json, project = <projectPath>/.mcp.json
  projectId?: string        // set when source === 'project'
  projectName?: string      // set when source === 'project'
}

// ---------------------------------------------------------------------------
// Discovered slash commands and subagents (v15)
// ---------------------------------------------------------------------------

export type ClaudeSlashCommand = {
  name: string
  path: string
  source: 'user' | 'project'
  projectId?: string
  projectName?: string
  description: string | null
  allowedTools: string[] | null
  argumentHint: string | null
  frontmatter: Record<string, string | string[]>
  bodyPreview: string
}

export type ClaudeSubagent = {
  name: string
  path: string
  source: 'user' | 'project'
  projectId?: string
  projectName?: string
  description: string | null
  tools: string[] | null
  model: string | null
  frontmatter: Record<string, string | string[]>
  bodyPreview: string
}

export type ClaudeHookEntry = {
  event: string                  // e.g. 'PreToolUse', 'Stop'
  matcher: string | null         // e.g. 'Bash' for PreToolUse, null when omitted
  type: string                   // typically 'command'
  command: string                // shell command to run
  source: 'user' | 'project'
  projectId?: string
  projectName?: string
  filePath: string               // absolute path of the settings.json this came from
  // Addressing fields for edit/delete
  matcherEntryIdx: number        // index in hooks[event] array
  hookIdx: number                // index in hooks[event][matcherEntryIdx].hooks array
}

export type ClaudeHookDraft = {
  event: string
  matcher: string | null
  type: string                   // always 'command' for now
  command: string
  source: 'user' | 'project'
  projectId?: string             // required when source === 'project'
}

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

// ---------------------------------------------------------------------------
// Per-workspace Claude settings overrides
// ---------------------------------------------------------------------------

export type ClaudeWorkspaceSettingsOverrides = {
  model?: string
  permissionMode?: ClaudePermissionMode
  effort?: ClaudeEffort
}

export type ClaudeWorkspaceSettings = {
  workspaceId: string
  overrides: ClaudeWorkspaceSettingsOverrides
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Claude Authentication (v13)
// ---------------------------------------------------------------------------

export type ClaudeCloudProvider = 'anthropic' | 'bedrock' | 'vertex' | 'foundry'

// Public API shape — what the renderer sees
export type ClaudeAuthState = {
  cloudProvider: ClaudeCloudProvider
  hasApiKey: boolean    // true if non-empty stored — renderer shows "•••" instead of the value
  hasAuthToken: boolean
  baseUrl: string       // not masked — base URL isn't secret
  awsRegion: string
  vertexProjectId: string
  vertexRegion: string
  // Foundry-specific (v22)
  hasFoundryApiKey: boolean
  foundryResource: string
  foundryBaseUrl: string
  // Bedrock bearer token (v22)
  hasBedrockBearerToken: boolean
}

// Patch shape — partial update; only the fields the user actually changed
export type ClaudeAuthPatch = {
  cloudProvider?: ClaudeCloudProvider
  apiKey?: string    // empty string clears
  baseUrl?: string
  authToken?: string
  awsRegion?: string
  vertexProjectId?: string
  vertexRegion?: string
  // Foundry-specific (v22)
  foundryApiKey?: string   // empty string clears
  foundryResource?: string
  foundryBaseUrl?: string
  // Bedrock bearer token (v22)
  bedrockBearerToken?: string  // empty string clears
}

// Test-connection result — returned by the Auth section's "Test connection" button
export type ClaudeAuthTestResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: string; status?: number }

export type WorkspaceStatus = 'in_progress' | 'in_review' | 'completed' | 'archived'

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
