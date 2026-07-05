// Canonical UI-state default values. Single source of truth for the fallback
// literals that the DB schema (src/main/db/schema.ts) mirrors as SQL DEFAULTs
// and that the main/renderer fallback sites (?? fallbacks, useState initializers,
// clamp bounds) previously hardcoded independently.
//
// NOTE: This file must import nothing from main/preload/renderer — it is a leaf
// in the shared layer (dependency-cruiser enforces the layering).

export const UI_STATE_DEFAULTS = {
  staleAfterMinutes: 60,
  statusPollIntervalSec: 1800,
  sidebarWidth: 256,
  archivedWorkspaceLimit: 20,
  // Files-tab tree view preferences (v67) — mirrors app_ui_state's
  // files_show_hidden/files_dim_gitignored/files_wrap_lines/files_sort_order/
  // files_flatten_empty_dirs SQL DEFAULTs in schema.ts. flattenEmptyDirs
  // defaults to true (Fix 3 — single-child dir chains collapse by default).
  filesShowHidden: false,
  filesDimGitignored: true,
  filesWrapLines: true,
  filesSortOrder: 'default' as const,
  filesFlattenEmptyDirs: true,
  // Workbench Git-tab diff view preferences (v68) — mirrors app_ui_state's
  // git_diff_wrap_lines SQL DEFAULT in schema.ts.
  gitDiffWrapLines: true
} as const

// Valid values for app_ui_state.files_sort_order — mirrors TreeSortOrder in
// TreeOptionsPopover.tsx and the SQL CHECK constraint in schema.ts.
export const VALID_FILES_SORT_ORDERS = ['default', 'name'] as const

// Valid values for the status-poller interval (seconds). The UI Select in
// OrpheusStatusSection.tsx must only offer values from this set, and the
// main-process validators (uiState.ts, claudeStatus.ts) reject anything else.
export const VALID_STATUS_POLL_INTERVALS_SEC: number[] = [300, 600, 900, 1800, 3600, 7200, 10800]

// Sidebar-width clamp bounds (px). Mirrored by the SQL CHECK constraint on
// app_ui_state.sidebar_width in schema.ts.
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 480
