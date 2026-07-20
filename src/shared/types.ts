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
  /** Parent workspace ID for lineage tracking; null for root workspaces (v64). */
  parentWorkspaceId: string | null
  /** Repo root this worktree branches from; null for a plain workspace (v64). */
  worktreeParentCwd: string | null
  /** Branch checked out in this worktree; null for a plain workspace (v64). */
  worktreeBranch: string | null
}

/** Params for creating a worktree-backed workspace (v64). When `branch` is
 *  omitted/blank, the handler defaults it to `worktree-<slug-of-name>`. */
export type CreateWorktreeParams = { name: string; branch?: string }

/**
 * DIPs rect used to mount/resize a workspace's libghostty surface. Mirrors
 * `SurfaceRect` in `packages/ghostty-surface/index.ts` (kept structurally
 * identical there so that package stays free of `src/` imports) and the
 * local `TerminalRect` aliases previously duplicated in
 * `src/preload/index.ts` / `index.d.ts`.
 */
export type TerminalRect = { x: number; y: number; w: number; h: number }

/**
 * Return type of `terminal:mount`.
 *
 * Success: `{ workspaceId, created, notice? }` — surface is mounted; if a
 * worktree was recreated with a new branch the optional `notice` carries a
 * one-time human-readable message the renderer should surface.
 *
 * Aborted: `{ workspaceId, aborted: 'gone' }` — the workspace was archived
 * or removed while the mount was in flight (e.g. mid worktree-reconcile or
 * shell-path resolution). The surface was never touched; the renderer
 * should treat this as a no-op, not an error.
 *
 * Failure: `{ workspaceId, worktreeError }` — reconcile determined the mount
 * cannot proceed (bad state that needs user intervention). The surface is NOT
 * mounted; the renderer should show an error card instead.
 */
export type TerminalMountResult =
  | { workspaceId: string; created: boolean; notice?: string }
  | { workspaceId: string; aborted: 'gone' }
  | {
      workspaceId: string
      worktreeError: {
        kind: 'checkedOutElsewhere' | 'corruptDir' | 'parentGone'
        message: string
        conflictPath?: string
      }
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

export type AppViewKind = 'dashboard' | 'sessions' | 'project' | 'workspace' | 'panes'

// Projects-surface-scoped view kind — narrower than AppViewKind because the
// Projects surface can never be 'dashboard' or 'panes' (see
// projectsLastViewKind on AppUiState below).
export type ProjectsLastViewKind = 'sessions' | 'project' | 'workspace'

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
  // Panes v2 active-panel/active-layout persistence (issue #1) — mirrors
  // lastProjectId/lastWorkspaceId exactly. Covered by AppUiStatePatch
  // (Partial<Omit<AppUiState, 'updatedAt'>>) automatically.
  lastPanelId: string | null
  lastLayoutId: string | null
  // Projects-surface-scoped location memory — written ONLY by Projects
  // navigation handlers (handleSelectWorkspace/handleSelectProject/
  // restoreLastProjectsLocation in Dashboard.tsx). Switching to Home/Panes/
  // Settings nulls the shared lastViewKind/lastProjectId/lastWorkspaceId
  // fields above (see handleSelectSurface's dashboard/panes branches and
  // handleSelectSettings/handleOpenUpdates), so Projects needs its own
  // memory that survives those surface switches — otherwise navigating away
  // and back to Projects incorrectly showed the empty state instead of
  // restoring the last workspace/project. Covered by AppUiStatePatch
  // (Partial<Omit<AppUiState, 'updatedAt'>>) automatically.
  projectsLastViewKind: ProjectsLastViewKind
  projectsLastProjectId: string | null
  projectsLastWorkspaceId: string | null
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
  // Projects surface — optional Workspaces board (kanban) visibility (U3).
  // Default false; mirrors defaultProjectExpanded exactly.
  showWorkspacesBoard: boolean
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
  // Dashboard "Usage" card background poll interval (Dashboard D3)
  usagePollIntervalSec: number // 300 | 600 | 900 | 1800 | 3600; default 600
  // Workspace footer visibility (v45)
  showWorkspaceFooter: boolean
  // Files-tab editor save mode (v62) — false = manual (Cmd/Ctrl+S only);
  // true = debounced auto-save on idle. Default false (manual).
  filesAutoSave: boolean
  // Files-tab tree VIEW preferences (v67) — app-wide, not per-workspace: these
  // are the ⚙ TreeOptionsPopover toggles, moved here (from the in-memory
  // filesTabStore) so they survive an app restart. `selectedFile`/`mode`/
  // `treeOpen`/`expandedPaths` remain per-workspace SESSION state in
  // filesTabStore — only the view-preference knobs live here.
  /** Reveal denylisted (noisy machine dir/file) rows. Default false (off). */
  filesShowHidden: boolean
  /** Dim gitignored rows to ~62% opacity. Default true (on). */
  filesDimGitignored: boolean
  /** Word-wrap long lines in both the viewer and the editor. Default true (on). */
  filesWrapLines: boolean
  /** Tree row ordering: Pierre's built-in dirs-first/alpha vs pure alphabetical. Default 'default'. */
  filesSortOrder: 'default' | 'name'
  /** Collapse single-child directory chains into one flattened row. Default true (on) — see Fix 3. */
  filesFlattenEmptyDirs: boolean
  // Workbench Git-tab diff VIEW preferences (v68) — app-wide, mirrors the
  // files_* pattern above: the Git tab's ⚙ options popover's "Wrap lines"
  // toggle, persisted so it survives an app restart.
  /** Word-wrap long lines in the diff viewer (PatchDiff's `overflow: 'wrap'`). Default true (on). */
  gitDiffWrapLines: boolean
  // Token-hover popover (Pierre Batch 3) — hovering a syntax token shows a
  // floating card with token text + line:col + copy. Fires in BOTH the Files
  // tab's editor/viewer (FilesTab.tsx) and the Git tab's diff (GitTab.tsx).
  // Intrusive while just reading, so it's opt-in. Default false (off).
  tokenHoverEnabled: boolean
  // Per-hunk "Revert" on the working-tree diff (Pierre content-transform
  // adoption) — a hunk-hover affordance in the Git tab's diff pane that
  // reverts ONE hunk back to its HEAD content by writing the resolved file
  // text via files:writeFile (see docs/learnings/hunk-accept-reject.md).
  // Mutates the working tree directly, so opt-in like tokenHoverEnabled
  // above. Default false (off).
  hunkActionsEnabled: boolean
  // Panes v2 top-level view visibility toggles — control whether the
  // Sidebar's "Panes" and "Workspaces" top-level NavItems render at all
  // (Settings > Navigation). Panes defaults visible (true); Workspaces
  // defaults hidden (false) since Panes is the new primary surface.
  // DEPRECATED — superseded by defaultSurface below; no longer read by the
  // sidebar. Kept (dead but harmless) for backward-compat DB reads.
  showPanesView: boolean
  showWorkspacesView: boolean
  // Open-at-launch surface (rail vocabulary) — which top-level surface the
  // app lands on at startup (Settings > Navigation). Replaces the
  // deprecated showPanesView/showWorkspacesView toggles above. Independent
  // from AppViewKind/lastViewKind — do not conflate the two enums.
  defaultSurface: 'dashboard' | 'projects' | 'panes'
  // Workbench changed-files/file TREE pane width (v69) — SHARED between the
  // Files tab and the Git tab's changed-files tree (both used a fixed `w-60`
  // before this; now a draggable divider persists one shared width so long
  // filenames don't truncate). Clamped 160–560px, default 240 (mirrors the
  // sidebarWidth clamp-at-read pattern in src/main/uiState.ts).
  workbenchTreeWidth: number
  // GitHub username greeting (D4) — the user's display name (or login
  // fallback), refreshed on each app open via `gh api user`. Null when gh
  // is missing/unauth or has never been resolved.
  githubUsername: string | null
  // Managed routing proxy (v70) — opt-in, off by default. Mirrors
  // hooksIntegrationEnabled exactly: a declarative reconcile (see
  // src/main/index.ts) starts/stops the managed CLIProxyAPI child process
  // when this flips. See src/main/routingProxy/.
  routingProxyEnabled: boolean
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
// The `family` field here is display metadata only (picker grouping) — it
// does NOT drive title-bar colour-coding (no such feature exists) and is
// NOT used for pricing resolution. Model facts (label, family, pricing,
// context) are owned exclusively by src/main/models/registry.ts, which
// resolves by exact id / date-stamped-id-prefix only — never by matching
// this array's `family` string against arbitrary ids (see that module's
// header comment for why family-substring matching was a landmine).
export const CLAUDE_MODEL_OPTIONS = [
  // Explicit versions — unambiguous pricing + context lookup
  { value: 'claude-opus-4-8', label: 'Opus 4.8', family: 'opus' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7', family: 'opus' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', family: 'sonnet' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', family: 'sonnet' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku' },
  { value: 'claude-fable-5', label: 'Fable 5', family: 'fable' },
  // Always-latest aliases — claude resolves at launch
  { value: 'opus', label: 'Opus (latest)', family: 'opus' },
  { value: 'sonnet', label: 'Sonnet (latest)', family: 'sonnet' },
  { value: 'haiku', label: 'Haiku (latest)', family: 'haiku' },
  { value: 'fable', label: 'Fable (latest)', family: 'fable' }
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

  // Custom CLI flags (global scope) — free-text passthrough flags, appended
  // after Orpheus's own typed flags at launch. See src/shared/cliFlags.ts.
  customCliFlags: string[]

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

  // Guardrail settings (v64) — spawn caps for workspace lineage
  maxWorkspaceDepth: number
  maxWorkspaceChildren: number

  // Env-var controls (v66) — Tools
  toolCallTimeoutMs: number | null
  maxToolOutputLength: number | null

  // Env-var controls (v66) — Display / Rendering
  disableMouseClicks: boolean

  // Env-var controls (v66) — Tools / File operations
  rewindOnErrorEnabled: boolean

  // Env-var controls (v66) — General / Model behavior
  lowPowerMode: boolean

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
  // Custom CLI flags (project scope) — merged with global scope via
  // mergeFlagScopes at launch (append; project wins on same-name conflict).
  customCliFlags?: string[]
  // Custom env vars (project scope) — merged with global scope as a plain
  // Record spread, last-wins (unlike flags, no append/override algebra).
  customEnvVars?: Record<string, string>
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
  // Custom CLI flags (workspace scope) — merged with global + project scope
  // via mergeFlagScopes at launch (append; workspace wins on same-name
  // conflict, highest precedence of the three).
  customCliFlags?: string[]
  // Custom env vars (workspace scope) — merged with global + project scope
  // as a plain Record spread, last-wins (unlike flags, no append/override
  // algebra); workspace wins on same-key conflict, highest precedence.
  customEnvVars?: Record<string, string>
}

export type ClaudeWorkspaceSettings = {
  workspaceId: string
  overrides: ClaudeWorkspaceSettingsOverrides
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Claude Authentication (v13)
// ---------------------------------------------------------------------------

// 'routed' sends traffic to Orpheus's local translating proxy instead of a
// cloud provider. It is structurally mutually exclusive with
// bedrock/vertex/foundry: each of those emits a CLAUDE_CODE_USE_* env var
// that makes the Claude CLI take a different code path and ignore
// ANTHROPIC_BASE_URL entirely, so a workspace can never be routed AND on a
// cloud provider at once. See src/main/orpheusSurfaceAdapter.ts buildMountEnv.
export type ClaudeCloudProvider = 'anthropic' | 'bedrock' | 'vertex' | 'foundry' | 'routed'

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
// Claude usage/limits (Dashboard "Usage" card) — models the fields we
// actually RENDER from the undocumented `GET
// https://api.anthropic.com/api/oauth/usage` response. The real payload has
// more fields (spend, extra_usage details, etc.) than we surface; only what
// the card needs is typed here. snake_case -> camelCase mapping happens in
// src/main/claudeUsage.ts's parse step, never in the renderer. See that
// file's header comment for the full fetch/cache/degrade contract.
// ---------------------------------------------------------------------------

/** One rolling usage window (five_hour "Session" or seven_day "Weekly"). */
export type ClaudeUsageWindow = {
  utilization: number | null // 0-100
  resetsAt: string | null // ISO timestamp
}

/** One entry from the `limits[]` array — session/weekly totals plus any
 *  model-scoped sub-limits (e.g. a weekly cap specific to one model). */
export type ClaudeUsageLimit = {
  kind: string
  group: string
  percent: number
  severity: string // 'normal' | 'warning' | 'critical' | ... (undocumented, tolerate any string)
  resetsAt: string | null
  modelName: string | null // scope?.model?.display_name, null when not model-scoped
  isActive: boolean
}

export type ClaudeUsage = {
  fiveHour: ClaudeUsageWindow // "Session · 5h"
  sevenDay: ClaudeUsageWindow // "Weekly · 7d"
  limits: ClaudeUsageLimit[]
  extraUsageEnabled: boolean
}

/** Degraded states the main process returns instead of throwing — see
 *  claudeUsage.ts's getClaudeUsage doc comment for when each fires. */
export type ClaudeUsageUnavailable = { unavailable: 'no-auth' | 'error' }

export type ClaudeUsageResult = ClaudeUsage | ClaudeUsageUnavailable

// ---------------------------------------------------------------------------
// src/main/claudeActivity.ts — real Claude activity, scanned directly off
// the on-disk transcript store (~/.claude/projects/**/*.jsonl), NOT the
// Orpheus-registered `sessions` table (sessions:listAll only covers
// workspaces created through Orpheus — ~40x undercounts total Claude usage).
// One .jsonl file = one real Claude session; its mtime is the session's
// "activity day", its line count is its message count. See claudeActivity.ts
// for the full scan/cache contract.
// ---------------------------------------------------------------------------

/** Trailing 7 calendar days (Mon..Sun), used by the dashboard's Activity
 *  card small-multiples chart. Shape/ordering matches the renderer's
 *  original pulseData.helpers.WeeklyActivityDay (weekday 0=Mon..6=Sun) —
 *  moved here so both the scanner and the renderer share one definition. */
export type WeeklyActivityDay = {
  weekday: number // 0=Mon..6=Sun
  sessions: number
  messages: number
}

export type ClaudeActivitySummary = {
  weeklyActivity: WeeklyActivityDay[]
  sessionsLast7Days: number
  messagesLast7Days: number
  allTimeSessions: number
  allTimeMessages: number
  /** Total tokens (input + output + cache read + cache creation, summed
   *  across every assistant-turn `message.usage` line) for sessions active
   *  in the last 7 days. */
  tokensLast7Days: number
  /** Same token sum as `tokensLast7Days`, across ALL history. */
  allTimeTokens: number
  /** Local hour-of-day (0-23) with the most session-file mtimes in the last
   *  7 days. Null when there's no data in that window to compute a peak
   *  from. */
  peakHour: number | null
  /** Consecutive-day streak of >=1 session, ending today or yesterday (same
   *  "alive until a full day is skipped" semantics as the renderer's
   *  original computeStreaks — see pulseData.helpers.ts). */
  currentStreak: number
  /** Distinct calendar days with >=1 session in the last 7 days. */
  activeDays: number
}

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

// ---------------------------------------------------------------------------
// Account-wide GitHub search (Dashboard Phase 2, U5) — `gh search prs`/
// `gh search issues` results, distinct from GhPullRequest above (which is
// scoped to ONE cwd's current branch via `gh pr list --head <branch>`).
// `gh search prs --json` does NOT expose `statusCheckRollup` (confirmed live
// via `gh search prs --help`'s available-fields list — only
// assignees/author/authorAssociation/body/closedAt/commentsCount/createdAt/
// id/isDraft/isLocked/isPullRequest/labels/number/repository/state/title/
// updatedAt/url), so `checks` here is resolved via a SEPARATE lazy
// `gh pr view <n> --repo <repo> --json statusCheckRollup` fetch per PR (see
// getMyOpenPrs in github.ts) — cheap in practice (real PR counts are small)
// and total: any per-PR failure degrades that one row's checks to null
// rather than failing the whole list.
// ---------------------------------------------------------------------------

export type GhSearchPr = {
  number: number
  title: string
  url: string
  repo: string // "owner/name", from repository.nameWithOwner
  state: GhPullRequestState
  checks: 'success' | 'failure' | 'pending' | null
  updatedAt: string // ISO
}

export type GhSearchIssue = {
  number: number
  title: string
  url: string
  repo: string // "owner/name"
  labels: GhLabel[]
  updatedAt: string // ISO
}

// ---------------------------------------------------------------------------
// GitHub PR detail (Workbench Git tab, Phase 3b) — richer `gh pr view` fetch
// feeding the Details/Commits/Checks tabs (3c/3d/3e) and the general-comments
// half of Phase 4. See docs/learnings/gh-pr-detail.md for the researched
// field mapping this type mirrors. `GhPullRequest` above stays the thin
// row/chip shape; this is fetched only when a user opens the PR detail panel.
// ---------------------------------------------------------------------------

export type GhLabel = {
  name: string
  color: string // hex, no leading '#'
  description: string | null
}

export type GhReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'

export type GhReview = {
  id: string
  author: string // login
  // Always null today: `gh pr view --json reviews` only exposes
  // `author.login`, not an avatar field (verified live against PR #117 —
  // GraphQL's fixed field list under `--json` has no avatarUrl passthrough
  // for the reviews array). Kept nullable so <Avatar> can fall back to
  // initials without a special case, and so a future GraphQL-based fetch can
  // populate it without a type change.
  avatarUrl: string | null
  state: GhReviewState
  submittedAt: string | null // ISO
  body: string
}

export type GhReviewRequest = {
  login: string // requested reviewer (user or team)
  isTeam: boolean
  // Same caveat as GhReview.avatarUrl — `gh pr view --json reviewRequests`
  // has no avatar field either; always null today.
  avatarUrl: string | null
}

export type GhCommit = {
  oid: string
  messageHeadline: string
  messageBody: string
  authoredDate: string
  committedDate: string
  authorLogin: string | null // authors[0]?.login
  authorName: string
  url: string // derived client-side: `${repoUrl}/commit/${oid}`
}

// Un-reduced per-check status, distinct from GhPullRequest['checks'] (which
// stays the existing 3-state aggregate for the row/chip). Normalizes both
// `statusCheckRollup` shapes (`CheckRun` and legacy `StatusContext`) into one.
export type GhCheckState = 'success' | 'failure' | 'pending' | 'neutral'

export type GhCheck = {
  name: string
  workflowName: string | null
  state: GhCheckState
  url: string | null
  startedAt: string | null
  completedAt: string | null
}

export type GhGeneralComment = {
  id: string
  author: string
  // Same caveat as GhReview.avatarUrl above — `gh pr view --json comments`
  // exposes only `author.login`, no avatar field; always null today.
  avatarUrl: string | null
  authorAssociation: string
  body: string
  createdAt: string
  url: string
  isMinimized: boolean
}

export type GhMilestone = {
  title: string
  url: string
  dueOn: string | null
}

// ---------------------------------------------------------------------------
// GitHub PR review comments (Workbench Git tab, Phase 4a) — line-anchored
// review comments, threaded, feeding inline annotations on the PR diff. A
// SEPARATE `gh api repos/{owner}/{repo}/pulls/{n}/comments --paginate` call
// from `prDetail` above (not folded in) — see docs/learnings/pr-comments.md
// for the full research this mirrors: field shapes, the `in_reply_to_id ??
// id` threading rule (verified live: 0 reply-to-reply chains across 41
// comments on PR #105), and the Pierre DiffLineAnnotation mapping.
// ---------------------------------------------------------------------------

export type GhReviewCommentSide = 'LEFT' | 'RIGHT'

export type GhReviewComment = {
  id: number
  inReplyToId: number | null
  path: string
  line: number | null // current diff line; null once the anchor is outdated
  originalLine: number | null // stable anchor recorded at creation, never null
  side: GhReviewCommentSide
  subjectType: 'line' | 'file'
  body: string
  authorLogin: string
  // Unlike GhReview/GhReviewRequest/GhGeneralComment above, this DOES carry a
  // real avatar: `gh api repos/{owner}/{repo}/pulls/{n}/comments` returns each
  // comment's full `user` object (REST, not the `gh pr view --json` GraphQL
  // field list), including `user.avatar_url` — verified live against PR #117
  // (coderabbitai[bot] resolved to a real avatars.githubusercontent.com URL).
  avatarUrl: string | null
  createdAt: string
  htmlUrl: string
}

export type GhReviewCommentThread = {
  id: number // the thread root comment's id (in_reply_to_id ?? id grouping key)
  path: string
  line: number | null // root comment's line ?? originalLine (see grouping in github.ts)
  side: GhReviewCommentSide
  subjectType: 'line' | 'file'
  outdated: boolean // true when the root comment's `line` is null
  comments: GhReviewComment[] // root + replies, sorted by createdAt
}

export type GhPullRequestDetail = {
  // meta
  number: number
  title: string
  body: string // markdown, PR description
  state: GhPullRequestState
  url: string
  baseRefName: string
  headRefName: string
  author: string | null
  createdAt: string
  updatedAt: string
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string // CLEAN|DIRTY|BLOCKED|BEHIND|DRAFT|HAS_HOOKS|UNKNOWN|UNSTABLE
  additions: number
  deletions: number
  changedFiles: number

  // people/metadata
  labels: GhLabel[]
  assignees: string[] // logins
  reviewRequests: GhReviewRequest[]
  reviews: GhReview[] // per-reviewer state, from gh pr view's own reviews field
  reviewDecision: GhPullRequest['reviewDecision'] // aggregate, reuses existing normalizer
  milestone: GhMilestone | null

  // content
  commits: GhCommit[]
  checks: GhCheck[] // un-reduced per-check list (Checks tab)
  comments: {
    general: GhGeneralComment[] // gh pr view --json comments
    // Line-anchored review comments are a SEPARATE `gh api
    // .../pulls/{n}/comments` call (Phase 4a's github:prReviewComments /
    // GhReviewCommentThread) — not part of this payload at all.
  }
}

// ---------------------------------------------------------------------------
// Local review comments (Workbench Git tab, Phase 4d) — the Orpheus-owned
// comment store (Epic G2), living alongside GitHub's own review comments in
// the SAME inline diff display. Completes the 3-source comment model:
// github-from-others / my-github (both GhReviewCommentThread, tagged
// 'GitHub') / LOCAL (this type, tagged 'Local'). Persisted in SQLite's
// `review_comments` table (src/main/db/schema.ts) — see src/main/reviewStore.ts
// for the CRUD surface. `prNumber` is nullable: a local comment can exist on
// a workspace with no PR at all (it anchors to workspace + path/line, not to
// a GitHub PR). `line`/`side` are nullable for a file-level (not
// line-anchored) comment, mirroring GhReviewCommentThread's own
// `subjectType: 'file'` case above. `startLine` is nullable/present only for
// a true multi-line range comment (Pierre Batch 3's select-to-comment
// gesture) — null means the comment is single-line and `line` alone anchors
// it, exactly as before; when present, the comment spans startLine..line.
// ---------------------------------------------------------------------------

export type LocalReviewComment = {
  id: string
  workspaceId: string
  prNumber: number | null
  path: string
  line: number | null
  startLine: number | null
  side: GhReviewCommentSide | null
  body: string
  author: string // e.g. 'you' — local comments have no real GitHub identity
  resolved: boolean
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U4,
// KTD2). Replaces the flat-row `Pane` type (U12/1ccc4f5) with a three-level
// hierarchy persisted across `pane_panels` / `pane_layouts` / `pane_terminals`
// (src/main/db/schema.ts); see src/main/paneStore.ts for the CRUD surface.
// Independent of claude workspaces/sessions entirely — Panes is its own
// top-level view (R1), not scoped to a claude workspace the way the old
// flat-row panes were.
//
//   PanePanel   — a sidebar-level grouping. 'general' is the single,
//                 always-there, cross-project panel (seeded once — see
//                 paneStore.ts's ensureGeneralPanel / the
//                 'pane-general-panel-seed' data step). 'project' panels are
//                 user-created and bound to `dir`, a folder chosen via the
//                 folder picker — that folder is Panes-only and is NEVER
//                 written to Orpheus's `projects` table (KTD8).
//   PaneLayout  — a saved split-tree arrangement bound to its OWN folder
//                 (`dir`, independent of the parent panel's `dir`). `splitTree`
//                 is the parsed form of the persisted `split_tree_json` blob
//                 (null only for a layout with zero panes, e.g. right after
//                 creation before the first pane is added).
//   PaneTerminal — one terminal (a "pane" in the UI). `command` is the setup
//                 rule (R7): a command that auto-runs once on every open,
//                 then drops to a live shell; '' means a plain shell with no
//                 setup step. `name` (issue #21) is the user-editable
//                 display name — '' falls back to "Pane N" by position. The
//                 native surface keys on this row's `id`:
//                 `pane:<layoutId>:<terminalId>` (KTD1 — the existing
//                 pane:* surface IPC is unchanged, just given different key
//                 parts).
//   SplitTree   — the binary arrangement + divider ratios for one layout's
//                 panes. A leaf `{ paneId }` references a PaneTerminal's id;
//                 a node `{ dir, a, b, ratio }` is a binary split ('v' = new
//                 pane to the right, 'h' = new pane below), with `ratio` the
//                 first child's (`a`'s) share of the split axis (0 < ratio <
//                 1). Pure UI geometry — stored as JSON on the layout rather
//                 than as a recursive table (KTD2).
// ---------------------------------------------------------------------------

export type PanePanelKind = 'general' | 'project'

export interface PanePanel {
  id: string
  kind: PanePanelKind
  name: string
  /** Null for the 'general' panel — each of its layouts carries its own dir. */
  dir: string | null
  position: number
  createdAt: number
  updatedAt: number
  /** Sidebar expand/collapse persistence (issue #1) — mirrors
   *  ProjectRecord.expandedInSidebar exactly. */
  expandedInSidebar: boolean
}

export type SplitDirection = 'v' | 'h'

export type SplitTree =
  | { paneId: string }
  | { dir: SplitDirection; a: SplitTree; b: SplitTree; ratio: number }

export interface PaneLayout {
  id: string
  panelId: string
  name: string
  dir: string
  splitTree: SplitTree | null
  position: number
  createdAt: number
  updatedAt: number
  /** Fix 4 — when true, all of this layout's panes are background-mounted
   *  at app launch, regardless of which surface is visible in the UI. */
  autoStart: boolean
}

export interface PaneTerminal {
  id: string
  layoutId: string
  /** The setup rule — auto-runs once per open, then drops to a live shell. '' = plain shell. */
  command: string
  /** User-editable display name (issue #21). '' means unnamed — the
   *  renderer falls back to "Pane N" (1-based position) in that case. Never
   *  affects the surface's launch (see `command`); renaming never relaunches. */
  name: string
  position: number
  createdAt: number
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
  /** Effective context window for the resolved model, in tokens, after
   *  applying disable1mContext / maxContextTokens caps (see
   *  src/main/models/registry.ts's resolveContextBudget). `null` when the
   *  model's context window is unknown — consumers must render an explicit
   *  "unknown" state, never a fabricated number. */
  contextBudget: number | null
  /** lastTurnContextTokens / contextBudget * 100, capped at 100. 0 when
   *  contextBudget is null (nothing to divide by). */
  usedPct: number
}

export type SessionCost = {
  usd: number
  byModel: Record<string, number>
  /** True when at least one model tallied in this session has no known
   *  pricing (getPricing returned null) and was therefore excluded from
   *  `usd`/`byModel`. Consumers must show this — otherwise a session that
   *  used only unpriced models silently reads as "$0.00", indistinguishable
   *  from genuinely free. */
  hasUnknownPricing: boolean
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

// ---------------------------------------------------------------------------
// Overlay layer (React overlays above the terminal NSView)
// ---------------------------------------------------------------------------

export type OverlayPlacement =
  | {
      mode: 'anchored'
      /** DIPs relative to `contentView`, top-left origin (see plan HTD note on zoomFactor). */
      anchorRect: { x: number; y: number; w: number; h: number }
      preferredSide?: 'top' | 'bottom' | 'left' | 'right'
    }
  | { mode: 'centered' }

export type OverlayDescriptor = {
  id: string
  kind: string
  placement: OverlayPlacement
  props: Record<string, unknown>
  /**
   * Card is clickable (e.g. PR chip, hover card) without stealing keyboard
   * focus from the terminal. Independent of `takesFocus` — a card can accept
   * clicks and still never become first responder.
   */
  acceptsClicks: boolean
  /**
   * Only confirm/palette-class overlays take focus. When true, main saves the
   * terminal's first responder at token acquisition and restores it on hide.
   */
  takesFocus: boolean
  /**
   * When set, main auto-hides this (anchored) overlay if the owning
   * workspace unmounts or is destroyed — a backstop independent of the
   * caller's own anchor-tracking cleanup.
   */
  ownerWorkspaceId?: string
}

// `invoke('overlay:showDescriptor', ...)` resolves at paint-ack, not at
// dismissal — dismissal (user action, timeout, replacement) arrives later as
// an `overlay:event` push.
export type OverlayShowResult = { shown: boolean }

// Pushed from main to the requesting (main) renderer: button clicks, cancel,
// mouseenter/mouseleave (hover bridge), and the terminal exit-fade-complete signal.
export type OverlayEvent = {
  overlayId: string
  kind: string
  type: string
  payload?: Record<string, unknown>
}

// --- Overlay-renderer-side messages (main -> overlay WebContentsView) ---

export type OverlayShowMessage = {
  descriptor: OverlayDescriptor
  /** Monotonic per-show generation; stale acks/updates/events are dropped by main. */
  generation: number
  theme: string
}

export type OverlayUpdateMessage = {
  id: string
  generation: number
  props: Record<string, unknown>
}

export type OverlaySizeReport = {
  id: string
  generation: number
  w: number
  h: number
}

export type OverlayAck = {
  id: string
  generation: number
  /** Set when the kind's error boundary caught a render failure. */
  error?: string
}

// ---------------------------------------------------------------------------
// Overlay card kinds — hoverCard / detailsCard. Props are serializable and
// reuse the app's own GitStatus/GhPullRequest shapes directly.
// ---------------------------------------------------------------------------

export type OverlayCardGit = {
  branch: string
  detached: boolean
  summary: string
  insertions: number
  deletions: number
}

export type OverlayCardPr = {
  number: number
  state: GhPullRequestState
  check: 'ok' | 'fail' | 'pending' | 'none'
  url?: string
}

export type HoverCardProps = {
  title: string
  activityLabel: string
  activityState: WorkspaceActivityDetail
  relativeTime: string
  git?: OverlayCardGit
  pr?: OverlayCardPr
  cwd?: string
}

export type DetailsCardProps = {
  pr?: OverlayCardPr
  model?: string
  contextText?: string
  contextLoading?: boolean
  cost?: string
  costLoading?: boolean
  git?: OverlayCardGit
  cwd?: string
  /** Workbench flag-on path (U3): settings changed since launch — mirrors the
   *  "Restart to apply" chip formerly shown only in the WorkspaceDrawer. */
  isDirty?: boolean
}

// ---------------------------------------------------------------------------
// Overlay kind: projectCard. Section order: header (name + pinned chip),
// repo, path, workspace count, workspace list (up to 8 + "+K more"). Width
// target ~224px.
// ---------------------------------------------------------------------------

export type OverlayCardWorkspaceEntry = {
  name: string
  state: WorkspaceActivityDetail
}

export type ProjectCardProps = {
  name: string
  pinned: boolean
  /** "owner/repo" when GitHub-linked, else absent. */
  repo?: string
  path: string
  workspaceCount: number
  /** Capped to 8 entries by the caller; overflow renders as "+K more". */
  workspaces: OverlayCardWorkspaceEntry[]
}

// ---------------------------------------------------------------------------
// Overlay kind: confirmModal. Centered, takesFocus: true.
// ---------------------------------------------------------------------------

export type ConfirmModalButtonStyle = 'default' | 'primary' | 'danger'

export type ConfirmModalButton = {
  id: string
  label: string
  style?: ConfirmModalButtonStyle
}

export type ConfirmModalProps = {
  title: string
  body: string
  buttons: ConfirmModalButton[]
  checkbox?: { id: string; label: string; checked: boolean }
}

export type ConfirmModalResult = { buttonId: string; checkboxChecked: boolean }

// ---------------------------------------------------------------------------
// Overlay kind: noticeBanner — U9 React migration of WorkspaceView's one-time
// notice banner. Non-interactive (acceptsClicks: false, takesFocus: false),
// anchored to the terminal host, auto-hidden by the call site's own timer
// (the kind itself has no internal timer — main renderer owns display
// duration exactly like the chassis-free `notice` state did).
// ---------------------------------------------------------------------------

export type NoticeBannerProps = {
  message: string
}

// ---------------------------------------------------------------------------
// Overlay kinds: chipTooltip / chipPrompt — U9 React migration of the footer
// ActionChip's two in-page `Overlay` usages (`ChipTooltip` component,
// `PromptPopover` component in ActionChip.tsx), both of which opened
// bottom-full (upward into the terminal rect) and were occluded by the live
// terminal. Anchored to the chip element, preferredSide 'top', matching the
// original upward-opening placement.
// ---------------------------------------------------------------------------

/** Transient hover-label card — non-interactive, matches today's tooltip styling. */
export type ChipTooltipProps = {
  text: string
}

/** Interactive prompt popover — same fields/labels/order as PromptDescriptor[]. */
export type ChipPromptProps = {
  prompts: PromptDescriptor[]
  /** Pre-filled default values (already placeholder-expanded by the caller). */
  values: Record<string, string>
}

/** Resolves on Apply/Enter; caller resolves `null` on Cancel/Escape/outside-click/IPC failure. */
export type ChipPromptResult = { values: Record<string, string> } | null

/** One selectable item in a chip dropdown (e.g. a model option). `destructive`
 *  is optional and additive — only PanesView's ⋯ layout-options menu sets it
 *  (for "Stop layout"), so it defaults to falsy/undefined for every other
 *  caller (e.g. the footer Model chip) and never changes their rendering. */
export type ChipDropdownItem = {
  value: string
  label: string
  sublabel?: string
  destructive?: boolean
}

/** Interactive dropdown/list popover — opens upward from its anchor chip. */
export type ChipDropdownProps = {
  items: ChipDropdownItem[]
  /** Currently-selected value, to render an active/check state on that row. */
  selectedValue?: string
  title?: string
}

/** Resolves on row click/Enter; caller resolves `null` on Cancel/Escape/outside-click/IPC failure. */
export type ChipDropdownResult = { kind: 'select'; value: string } | null

// ---------------------------------------------------------------------------
// Overlay kind: workspaceSettingsCard — the workspace title bar's Settings
// gear popover (WorkspaceSettingsPopover.tsx), migrated off the in-page
// `Overlay` component because it opens downward off a title-bar anchor,
// straight into the live terminal rect (docs/learnings/overlay-child-window-
// macos.md). Unlike chipPrompt/chipDropdown (transient, promise-settled),
// this kind is LONG-LIVED like detailsCard: it stays open across many
// `update()` pushes as the underlying settings/dirty-flag change, AND it's
// focusable/interactive like chipPrompt (text inputs in the CLI-flags/env-var
// editors). Props down, events up: the main window owns every
// `window.api.claudeWorkspaceSettings.*` call and all data hooks; this props
// bag is a pure serializable snapshot the card renders, and every edit is an
// `emit(...)` the call site turns back into a hook call + a follow-up
// `updateWorkspaceSettingsCard` push (mirrors updateDetailsCard).
// ---------------------------------------------------------------------------

/** One row as edited in the card — matches CliFlagsEditorProps/
 *  CustomEnvVarsEditorProps' `value` shapes exactly so the kind can pass them
 *  straight through without reshaping. */
export type WorkspaceSettingsCardProps = {
  /** Derived Loco-channel toggle state — `flags.some(flagName(e) === LOCO_FLAG_NAME)`,
   *  computed by the caller (never independent state) and passed down read-only. */
  locoEnabled: boolean
  /** This workspace's raw customCliFlags override entries. */
  flags: string[]
  /** Global + project raw flag entries (scope order), rendered muted in the
   *  command preview alongside `flags`. */
  inheritedFlags: string[]
  /** This workspace's raw customEnvVars override. */
  envVars: Record<string, string>
  /** True while either the flags or env-vars settings are still loading. */
  loading: boolean
  /** Mirrors DetailsCardProps.isDirty — the same "Restart to apply" row. */
  isDirty: boolean
}

/** Partial props pushed via `overlay:update` as async loads/edits resolve —
 *  same shallow-merge contract DetailsCardProps' patches use. */
export type WorkspaceSettingsCardPatch = Partial<WorkspaceSettingsCardProps>

// ---------------------------------------------------------------------------
// Workbench Files tab — file tree + viewer data sources (Stage A backend).
//
// These feed @pierre/trees (flat `paths: string[]` + per-path git-status
// decorations) and the file viewer. See docs/learnings/pierre-libraries.md
// §7 for why the tree consumes a FLAT path list and a GitStatusEntry[].
// ---------------------------------------------------------------------------

/**
 * Visibility tier for a single tree entry (see docs/learnings/pierre-libraries.md §11).
 *
 *  - `'normal'`     — tracked / non-ignored path; full opacity, no annotation.
 *  - `'gitignored'` — matched by the `.gitignore` chain but NOT denylisted
 *                     (e.g. `.env`, `.claude/settings.local.json`); shown,
 *                     dimmed when "Dim gitignored" is on.
 *  - `'denylisted'` — a hardcoded noisy machine dir/file (`node_modules`,
 *                     `.git`, `vendor`, `out`/`dist`/`build`/`target`,
 *                     `.DS_Store`, `*.log`, caches); hidden unless "Show hidden
 *                     files" is on. The denylist is applied regardless of
 *                     whether the project's own `.gitignore` mentions it.
 */
export type FileTier = 'normal' | 'gitignored' | 'denylisted'

/**
 * A single flat directory-walk entry, tagged with its visibility tier.
 * `path` is a repo-relative POSIX path — directories carry a trailing slash
 * (e.g. `'src/'`), files do not (e.g. `'src/index.ts'`).
 */
export type FileEntry = {
  path: string
  tier: FileTier
}

/**
 * Flat, tier-tagged directory listing of a workspace's cwd.
 *
 * Every path is returned tagged with its `tier` (rather than gitignored paths
 * being dropped at walk time) so the renderer can filter/dim client-side with
 * NO re-fetch when the tree-options toggles flip — see §11. Directories carry a
 * trailing slash and files do not, matching the mixed dir+file input
 * @pierre/trees' README examples pass. `truncated` is true when the walk hit
 * the depth/entry cap and the listing is partial.
 */
export type FilesListing = {
  entries: FileEntry[]
  truncated: boolean
}

/**
 * Per-path git status decoration for the file tree, mapped to @pierre/trees'
 * `GitStatusEntry` enum. `path` is repo-relative POSIX (joins to the same
 * paths `files:listDir` returns).
 */
export type GitFileStatusKind =
  | 'added'
  | 'deleted'
  | 'ignored'
  | 'modified'
  | 'renamed'
  | 'untracked'

export type GitStatusEntry = {
  path: string
  status: GitFileStatusKind
}

// ---------------------------------------------------------------------------
// Workbench Git tab — Phase 1 working-tree diff (per-file unified-diff
// patches, consumed by @pierre/diffs' <PatchDiff patch={...}>). See
// docs/learnings/pierre-libraries.md §13.4/§13.9: PatchDiff takes a raw patch
// string, so the git:diff IPC ships one already-split patch per file rather
// than pre-parsed FileDiffMetadata.
// ---------------------------------------------------------------------------

/**
 * Per-file working-tree diff status. Distinct from `GitFileStatusKind` (the
 * Files-tab tree decoration enum) only in that there's no `'ignored'` state
 * here — every entry in a `git:diff` result is a real changed file.
 */
export type GitDiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

/**
 * A single file's working-tree diff: the repo-relative path, its change
 * status, a ready-to-render unified-diff patch string (`diff --git ...`
 * through the last hunk line for this file only), and +/- line counts parsed
 * from the same patch. `oldPath` is set only for renames (the pre-rename
 * path) so the renderer can show "old → new" if desired.
 *
 * `binary` (Fix 4) is true when the patch chunk is a `git diff` binary marker
 * (`Binary files a/x b/x differ` or a `GIT binary patch` block) rather than
 * real `+`/`-` hunks — additions/deletions are then meaningless (always 0)
 * and the renderer shows "Binary" instead of a line-count, routing image
 * extensions to an <img> preview (via files:readImage) and everything else to
 * a "no preview" placeholder rather than rendering the (blank) patch.
 *
 * `oversized` (crash fix #1 — see gitDiff.ts's OVERSIZED_LINE_THRESHOLD/
 * OVERSIZED_BYTE_THRESHOLD) is true when the patch chunk exceeds a per-file
 * line/byte cap. `additions`/`deletions`/`status`/`binary` are always computed
 * from the FULL chunk regardless of this flag, so counts and comment
 * line-anchoring stay correct — `oversized` only tells the renderer's
 * DiffContentPane to hide the patch behind a "Large diff hidden — show
 * anyway" placeholder instead of feeding it straight into <PatchDiff>. As of
 * Pierre adoption batch 2a, <PatchDiff> renders inside a <Virtualizer> (only
 * ~visible rows hit shadow-DOM), so this cap was raised substantially rather
 * than removed — it now exists mainly to protect against the still-
 * synchronous whole-patch Shiki tokenize pass on an astronomically large
 * single file, not DOM size.
 */
export type GitDiffFile = {
  path: string
  status: GitDiffFileStatus
  patch: string
  additions: number
  deletions: number
  oldPath?: string
  binary: boolean
  oversized?: boolean
  /** PERF FIX (LAG-LAYER #7) — a cyrb53 content hash over path+status+patch,
   *  computed ONCE in main (src/main/gitDiff.ts's fileFromChunk) so the
   *  renderer's diffSignature (GitTab.tsx) can combine per-file hashes
   *  instead of re-concatenating every file's full patch TEXT into one giant
   *  string on every settled git:diff/prDiff. See gitDiff.ts's own doc
   *  comment for why this isn't a 32-bit hash or `patch.length`. */
  sig: string
}

/**
 * Result of `git:diff` — the working tree vs `HEAD` (tracked changes) plus
 * untracked files (each rendered as an all-additions patch against
 * `/dev/null`). Empty `files` for a non-repo, a clean tree, or any git
 * failure — the handler never throws (see src/main/gitDiff.ts).
 *
 * `repo` (Phase 2 — Workbench Git tab edge states) discriminates the two
 * cases that otherwise both resolve to an empty `files[]`: `repo: false`
 * means `cwd` isn't inside a git working tree at all (the renderer shows the
 * "Not a git repository" + Git-init empty state); `repo: true` with an empty
 * `files[]` means it IS a repo and the working tree is simply clean (the
 * renderer shows the "No changes" empty state). `files.length > 0` always
 * implies `repo: true`.
 */
export type GitDiffResult = {
  repo: boolean
  files: GitDiffFile[]
}

/**
 * PERF FIX (main-side diff no-op detection) — an ADDITIVE sentinel returned
 * by `git:diff` ONLY (never `git:prDiff` — see src/main/ipc/git.ts's handler)
 * when the freshly-computed working-tree diff is byte-for-byte identical to
 * the last one emitted for the SAME workspaceId (src/main/gitDiff.ts caches
 * the last-emitted signature per workspaceId). Lets main skip re-serializing/
 * structured-cloning the full `files[]` (multi-MB patch text on a large diff)
 * across IPC on a live-refresh settle that changed nothing, instead of only
 * skipping the renderer's OWN setState (the pre-existing diffSignature guard
 * in GitTab.tsx, kept as the renderer-side backstop).
 *
 * This is a UNION on `git:diff`'s return type, not a change to `GitDiffResult`
 * itself — `git:prDiff` and every other consumer of `GitDiffResult` are
 * unaffected. The renderer MUST check `unchanged` before touching `.files`
 * (see GitTab.tsx's `isUnchangedDiffResult`, used by `fetchDiff`) — the cache
 * is keyed by workspaceId, so a workspace switch is always a cache MISS and
 * never returns this sentinel for the first fetch after a switch (see
 * gitDiff.ts's `getWorkingTreeDiff`'s own doc comment on the cache key).
 */
export type GitDiffUnchangedResult = {
  repo: true
  unchanged: true
}

/**
 * Text contents of a single file for the viewer.
 *
 * `binary` is true when null bytes were detected — `contents` is then empty
 * and the renderer shows a placeholder rather than garbage. `truncated` is
 * true when the file exceeded the size cap and `contents` holds only the
 * leading portion that was read.
 */
export type FileContents = {
  /** File contents as UTF-8 text (empty when `binary`). */
  contents: string
  /** Basename of the file (e.g. `index.ts`). */
  name: string
  /** Byte size of the file on disk. */
  size: number
  /** True when the file exceeded the size cap; `contents` is partial. */
  truncated: boolean
  /** True when null bytes were detected; `contents` is empty. */
  binary: boolean
  /**
   * Crash fix #2 — cheap newline count over the read `contents` (bounded
   * `indexOf` scan in files.ts, not a full `.split('\n')` allocation), so the
   * renderer can gate full-file Shiki highlighting on line count without
   * re-scanning a multi-MB string client-side. 0 for `binary`/empty files.
   */
  lineCount: number
  /**
   * Crash fix #2 — length of the longest line seen during that SAME bounded
   * scan (capped — see files.ts's MAX_LINE_LENGTH_SCAN), so a minified
   * single-line blob (low `lineCount`, huge single line) is also caught. 0
   * for `binary`/empty files.
   */
  maxLineLength: number
}

/**
 * Result of `files:writeFile` (Files-tab editor save). `ok` is true when the
 * UTF-8 write to the resolved-inside path succeeded; on failure `error` carries
 * a short reason (`traversal` = the path escaped the workspace cwd, `denied` =
 * fs write failed, `no-workspace` = workspace cwd could not be resolved). The
 * handler never throws — every failure is a typed result the renderer can
 * surface without an unhandled rejection.
 */
export type WriteFileResult =
  | { ok: true }
  | { ok: false; error: 'traversal' | 'denied' | 'no-workspace' }

/**
 * Result of the Files-tab tree mutation IPCs (`files:createFile`,
 * `files:createDir`, `files:rename`, `files:delete` — Phase 4). One shared
 * shape across all four so the renderer can surface a single error union:
 *   - `exists`      — the target path (or rename destination) already exists
 *   - `traversal`   — a path escaped the workspace cwd (`../`, absolute, root)
 *   - `denied`      — an underlying fs/trash operation failed
 *   - `missing`     — the source path (rename `from`, delete target) is gone
 *   - `no-workspace`— the workspace cwd could not be resolved from its id
 * Every mutating handler is total — it returns one of these results rather than
 * throwing across the IPC boundary.
 */
export type FilesMutationResult =
  | { ok: true }
  | { ok: false; error: 'exists' | 'traversal' | 'denied' | 'missing' | 'no-workspace' }

/**
 * Result of `files:readImage` (Files-tab image viewer). On success, `dataUrl`
 * is a base64 `data:<mime>;base64,...` URL of the whole file (small enough to
 * hand straight to an `<img src>`) and `size` is the on-disk byte size. On
 * failure, `error` carries a short reason: `too-large` (over the read cap),
 * `missing` (no workspace cwd, a traversal escape, or the path doesn't
 * resolve to an existing file), or `denied` (the file exists and is within
 * cap but the fs read itself failed, e.g. a permissions error). The handler
 * never throws across the IPC boundary — see `readFileContents`'s sibling
 * `readImageContents` in src/main/ipc/files.ts.
 */
export type FileImage =
  | { ok: true; dataUrl: string; size: number }
  | { ok: false; error: 'too-large' | 'denied' | 'missing' }

// ---------------------------------------------------------------------------
// Managed routing proxy (model-routing unit 04) — CLIProxyAPI component
//
// An opt-in, Orpheus-downloaded/managed CLIProxyAPI binary that non-Claude
// ("routed") model workspaces talk to instead of api.anthropic.com directly.
// See src/main/routingProxy/ for the manager; src/main/modelRouting.ts for
// how a workspace's launch env points at this proxy's URL/token.
// ---------------------------------------------------------------------------

/** Component lifecycle state, mirroring the shape of UpdateSnapshot's 'kind' union. */
export type RoutingProxyStatus =
  | 'not_installed'
  | 'installing'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'error'

/** One connected-provider row from GET /v0/management/auth-files. */
export interface RoutingProxyAuthFile {
  provider: string
  /** Display label / filename as reported by the management API. */
  label: string
  /** Best-effort health signal — the management API's own field name varies
   *  by provider, so this is normalized to a small enum by the manager. */
  health: 'ok' | 'error' | 'unknown'
}

/** Rehydratable snapshot the renderer polls/subscribes to — mirrors UpdateSnapshot. */
export interface RoutingProxySnapshot {
  enabled: boolean
  status: RoutingProxyStatus
  /** Installed version (e.g. "7.2.92"), or null if never installed. */
  installedVersion: string | null
  /** Version this build of Orpheus is pinned to. */
  pinnedVersion: string
  /** Set only while status === 'installing'. */
  installProgress: {
    phase: 'downloading' | 'verifying' | 'extracting'
    percent: number | null
  } | null
  /** Human-readable error, set only when status === 'error'. */
  error: string | null
  /** Connected accounts, populated only while status === 'running'. */
  authFiles: RoutingProxyAuthFile[]
  /** Last time authFiles was refreshed, or null. */
  authFilesCheckedAt: number | null
}

/** Result of a "check for updates" call against the GitHub latest-release API. */
export interface RoutingProxyUpdateCheckResult {
  current: string | null
  latest: string | null
  available: boolean
  checkedAt: number
  error?: string
}

/** Download size info surfaced before an install, so the Settings UI can show it. */
export interface RoutingProxyAssetInfo {
  version: string
  assetName: string
  sizeBytes: number | null
}

// ---------------------------------------------------------------------------
// Provider framework (model-routing unit 05) — declarative non-Claude
// provider descriptors + per-provider stored config, surfaced to the
// renderer's Settings > Model Routing > Providers section. See
// src/main/routingProxy/providers/ for the main-process source of truth;
// these are renderer-facing mirrors (never re-derive "is this a known
// provider" client-side — the descriptor list always comes from main via
// providers:list).
// ---------------------------------------------------------------------------

export type ProviderAuthMethodShared = 'oauth' | 'apiKey' | 'openaiCompatible'

/** One provider descriptor, as sent to the renderer (docsUrl/oauthLoginFlag
 *  included for display only — this unit does not build the OAuth
 *  connect-button flow; see the oauthLoginFlag field's own doc comment in
 *  providers/types.ts). */
export interface ProviderDescriptorSummary {
  id: string
  label: string
  authMethods: ProviderAuthMethodShared[]
  oauthLoginFlag?: string
  apiKeyConfigKey?: string
  openaiCompatibleDefaultBaseUrl?: string
  docsUrl?: string
}

/** One stored API-key entry, as sent to/from the renderer. The renderer only
 *  ever displays a redacted form of `apiKey` (see the Settings UI's own
 *  masking) — the real value is still present on this wire type because the
 *  add/update flow needs to send a new key value up; it is never logged. */
export interface ProviderApiKeyEntrySummary {
  id: string
  apiKey: string
  prefix?: string
  baseUrl?: string
}

/** One provider's full stored config + live connection status, as sent to
 *  the renderer. `connection` is populated from the routing-proxy snapshot's
 *  authFiles (oauth providers) — null when the proxy isn't running or the
 *  provider hasn't connected via OAuth. */
export interface ProviderConfigSummary {
  providerId: string
  enabled: boolean
  authMethod: ProviderAuthMethodShared
  apiKeys: ProviderApiKeyEntrySummary[]
  baseUrl?: string
  displayName?: string
  prefix?: string
  connection: RoutingProxyAuthFile | null
}
