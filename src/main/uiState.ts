import { getDb } from './db'
import type {
  AppUiState,
  AppUiStatePatch,
  AppViewKind,
  Theme,
  AccentColor,
  UiFontScale,
  SoundPack
} from '../shared/types'
import {
  UI_STATE_DEFAULTS,
  VALID_STATUS_POLL_INTERVALS_SEC,
  VALID_FILES_SORT_ORDERS,
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
  // Workbench tree/code split pane width (v69)
  workbench_tree_width: number
  // Diagnostics capture toggles (v56)
  diag_error: number | null
  diag_lifecycle: number | null
  diag_perf: number | null
  diag_anomaly: number | null
  // Trace capture (v61)
  diag_trace: number | null
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
    // Workbench tree/code split pane width (v69) — shared Files+Git divider width
    workbenchTreeWidth: clampedTreeWidth,
    // Diagnostics capture toggles (v56)
    diagError: row.diag_error == null ? true : row.diag_error === 1,
    diagLifecycle: row.diag_lifecycle === 1,
    diagPerf: row.diag_perf === 1,
    diagAnomaly: row.diag_anomaly === 1,
    // Trace capture (v61) — off by default
    diagTrace: row.diag_trace === 1,
    updatedAt: row.updated_at
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_VIEW_KINDS: AppViewKind[] = ['sessions', 'project', 'workspace']
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

function validatePatch(patch: AppUiStatePatch): void {
  if ('lastViewKind' in patch) {
    if (!VALID_VIEW_KINDS.includes(patch.lastViewKind as AppViewKind)) {
      throw new Error(`uiState: lastViewKind must be one of ${VALID_VIEW_KINDS.join(', ')}`)
    }
  }
  if ('lastProjectId' in patch) {
    if (patch.lastProjectId !== null && typeof patch.lastProjectId !== 'string') {
      throw new Error('uiState: lastProjectId must be a string or null')
    }
  }
  if ('lastWorkspaceId' in patch) {
    if (patch.lastWorkspaceId !== null && typeof patch.lastWorkspaceId !== 'string') {
      throw new Error('uiState: lastWorkspaceId must be a string or null')
    }
  }
  if ('theme' in patch && patch.theme !== undefined) {
    if (!VALID_THEMES.includes(patch.theme)) {
      throw new Error(`uiState: theme must be one of ${VALID_THEMES.join(', ')}`)
    }
  }
  if ('accentColor' in patch && patch.accentColor !== undefined) {
    if (patch.accentColor !== null && !VALID_ACCENT_COLORS.includes(patch.accentColor)) {
      throw new Error(
        `uiState: accentColor must be one of ${VALID_ACCENT_COLORS.join(', ')} or null`
      )
    }
  }
  if ('uiFontScale' in patch && patch.uiFontScale !== undefined) {
    if (!VALID_FONT_SCALES.includes(patch.uiFontScale)) {
      throw new Error(`uiState: uiFontScale must be one of ${VALID_FONT_SCALES.join(', ')}`)
    }
  }
  if ('soundPack' in patch && patch.soundPack !== undefined) {
    if (!VALID_SOUND_PACKS.includes(patch.soundPack)) {
      throw new Error(`uiState: soundPack must be one of ${VALID_SOUND_PACKS.join(', ')}`)
    }
  }
  if ('statusPollIntervalSec' in patch && patch.statusPollIntervalSec !== undefined) {
    if (
      typeof patch.statusPollIntervalSec !== 'number' ||
      !VALID_STATUS_POLL_INTERVALS.includes(patch.statusPollIntervalSec)
    ) {
      throw new Error(
        `uiState: statusPollIntervalSec must be one of ${VALID_STATUS_POLL_INTERVALS.join(', ')}`
      )
    }
  }
  if ('muteStatusNotifications' in patch && patch.muteStatusNotifications !== undefined) {
    if (typeof patch.muteStatusNotifications !== 'boolean') {
      throw new Error('uiState: muteStatusNotifications must be a boolean')
    }
  }
  if ('showWorkspaceFooter' in patch && patch.showWorkspaceFooter !== undefined) {
    if (typeof patch.showWorkspaceFooter !== 'boolean') {
      throw new Error('uiState: showWorkspaceFooter must be a boolean')
    }
  }
  if ('filesAutoSave' in patch && patch.filesAutoSave !== undefined) {
    if (typeof patch.filesAutoSave !== 'boolean') {
      throw new Error('uiState: filesAutoSave must be a boolean')
    }
  }
  if ('gitDiffWrapLines' in patch && patch.gitDiffWrapLines !== undefined) {
    if (typeof patch.gitDiffWrapLines !== 'boolean') {
      throw new Error('uiState: gitDiffWrapLines must be a boolean')
    }
  }
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
    // Workbench tree/code split pane width (v69)
    workbenchTreeWidth: 'workbench_tree_width',
    // Diagnostics capture toggles (v56)
    diagError: 'diag_error',
    diagLifecycle: 'diag_lifecycle',
    diagPerf: 'diag_perf',
    diagAnomaly: 'diag_anomaly',
    // Trace capture (v61)
    diagTrace: 'diag_trace'
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
