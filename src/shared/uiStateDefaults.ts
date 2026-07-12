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
  // files_flatten_empty_dirs SQL DEFAULTs in schema.ts. flattenEmptyDirs is a
  // SHARED Files+Git setting (see GitDiffOptionsPopover's "Flatten empty
  // folders" toggle) and now defaults to FALSE — each folder gets its own
  // expandable row rather than collapsing single-child dir chains into an
  // unreadable breadcrumb (live QA finding on the Git tab's tree).
  filesShowHidden: false,
  filesDimGitignored: true,
  filesWrapLines: true,
  filesSortOrder: 'default' as const,
  filesFlattenEmptyDirs: false,
  // Workbench Git-tab diff view preferences (v68) — mirrors app_ui_state's
  // git_diff_wrap_lines SQL DEFAULT in schema.ts.
  gitDiffWrapLines: true,
  // Token-hover popover (Pierre Batch 3) — mirrors app_ui_state's
  // token_hover_enabled SQL DEFAULT in schema.ts. Opt-in, default OFF (was
  // always-on and intrusive while just reading — see GitDiffOptionsPopover /
  // TreeOptionsPopover "Token hover" toggle).
  tokenHoverEnabled: false,
  // Per-hunk "Revert" on the working-tree diff — mirrors app_ui_state's
  // hunk_actions_enabled SQL DEFAULT in schema.ts. Opt-in, default OFF (it
  // mutates the working tree — see GitDiffOptionsPopover's "Hunk revert"
  // toggle and docs/learnings/hunk-accept-reject.md).
  hunkActionsEnabled: false,
  // Panes v2 top-level view visibility toggles — mirrors app_ui_state's
  // show_panes_view/show_workspaces_view SQL DEFAULTs in schema.ts. BOTH
  // default shown so the sidebar always offers a way to switch between the
  // Panes view and the Workspaces (claude projects) view; either can be
  // hidden in Settings > Navigation.
  // DEPRECATED — superseded by defaultSurface below. No longer read by the
  // sidebar; kept (dead but harmless) so old DB rows/types stay valid.
  showPanesView: true,
  showWorkspacesView: true,
  // Open-at-launch surface (rail vocabulary) — mirrors app_ui_state's
  // default_surface SQL DEFAULT in schema.ts. Replaces the deprecated
  // showPanesView/showWorkspacesView toggles above as the single "which
  // surface does the app land on at startup" preference.
  defaultSurface: 'projects' as const,
  // Workbench tree/code split pane width (v69) — mirrors app_ui_state's
  // workbench_tree_width SQL DEFAULT in schema.ts. Shared by FilesTab's tree
  // and GitTab's DiffTreePane (one draggable divider width for both).
  workbenchTreeWidth: 240,
  // Dashboard "Usage" card background poll interval (Dashboard D3) — mirrors
  // app_ui_state's usage_poll_interval_sec SQL DEFAULT in schema.ts. Default
  // 10min; deliberately coarser floor/ceiling than statusPollIntervalSec
  // above since this hits an internal, undocumented Anthropic endpoint the
  // user doesn't want hammered (see src/main/claudeUsage.ts's rate-limit
  // discipline).
  usagePollIntervalSec: 600,
  // GitHub username greeting (D4) — mirrors app_ui_state's github_username
  // SQL default (none/NULL) in schema.ts. Null until the first successful
  // `gh api user` refresh.
  githubUsername: null
} as const

// Draggable tree-pane width clamp bounds (px), shared by FilesTab and GitTab.
// Mirrors the SQL CHECK constraint on app_ui_state.workbench_tree_width in
// schema.ts.
export const WORKBENCH_TREE_WIDTH_MIN = 160
export const WORKBENCH_TREE_WIDTH_MAX = 560

// Valid values for app_ui_state.files_sort_order — mirrors TreeSortOrder in
// TreeOptionsPopover.tsx and the SQL CHECK constraint in schema.ts.
export const VALID_FILES_SORT_ORDERS = ['default', 'name'] as const

// Valid values for app_ui_state.default_surface — mirrors the SQL CHECK
// constraint in schema.ts. Which top-level surface the app opens on launch.
export const VALID_DEFAULT_SURFACES = ['dashboard', 'projects', 'panes'] as const

// Valid values for the status-poller interval (seconds). The UI Select in
// OrpheusStatusSection.tsx must only offer values from this set, and the
// main-process validators (uiState.ts, claudeStatus.ts) reject anything else.
export const VALID_STATUS_POLL_INTERVALS_SEC: number[] = [300, 600, 900, 1800, 3600, 7200, 10800]

// Valid values for the Claude usage background poller interval (seconds). The
// UI Select in OrpheusStatusSection.tsx must only offer values from this set,
// and the main-process validators (uiState.ts, usagePoller.ts) reject
// anything else. No sub-5min option and a lower ceiling than the status
// poller — this hits an internal endpoint we deliberately don't hammer.
export const VALID_USAGE_POLL_INTERVALS_SEC: number[] = [300, 600, 900, 1800, 3600]

// Sidebar-width clamp bounds (px). Mirrored by the SQL CHECK constraint on
// app_ui_state.sidebar_width in schema.ts.
export const SIDEBAR_WIDTH_MIN = 200
export const SIDEBAR_WIDTH_MAX = 480
