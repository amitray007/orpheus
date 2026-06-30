// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

export type UpdateCheckResult = {
  current: string
  latest: string | null
  available: boolean
  checkedAt: number
  error?: string
}

export type UpdatePhase = 'refresh' | 'download' | 'verify' | 'install'

export interface UpdateProgress {
  phase: UpdatePhase
  percent: number | null
  line: string
}

export interface UpdateSnapshot {
  kind: 'idle' | 'checking' | 'up_to_date' | 'available' | 'installing' | 'installed' | 'error'
  latest: string | null
  lastChecked: number | null
  phase: UpdatePhase | null
  percent: number | null
  log: string[]
  reason: string | null
}

// ---------------------------------------------------------------------------
// Shell app detection (re-exported from main for use in renderer via IPC)
// ---------------------------------------------------------------------------

export type DetectedApp = {
  /** App bundle name (e.g. "Cursor", "Visual Studio Code") — used in CLI invocations. */
  name: string
  /** Optional display label (defaults to name). */
  label?: string
  /** Filesystem path of the .app bundle (for existence checks). */
  appPath: string
}

export type GitStatus = {
  insertions: number
  deletions: number
  hasChanges: boolean
  branch: string | null
  /** Count of untracked (new) files */
  newFiles: number
  /** Count of tracked files with modifications (working tree vs HEAD) */
  modifiedFiles: number
  /** Count of deleted files (working tree vs HEAD) */
  deletedFiles: number
}

export type GitBranchInfo = {
  name: string
  isCurrent: boolean
  lastCommitAt: number | null
}

export type GitCommit = {
  sha: string
  fullSha: string
  subject: string
  author: string
  authorEmail: string
  timestamp: number
  // Diff stats from `git log --shortstat`. Default to 0 when the commit has no
  // tree change (e.g. merges or empty commits where shortstat is silent).
  filesChanged: number
  insertions: number
  deletions: number
}

export type DoctorResult = {
  claudeInstalled: boolean
  claudeVersion: string | null // e.g. "1.2.3" extracted from `claude --version`
  claudePath: string | null // e.g. "/usr/local/bin/claude"
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
  pinnedAt: number | null
  // v37 — GitHub avatar data; null until first check or when remote isn't GitHub
  githubOwner: string | null
  githubRepo: string | null
  githubAvatarUrl: string | null
  githubCheckedAt: number | null
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
  closedAt: number | null
  sortOrder: number | null
  status: WorkspaceStatus
  claudeSessionId: string | null
  /** Set when this workspace was forked from another session (v43). */
  forkedFromSessionId: string | null
  /** Last terminal title seen before the workspace was closed (v58). */
  lastTitle: string | null
  /** Repo root this worktree branches from; null for a plain workspace (v64). */
  worktreeParentCwd: string | null
  /** Branch checked out in this worktree; null for a plain workspace (v64). */
  worktreeBranch: string | null
}

/** Params for creating a worktree-backed workspace (v64). When `branch` is
 *  omitted/blank, the handler defaults it to `worktree-<slug-of-name>`. */
export type CreateWorktreeParams = { name: string; branch?: string }

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

export type AppViewKind = 'sessions' | 'project' | 'workspace'

export type Theme = 'midnight' | 'daylight' | 'eclipse'
export type AccentColor = 'gold' | 'blue' | 'teal' | 'orange' | 'pink'
export type UiFontScale = 'small' | 'default' | 'large'
export type SoundPack =
  | 'core'
  | 'minimal'
  | 'mechanical'
  | 'retro'
  | 'playful'
  | 'crisp'
  | 'organic'
  | 'soft'

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
  // Archive cap (v25)
  archivedWorkspaceLimit: number
  // Hooks integration (v60) — default false; opt-in to socket server + ~/.claude/settings.json hooks
  hooksIntegrationEnabled: boolean
  // Notification preferences (v29)
  notifyAttention: boolean
  notifyStop: boolean
  notifyAlways: boolean
  // Notification enrichment (v59)
  notifyRichSummary: boolean
  notifySuppressWhenFocused: boolean
  // Persistent attention reminders (v30) — 0 disables; cap is hardcoded backoff length.
  notifyMaxAttentionRepeats: number
  // In-progress watchdog (v31) — seconds without a heartbeat hook before auto-demoting from in_progress. 0 disables.
  inProgressWatchdogSec: number
  // (v54) Minutes of no agent activity before the sidebar marks a workspace stale.
  staleAfterMinutes: number
  // (v57) Minutes of idle before auto-closing the workspace. 0 disables.
  autoCloseAfterMinutes: number
  // (v56) Diagnostics capture toggles. Errors on by default; rest opt-in.
  diagError: boolean
  diagLifecycle: boolean
  diagPerf: boolean
  diagAnomaly: boolean
  // (v61) Cross-process span/trace capture. Opt-in; off by default.
  diagTrace: boolean
  // App picker preferences (v32) — null = auto-detect first found
  preferredEditorApp?: string | null
  preferredTerminalApp?: string | null
  // Auto-prune cap (v33) — null = unlimited; positive integer = max non-archived sessions per project
  maxLocalSessions?: number | null
  // Appearance (v36)
  theme: Theme
  accentColor: AccentColor | null // null = use theme's built-in default accent
  uiFontScale: UiFontScale
  // Privacy (v37)
  fetchGithubAvatars: boolean
  // Sound (v38)
  playInteractionSounds: boolean
  // Sound pack (v39)
  soundPack: SoundPack
  // Updates (v40)
  autoCheckUpdates: boolean
  // Status polling preferences (v42)
  statusPollIntervalSec: number // 300 | 600 | 900 | 1800 | 3600 | 7200 | 10800; default 1800
  muteStatusNotifications: boolean
  // Workspace footer visibility (v45)
  showWorkspaceFooter: boolean
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

// Keep Awake (power management) — see docs/superpowers/specs/2026-06-26-keep-awake-design.md
export type KeepAwakeBaseMode = 'off' | 'auto' | 'on'
export type KeepAwakeMode = KeepAwakeBaseMode | 'timer'

export type KeepAwakeState = {
  /** Effective current mode — 'timer' while a countdown is active, else the base mode. */
  mode: KeepAwakeMode
  /** Persisted base mode the control reverts to when a timer expires/restarts. */
  baseMode: KeepAwakeBaseMode
  /** false → prevent-app-suspension (screen may sleep); true → prevent-display-sleep. */
  keepDisplayOn: boolean
  /** Whether a powerSaveBlocker is currently held. */
  isHolding: boolean
  /** Milliseconds remaining on the active timer, or null when no timer is running. */
  timerRemainingMs: number | null
  /** Default duration (minutes) used when starting a 'For a while' timer. */
  defaultTimerMinutes: number
  /** Number of workspaces currently in_progress (drives the Auto status line). */
  busyCount: number
}

// Shared model picker options — keep this list in one place so the General
// settings, ProjectView overrides, and WorkspaceDrawer all agree.
//
// Two groups:
//   1. Explicit versioned IDs — unambiguous pricing + context lookup
//   2. Always-latest aliases — claude resolves the exact version at launch
//
// The `family` field is used by the title-bar chip for color-coding and by
// `getPricing` family-alias resolution.
export const CLAUDE_MODEL_OPTIONS = [
  // Explicit versions — unambiguous pricing + context lookup
  { value: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus' },
  { value: 'claude-opus-4-5', label: 'Opus 4.5', family: 'opus' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet' },
  { value: 'claude-sonnet-4-5', label: 'Sonnet 4.5', family: 'sonnet' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku' },
  // Always-latest aliases — claude resolves at launch
  { value: 'opus', label: 'Opus (latest)', family: 'opus' },
  { value: 'sonnet', label: 'Sonnet (latest)', family: 'sonnet' },
  { value: 'haiku', label: 'Haiku (latest)', family: 'haiku' }
] as const

export type ClaudeModelOption = (typeof CLAUDE_MODEL_OPTIONS)[number]['value']

// Index into CLAUDE_MODEL_OPTIONS where the "always-latest" aliases begin.
// Options before this index are explicit versioned IDs; from this index onward
// they are family aliases that claude resolves to the latest release at launch.
// Derived from the array shape so adding/removing versioned entries doesn't
// silently break the picker grouping — aliases are entries where value === family.
export const CLAUDE_MODEL_ALIAS_START_INDEX = CLAUDE_MODEL_OPTIONS.findIndex(
  (o) => o.value === o.family
)

// ---------------------------------------------------------------------------
// Ghostty user config (v53)
// ---------------------------------------------------------------------------

export type GhosttyKeybind = { trigger: string; action: string }

export type GhosttyUserConfig = {
  // Flat key→value map using ghostty config keys; only NON-default keys stored.
  // Values are raw ghostty config values (unquoted). Booleans as true/false.
  settings: Record<string, string | number | boolean>
  keybinds: GhosttyKeybind[]
}

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

  // Env-var controls (v24) — Display / Rendering
  noFlicker: boolean
  disableAlternateScreen: boolean
  disableVirtualScroll: boolean
  disableMouse: boolean
  disableTerminalTitle: boolean
  scrollSpeed: number | null
  codeAccessibility: boolean
  omitAttributionHeader: boolean
  forceSyncOutput: boolean
  enablePromptSuggestion: boolean

  // Env-var controls (v24) — General / Model capabilities
  disable1mContext: boolean
  disableAdaptiveThinking: boolean
  disableLegacyModelRemap: boolean

  // Env-var controls (v24) — Memory & Context
  autoCompactWindow: number | null
  autocompactPctOverride: number | null

  // Env-var controls (v24) — Tools / File operations & Shell
  disableFileCheckpointing: boolean
  disableAttachments: boolean
  shellOverride: string
  shellPrefix: string

  // Env-var controls (v24) — Developer / Network
  enableFineGrainedToolStreaming: boolean
  disableNonstreamingFallback: boolean
  proxyResolvesHosts: boolean
  enableGatewayModelDiscovery: boolean

  // Env-var controls (v24) — Developer / Privacy & background tasks
  autoBackgroundTasks: boolean
  asyncAgentStallTimeoutMs: number | null
  enableTasks: boolean
  disableCron: boolean
  exitAfterStopDelay: number | null
  disableFeedbackCommand: boolean
  disableFeedbackSurvey: boolean

  // Env-var controls (v52) — General / Model behavior
  disableBundledSkills: boolean
  disableWorkflows: boolean

  // Env-var controls (v52) — General
  enableAwaySummary: boolean

  // Env-var controls (v52) — Tools
  disableArtifact: boolean
  disableAdvisorTool: boolean

  // Env-var controls (v52) — Display
  screenReader: boolean

  // Env-var controls (v52) — Memory & Context
  additionalDirsClaudeMd: boolean

  updatedAt: number
}

export type ClaudeGlobalSettingsPatch = Partial<Omit<ClaudeGlobalSettings, 'updatedAt'>>

// ---------------------------------------------------------------------------
// Discovered MCP servers (v14)
// ---------------------------------------------------------------------------

export type DiscoveredMcpServer = {
  name: string // server key from mcpServers map
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  command?: string // for stdio servers
  args?: string[] // for stdio servers
  env?: Record<string, string> // for stdio servers
  url?: string // for http/sse servers
  source: 'user' | 'project' // user = ~/.claude.json, project = <projectPath>/.mcp.json
  projectId?: string // set when source === 'project'
  projectName?: string // set when source === 'project'
  filePath: string // absolute path to the file this came from (for edit/delete)
}

export type McpServerDraft = {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string // stdio only
  args?: string[] // stdio only
  url?: string // http/sse only
  env?: Record<string, string> // stdio only
  source: 'user' | 'project'
  projectId?: string // required when source === 'project'
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
  event: string // e.g. 'PreToolUse', 'Stop'
  matcher: string | null // e.g. 'Bash' for PreToolUse, null when omitted
  type: string // typically 'command'
  command: string // shell command to run
  source: 'user' | 'project'
  projectId?: string
  projectName?: string
  filePath: string // absolute path of the settings.json this came from
  // Addressing fields for edit/delete
  matcherEntryIdx: number // index in hooks[event] array
  hookIdx: number // index in hooks[event][matcherEntryIdx].hooks array
}

export type ClaudeHookDraft = {
  event: string
  matcher: string | null
  type: string // always 'command' for now
  command: string
  source: 'user' | 'project'
  projectId?: string // required when source === 'project'
}

export type ClaudeSlashCommandDraft = {
  name: string
  description: string
  allowedTools: string[] | null
  argumentHint: string
  body: string
  source: 'user' | 'project'
  projectId?: string
}

export type ClaudeSubagentDraft = {
  name: string
  description: string
  tools: string[] | null
  model: string
  body: string
  source: 'user' | 'project'
  projectId?: string
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
  hasApiKey: boolean // true if non-empty stored — renderer shows "•••" instead of the value
  hasAuthToken: boolean
  baseUrl: string // not masked — base URL isn't secret
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
  apiKey?: string // empty string clears
  baseUrl?: string
  authToken?: string
  awsRegion?: string
  vertexProjectId?: string
  vertexRegion?: string
  // Foundry-specific (v22)
  foundryApiKey?: string // empty string clears
  foundryResource?: string
  foundryBaseUrl?: string
  // Bedrock bearer token (v22)
  bedrockBearerToken?: string // empty string clears
}

// Test-connection result — returned by the Auth section's "Test connection" button
export type ClaudeAuthTestResult =
  | { ok: true; durationMs: number }
  | { ok: false; reason: string; status?: number }

// ---------------------------------------------------------------------------
// Native context menu (v25)
// ---------------------------------------------------------------------------

export type ContextMenuNativeItem =
  | {
      label: string
      action: string // identifier the renderer maps to a callback
      enabled?: boolean
      destructive?: boolean
    }
  | { divider: true }

export type WorkspaceStatus = 'in_progress' | 'awaiting_input' | 'attention' | 'idle' | 'archived'

export type WorkspaceActivityDetail = 'working' | 'attention' | 'ready' | 'idle' | 'archived'

// GitHub PR state mapped from `gh pr list` plus the draft flag — drafts come
// back as OPEN with isDraft=true; we hoist draft into its own state so chip
// color reflects GitHub's own header (open=green, draft=gray, merged=purple,
// closed=red).
export type GhPullRequestState = 'open' | 'draft' | 'merged' | 'closed'

export type GhPullRequest = {
  number: number
  state: GhPullRequestState
  title: string
  url: string
  author: string | null
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null
  checks: 'success' | 'failure' | 'pending' | null
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
  // Populated by refreshSessionMetadata (v33)
  messageCount?: number | null
  jsonlSizeBytes?: number | null
  // Populated by refreshSessionMetadata (v34)
  lastMessagePreview?: string | null
  // Populated by refreshSessionMetadata (v35)
  lastUserMessagePreview?: string | null
  // Populated by refreshSessionMetadata (v50)
  jsonlMtime?: number | null
}

export type SessionsPagedRequest = {
  projectId: string
  search?: string // substring match against title (case-insensitive)
  dateFrom?: number // updated_at >= this (epoch ms)
  dateTo?: number // updated_at <= this (epoch ms)
  sortBy?: 'updatedAt' | 'createdAt' | 'title'
  sortDir?: 'asc' | 'desc'
  offset?: number
  limit?: number // default 25
}

export type SessionsPagedResult = {
  rows: SessionRecord[]
  total: number // total matching rows before pagination
}

// ---------------------------------------------------------------------------
// Claude status (status.claude.com polling)
// ---------------------------------------------------------------------------

export type ClaudeStatusIndicator = 'none' | 'minor' | 'major' | 'critical' | 'maintenance'

export type ClaudeStatusComponentStatus =
  | 'operational'
  | 'degraded_performance'
  | 'partial_outage'
  | 'major_outage'
  | 'under_maintenance'

export type ClaudeStatusComponent = {
  id: string
  name: string
  status: ClaudeStatusComponentStatus
  updatedAt: string // ISO timestamp
  /** True for the two components that drive the top-bar chip color */
  watched: boolean
}

export type ClaudeStatusIncident = {
  id: string
  name: string
  impact: 'none' | 'minor' | 'major' | 'critical'
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved'
  updatedAt: string // ISO timestamp
}

export type ClaudeStatusSnapshot = {
  /** Overall page indicator */
  indicator: ClaudeStatusIndicator
  /** Human-readable summary, e.g. "All Systems Operational" */
  description: string
  /** Worst indicator of the two watched components (drives chip color) */
  watchedIndicator: ClaudeStatusIndicator
  components: ClaudeStatusComponent[]
  incidents: ClaudeStatusIncident[]
  /** ms epoch when this snapshot was fetched */
  fetchedAt: number | null
  /** False when the last fetch attempt failed; snapshot is stale */
  fetchOk: boolean
  /** True while a fetch is in flight */
  isFetching: boolean
}

// ---------------------------------------------------------------------------
// Quick Actions — phase 1: terminal interaction primitives
// ---------------------------------------------------------------------------

export type ActionResultOk<T = unknown> = { ok: true; value?: T }
export type ActionErrorCode = 'busy' | 'not_found' | 'invalid' | 'failed'
export type ActionResultErr = { ok: false; error: string; code: ActionErrorCode }
export type ActionResult<T = unknown> = ActionResultOk<T> | ActionResultErr

export type TerminalSendKeyDescriptor = {
  keycode: number
  mods?: number
  action?: 'press' | 'release' | 'repeat'
}

// ---------------------------------------------------------------------------
// Quick Actions — phase 2: registry types + session + workspace data types
// ---------------------------------------------------------------------------

export type ActionKind = 'mutator' | 'query' | 'subscription'

export type ActionInvocation = {
  id: string
  params: Record<string, unknown>
  workspaceId: string
}

export type ActionAuditEntry = {
  id: number
  workspaceId: string
  actionId: string
  /** SECRET_KEYS-redacted JSON of the params */
  paramsJson: string
  /** 'ok' | ActionErrorCode */
  resultCode: string
  consumerHint: string
  createdAt: number
}

export type SessionMeta = {
  sessionId: string
  model: string
  startedAt: number
  lastMessageAt: number | null
  turnCount: number
}

export type SessionUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Point-in-time context-window occupancy from the most recent assistant turn only.
   *  = input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens for that turn.
   *  Used for the context chip in the footer. Do NOT use for cost (cost uses cumulative fields). */
  lastTurnContextTokens: number
  /** Effective maxContextTokens from global settings (or default 200k) */
  contextBudget: number
  /** lastTurnContextTokens / contextBudget * 100, capped at 100 */
  usedPct: number
}

export type SessionCost = {
  usd: number
  byModel: Record<string, number>
}

export type SessionLastTurn = {
  userText: string | null
  assistantText: string | null
  userAt: number | null
  assistantAt: number | null
}

export type WorkspaceForkParams = {
  worktree?: boolean
  name?: string
}

// ---------------------------------------------------------------------------
// Footer actions — phase 3a storage types
// ---------------------------------------------------------------------------

export type FooterActionScope = 'global' | 'project' | 'workspace'
export type FooterActionVisibility = 'always' | 'idle' | 'awaitingInput'

/**
 * A single user-facing prompt that an action needs before it can execute.
 * Used by workspace.rename to ask for the new name inline in the footer.
 */
export type PromptDescriptor = {
  /** The param key the value fills (e.g. 'name'). */
  key: string
  /** User-visible label shown above the input (e.g. 'New name'). */
  label: string
  /** Placeholder text inside the input. */
  placeholder?: string
  /**
   * Pre-fill value — supports {workspaceName}, {sessionId}, {workspaceId},
   * {cwd} placeholder tokens that are expanded at display time.
   */
  default?: string
}

export type FooterActionDescriptor = {
  id: string
  scope: FooterActionScope
  scopeId: string | null // null for global; projectId or workspaceId otherwise
  label: string
  icon: string | null // Phosphor PascalCase icon name (e.g. 'GitFork', 'Clipboard'), optional
  actionId: string // 'terminal.sendInput' | 'workspace.fork' | 'session.getUsage' | etc.
  params: Record<string, unknown> // {} or { text: '/copy', submit: true } etc.
  visibleWhen: FooterActionVisibility
  position: number
  createdAt: number
  updatedAt: number
  /** Prompts to show before invoking (e.g. ask for new workspace name). */
  prompts?: PromptDescriptor[]
}

export type FooterActionDraft = Omit<
  FooterActionDescriptor,
  'id' | 'createdAt' | 'updatedAt' | 'scope' | 'scopeId' | 'position'
> & {
  /** When omitted on create, the backend assigns max(position)+1 for the scope. */
  position?: number
}

export type DiagCategory = 'error' | 'lifecycle' | 'perf' | 'anomaly' | 'trace'
export type DiagLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type DiagProcess = 'main' | 'renderer' | 'native'

// One diagnostic event. `event` should be a value from DIAG_EVENTS for curated
// point-events, OR a free-form dotted span/trace name (category 'trace').
export type DiagEvent = {
  ts: number
  process: DiagProcess
  category: DiagCategory
  level: DiagLevel
  event: string
  workspaceId?: string | null
  sessionId?: string | null
  durationMs?: number | null
  message?: string
  data?: Record<string, unknown> | null
  // Trace correlation (category 'trace'); null/undefined for plain events.
  traceId?: string | null
  spanId?: string | null
  parentSpanId?: string | null
  name?: string | null
  kind?: 'span' | 'event' | 'mark' | null
}

// Stored row shape returned by queries (adds id + seq).
export type DiagRow = DiagEvent & { id: number; seq: number }

export type DiagQuery = {
  sinceMs?: number
  untilMs?: number
  categories?: DiagCategory[]
  levels?: DiagLevel[]
  event?: string
  workspaceId?: string
  traceId?: string
  limit?: number
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthProbe = { status: 'ok' | 'warn' | 'error'; detail: string }

export type HealthReport = {
  claudeCli: HealthProbe
  sessionRegistry: HealthProbe
  notifications: HealthProbe
  hooks: HealthProbe & { enabled: boolean; installed: number }
  dataDir: HealthProbe
}
