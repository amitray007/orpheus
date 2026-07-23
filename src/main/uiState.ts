import { getDb } from './db'
import type {
  AppUiState,
  AppUiStatePatch,
  AppViewKind,
  ProjectsLastViewKind,
  Theme,
  AccentColor,
  UiFontScale,
  SoundPack
} from '../shared/types'
import {
  UI_STATE_DEFAULTS,
  VALID_STATUS_POLL_INTERVALS_SEC,
  VALID_USAGE_POLL_INTERVALS_SEC,
  VALID_FILES_SORT_ORDERS,
  VALID_DEFAULT_SURFACES,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  WORKBENCH_TREE_WIDTH_MIN,
  WORKBENCH_TREE_WIDTH_MAX
} from '../shared/uiStateDefaults'

// ---------------------------------------------------------------------------
// DB row ↔ type mapping
// ---------------------------------------------------------------------------

type AppUiStateRow = {
  id: number
  sidebar_collapsed: number
  last_view_kind: string
  last_project_id: string | null
  last_workspace_id: string | null
  // Panes v2 active-panel/active-layout persistence (issue #1) — mirrors
  // last_project_id/last_workspace_id exactly.
  last_panel_id: string | null
  last_layout_id: string | null
  // Projects-surface-scoped location memory — see AppUiState.projectsLastViewKind.
  projects_last_view_kind: string
  projects_last_project_id: string | null
  projects_last_workspace_id: string | null
  window_x: number | null
  window_y: number | null
  window_width: number | null
  window_height: number | null
  window_fullscreen: number
  // Window behavior preferences (v11)
  restore_geometry: number
  close_hides: number
  open_at_last_view: number
  // Sidebar behavior preferences (v12)
  pinned_section_visible: number
  workspace_count_inline: number
  sidebar_width: number
  default_project_expanded: number
  // Projects surface — optional Workspaces board (kanban) visibility (U3).
  show_workspaces_board: number
  // Launch + hotkey (v18)
  launch_at_login: number
  global_hotkey: string
  // Archive cap (v25)
  archived_workspace_limit: number
  // Hooks integration (v60)
  hooks_integration_enabled: number | null
  // Notification preferences (v29)
  notify_attention: number
  notify_stop: number
  notify_always: number
  // Notification enrichment (v59)
  notify_rich_summary: number
  notify_suppress_when_focused: number
  // Persistent attention reminders (v30)
  notify_max_attention_repeats: number
  // In-progress watchdog (v31) — auto-demote to awaiting_input if no heartbeat in N seconds. 0 disables.
  in_progress_watchdog_sec: number
  // Stale threshold (v54)
  stale_after_minutes: number | null
  // Auto-close threshold (v57)
  auto_close_after_minutes: number | null
  // App picker preferences (v32)
  preferred_editor_app: string | null
  preferred_terminal_app: string | null
  // Auto-prune cap (v33)
  max_local_sessions: number | null
  // Appearance (v36)
  theme: string
  accent_color: string | null
  ui_font_scale: string
  // Privacy (v37)
  fetch_github_avatars: number | null
  // Sound (v38)
  play_interaction_sounds: number | null
  // Sound pack (v39)
  sound_pack: string | null
  // Updates (v40)
  auto_check_updates: number | null
  // Status polling preferences (v42)
  status_poll_interval_sec: number | null
  mute_status_notifications: number | null
  // Dashboard "Usage" card background poll interval (D3)
  usage_poll_interval_sec: number | null
  // Workspace footer visibility (v45)
  show_workspace_footer: number | null
  // Files-tab editor save mode (v62)
  files_auto_save: number | null
  // Files-tab tree view preferences (v67)
  files_show_hidden: number
  files_dim_gitignored: number
  files_wrap_lines: number
  files_sort_order: string
  files_flatten_empty_dirs: number
  // Workbench Git-tab diff view preferences (v68)
  git_diff_wrap_lines: number
  // Token-hover popover (Pierre Batch 3)
  token_hover_enabled: number
  // Per-hunk "Revert" on the working-tree diff
  hunk_actions_enabled: number
  // Panes v2 top-level view visibility toggles
  show_panes_view: number
  show_workspaces_view: number
  // Open-at-launch surface
  default_surface: string
  // Workbench tree/code split pane width (v69)
  workbench_tree_width: number
  // Diagnostics capture toggles (v56)
  diag_error: number | null
  diag_lifecycle: number | null
  diag_perf: number | null
  diag_anomaly: number | null
  // Trace capture (v61)
  diag_trace: number | null
  // GitHub username greeting (D4)
  github_username: string | null
  // Managed routing proxy (v70)
  routing_proxy_enabled: number | null
  // Model-name aliasing (model-routing unit 08)
  model_aliases_enabled: number | null
  // Privacy mode (v66)
  privacy_mode: number | null
  updated_at: number
}

function rowToRecord(row: AppUiStateRow): AppUiState {
  // Clamp sidebar_width to valid range at read time — guards against manual DB edits
  const rawWidth = row.sidebar_width ?? UI_STATE_DEFAULTS.sidebarWidth
  const clampedWidth = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, rawWidth))
  // Clamp workbench_tree_width the same way (see sidebar_width above).
  const rawTreeWidth = row.workbench_tree_width ?? UI_STATE_DEFAULTS.workbenchTreeWidth
  const clampedTreeWidth = Math.min(
    WORKBENCH_TREE_WIDTH_MAX,
    Math.max(WORKBENCH_TREE_WIDTH_MIN, rawTreeWidth)
  )
  return {
    sidebarCollapsed: row.sidebar_collapsed === 1,
    // 'dashboard' was a valid kind in older DB rows — coerce to 'sessions' on read.
    lastViewKind: (row.last_view_kind === 'dashboard'
      ? 'sessions'
      : row.last_view_kind) as AppViewKind,
    lastProjectId: row.last_project_id,
    lastWorkspaceId: row.last_workspace_id,
    // Panes v2 active-panel/active-layout persistence (issue #1)
    lastPanelId: row.last_panel_id,
    lastLayoutId: row.last_layout_id,
    // Projects-surface-scoped location memory — defensive coercion mirrors
    // how lastViewKind coerces legacy 'dashboard' → 'sessions' on read;
    // default to 'sessions' if the stored value is somehow invalid.
    projectsLastViewKind: (['sessions', 'project', 'workspace'] as const).includes(
      row.projects_last_view_kind as 'sessions' | 'project' | 'workspace'
    )
      ? (row.projects_last_view_kind as ProjectsLastViewKind)
      : 'sessions',
    projectsLastProjectId: row.projects_last_project_id,
    projectsLastWorkspaceId: row.projects_last_workspace_id,
    windowX: row.window_x,
    windowY: row.window_y,
    windowWidth: row.window_width,
    windowHeight: row.window_height,
    windowFullscreen: row.window_fullscreen === 1,
    // Window behavior preferences (v11) — default 1 matches schema DEFAULT
    restoreGeometry: (row.restore_geometry ?? 1) === 1,
    closeHides: (row.close_hides ?? 1) === 1,
    openAtLastView: (row.open_at_last_view ?? 1) === 1,
    // Sidebar behavior preferences (v12)
    pinnedSectionVisible: (row.pinned_section_visible ?? 1) === 1,
    workspaceCountInline: (row.workspace_count_inline ?? 1) === 1,
    sidebarWidth: clampedWidth,
    defaultProjectExpanded: (row.default_project_expanded ?? 0) === 1,
    // Projects surface — optional Workspaces board (kanban) visibility (U3).
    showWorkspacesBoard: (row.show_workspaces_board ?? 0) === 1,
    // Launch + hotkey (v18)
    launchAtLogin: (row.launch_at_login ?? 0) === 1,
    globalHotkey: row.global_hotkey ?? '',
    // Archive cap (v25)
    archivedWorkspaceLimit:
      row.archived_workspace_limit ?? UI_STATE_DEFAULTS.archivedWorkspaceLimit,
    // Hooks integration (v60) — default false (off)
    hooksIntegrationEnabled: (row.hooks_integration_enabled ?? 0) === 1,
    // Notification preferences (v29)
    notifyAttention: (row.notify_attention ?? 1) === 1,
    notifyStop: (row.notify_stop ?? 1) === 1,
    notifyAlways: (row.notify_always ?? 0) === 1,
    notifyRichSummary: (row.notify_rich_summary ?? 1) === 1,
    notifySuppressWhenFocused: (row.notify_suppress_when_focused ?? 0) === 1,
    notifyMaxAttentionRepeats: row.notify_max_attention_repeats ?? 5,
    inProgressWatchdogSec: row.in_progress_watchdog_sec ?? 120,
    staleAfterMinutes: row.stale_after_minutes ?? UI_STATE_DEFAULTS.staleAfterMinutes,
    autoCloseAfterMinutes: row.auto_close_after_minutes ?? 120,
    // App picker preferences (v32) — undefined when column absent (old DB pre-migration)
    preferredEditorApp: row.preferred_editor_app ?? null,
    preferredTerminalApp: row.preferred_terminal_app ?? null,
    // Auto-prune cap (v33) — null = unlimited
    maxLocalSessions: row.max_local_sessions ?? null,
    // Appearance (v36) — use defaults if column absent (pre-migration reads)
    theme: (row.theme ?? 'midnight') as Theme,
    accentColor: (row.accent_color ?? null) as AccentColor | null,
    uiFontScale: (row.ui_font_scale ?? 'default') as UiFontScale,
    // Privacy (v37) — default true (enabled)
    fetchGithubAvatars: (row.fetch_github_avatars ?? 1) === 1,
    // Sound (v38) — default true (enabled)
    playInteractionSounds: (row.play_interaction_sounds ?? 1) === 1,
    // Sound pack (v39) — default 'core'
    soundPack: (row.sound_pack ?? 'core') as SoundPack,
    // Updates (v40) — default true
    autoCheckUpdates: (row.auto_check_updates ?? 1) === 1,
    // Status polling preferences (v42)
    statusPollIntervalSec: row.status_poll_interval_sec ?? UI_STATE_DEFAULTS.statusPollIntervalSec,
    muteStatusNotifications: (row.mute_status_notifications ?? 0) === 1,
    // Dashboard "Usage" card background poll interval (D3)
    usagePollIntervalSec: row.usage_poll_interval_sec ?? UI_STATE_DEFAULTS.usagePollIntervalSec,
    // Workspace footer visibility (v45) — default true
    showWorkspaceFooter: (row.show_workspace_footer ?? 1) === 1,
    // Files-tab editor save mode (v62) — default false (manual save)
    filesAutoSave: (row.files_auto_save ?? 0) === 1,
    // Files-tab tree view preferences (v67) — mirrors UI_STATE_DEFAULTS in
    // src/shared/uiStateDefaults.ts (filesFlattenEmptyDirs defaults true, Fix 3)
    filesShowHidden: (row.files_show_hidden ?? 0) === 1,
    filesDimGitignored: (row.files_dim_gitignored ?? 1) === 1,
    filesWrapLines: (row.files_wrap_lines ?? 1) === 1,
    filesSortOrder: row.files_sort_order === 'name' ? 'name' : 'default',
    filesFlattenEmptyDirs: (row.files_flatten_empty_dirs ?? 1) === 1,
    // Workbench Git-tab diff view preferences (v68) — default true (wrap on)
    gitDiffWrapLines: (row.git_diff_wrap_lines ?? 1) === 1,
    // Token-hover popover (Pierre Batch 3) — default false (off)
    tokenHoverEnabled: (row.token_hover_enabled ?? 0) === 1,
    // Per-hunk "Revert" on the working-tree diff — default false (off)
    hunkActionsEnabled: (row.hunk_actions_enabled ?? 0) === 1,
    // Panes v2 top-level view visibility toggles — showPanesView defaults
    // true, showWorkspacesView defaults false (matches schema DEFAULTs)
    showPanesView: (row.show_panes_view ?? 1) === 1,
    showWorkspacesView: (row.show_workspaces_view ?? 1) === 1,
    // Open-at-launch surface — default 'projects' (matches schema DEFAULT)
    defaultSurface: (VALID_DEFAULT_SURFACES as readonly string[]).includes(row.default_surface)
      ? (row.default_surface as AppUiState['defaultSurface'])
      : 'projects',
    // Workbench tree/code split pane width (v69) — shared Files+Git divider width
    workbenchTreeWidth: clampedTreeWidth,
    // Diagnostics capture toggles (v56)
    diagError: row.diag_error == null ? true : row.diag_error === 1,
    diagLifecycle: row.diag_lifecycle === 1,
    diagPerf: row.diag_perf === 1,
    diagAnomaly: row.diag_anomaly === 1,
    // Trace capture (v61) — off by default
    diagTrace: row.diag_trace === 1,
    // GitHub username greeting (D4) — nullable, no default
    githubUsername: row.github_username ?? null,
    // Managed routing proxy (v70) — default false (off)
    routingProxyEnabled: (row.routing_proxy_enabled ?? 0) === 1,
    // Model-name aliasing (model-routing unit 08) — default false (off)
    modelAliasesEnabled: (row.model_aliases_enabled ?? 0) === 1,
    // Privacy mode (v66) — default false
    privacyMode: (row.privacy_mode ?? 0) === 1,
    updatedAt: row.updated_at
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_VIEW_KINDS: AppViewKind[] = ['dashboard', 'sessions', 'project', 'workspace', 'panes']
const VALID_PROJECTS_LAST_VIEW_KINDS: ProjectsLastViewKind[] = ['sessions', 'project', 'workspace']
const VALID_THEMES: Theme[] = ['midnight', 'daylight', 'eclipse']
const VALID_ACCENT_COLORS: AccentColor[] = ['gold', 'blue', 'teal', 'orange', 'pink']
const VALID_FONT_SCALES: UiFontScale[] = ['small', 'default', 'large']
const VALID_SOUND_PACKS: SoundPack[] = [
  'core',
  'minimal',
  'mechanical',
  'retro',
  'playful',
  'crisp',
  'organic',
  'soft'
]
// Allowed values for the status poller interval. Must stay in sync with the
// Select options surfaced in OrpheusStatusSection.tsx (5/10/15/30 min,
// 1/2/3 hr) so the UI never offers a value the validator rejects.
const VALID_STATUS_POLL_INTERVALS = VALID_STATUS_POLL_INTERVALS_SEC
// Allowed values for the Claude usage background poller interval (D3). Must
// stay in sync with the Select options surfaced in OrpheusStatusSection.tsx
// (5/10/15/30 min, 1 hr) so the UI never offers a value the validator rejects.
const VALID_USAGE_POLL_INTERVALS = VALID_USAGE_POLL_INTERVALS_SEC

// ---------------------------------------------------------------------------
// Table-driven validators
//
// The bulk of validatePatch is a flat sequence of independent per-key checks
// that fall into a few uniform shapes (enum membership, nullable-string,
// plain boolean). Each shape is factored into a small helper applied over a
// table of keys — but ONLY where the predicate + thrown message are
// byte-for-byte identical across every key in that table. Keys whose check
// has a different guard (e.g. no `!== undefined`) or message phrasing (e.g.
// "or null" suffix) are kept as their own standalone block below.
// ---------------------------------------------------------------------------

// Enum keys that use the `!== undefined` guard and the plain
// "<label> must be one of <list>" message (no "or null" suffix).
function validateEnumField<K extends keyof AppUiStatePatch>(
  patch: AppUiStatePatch,
  key: K,
  validValues: readonly AppUiStatePatch[K][],
  label: string
): void {
  const value = patch[key]
  if (key in patch && value !== undefined) {
    if (!validValues.includes(value)) {
      throw new Error(`uiState: ${label} must be one of ${validValues.join(', ')}`)
    }
  }
}

// Nullable-string keys: "<label> must be a string or null", no `undefined` guard.
function validateNullableStringField<K extends keyof AppUiStatePatch>(
  patch: AppUiStatePatch,
  key: K,
  label: string
): void {
  const value = patch[key]
  if (key in patch) {
    if (value !== null && typeof value !== 'string') {
      throw new Error(`uiState: ${label} must be a string or null`)
    }
  }
}

// Plain-boolean keys: "<label> must be a boolean", with `!== undefined` guard.
function validateBooleanField<K extends keyof AppUiStatePatch>(
  patch: AppUiStatePatch,
  key: K,
  label: string
): void {
  const value = patch[key]
  if (key in patch && value !== undefined) {
    if (typeof value !== 'boolean') {
      throw new Error(`uiState: ${label} must be a boolean`)
    }
  }
}

const NULLABLE_STRING_FIELDS: {
  key: keyof AppUiStatePatch
  label: string
}[] = [
  { key: 'lastProjectId', label: 'lastProjectId' },
  { key: 'lastWorkspaceId', label: 'lastWorkspaceId' },
  { key: 'projectsLastProjectId', label: 'projectsLastProjectId' },
  { key: 'projectsLastWorkspaceId', label: 'projectsLastWorkspaceId' },
  { key: 'githubUsername', label: 'githubUsername' }
]

// Note: muteStatusNotifications sits between the two poll-interval checks in
// validatePatch's original order, so it's validated standalone there rather
// than folded into this table (keeps the checks in their original sequence).
const BOOLEAN_FIELDS: { key: keyof AppUiStatePatch; label: string }[] = [
  { key: 'showWorkspaceFooter', label: 'showWorkspaceFooter' },
  { key: 'filesAutoSave', label: 'filesAutoSave' },
  { key: 'gitDiffWrapLines', label: 'gitDiffWrapLines' },
  { key: 'tokenHoverEnabled', label: 'tokenHoverEnabled' },
  { key: 'hunkActionsEnabled', label: 'hunkActionsEnabled' },
  { key: 'showPanesView', label: 'showPanesView' },
  { key: 'showWorkspacesView', label: 'showWorkspacesView' },
  { key: 'routingProxyEnabled', label: 'routingProxyEnabled' },
  { key: 'modelAliasesEnabled', label: 'modelAliasesEnabled' }
]

// Numeric-membership keys: "<label> must be one of <list>", requires
// typeof === 'number' AND membership in the valid-values list.
function validateNumericEnumField(
  patch: AppUiStatePatch,
  key: 'statusPollIntervalSec' | 'usagePollIntervalSec',
  validValues: readonly number[],
  label: string
): void {
  const value = patch[key]
  if (key in patch && value !== undefined) {
    if (typeof value !== 'number' || !validValues.includes(value)) {
      throw new Error(`uiState: ${label} must be one of ${validValues.join(', ')}`)
    }
  }
}

function validatePatch(patch: AppUiStatePatch): void {
  // lastViewKind: no `undefined` guard (differs from the enum table below).
  if ('lastViewKind' in patch) {
    if (!VALID_VIEW_KINDS.includes(patch.lastViewKind as AppViewKind)) {
      throw new Error(`uiState: lastViewKind must be one of ${VALID_VIEW_KINDS.join(', ')}`)
    }
  }
  // projectsLastViewKind: no `undefined` guard (differs from the enum table below).
  if ('projectsLastViewKind' in patch) {
    if (
      !VALID_PROJECTS_LAST_VIEW_KINDS.includes(patch.projectsLastViewKind as ProjectsLastViewKind)
    ) {
      throw new Error(
        `uiState: projectsLastViewKind must be one of ${VALID_PROJECTS_LAST_VIEW_KINDS.join(', ')}`
      )
    }
  }

  for (const { key, label } of NULLABLE_STRING_FIELDS) {
    validateNullableStringField(patch, key, label)
  }

  validateEnumField(patch, 'theme', VALID_THEMES, 'theme')

  // accentColor: nullable enum with a distinct "or null" message suffix —
  // kept standalone rather than forced into validateEnumField.
  if ('accentColor' in patch && patch.accentColor !== undefined) {
    if (patch.accentColor !== null && !VALID_ACCENT_COLORS.includes(patch.accentColor)) {
      throw new Error(
        `uiState: accentColor must be one of ${VALID_ACCENT_COLORS.join(', ')} or null`
      )
    }
  }

  validateEnumField(patch, 'uiFontScale', VALID_FONT_SCALES, 'uiFontScale')
  validateEnumField(patch, 'soundPack', VALID_SOUND_PACKS, 'soundPack')

  validateNumericEnumField(
    patch,
    'statusPollIntervalSec',
    VALID_STATUS_POLL_INTERVALS,
    'statusPollIntervalSec'
  )

  validateBooleanField(patch, 'muteStatusNotifications', 'muteStatusNotifications')

  validateNumericEnumField(
    patch,
    'usagePollIntervalSec',
    VALID_USAGE_POLL_INTERVALS,
    'usagePollIntervalSec'
  )

  for (const { key, label } of BOOLEAN_FIELDS) {
    validateBooleanField(patch, key, label)
  }

  validateEnumField(patch, 'defaultSurface', VALID_DEFAULT_SURFACES, 'defaultSurface')

  // workbenchTreeWidth: numeric range check, one-of-a-kind shape.
  if ('workbenchTreeWidth' in patch && patch.workbenchTreeWidth !== undefined) {
    if (
      typeof patch.workbenchTreeWidth !== 'number' ||
      patch.workbenchTreeWidth < WORKBENCH_TREE_WIDTH_MIN ||
      patch.workbenchTreeWidth > WORKBENCH_TREE_WIDTH_MAX
    ) {
      throw new Error(
        `uiState: workbenchTreeWidth must be a number between ${WORKBENCH_TREE_WIDTH_MIN} and ${WORKBENCH_TREE_WIDTH_MAX}`
      )
    }
  }

  validateFilesViewPatch(patch)
}

// Split out of validatePatch to keep its cognitive complexity under the
// ratchet ceiling — the 5 Files-tab tree view-preference fields (Fix 2) are
// all boolean except filesSortOrder, which is a small enum.
function validateFilesViewPatch(patch: AppUiStatePatch): void {
  const boolFields = [
    'filesShowHidden',
    'filesDimGitignored',
    'filesWrapLines',
    'filesFlattenEmptyDirs'
  ] as const
  for (const key of boolFields) {
    if (key in patch && patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      throw new Error(`uiState: ${key} must be a boolean`)
    }
  }
  if ('filesSortOrder' in patch && patch.filesSortOrder !== undefined) {
    if (!VALID_FILES_SORT_ORDERS.includes(patch.filesSortOrder)) {
      throw new Error(
        `uiState: filesSortOrder must be one of ${VALID_FILES_SORT_ORDERS.join(', ')}`
      )
    }
  }
  if ('privacyMode' in patch && patch.privacyMode !== undefined) {
    if (typeof patch.privacyMode !== 'boolean') {
      throw new Error('uiState: privacyMode must be a boolean')
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cachedState: AppUiState | null = null

export function getAppUiState(): AppUiState {
  if (cachedState !== null) return cachedState
  const db = getDb()
  const row = db.prepare('SELECT * FROM app_ui_state WHERE id = 1').get() as AppUiStateRow
  cachedState = rowToRecord(row)
  return cachedState
}

export function updateAppUiState(patch: AppUiStatePatch): AppUiState {
  validatePatch(patch)

  const db = getDb()
  const now = Date.now()

  // Build a dynamic SET clause covering only the provided keys
  const columnMap: Record<keyof AppUiStatePatch, string> = {
    sidebarCollapsed: 'sidebar_collapsed',
    lastViewKind: 'last_view_kind',
    lastProjectId: 'last_project_id',
    lastWorkspaceId: 'last_workspace_id',
    // Panes v2 active-panel/active-layout persistence (issue #1)
    lastPanelId: 'last_panel_id',
    lastLayoutId: 'last_layout_id',
    // Projects-surface-scoped location memory
    projectsLastViewKind: 'projects_last_view_kind',
    projectsLastProjectId: 'projects_last_project_id',
    projectsLastWorkspaceId: 'projects_last_workspace_id',
    windowX: 'window_x',
    windowY: 'window_y',
    windowWidth: 'window_width',
    windowHeight: 'window_height',
    windowFullscreen: 'window_fullscreen',
    // Window behavior preferences (v11)
    restoreGeometry: 'restore_geometry',
    closeHides: 'close_hides',
    openAtLastView: 'open_at_last_view',
    // Sidebar behavior preferences (v12)
    pinnedSectionVisible: 'pinned_section_visible',
    workspaceCountInline: 'workspace_count_inline',
    sidebarWidth: 'sidebar_width',
    defaultProjectExpanded: 'default_project_expanded',
    // Projects surface — optional Workspaces board (kanban) visibility (U3).
    showWorkspacesBoard: 'show_workspaces_board',
    // Launch + hotkey (v18)
    launchAtLogin: 'launch_at_login',
    globalHotkey: 'global_hotkey',
    // Archive cap (v25)
    archivedWorkspaceLimit: 'archived_workspace_limit',
    // Hooks integration (v60)
    hooksIntegrationEnabled: 'hooks_integration_enabled',
    // Notification preferences (v29)
    notifyAttention: 'notify_attention',
    notifyStop: 'notify_stop',
    notifyAlways: 'notify_always',
    notifyRichSummary: 'notify_rich_summary',
    notifySuppressWhenFocused: 'notify_suppress_when_focused',
    // Persistent attention reminders (v30)
    notifyMaxAttentionRepeats: 'notify_max_attention_repeats',
    // In-progress watchdog (v31)
    inProgressWatchdogSec: 'in_progress_watchdog_sec',
    // Stale threshold (v54)
    staleAfterMinutes: 'stale_after_minutes',
    // Auto-close threshold (v57)
    autoCloseAfterMinutes: 'auto_close_after_minutes',
    // App picker preferences (v32)
    preferredEditorApp: 'preferred_editor_app',
    preferredTerminalApp: 'preferred_terminal_app',
    // Auto-prune cap (v33)
    maxLocalSessions: 'max_local_sessions',
    // Appearance (v36)
    theme: 'theme',
    accentColor: 'accent_color',
    uiFontScale: 'ui_font_scale',
    // Privacy (v37)
    fetchGithubAvatars: 'fetch_github_avatars',
    // Sound (v38)
    playInteractionSounds: 'play_interaction_sounds',
    // Sound pack (v39)
    soundPack: 'sound_pack',
    // Updates (v40)
    autoCheckUpdates: 'auto_check_updates',
    // Status polling preferences (v42)
    statusPollIntervalSec: 'status_poll_interval_sec',
    muteStatusNotifications: 'mute_status_notifications',
    usagePollIntervalSec: 'usage_poll_interval_sec',
    // Workspace footer visibility (v45)
    showWorkspaceFooter: 'show_workspace_footer',
    // Files-tab editor save mode (v62)
    filesAutoSave: 'files_auto_save',
    // Files-tab tree view preferences (v67)
    filesShowHidden: 'files_show_hidden',
    filesDimGitignored: 'files_dim_gitignored',
    filesWrapLines: 'files_wrap_lines',
    filesSortOrder: 'files_sort_order',
    filesFlattenEmptyDirs: 'files_flatten_empty_dirs',
    // Workbench Git-tab diff view preferences (v68)
    gitDiffWrapLines: 'git_diff_wrap_lines',
    // Token-hover popover (Pierre Batch 3)
    tokenHoverEnabled: 'token_hover_enabled',
    // Per-hunk "Revert" on the working-tree diff
    hunkActionsEnabled: 'hunk_actions_enabled',
    // Panes v2 top-level view visibility toggles
    showPanesView: 'show_panes_view',
    showWorkspacesView: 'show_workspaces_view',
    // Open-at-launch surface
    defaultSurface: 'default_surface',
    // Workbench tree/code split pane width (v69)
    workbenchTreeWidth: 'workbench_tree_width',
    // Diagnostics capture toggles (v56)
    diagError: 'diag_error',
    diagLifecycle: 'diag_lifecycle',
    diagPerf: 'diag_perf',
    diagAnomaly: 'diag_anomaly',
    // Trace capture (v61)
    diagTrace: 'diag_trace',
    // GitHub username greeting (D4)
    githubUsername: 'github_username',
    // Managed routing proxy (v70)
    routingProxyEnabled: 'routing_proxy_enabled',
    // Model-name aliasing (model-routing unit 08)
    modelAliasesEnabled: 'model_aliases_enabled',
    // Privacy mode (v66)
    privacyMode: 'privacy_mode'
  }

  const setClauses: string[] = []
  const values: unknown[] = []

  for (const key of Object.keys(patch) as (keyof AppUiStatePatch)[]) {
    const col = columnMap[key]
    if (!col) continue
    setClauses.push(`${col} = ?`)
    const val = patch[key]
    // Coerce booleans to integers for SQLite
    values.push(typeof val === 'boolean' ? (val ? 1 : 0) : val)
  }

  if (setClauses.length === 0) {
    // Nothing to update — return cached or fresh state
    return cachedState ?? getAppUiState()
  }

  setClauses.push('updated_at = ?')
  values.push(now)
  values.push(1) // WHERE id = 1

  db.prepare(`UPDATE app_ui_state SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)

  const row = db.prepare('SELECT * FROM app_ui_state WHERE id = 1').get() as AppUiStateRow
  cachedState = rowToRecord(row)
  return cachedState
}
