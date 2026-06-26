import { APP_NAME, APP_ID, isDev } from './appMode'
import {
  startSessionStateService,
  setSessionReadyHandler,
  isWorkspaceSessionReady,
  getLiveSessionState
} from './sessionState'
import { monitorEventLoopDelay } from 'perf_hooks'
import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  globalShortcut,
  powerMonitor,
  Notification
} from 'electron'

// Set app name before anything reads app.getPath('userData'). Electron derives
// userData from app.name, which defaults to package.json "name" ("orpheus") for
// both variants. Setting it here gives each build its own isolated data directory:
//   prod → ~/Library/Application Support/Orpheus/
//   dev  → ~/Library/Application Support/Orpheus Dev/
app.setName(APP_NAME)
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import * as os from 'node:os'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DoctorResult, GitStatus, HealthReport } from '../shared/types'
import { TRAFFIC_LIGHT_INSET } from '../shared/windowChrome'
import {
  getGitStatus,
  listBranches,
  listCommits,
  countCommits,
  startGitWatch,
  stopGitWatch,
  stopAllGitWatches
} from './git'
import { getPrForBranch } from './github'
import { getDb } from './db'
import {
  listProjects,
  addProject,
  openProject,
  deleteProject,
  renameProject,
  setProjectExpandedInSidebar,
  reorderProjects
} from './projects'
import { refreshGithubData } from './githubAvatar'
import {
  listSessionsForProject,
  listSessionsForProjectPaged,
  listAllSessions,
  setSessionStatus,
  createWorkspaceResumingSession,
  refreshSessionMetadata,
  deleteSession,
  getContextBudget
} from './sessions'
import {
  listWorkspacesForProject,
  createWorkspace,
  openWorkspace,
  getWorkspace,
  setWorkspacePinned,
  archiveWorkspace,
  closeWorkspace,
  reopenWorkspace,
  renameWorkspace,
  reorderWorkspaces,
  listAllPinned,
  setWorkspaceLastTitle,
  getAllWorkspaceLastTitles,
  resetTransientStatusesOnStartup
} from './workspaces'
import {
  getClaudeGlobalSettings,
  updateClaudeGlobalSettings,
  composeClaudeLaunch
} from './claudeSettings'
import { getClaudeProjectSettings, updateClaudeProjectSettings } from './claudeProjectSettings'
import {
  getClaudeWorkspaceSettings,
  updateClaudeWorkspaceSettings,
  invalidateClaudeWorkspaceSettingsCache
} from './claudeWorkspaceSettings'
import { getAppUiState, updateAppUiState } from './uiState'
import { getClaudeAuthState, updateClaudeAuth, testAnthropicConnection } from './claudeAuth'
import { listMcpServers, addMcpServer, updateMcpServer, deleteMcpServer } from './mcp'
import {
  listSlashCommands,
  listSubagents,
  addSlashCommand,
  updateSlashCommand,
  deleteSlashCommand,
  addSubagent,
  updateSubagent,
  deleteSubagent
} from './claudeAgents'
import { listClaudeHooks, addHook, updateHook, deleteHook } from './claudeHooks'
import { onActivityBatch } from './activitySink'
import {
  startNotifyServer,
  ensureManagedHooks,
  uninstallManagedHooks,
  countManagedHooks,
  clearWorkspaceActivity,
  invalidateWatchdogCache,
  getWorkspaceActivity,
  setAutoCloseHandler
} from './orpheusNotify'
import {
  configureLoadingOverlay,
  show as showLoadingOverlay,
  hide as hideLoadingOverlay
} from './loadingOverlay'
import type { Theme } from '../shared/types'
import {
  setCurrentlyViewedWorkspace,
  getCurrentlyViewedWorkspace,
  fireTestNotification,
  cancelAttentionRetry
} from './osNotifications'
import {
  checkForUpdates,
  installUpdate,
  relaunchApp,
  startAutoCheckLoop,
  stopAutoCheckLoop,
  getUpdateSnapshot
} from './updates'
import {
  getStatusSnapshot,
  startStatusPoller,
  stopStatusPoller,
  refreshStatusNow,
  rescheduleStatusPoll
} from './claudeStatus'
import { showContextMenu } from './contextMenu'
import {
  revealInFinder,
  openInEditor,
  openTerminal,
  copyToClipboard,
  listEditorApps,
  listTerminalApps,
  getUserShellPath,
  getCachedShellPath
} from './shellHelpers'
import type {
  SessionStatus,
  SessionsPagedRequest,
  ClaudeGlobalSettingsPatch,
  AppUiStatePatch,
  ClaudeProjectSettingsOverrides,
  ClaudeWorkspaceSettingsOverrides,
  ClaudeAuthPatch,
  ClaudeHookDraft,
  McpServerDraft,
  ClaudeSlashCommandDraft,
  ClaudeSubagentDraft,
  ContextMenuNativeItem,
  GhosttyUserConfig,
  WorkspaceRecord
} from '../shared/types'
import type { ClaudeLaunch } from './claudeSettings'
import { loadOrpheusSurface, buildMountEnv } from './orpheusSurfaceAdapter'
import type { GhosttySurfaceAddon, SurfaceRect } from '../../packages/ghostty-surface/index'
import * as terminalActions from './actions/terminal'
import {
  writeGhosttyConfigFile,
  getGhosttyUserConfig,
  updateGhosttyUserConfig
} from './ghosttyConfig'
import type { TerminalSendKeyDescriptor, ActionInvocation } from '../shared/types'
import {
  bootActions,
  invoke as actionsInvoke,
  list as actionsList,
  getAuditHistory,
  setTerminalAddonRef,
  startSubscription,
  stopSubscription,
  registerWebContentsCleanup
} from './actions/index'
import { evictAccumulator } from './actions/session'
import {
  listGlobal as listGlobalFooterActions,
  listForProject as listProjectFooterActions,
  listForWorkspace as listWorkspaceFooterActions,
  listMerged as listMergedFooterActions,
  create as createFooterAction,
  update as updateFooterAction,
  remove as removeFooterAction,
  reorder as reorderFooterActions,
  seedDefaultFooterActions,
  resetToDefaults as resetFooterActionsToDefaults
} from './footerActions'
import type { FooterActionScope, FooterActionDraft } from '../shared/types'
import { refreshFromModelsDev } from './pricing'
import {
  startDiagnostics,
  stopDiagnostics,
  logDiagMain,
  ingestDiagEvent,
  setDiagCategoryFlags,
  queryDiagnostics,
  diag
} from './diagnostics'
import { openDiagConsole } from './diagConsoleWindow'
import { DIAG_EVENTS } from '../shared/diagEvents'
import { formatTraceTree, formatEventLine } from '../shared/diagFormat'
import type { DiagRow } from '../shared/types'
import {
  startPowerAwake,
  getKeepAwakeState,
  setKeepAwakeMode,
  setKeepAwakeDisplayOn,
  startKeepAwakeTimer
} from './powerAwake'
import type { KeepAwakeBaseMode } from '../shared/types'

// ---------------------------------------------------------------------------
// Launch snapshot + dirty tracking
// ---------------------------------------------------------------------------

// Keyed by workspaceId — snapshot of the ClaudeLaunch used at terminal:mount time.
const launchSnapshots = new Map<string, ClaudeLaunch>()
const dirtyWorkspaces = new Set<string>()

// Fallback auto-hide timers for loading overlays — ensures a stuck overlay
// is always dismissed even if claude never registers a session file.
const overlayFallbackTimers = new Map<string, NodeJS.Timeout>()

let notifyServer: { sockPath: string; close: () => void } | null = null
let sessionStateService: { stop: () => void } | null = null
let powerAwakeCleanup: (() => void) | null = null

/**
 * Declarative reconcile: reads hooksIntegrationEnabled and either starts the
 * notify server + installs managed hooks (enabled) or shuts down the server +
 * removes managed hooks (disabled). Safe to call multiple times.
 */
function reconcileHooks(): void {
  const enabled = getAppUiState().hooksIntegrationEnabled
  if (enabled) {
    if (!notifyServer) {
      try {
        notifyServer = startNotifyServer()
      } catch (err) {
        console.error('[orpheusNotify] failed to start notify server:', err)
      }
    }
    try {
      ensureManagedHooks()
    } catch (err) {
      console.error('[orpheusNotify] failed to install managed hooks:', err)
    }
  } else {
    if (notifyServer) {
      notifyServer.close()
      notifyServer = null
    }
    try {
      uninstallManagedHooks()
    } catch (err) {
      console.error('[orpheusNotify] failed to uninstall managed hooks:', err)
    }
  }
}

// Cached main window reference — avoids BrowserWindow.getAllWindows() in hot paths.
let mainWindowRef: BrowserWindow | null = null

function getMainWindow(): BrowserWindow | null {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) return mainWindowRef
  // Fallback — should only happen if the window was destroyed unexpectedly.
  mainWindowRef = BrowserWindow.getAllWindows()[0] ?? null
  return mainWindowRef
}

// Keyed by workspaceId — most recent terminal title from OSC 0/2.
const workspaceTitles = new Map<string, string>()

let titleCallbackRegistered = false
let loadingOverlayWired = false

// Theme palettes for the loading overlay. Must mirror src/renderer/src/assets/main.css.
// RGB tuples (0-255) so the native side doesn't need a hex parser. `isDark` picks
// the NSAppearance for the NSVisualEffectView blur backdrop.
type LoadingThemePalette = {
  backdrop: [number, number, number]
  card: [number, number, number]
  textPrimary: [number, number, number]
  textSecondary: [number, number, number]
  border: [number, number, number]
  isDark: boolean
  // Extra dark/light tint above the macOS blur. macOS dark blur reads as
  // bluish-gray over a pure-black eclipse terminal — looks LIGHTER than the
  // surrounding content. tintAlpha deepens it back to true black for eclipse.
  // 0 = blur only (no extra tint).
  tintAlpha: number
}
const THEME_PALETTES: Record<Theme, LoadingThemePalette> = {
  midnight: {
    backdrop: [0x0b, 0x0b, 0x0c],
    card: [0x16, 0x16, 0x1a],
    textPrimary: [0xf4, 0xf4, 0xf5],
    textSecondary: [0xa1, 0xa1, 0xaa],
    border: [0x27, 0x27, 0x2a],
    isDark: true,
    tintAlpha: 0
  },
  daylight: {
    backdrop: [0xfa, 0xfa, 0xf7],
    card: [0xff, 0xff, 0xff],
    textPrimary: [0x18, 0x18, 0x1b],
    textSecondary: [0x52, 0x52, 0x5b],
    border: [0xd4, 0xd4, 0xd0],
    isDark: false,
    tintAlpha: 0
  },
  eclipse: {
    backdrop: [0x00, 0x00, 0x00],
    card: [0x0a, 0x0a, 0x0a],
    textPrimary: [0xff, 0xff, 0xff],
    textSecondary: [0xb4, 0xb4, 0xb4],
    border: [0x1f, 0x1f, 0x1f],
    isDark: true,
    tintAlpha: 0.35
  }
}

// ---------------------------------------------------------------------------
// Popover theme palettes — separate from loading overlay (different token set:
// no backdrop/tintAlpha; adds textMuted + accent).
// surface-overlay tokens are the solid card background for the 3 themes.
// ---------------------------------------------------------------------------
type PopoverThemePalette = {
  card: [number, number, number]
  textPrimary: [number, number, number]
  textSecondary: [number, number, number]
  textMuted: [number, number, number]
  border: [number, number, number]
  accent: [number, number, number]
  isDark: boolean
}

const POPOVER_THEME_PALETTES: Record<Theme, PopoverThemePalette> = {
  midnight: {
    card: [0x1c, 0x1c, 0x1f], // surface-overlay: slightly lighter than page bg
    textPrimary: [0xf4, 0xf4, 0xf5], // zinc-100
    textSecondary: [0xa1, 0xa1, 0xaa], // zinc-400
    textMuted: [0x71, 0x71, 0x7a], // zinc-500
    border: [0x3f, 0x3f, 0x46], // zinc-700 (border-white/10 approximation on dark)
    accent: [0x60, 0xa5, 0xfa], // blue-400
    isDark: true
  },
  daylight: {
    card: [0xff, 0xff, 0xff], // white
    textPrimary: [0x18, 0x18, 0x1b], // zinc-900
    textSecondary: [0x52, 0x52, 0x5b], // zinc-600
    textMuted: [0xa1, 0xa1, 0xaa], // zinc-400
    border: [0xe4, 0xe4, 0xe7], // zinc-200
    accent: [0x25, 0x63, 0xeb], // blue-600
    isDark: false
  },
  eclipse: {
    card: [0x10, 0x10, 0x10], // near-black surface
    textPrimary: [0xff, 0xff, 0xff],
    textSecondary: [0xb4, 0xb4, 0xb4],
    textMuted: [0x71, 0x71, 0x71],
    border: [0x2a, 0x2a, 0x2a],
    accent: [0x60, 0xa5, 0xfa], // blue-400
    isDark: true
  }
}

let popoverWired = false

// PR URL per workspace, captured when a popover is shown so the popover
// action callback can open it directly via shell.openExternal — avoids the
// fragile renderer round-trip whose Map entry is cleared before the click.
const popoverPrUrlByWorkspace = new Map<string, string>()

function applyPopoverTheme(theme: Theme): void {
  if (!terminalAddon) return
  const palette = POPOVER_THEME_PALETTES[theme] ?? POPOVER_THEME_PALETTES.midnight
  terminalAddon.setPopoverTheme(palette)
  console.log('[popover] theme applied:', theme)
}

function ensurePopoverWiring(addon: GhosttySurfaceAddon): void {
  if (popoverWired) return
  popoverWired = true
  const currentTheme = getAppUiState().theme as Theme
  addon.setPopoverTheme(POPOVER_THEME_PALETTES[currentTheme] ?? POPOVER_THEME_PALETTES.midnight)
  // Wire the action callback: fires when a clickable element (Phase B: PR chip)
  // inside a native popover is tapped. The identifier encodes "workspaceId::elementId".
  addon.setPopoverActionCallback((identifier: string) => {
    console.log('[popover] action callback:', identifier)
    // Open the PR directly from main on a PR-chip click — the renderer Map that
    // used to hold the URL is cleared before the click lands, so main owns this.
    if (identifier.endsWith('::pr')) {
      const wsId = identifier.slice(0, identifier.lastIndexOf('::'))
      const url = popoverPrUrlByWorkspace.get(wsId)
      if (url) shell.openExternal(url)
    }
    // Phase B: parse identifier and route action (e.g. open PR URL).
    // For now, broadcast to renderer so it can handle it.
    getMainWindow()?.webContents.send('popover:actionClicked', { identifier })
  })
}

function applyLoadingOverlayTheme(theme: Theme): void {
  if (!terminalAddon) return // addon not loaded yet — startup wiring will apply it on first mount
  const palette = THEME_PALETTES[theme] ?? THEME_PALETTES.midnight
  terminalAddon.setLoadingTheme(palette)
  console.log('[loadingOverlay] theme applied:', theme)
}

function ensureLoadingOverlayWiring(addon: GhosttySurfaceAddon): void {
  if (loadingOverlayWired) return
  loadingOverlayWired = true
  // Push the current app theme to the native side so the overlay matches.
  const currentTheme = getAppUiState().theme as Theme
  addon.setLoadingTheme(THEME_PALETTES[currentTheme] ?? THEME_PALETTES.midnight)
  // Bridge the state machine to the native addon's overlay calls.
  configureLoadingOverlay((workspaceId, state, copy) => {
    addon.setLoadingOverlay(workspaceId, state, copy)
  })
  // Native overlay's action button (e.g. "Show terminal anyway", "Dismiss")
  // dismisses the overlay regardless of which state it was in.
  addon.setLoadingActionCallback((workspaceId: string) => {
    console.log('[loadingOverlay] action click', workspaceId)
    hideLoadingOverlay(workspaceId)
  })
  // Session file reaching a concrete status (busy|idle|waiting) is the canonical
  // "claude is ready" signal — dismiss the overlay. Min-show debounce in the
  // state machine prevents flash on fast mounts.
  setSessionReadyHandler((workspaceId: string) => {
    hideLoadingOverlay(workspaceId)
  })
}

function ensureTitleCallback(addon: GhosttySurfaceAddon): void {
  if (titleCallbackRegistered) return
  titleCallbackRegistered = true
  addon.setTitleCallback((workspaceId: string, title: string) => {
    // Claude Code prefixes titles with a cycling spinner glyph (✱ ✶ ✻ ✺ ✦ …)
    // and a space. Strip leading non-letter/non-digit characters so the
    // sidebar shows clean text and so our own loader UI can layer in front.
    // Stripping also collapses the spinner animation to one stable string
    // ("✱ Loading" → "✶ Loading" → … all become "Loading"), which the
    // dedupe below uses to avoid hammering the DB on every frame.

    const cleaned = (title ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim() || null

    // Skip if nothing changed — guards the per-frame spinner churn.
    if (workspaceTitles.get(workspaceId) === (cleaned ?? undefined)) return
    if (!cleaned && !workspaceTitles.has(workspaceId)) return

    console.log('[title] native fired', { workspaceId, raw: title, cleaned })
    if (cleaned) {
      workspaceTitles.set(workspaceId, cleaned)
    } else {
      workspaceTitles.delete(workspaceId)
    }
    // Persist so the next launch can seed from the DB and the sidebar/header
    // shows the prior title instead of the default workspace name.
    try {
      setWorkspaceLastTitle(workspaceId, cleaned)
    } catch (err) {
      console.error('[title] failed to persist last_title', err)
    }
    getMainWindow()?.webContents.send('workspace:titleChanged', { workspaceId, title: cleaned })
  })
  addon.setOcclusionCallback((workspaceId: string, occluded: boolean) => {
    getMainWindow()?.webContents.send('terminal:sleepStateChanged', {
      workspaceId,
      sleeping: occluded
    })
  })
  // Liveness ticks (global) for the renderer freeze watchdog: inputTick bumps on
  // native key/mouse input, liveTick bumps on every draw/IO wakeup. Throttled
  // native-side. The watchdog applies them to the active workspace.
  addon.setLivenessCallback(
    (workspaceId: string, inputTick: number, liveTick: number, occluded: boolean) => {
      getMainWindow()?.webContents.send('terminal:liveness', {
        workspaceId,
        inputTick,
        liveTick,
        occluded
      })
    }
  )
  // Diagnostic: forward every action_cb tag to the renderer for visibility
  // via DevTools console. Gated on ORPHEUS_DEBUG_ACTION_TRACE=1 because this
  // fires at 60-120 Hz (every RENDER action) and is heavy in production.
  if (process.env['ORPHEUS_DEBUG_ACTION_TRACE'] === '1') {
    addon.setActionTraceCallback((tagName: string) => {
      const win = getMainWindow()
      win?.webContents.send('addon:actionTrace', { tagName })
    })
  }
}

function launchEquals(a: ClaudeLaunch, b: ClaudeLaunch): boolean {
  if (a.flags !== b.flags || a.settingsJson !== b.settingsJson) return false
  const ak = Object.keys(a.env).sort()
  const bk = Object.keys(b.env).sort()
  if (ak.length !== bk.length) return false
  for (let i = 0; i < ak.length; i++) {
    if (ak[i] !== bk[i]) return false
    if (a.env[ak[i] as string] !== b.env[ak[i] as string]) return false
  }
  return true
}

function broadcastDirty(workspaceId: string, dirty: boolean): void {
  getMainWindow()?.webContents.send('workspace:dirtyChanged', { workspaceId, dirty })
}

function setDirty(workspaceId: string, dirty: boolean): void {
  const was = dirtyWorkspaces.has(workspaceId)
  if (dirty) dirtyWorkspaces.add(workspaceId)
  else dirtyWorkspaces.delete(workspaceId)
  if (was !== dirty) broadcastDirty(workspaceId, dirty)
}

// ---------------------------------------------------------------------------
// Unified per-workspace teardown
// ---------------------------------------------------------------------------

// Evicts all per-workspace in-memory state for a workspace that has been
// archived, destroyed, or removed. Idempotent — safe to call multiple times
// for the same workspaceId. All .delete() calls are already idempotent.
//
// NOTE: only call this for provably-dead workspaces (archived / project-removed).
// Do NOT call on terminal:destroy alone, because destroy is also issued during
// live restarts (WorkspaceView.handleRestart) where the workspace stays alive.
function teardownWorkspaceResources(workspaceId: string, cwd: string | null): void {
  hideLoadingOverlay(workspaceId)
  cancelAttentionRetry(workspaceId)
  clearWorkspaceActivity(workspaceId)
  launchSnapshots.delete(workspaceId)
  if (dirtyWorkspaces.delete(workspaceId)) broadcastDirty(workspaceId, false)
  evictAccumulator(workspaceId)
  invalidateClaudeWorkspaceSettingsCache(workspaceId)
  if (workspaceTitles.delete(workspaceId)) {
    getMainWindow()?.webContents.send('workspace:titleChanged', { workspaceId, title: null })
  }
  if (cwd) stopGitWatch(workspaceId, cwd)
}

function performClose(id: string): WorkspaceRecord | undefined {
  const ws = getWorkspace(id)
  // Capture the live terminal title BEFORE teardownWorkspaceResources clears it,
  // so the closed workspace keeps its name in the sidebar.
  const lastTitle = workspaceTitles.get(id) ?? null
  if (terminalAddon) {
    try {
      terminalAddon.destroy(id)
    } catch {
      // Surface not mounted or already destroyed — ignore.
    }
  }
  teardownWorkspaceResources(id, ws?.cwd ?? null)
  return closeWorkspace(id, lastTitle)
}

function recomputeDirty(): void {
  if (launchSnapshots.size === 0) return
  // Fetch global settings once — shared across all workspaces in the loop.
  // Each composeClaudeLaunch would otherwise run a redundant DB read.
  const globalSettings = getClaudeGlobalSettings()
  for (const [workspaceId, snap] of launchSnapshots.entries()) {
    const ws = getWorkspace(workspaceId)
    if (!ws) continue
    const fresh = composeClaudeLaunch(ws.projectId, workspaceId, globalSettings)
    setDirty(workspaceId, !launchEquals(snap, fresh))
  }
}

// ---------------------------------------------------------------------------
// Claude session-ID capture (v26)
// ---------------------------------------------------------------------------

// Note: captureWorkspaceSessionId + encodedClaudeCwd were removed in v0.0.3.
// They polled ~/.claude/projects/<encoded-cwd>/ to back-fill a workspace's
// session id after first mount, but since the v26 pre-assignment refactor
// createWorkspace generates the UUID up-front so that path was unreachable.

// ---------------------------------------------------------------------------
// Launch at login + global hotkey helpers
// ---------------------------------------------------------------------------

function applyLaunchAtLogin(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: false })
}

let registeredHotkey: string = ''

function applyGlobalHotkey(hotkey: string): boolean {
  // Unregister previous if changed
  if (registeredHotkey && registeredHotkey !== hotkey) {
    globalShortcut.unregister(registeredHotkey)
    registeredHotkey = ''
  }
  if (!hotkey) return true
  if (registeredHotkey === hotkey) return true // already active
  try {
    const ok = globalShortcut.register(hotkey, () => {
      const wins = BrowserWindow.getAllWindows()
      const win = wins[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      app.focus({ steal: true })
    })
    if (!ok) {
      console.error('[shortcut] failed to register:', hotkey)
      return false
    }
    registeredHotkey = hotkey
    return true
  } catch (err) {
    console.error('[shortcut] register threw:', err)
    return false
  }
}

// Diagnostics: record uncaught errors / rejections. Logging only — does NOT
// alter Electron's default crash handling; logDiagMain never throws.
process.on('uncaughtException', (err) => {
  logDiagMain({
    category: 'error',
    level: 'fatal',
    event: DIAG_EVENTS.ERROR_UNCAUGHT,
    message: err?.message ?? String(err),
    data: { stack: err?.stack ?? null, name: err?.name ?? null }
  })
})
process.on('unhandledRejection', (reason) => {
  const e = reason as { message?: string; stack?: string; name?: string }
  logDiagMain({
    category: 'error',
    level: 'error',
    event: DIAG_EVENTS.ERROR_UNHANDLED_REJECTION,
    message: e?.message ?? String(reason),
    data: { stack: e?.stack ?? null, name: e?.name ?? null }
  })
})

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

// Track when the user explicitly quits (Cmd+Q / app.quit()) so the close
// handler below can let the window actually close instead of hiding.
let isQuitting = false
app.on('before-quit', () => {
  isQuitting = true
})

function kickActiveTerminal(): void {
  try {
    // Use the in-memory currently-viewed workspace (no SQLite dependency, so
    // this works even if the main thread / DB is mid-stall). Reclaim focus
    // unconditionally on app return — the addon.focus force-cycles the surface
    // so it wakes even when the terminal was frozen / input was stuck.
    const ws = getCurrentlyViewedWorkspace()
    if (!ws) return
    console.log('[lifecycle] terminal kick (wake)')
    loadTerminalAddon().focus(ws)
  } catch (err) {
    console.error('[lifecycle] terminal kick failed:', err)
  }
}

function createWindow(): void {
  // ---------------------------------------------------------------------------
  // Restore saved window geometry
  // ---------------------------------------------------------------------------
  const savedState = getAppUiState()

  // Validate saved bounds against currently-connected displays. If the saved
  // position is on an unplugged monitor, fall back to defaults.
  function isWithinSomeDisplay(x: number, y: number): boolean {
    const displays = screen.getAllDisplays()
    // Window is "within a display" if at least its top-left corner is inside
    // one of the displays' workAreas. Electron clamps the rest to screen edges.
    return displays.some((d) => {
      const a = d.workArea
      return x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height
    })
  }

  let restoredBounds: { x?: number; y?: number; width: number; height: number } = {
    width: 1280,
    height: 800
  }

  if (
    (savedState.restoreGeometry ?? true) &&
    savedState.windowX !== null &&
    savedState.windowY !== null &&
    savedState.windowWidth !== null &&
    savedState.windowHeight !== null &&
    isWithinSomeDisplay(savedState.windowX, savedState.windowY)
  ) {
    restoredBounds = {
      x: savedState.windowX,
      y: savedState.windowY,
      width: Math.max(savedState.windowWidth, 960), // clamp to minWidth
      height: Math.max(savedState.windowHeight, 600)
    }
  }

  // Task 8: window is opaque on all platforms. The terminal NSView is now the
  // topmost sibling of contentView (NSWindowAbove relativeTo:nil) and has
  // isOpaque=YES, so it paints itself; the web layer no longer needs to be
  // transparent. Using an opaque window eliminates the compositor overhead of
  // alpha-blending the entire window and fixes flicker on macOS 15+.
  const mainWindow = new BrowserWindow({
    ...restoredBounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0b0c',
    titleBarStyle: 'hiddenInset',
    // Traffic lights vertically centered in the 44px (h-11) sidebar top strip:
    // (44 - 14) / 2 = 15
    trafficLightPosition: { x: TRAFFIC_LIGHT_INSET, y: 15 },
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // Keep the renderer's timers/rAF running when backgrounded so terminal
      // title/activity updates and event drain don't stall during long idle.
      backgroundThrottling: false
    }
  })

  // Cache the main window reference for use in hot-path broadcasts.
  mainWindowRef = mainWindow
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null
  })

  // Register subscription cleanup so actions:subscribe subscriptions are
  // automatically torn down when the window (and its webContents) is destroyed.
  registerWebContentsCleanup(mainWindow.webContents)
  // Tear down all git watchers when the renderer goes away so we don't hold
  // destroyed WebContents references until will-quit.
  mainWindow.webContents.on('destroyed', () => stopAllGitWatches())

  // Restore fullscreen state before the window is shown
  if (savedState.windowFullscreen) {
    mainWindow.setFullScreen(true)
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    try {
      loadTerminalAddon().installBackstop(mainWindow.getNativeWindowHandle())
    } catch (err) {
      console.error('[lifecycle] installBackstop failed:', err)
    }
    if (isDev) {
      mainWindow.setTitle(app.getName())
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // On macOS, standard Electron behavior keeps the app frontmost when the
  // user clicks close or minimize — the menu bar stays "Orpheus" and apps
  // behind remain darkened. We call app.hide() instead so the previous app
  // regains focus naturally (same as Cmd+H). Cmd+Q still quits because
  // before-quit sets isQuitting=true, letting the close event pass through.
  //
  // closeHides is read fresh from DB on each close event so that toggling the
  // setting in the UI takes effect without a restart.
  if (process.platform === 'darwin') {
    mainWindow.on('close', (e) => {
      const state = getAppUiState()
      if (!isQuitting && (state.closeHides ?? true)) {
        e.preventDefault()
        app.hide()
      }
      // else: let close proceed → window-all-closed fires → app.quit() not
      // called on darwin by default, so the process stays alive but windowless.
      // That's acceptable; user can re-open via the Dock or ⌘Q.
    })
    // 'minimize' fires after the window has been minimized; hide the app
    // immediately after so the previous app gains focus.
    mainWindow.on('minimize', () => {
      app.hide()
    })
  }

  // ---------------------------------------------------------------------------
  // Persist window geometry
  // ---------------------------------------------------------------------------

  let saveTimer: NodeJS.Timeout | null = null

  function scheduleBoundsSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      flushBoundsSave()
    }, 500)
  }

  function flushBoundsSave(): void {
    if (mainWindow.isDestroyed()) return
    // Don't save bounds while fullscreen — they reflect the pre-fullscreen geometry
    // that AppKit auto-restores on exit, and saving them here would clobber that.
    if (mainWindow.isFullScreen()) return
    const b = mainWindow.getBounds()
    updateAppUiState({
      windowX: b.x,
      windowY: b.y,
      windowWidth: b.width,
      windowHeight: b.height
    })
  }

  mainWindow.on('resize', scheduleBoundsSave)
  mainWindow.on('move', scheduleBoundsSave)

  // Auto-focus the current workspace's terminal whenever the window becomes
  // active again (Cmd-Tab back, dock click, etc.). Without this the focus
  // stays on whatever HTML element it was on, and typing won't reach claude.
  mainWindow.on('focus', () => {
    // Invalidate the checkClaude cache so the next doctor:check picks up any
    // claude install/update that happened while the window was in the background.
    cachedClaudeCheck = null
    kickActiveTerminal()
  })

  mainWindow.on('enter-full-screen', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    updateAppUiState({ windowFullscreen: true })
  })

  mainWindow.on('leave-full-screen', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    updateAppUiState({ windowFullscreen: false })
    // After exiting fullscreen, AppKit restores the pre-fullscreen geometry.
    // Capture it for next launch.
    // Use a slight delay because getBounds inside the leave-full-screen callback
    // may still report fullscreen bounds.
    setTimeout(() => {
      if (mainWindow.isDestroyed()) return
      const b = mainWindow.getBounds()
      updateAppUiState({ windowX: b.x, windowY: b.y, windowWidth: b.width, windowHeight: b.height })
    }, 250)
  })

  mainWindow.on('close', () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
      flushBoundsSave()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ---------------------------------------------------------------------------
// Doctor helpers
// ---------------------------------------------------------------------------

// Finder-launched Electron apps get a stripped-down PATH that doesn't include
// the user's shell customizations (`.zshrc`, brew paths, npm-global, etc.).
// To match what the user sees in their actual terminal, we spawn a login +
// interactive subshell once on first check, capture its $PATH, and cache it.
//
// The resolution is async so the main thread doesn't block on the first call.
// Cache for checkClaude — invalidated on app focus change (app:focus event).
// 30s TTL guards against stale "not installed" results if the user installs
// claude while Orpheus is open.
let cachedClaudeCheck: {
  result: { installed: boolean; version: string | null; path: string | null }
  at: number
} | null = null

const CLAUDE_CHECK_TTL_MS = 30_000

async function checkClaude(): Promise<{
  installed: boolean
  version: string | null
  path: string | null
}> {
  if (cachedClaudeCheck && Date.now() - cachedClaudeCheck.at < CLAUDE_CHECK_TTL_MS) {
    return cachedClaudeCheck.result
  }

  // PATH comes from the user's actual shell (cached). No hardcoded fallbacks:
  // if `claude` isn't on the user's shell PATH, it isn't installed for them.
  const userPath = await getUserShellPath()
  const env = { ...process.env, PATH: userPath || process.env['PATH'] || '' }

  const execFile = promisify(childProcess.execFile)

  let claudePath: string
  try {
    const { stdout } = await execFile('which', ['claude'], {
      encoding: 'utf-8',
      env,
      timeout: 3000
    })
    claudePath = stdout.trim()
    if (!claudePath) {
      const result = { installed: false, version: null, path: null }
      cachedClaudeCheck = { result, at: Date.now() }
      return result
    }
  } catch {
    const result = { installed: false, version: null, path: null }
    cachedClaudeCheck = { result, at: Date.now() }
    return result
  }

  let version: string | null = null
  try {
    const { stdout: versionOutput } = await execFile('claude', ['--version'], {
      encoding: 'utf-8',
      env,
      timeout: 3000
    })
    const match = versionOutput.match(/(\d+\.\d+\.\d+)/)
    version = match ? match[1] : null
  } catch {
    // `which` succeeded but `--version` failed; treat as installed, version unknown
  }
  const result = { installed: true, version, path: claudePath }
  cachedClaudeCheck = { result, at: Date.now() }
  return result
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Diagnostics: typed IPC wrapper — times every handler, logs slow (>50ms) calls
// as PERF_IPC_ROUNDTRIP, captures and re-throws errors as ERROR_IPC_FAIL.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC handlers are inherently untyped at this boundary
function handle(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC handlers are inherently untyped at this boundary
  fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => any
): void {
  ipcMain.handle(channel, async (e, ...args) => {
    const start = Date.now()
    try {
      const result = await fn(e, ...args)
      const ms = Date.now() - start
      if (ms > 50) {
        logDiagMain({
          category: 'perf',
          level: 'info',
          event: DIAG_EVENTS.PERF_IPC_ROUNDTRIP,
          message: channel,
          durationMs: ms,
          data: { channel }
        })
      }
      return result
    } catch (err) {
      logDiagMain({
        category: 'error',
        level: 'error',
        event: DIAG_EVENTS.ERROR_IPC_FAIL,
        message: `${channel}: ${err instanceof Error ? err.message : String(err)}`,
        data: { channel, stack: err instanceof Error ? err.stack : null }
      })
      throw err
    }
  })
}

// ---------------------------------------------------------------------------
// IPC input-validation helpers
// ---------------------------------------------------------------------------

/**
 * Assert that `value` is a non-empty string and an absolute filesystem path.
 * Throws on any renderer-supplied value that isn't a clean absolute path.
 */
function assertAbsolutePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`IPC validation: ${label} must be a non-empty string`)
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`IPC validation: ${label} must be an absolute path`)
  }
}

/**
 * Assert that `value` is an absolute path confined to a legitimate Claude
 * config root: the user's home directory (for `~/.claude/...` / `~/.claude.json`)
 * or any registered project's directory (for project-scoped settings files).
 * Used for renderer-supplied config-file paths so a compromised renderer cannot
 * redirect a write/delete/open at an arbitrary system path.
 */
function assertManagedConfigPath(value: unknown, label: string): asserts value is string {
  assertAbsolutePath(value, label)
  const v = value as string
  const isUnder = (root: string): boolean => v === root || v.startsWith(root + path.sep)
  if (isUnder(os.homedir())) return
  for (const project of listProjects()) {
    if (project.path && isUnder(project.path)) return
  }
  throw new Error(
    `IPC validation: ${label} must be under the home directory or a registered project`
  )
}

const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

/**
 * Return true iff `url` is safe to pass to shell.openExternal().
 * Only http, https, and mailto are permitted — blocks file:, javascript:, etc.
 */
function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    const { protocol } = new URL(url)
    return ALLOWED_EXTERNAL_SCHEMES.has(protocol)
  } catch {
    return false
  }
}

handle('config:openFolder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled) return null
  const chosen = result.filePaths[0]
  console.log('[orpheus] folder selected:', chosen)
  return chosen ?? null
})

handle('app:getVersion', () => app.getVersion())

handle('app:getPaths', () => ({
  userData: app.getPath('userData'),
  logs: app.getPath('logs')
}))

handle('window:openDevTools', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  win.webContents.openDevTools({ mode: 'detach' })
})

handle('window:reload', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  win.webContents.reload()
})

// ---------------------------------------------------------------------------
// Projects IPC
// ---------------------------------------------------------------------------

handle('projects:list', () => listProjects())

handle('projects:add', (_e, { path }: { path: string }) => addProject(path))

handle('projects:pickAndAdd', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  const chosen = result.filePaths[0]
  console.log('[orpheus] project folder selected:', chosen)
  return addProject(chosen)
})

handle('projects:open', (_e, { id }: { id: string }) => openProject(id))

handle('projects:remove', (_e, { id }: { id: string }) => {
  // Enumerate workspaces before the cascade-delete removes the rows so we can
  // tear down each one's in-memory state and native surface. The renderer
  // pre-destroys surfaces via terminal:destroy, but projects:remove must be
  // self-sufficient even when called directly (double-cleanup is safe — all
  // teardown operations are idempotent).
  const workspacesToRemove = listWorkspacesForProject(id, { scope: 'all' })
  for (const ws of workspacesToRemove) {
    if (terminalAddon) {
      try {
        terminalAddon.destroy(ws.id)
      } catch {
        // Surface not mounted or already destroyed — ignore.
      }
    }
    teardownWorkspaceResources(ws.id, ws.cwd ?? null)
  }
  deleteProject(id)
})

handle('projects:rename', (_e, { id, name }: { id: string; name: string }) =>
  renameProject(id, name)
)

// ---------------------------------------------------------------------------
// Workspaces IPC
// ---------------------------------------------------------------------------

handle(
  'workspaces:listForProject',
  (_e, { projectId, scope }: { projectId: string; scope?: 'active' | 'archived' | 'all' }) =>
    listWorkspacesForProject(projectId, { scope })
)

handle('workspaces:create', (_e, args: { projectId: string; name: string; cwd: string }) =>
  createWorkspace(args)
)

handle('workspaces:open', (_e, { id }: { id: string }) => openWorkspace(id))

handle('workspaces:setPinned', (_e, { id, pinned }: { id: string; pinned: boolean }) =>
  setWorkspacePinned(id, pinned)
)

handle('workspaces:archive', (_e, { id }: { id: string }) => {
  // Capture cwd before the DB row is gone so teardown can stop the git watcher.
  const ws = getWorkspace(id)
  // Destroy the libghostty surface so the NSView is freed before the DB row
  // disappears. Silently no-ops when the terminal was never mounted.
  if (terminalAddon) {
    try {
      terminalAddon.destroy(id)
    } catch {
      // Surface not mounted or already destroyed — ignore.
    }
  }
  archiveWorkspace(id)
  // Evict all per-workspace in-memory state via the unified teardown so
  // archived workspaces don't leak into any runtime cache.
  teardownWorkspaceResources(id, ws?.cwd ?? null)
})

handle('workspace:close', (_e, { id }: { id: string }) => {
  const status = getWorkspaceActivity(id)
  if (status === 'in_progress') {
    return { ok: false as const, reason: 'busy' as const }
  }
  const workspace = performClose(id)
  return { ok: true as const, workspace: workspace ?? null }
})

handle('workspace:reopen', (_e, { id }: { id: string }) => {
  const workspace = reopenWorkspace(id)
  return { ok: true as const, workspace: workspace ?? null }
})

handle('workspaces:rename', (_e, { id, name }: { id: string; name: string }) =>
  renameWorkspace(id, name)
)

handle(
  'workspaces:reorder',
  (_e, { projectId, orderedIds }: { projectId: string; orderedIds: string[] }) =>
    reorderWorkspaces(projectId, orderedIds)
)

handle('workspace:isDirty', (_e, { workspaceId }: { workspaceId: string }): boolean =>
  dirtyWorkspaces.has(workspaceId)
)

// ---------------------------------------------------------------------------
// Pins IPC
// ---------------------------------------------------------------------------

handle('pins:listAll', () => listAllPinned())

// ---------------------------------------------------------------------------
// Sessions IPC
// ---------------------------------------------------------------------------

handle(
  'sessions:listForProject',
  (_e, { projectId, includeArchived }: { projectId: string; includeArchived?: boolean }) =>
    listSessionsForProject(projectId, { includeArchived })
)

handle('sessions:listAll', (_e, opts?: { status?: SessionStatus }) => listAllSessions(opts))

handle('sessions:setStatus', (_e, { id, status }: { id: string; status: SessionStatus }) =>
  setSessionStatus(id, status)
)

handle('sessions:listForProjectPaged', (_e, req: SessionsPagedRequest) =>
  listSessionsForProjectPaged(req)
)

handle(
  'sessions:resumeInNewWorkspace',
  (_e, { sessionId, projectId }: { sessionId: string; projectId: string }) =>
    createWorkspaceResumingSession(projectId, sessionId)
)

handle('sessions:refreshMetadata', async (_e, { projectId }: { projectId: string }) => {
  await refreshSessionMetadata(projectId)
})

handle('sessions:delete', (_e, { id }: { id: string }) => deleteSession(id))

handle('sessions:getContextBudget', (_e, { workspaceId }: { workspaceId: string }) =>
  getContextBudget(workspaceId)
)

// ---------------------------------------------------------------------------
// Claude Settings IPC
// ---------------------------------------------------------------------------

handle('claudeSettings:get', () => getClaudeGlobalSettings())

handle('claudeSettings:update', (_e, patch: ClaudeGlobalSettingsPatch) => {
  const result = updateClaudeGlobalSettings(patch)
  recomputeDirty()
  return result
})

// ---------------------------------------------------------------------------
// Ghostty Settings IPC
// ---------------------------------------------------------------------------

handle('ghosttySettings:get', () => getGhosttyUserConfig())

handle('ghosttySettings:update', (_e, patch: Partial<GhosttyUserConfig>) => {
  const result = updateGhosttyUserConfig(patch)
  writeGhosttyConfigFile()
  // TODO: add "restart to apply" signal for keys that require restart
  try {
    const addon = loadTerminalAddon()
    addon.reloadGhosttyConfig()
  } catch (err) {
    console.warn('[ghosttySettings] reloadGhosttyConfig failed (non-fatal):', err)
  }
  return result
})

// ---------------------------------------------------------------------------
// MCP IPC
// ---------------------------------------------------------------------------

handle('mcp:listServers', () => listMcpServers())
handle('mcp:add', (_e, draft: McpServerDraft) => addMcpServer(draft))
handle(
  'mcp:update',
  (
    _e,
    args: { filePath: string; oldName: string; draft: Omit<McpServerDraft, 'source' | 'projectId'> }
  ) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return updateMcpServer(args.filePath, args.oldName, args.draft)
  }
)
handle('mcp:delete', (_e, args: { filePath: string; name: string }) => {
  assertManagedConfigPath(args.filePath, 'filePath')
  return deleteMcpServer(args.filePath, args.name)
})

// ---------------------------------------------------------------------------
// Claude Agents IPC
// ---------------------------------------------------------------------------

handle('claudeAgents:listSlashCommands', () => listSlashCommands())
handle('claudeAgents:listSubagents', () => listSubagents())

handle('claudeAgents:addSlashCommand', (_e, draft: ClaudeSlashCommandDraft) =>
  addSlashCommand(draft)
)
handle(
  'claudeAgents:updateSlashCommand',
  (
    _e,
    args: { filePath: string; draft: Omit<ClaudeSlashCommandDraft, 'source' | 'projectId'> }
  ) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return updateSlashCommand(args.filePath, args.draft)
  }
)
handle('claudeAgents:deleteSlashCommand', (_e, args: { filePath: string }) => {
  assertManagedConfigPath(args.filePath, 'filePath')
  return deleteSlashCommand(args.filePath)
})

handle('claudeAgents:addSubagent', (_e, draft: ClaudeSubagentDraft) => addSubagent(draft))
handle(
  'claudeAgents:updateSubagent',
  (_e, args: { filePath: string; draft: Omit<ClaudeSubagentDraft, 'source' | 'projectId'> }) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return updateSubagent(args.filePath, args.draft)
  }
)
handle('claudeAgents:deleteSubagent', (_e, args: { filePath: string }) => {
  assertManagedConfigPath(args.filePath, 'filePath')
  return deleteSubagent(args.filePath)
})

// ---------------------------------------------------------------------------
// Claude Hooks IPC
// ---------------------------------------------------------------------------

handle('claudeHooks:list', () => listClaudeHooks())
handle('claudeHooks:openFile', async (_e, { filePath }: { filePath: string }) => {
  assertManagedConfigPath(filePath, 'filePath')
  await shell.openPath(filePath)
})
handle('claudeHooks:add', (_e, draft: ClaudeHookDraft) => addHook(draft))
handle(
  'claudeHooks:update',
  (
    _e,
    args: {
      filePath: string
      event: string
      matcherEntryIdx: number
      hookIdx: number
      draft: Omit<ClaudeHookDraft, 'source' | 'projectId'>
    }
  ) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return updateHook(args.filePath, args.event, args.matcherEntryIdx, args.hookIdx, args.draft)
  }
)
handle(
  'claudeHooks:delete',
  (
    _e,
    args: {
      filePath: string
      event: string
      matcherEntryIdx: number
      hookIdx: number
    }
  ) => {
    assertManagedConfigPath(args.filePath, 'filePath')
    return deleteHook(args.filePath, args.event, args.matcherEntryIdx, args.hookIdx)
  }
)

// ---------------------------------------------------------------------------
// Claude Auth IPC
// ---------------------------------------------------------------------------

handle('claudeAuth:get', () => getClaudeAuthState())

handle('claudeAuth:update', (_e, patch: ClaudeAuthPatch) => updateClaudeAuth(patch))

handle('claudeAuth:testConnection', () => testAnthropicConnection())

// ---------------------------------------------------------------------------
// Per-project Claude Settings IPC
// ---------------------------------------------------------------------------

handle('claudeProjectSettings:get', (_e, { projectId }: { projectId: string }) =>
  getClaudeProjectSettings(projectId)
)

handle(
  'claudeProjectSettings:update',
  (_e, args: { projectId: string; patch: ClaudeProjectSettingsOverrides }) => {
    const result = updateClaudeProjectSettings(args.projectId, args.patch)
    recomputeDirty()
    return result
  }
)

// ---------------------------------------------------------------------------
// Per-workspace Claude Settings IPC
// ---------------------------------------------------------------------------

handle('claudeWorkspaceSettings:get', (_e, { workspaceId }: { workspaceId: string }) =>
  getClaudeWorkspaceSettings(workspaceId)
)

handle(
  'claudeWorkspaceSettings:update',
  (_e, args: { workspaceId: string; patch: ClaudeWorkspaceSettingsOverrides }) => {
    const result = updateClaudeWorkspaceSettings(args.workspaceId, args.patch)
    recomputeDirty()
    return result
  }
)

// ---------------------------------------------------------------------------
// Diagnostics IPC
// ---------------------------------------------------------------------------

ipcMain.on('diag:event', (_e, evt) => {
  ingestDiagEvent(evt)
})

handle('diag:openConsole', () => {
  openDiagConsole()
})

handle('diag:export', async (_e, { sinceMs }: { sinceMs: number }) => {
  try {
    const result = await dialog.showSaveDialog({
      title: 'Export Diagnostics',
      defaultPath: 'orpheus-diagnostics.txt',
      filters: [{ name: 'Text', extensions: ['txt'] }]
    })

    if (result.canceled || !result.filePath) {
      return { ok: false, error: 'canceled' }
    }

    const txtPath = result.filePath
    const { dir, name } = path.parse(txtPath)
    const jsonPath = path.join(dir, name + '.json')

    const rows = queryDiagnostics({ sinceMs, limit: 100_000 })

    // Build readable .txt report
    const exportedAt = new Date().toISOString()
    const rangeStart = new Date(sinceMs).toISOString()
    const lines: string[] = [
      `Orpheus Diagnostics Export`,
      `Exported: ${exportedAt}`,
      `Range: ${rangeStart} — ${exportedAt}`,
      `Rows: ${rows.length}`,
      '',
      '═'.repeat(72),
      ''
    ]

    // Group rows by traceId
    const traceRows = new Map<string, DiagRow[]>()
    const nonTraceRows: DiagRow[] = []
    for (const row of rows) {
      if (row.traceId) {
        if (!traceRows.has(row.traceId)) traceRows.set(row.traceId, [])
        traceRows.get(row.traceId)!.push(row)
      } else {
        nonTraceRows.push(row)
      }
    }

    // Trace trees section
    if (traceRows.size > 0) {
      lines.push('TRACES', '─'.repeat(72), '')
      for (const [traceId, tRows] of traceRows) {
        lines.push(`Trace: ${traceId}`)
        lines.push(formatTraceTree(tRows))
        lines.push('')
      }
    }

    // Flat events section
    if (nonTraceRows.length > 0) {
      lines.push('EVENTS', '─'.repeat(72), '')
      for (const row of nonTraceRows) {
        lines.push(formatEventLine(row))
      }
      lines.push('')
    }

    const txtContent = lines.join('\n')

    // Write the .txt first, then the .json sidecar. If the JSON write fails
    // after the txt landed, remove the orphaned txt so we never leave a
    // half-completed report behind.
    fs.writeFileSync(txtPath, txtContent, 'utf8')
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(rows, null, 2), 'utf8')
    } catch (jsonErr) {
      try {
        fs.unlinkSync(txtPath)
      } catch {
        /* best-effort cleanup */
      }
      return {
        ok: false,
        error: `Report could not be completed (JSON sidecar failed): ${
          jsonErr instanceof Error ? jsonErr.message : String(jsonErr)
        }`
      }
    }

    return { ok: true, path: txtPath, txtPath, jsonPath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

// ---------------------------------------------------------------------------
// UI State IPC
// ---------------------------------------------------------------------------

handle('uiState:get', () => getAppUiState())

function syncDiagFlags(): void {
  const s = getAppUiState()
  setDiagCategoryFlags({
    error: s.diagError,
    lifecycle: s.diagLifecycle,
    perf: s.diagPerf,
    anomaly: s.diagAnomaly,
    trace: s.diagTrace
  })
}

handle('uiState:update', (_e, patch: AppUiStatePatch) => {
  const result = updateAppUiState(patch)
  if (patch.launchAtLogin !== undefined) applyLaunchAtLogin(patch.launchAtLogin)
  if (patch.globalHotkey !== undefined) applyGlobalHotkey(patch.globalHotkey)
  if (patch.theme !== undefined) {
    applyLoadingOverlayTheme(patch.theme as Theme)
    applyPopoverTheme(patch.theme as Theme)
  }
  if (patch.inProgressWatchdogSec !== undefined) invalidateWatchdogCache()
  if (patch.staleAfterMinutes !== undefined) invalidateWatchdogCache()
  if (patch.autoCloseAfterMinutes !== undefined) invalidateWatchdogCache()
  if (patch.statusPollIntervalSec !== undefined) rescheduleStatusPoll()
  syncDiagFlags()
  // Broadcast the updated state so renderer subscribers (e.g. WorkspaceFooter)
  // can react without polling.
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('uiState:changed', result)
  }
  return result
})

ipcMain.on(
  'workspace:setCurrentlyViewed',
  (_e, { workspaceId }: { workspaceId: string | null }) => {
    setCurrentlyViewedWorkspace(workspaceId)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:activeWorkspaceChanged', { workspaceId })
    }
  }
)

// ---------------------------------------------------------------------------
// Hooks integration IPC
// ---------------------------------------------------------------------------

handle('hooks:setEnabled', (_e, enabled: boolean) => {
  updateAppUiState({ hooksIntegrationEnabled: enabled })
  reconcileHooks()
  return { enabled }
})

handle('hooks:getStatus', () => {
  const enabled = getAppUiState().hooksIntegrationEnabled
  const installed = countManagedHooks()
  return { enabled, installed }
})

handle('notifications:test', () => {
  fireTestNotification()
})

// ---------------------------------------------------------------------------
// Health IPC
// ---------------------------------------------------------------------------

handle('health:get', async (): Promise<HealthReport> => {
  // claudeCli
  let claudeCli: HealthReport['claudeCli']
  try {
    const userPath = await getUserShellPath()
    const whichResult = await new Promise<string>((resolve, reject) => {
      childProcess.exec(
        'which claude',
        { env: { ...process.env, PATH: userPath } },
        (err, stdout) => {
          if (err) reject(err)
          else resolve(stdout.trim())
        }
      )
    })
    if (!whichResult) throw new Error('claude not found on PATH')
    const version = await new Promise<string>((resolve, reject) => {
      const child = childProcess.spawn(whichResult, ['--version'], {
        env: { ...process.env, PATH: userPath },
        timeout: 5000
      })
      let out = ''
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString()
      })
      child.stderr.on('data', (d: Buffer) => {
        out += d.toString()
      })
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`exit ${code}`))
      })
      child.on('error', reject)
    })
    claudeCli = { status: 'ok', detail: version }
  } catch {
    claudeCli = { status: 'error', detail: 'claude not found on PATH' }
  }

  // sessionRegistry
  let sessionRegistry: HealthReport['sessionRegistry']
  try {
    const sessionDir = path.join(os.homedir(), '.claude', 'sessions')
    await fs.promises.access(sessionDir, fs.constants.R_OK)
    const liveCount = getLiveSessionState().size
    sessionRegistry = { status: 'ok', detail: `${liveCount} live session(s)` }
  } catch {
    sessionRegistry = { status: 'warn', detail: 'session directory not found' }
  }

  // notifications
  const notifSupported = Notification.isSupported()
  const notifications: HealthReport['notifications'] = notifSupported
    ? { status: 'ok', detail: 'Supported' }
    : { status: 'warn', detail: 'Not supported on this platform' }

  // hooks
  const hooksEnabled = getAppUiState().hooksIntegrationEnabled
  const hooksInstalled = countManagedHooks()
  const hooksDetail = hooksEnabled ? `enabled · ${hooksInstalled} installed` : 'disabled'
  const hooks: HealthReport['hooks'] = {
    status: 'ok',
    detail: hooksDetail,
    enabled: hooksEnabled,
    installed: hooksInstalled
  }

  // dataDir
  let dataDir: HealthReport['dataDir']
  try {
    await fs.promises.access(app.getPath('userData'), fs.constants.W_OK)
    dataDir = { status: 'ok', detail: 'Writable' }
  } catch {
    dataDir = { status: 'error', detail: 'Not writable' }
  }

  return { claudeCli, sessionRegistry, notifications, hooks, dataDir }
})

// ---------------------------------------------------------------------------
// Updates IPC
// ---------------------------------------------------------------------------

handle('updates:check', () => checkForUpdates())
handle('updates:install', () => {
  installUpdate()
})
handle('updates:restart', () => {
  relaunchApp()
})
handle('updates:getState', () => getUpdateSnapshot())

// ---------------------------------------------------------------------------
// Claude status IPC
// ---------------------------------------------------------------------------

handle('status:get', () => getStatusSnapshot())
handle('status:refresh', async () => refreshStatusNow())
handle('status:openPage', () => {
  shell.openExternal('https://status.claude.com').catch((err) => {
    console.warn('[status] openExternal failed:', err)
  })
})

handle('projects:setExpandedInSidebar', (_e, { id, expanded }: { id: string; expanded: boolean }) =>
  setProjectExpandedInSidebar(id, expanded)
)

handle('projects:reorder', (_e, { orderedIds }: { orderedIds: string[] }) =>
  reorderProjects(orderedIds)
)

handle('projects:refreshGithub', (_e, projectId: string) => refreshGithubData(projectId))

handle('doctor:check', async (): Promise<DoctorResult> => {
  const { installed, version, path: claudePath } = await checkClaude()
  return {
    claudeInstalled: installed,
    claudeVersion: version,
    claudePath
  }
})

// ---------------------------------------------------------------------------
// Context menu IPC (native Electron menu — renders above NSView)
// ---------------------------------------------------------------------------

handle('contextMenu:show', async (e, items: ContextMenuNativeItem[]) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return null
  return showContextMenu(items, win)
})

// ---------------------------------------------------------------------------
// Git IPC
// ---------------------------------------------------------------------------

handle('git:status', (_e, { cwd }: { cwd: string }): Promise<GitStatus | null> => getGitStatus(cwd))

handle('git:branches', async (_e, { cwd }: { cwd: string }) => {
  const result = await listBranches(cwd)
  return result
})

handle(
  'git:log',
  (
    _e,
    args: {
      cwd: string
      branch?: string
      limit?: number
      offset?: number
      sinceMs?: number
      untilMs?: number
      grep?: string
    }
  ) => listCommits(args.cwd, args)
)

handle(
  'git:count',
  async (
    _e,
    args: { cwd: string; branch?: string; sinceMs?: number; untilMs?: number; grep?: string }
  ) => {
    const result = await countCommits(args.cwd, args)
    return result
  }
)

// ---------------------------------------------------------------------------
// GitHub IPC — `gh` CLI passthrough; null on every failure mode.
// ---------------------------------------------------------------------------

handle('github:prForBranch', (_e, { cwd, branch }: { cwd: string; branch: string }) =>
  getPrForBranch(cwd, branch)
)

// ---------------------------------------------------------------------------
// Shell helpers IPC
// ---------------------------------------------------------------------------

handle('shell:revealInFinder', (_e, { path: filePath }: { path: string }) => {
  assertAbsolutePath(filePath, 'path')
  return revealInFinder(filePath)
})
handle('shell:openInEditor', (_e, { path: filePath }: { path: string }) => {
  assertAbsolutePath(filePath, 'path')
  const state = getAppUiState()
  return openInEditor(filePath, state.preferredEditorApp ?? undefined)
})
handle('shell:openTerminal', (_e, { path: filePath }: { path: string }) => {
  assertAbsolutePath(filePath, 'path')
  const state = getAppUiState()
  return openTerminal(filePath, state.preferredTerminalApp ?? undefined)
})
handle('shell:copyToClipboard', (_e, { text }: { text: string }) => copyToClipboard(text))
handle('shell:listEditorApps', () => listEditorApps())
handle('shell:listTerminalApps', () => listTerminalApps())

// ---------------------------------------------------------------------------
// Terminal IPC — ghostty-surface lifecycle
// ---------------------------------------------------------------------------

// TerminalRect is a local alias for SurfaceRect (imported from the generic
// ghostty-surface package). They are structurally identical; the alias keeps
// the IPC handler parameter type names stable without a broad rename.
type TerminalRect = SurfaceRect

let terminalAddon: GhosttySurfaceAddon | null = null
let terminalAddonError: string | null = null

function loadTerminalAddon(): GhosttySurfaceAddon {
  if (terminalAddon) return terminalAddon
  if (terminalAddonError) throw new Error(terminalAddonError)

  // Set GHOSTTY_RESOURCES_DIR before the addon is loaded so ghostty_init
  // can find the terminfo / shell-integration resources bundled at:
  //   (packaged) Contents/Resources/ghostty
  //   (dev)      resources/ghostty/ghostty
  const resDir = app.isPackaged
    ? join(process.resourcesPath, 'ghostty')
    : join(__dirname, '../../resources/ghostty/ghostty')
  process.env['GHOSTTY_RESOURCES_DIR'] = resDir
  console.log('[terminal] GHOSTTY_RESOURCES_DIR set to', resDir)

  console.log('[terminal] loading addon via loadOrpheusSurface')
  try {
    terminalAddon = loadOrpheusSurface()
    console.log('[terminal] addon loaded OK')
    // Wire the addon reference into the actions registry so terminal.*
    // actions can delegate through the same addon instance.
    setTerminalAddonRef(terminalAddon)
    return terminalAddon
  } catch (err) {
    const msg = String(err)
    terminalAddonError = msg
    console.error('[terminal] addon load FAILED:', msg)
    throw err
  }
}

handle(
  'terminal:mount',
  async (
    e,
    {
      workspaceId,
      rect,
      scaleFactor,
      cwd
    }: { workspaceId: string; rect: TerminalRect; scaleFactor: number; cwd?: string }
  ): Promise<{ workspaceId: string; created: boolean }> => {
    const addon = loadTerminalAddon()
    ensureTitleCallback(addon)
    ensureLoadingOverlayWiring(addon)
    ensurePopoverWiring(addon)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('terminal:mount — no BrowserWindow for sender')
    const nativeHandle = win.getNativeWindowHandle()

    // Look up the workspace's projectId for per-project override resolution
    const ws = getWorkspace(workspaceId)
    const projectId = ws?.projectId

    // Close the cold-mount PATH race: if the boot-time shell-path spawn hasn't
    // settled yet, await it now so buildMountEnv can inject ORPHEUS_USER_PATH
    // instead of forcing the .zshrc fallback (+100–800 ms).
    if (getCachedShellPath() === null) {
      await getUserShellPath()
    }

    let launch!: ReturnType<typeof buildMountEnv>['launch']
    const _mountStart = Date.now()
    const result = await diag.trace('terminal.mount', { workspaceId }, async (s) => {
      // Compose launch env as a child span nested under terminal.mount.
      // buildMountEnv is sync; use diag.span (not diag.trace).
      let buildResult!: ReturnType<typeof buildMountEnv>
      try {
        buildResult = diag.span(
          'launch.compose',
          { workspaceId, projectId: projectId ?? null },
          () => buildMountEnv(workspaceId, projectId, notifyServer?.sockPath)
        )
      } catch (err) {
        logDiagMain({
          category: 'error',
          level: 'error',
          event: DIAG_EVENTS.LAUNCH_COMPOSE_FAILED,
          message: err instanceof Error ? err.message : String(err),
          workspaceId,
          data: { stack: err instanceof Error ? err.stack : null }
        })
        throw err
      }
      const { command, env: surfaceEnv, launch: composedLaunch } = buildResult
      launch = composedLaunch

      console.log(
        '[terminal] mount workspaceId=%s flags=%s settingsJson=%s envKeys=%s',
        workspaceId,
        launch.flags || '(none)',
        launch.settingsJson || '(none)',
        Object.keys(surfaceEnv).join(',')
      )

      let mountResult: { workspaceId: string; created: boolean }
      try {
        mountResult = addon.mount(nativeHandle, {
          workspaceId,
          rect,
          scaleFactor,
          cwd,
          command,
          env: surfaceEnv
        })
      } catch (err) {
        logDiagMain({
          category: 'error',
          level: 'error',
          event: DIAG_EVENTS.ERROR_NATIVE,
          message: `addon.mount failed: ${err instanceof Error ? err.message : String(err)}`,
          workspaceId,
          data: { stack: err instanceof Error ? err.stack : null }
        })
        throw err
      }
      s.mark(mountResult.created ? 'surface-created' : 'surface-reattached')
      logDiagMain({
        category: 'lifecycle',
        level: 'info',
        event: DIAG_EVENTS.TERMINAL_MOUNT,
        workspaceId,
        data: { created: mountResult?.created ?? null }
      })
      logDiagMain({
        category: 'perf',
        level: 'info',
        event: DIAG_EVENTS.PERF_TERMINAL_MOUNT,
        workspaceId,
        durationMs: Date.now() - _mountStart
      })
      return mountResult
    })

    if (result.created) {
      logDiagMain({
        category: 'lifecycle',
        level: 'info',
        event: DIAG_EVENTS.TERMINAL_SURFACE_CREATED,
        workspaceId
      })
    }

    // Show the loading overlay only when a new surface was actually created —
    // re-attaching a hidden surface or a defensive resize means claude is
    // already running and there's no boot to mask.
    if (result.created) {
      showLoadingOverlay(workspaceId, { title: 'Starting workspace' })

      // If the session is already past its starting phase (re-mount of a
      // running workspace), dismiss the overlay immediately.
      if (isWorkspaceSessionReady(workspaceId)) {
        hideLoadingOverlay(workspaceId)
      } else {
        // Fallback: ensure the overlay is always dismissed after 10s even if
        // claude never registers a session file (e.g. auth failure, crash).
        const prev = overlayFallbackTimers.get(workspaceId)
        if (prev) clearTimeout(prev)
        const t = setTimeout(() => {
          overlayFallbackTimers.delete(workspaceId)
          logDiagMain({
            category: 'anomaly',
            level: 'warn',
            event: DIAG_EVENTS.OVERLAY_FALLBACK,
            workspaceId,
            message: 'overlay dismissed by fallback timeout'
          })
          hideLoadingOverlay(workspaceId)
        }, 10000)
        overlayFallbackTimers.set(workspaceId, t)
      }
    }

    // Snapshot the composed launch so we can detect settings drift later.
    launchSnapshots.set(workspaceId, launch)
    setDirty(workspaceId, false)

    // Push the current canInject state so the renderer chip gets an immediate
    // value without waiting for the next activity transition.
    {
      const injectable = terminalActions.canInject(workspaceId)
      e.sender.send('terminal:canInjectChanged', { workspaceId, canInject: injectable })
    }

    // Start (or re-join) the fs.watch watcher for this workspace's git repo so
    // status is pushed on change instead of polled every 30s.
    if (cwd) {
      startGitWatch(workspaceId, cwd, e.sender)
    }

    return result
  }
)

handle('terminal:hide', (_e, { workspaceId }: { workspaceId: string }): void => {
  const addon = loadTerminalAddon()
  // If the user navigates away mid-boot, dismiss the overlay so it doesn't
  // outlive its parent surface in the contentView.
  const fallback = overlayFallbackTimers.get(workspaceId)
  if (fallback) {
    clearTimeout(fallback)
    overlayFallbackTimers.delete(workspaceId)
  }
  hideLoadingOverlay(workspaceId)
  try {
    addon.hide(workspaceId)
  } catch (err) {
    logDiagMain({
      category: 'error',
      level: 'error',
      event: DIAG_EVENTS.ERROR_NATIVE,
      message: `addon.hide failed: ${err instanceof Error ? err.message : String(err)}`,
      workspaceId,
      data: { stack: err instanceof Error ? err.stack : null }
    })
    throw err
  }
  logDiagMain({
    category: 'lifecycle',
    level: 'info',
    event: DIAG_EVENTS.TERMINAL_HIDE,
    workspaceId
  })
})

handle('terminal:focus', (_e, { workspaceId }: { workspaceId: string }): void => {
  const addon = loadTerminalAddon()
  try {
    addon.focus(workspaceId)
  } catch (err) {
    logDiagMain({
      category: 'error',
      level: 'error',
      event: DIAG_EVENTS.ERROR_NATIVE,
      message: `addon.focus failed: ${err instanceof Error ? err.message : String(err)}`,
      workspaceId,
      data: { stack: err instanceof Error ? err.stack : null }
    })
    throw err
  }
  logDiagMain({
    category: 'anomaly',
    level: 'warn',
    event: DIAG_EVENTS.TERMINAL_FOCUS_RECLAIMED,
    workspaceId
  })
})

// ---------------------------------------------------------------------------
// Native popover IPC handlers (Phase A chassis)
// ---------------------------------------------------------------------------

handle(
  'terminal:showPopover',
  (
    _e,
    {
      workspaceId,
      kind,
      anchorRect,
      data
    }: {
      workspaceId: string
      kind: string
      anchorRect: { x: number; y: number; w: number; h: number }
      data: Record<string, unknown>
    }
  ): void => {
    const prUrl = typeof data.prUrl === 'string' ? data.prUrl : undefined
    if (prUrl && isSafeExternalUrl(prUrl)) popoverPrUrlByWorkspace.set(workspaceId, prUrl)
    const addon = loadTerminalAddon()
    // Resolve the Geist font directory: packaged → Contents/Resources/fonts,
    // dev → node_modules/geist/dist/fonts (native fallback handles this when omitted).
    const fontDir = app.isPackaged ? join(process.resourcesPath, 'fonts') : undefined
    addon.showPopover(workspaceId, kind, anchorRect, data, fontDir)
  }
)

handle(
  'terminal:updatePopover',
  (_e, { workspaceId, data }: { workspaceId: string; data: Record<string, unknown> }): void => {
    const addon = loadTerminalAddon()
    addon.updatePopover(workspaceId, data)
  }
)

handle('terminal:hidePopover', (_e, { workspaceId }: { workspaceId: string }): void => {
  const addon = loadTerminalAddon()
  addon.hidePopover(workspaceId)
})

handle('terminal:getSurfacePhase', (_e, { workspaceId }: { workspaceId: string }): string => {
  try {
    return loadTerminalAddon().getSurfacePhase(workspaceId)
  } catch {
    return 'none'
  }
})

handle(
  'terminal:resize',
  (
    _e,
    {
      workspaceId,
      rect,
      scaleFactor
    }: { workspaceId: string; rect: TerminalRect; scaleFactor: number }
  ): void => {
    const addon = loadTerminalAddon()
    try {
      addon.resize(workspaceId, rect, scaleFactor)
    } catch (err) {
      logDiagMain({
        category: 'error',
        level: 'error',
        event: DIAG_EVENTS.ERROR_NATIVE,
        message: `addon.resize failed: ${err instanceof Error ? err.message : String(err)}`,
        workspaceId,
        data: { stack: err instanceof Error ? err.stack : null }
      })
      throw err
    }
  }
)

handle('terminal:destroy', (_e, { workspaceId }: { workspaceId: string }): void => {
  // NOTE: terminal:destroy is called in two distinct scenarios:
  //   1. Workspace death (archive / project-remove) — full teardown happens in
  //      the archive/remove handlers via teardownWorkspaceResources; this path
  //      only handles the surface + transient mount state.
  //   2. Live restart (WorkspaceView.handleRestart) — workspace stays alive;
  //      activity/accumulator/session state must NOT be evicted here.
  //
  // Clean up surface-level mount state that is always safe to evict — it is
  // re-seeded by the next terminal:mount call in both scenarios.
  const fallbackTimer = overlayFallbackTimers.get(workspaceId)
  if (fallbackTimer) {
    clearTimeout(fallbackTimer)
    overlayFallbackTimers.delete(workspaceId)
  }
  hideLoadingOverlay(workspaceId)
  cancelAttentionRetry(workspaceId)
  launchSnapshots.delete(workspaceId)
  if (dirtyWorkspaces.delete(workspaceId)) {
    broadcastDirty(workspaceId, false)
  }
  // Clear title and notify renderer so stale claude titles don't linger
  if (workspaceTitles.delete(workspaceId)) {
    getMainWindow()?.webContents.send('workspace:titleChanged', { workspaceId, title: null })
  }
  // Settings cache is cheap to evict — will be re-read on the next mount.
  invalidateClaudeWorkspaceSettingsCache(workspaceId)
  // Tear down the git watcher for this workspace (ref-counted: only closes
  // underlying fs.watch when the last subscriber for this cwd is removed).
  const wsForGit = getWorkspace(workspaceId)
  if (wsForGit?.cwd) {
    stopGitWatch(workspaceId, wsForGit.cwd)
  }
  const addon = loadTerminalAddon()
  try {
    addon.destroy(workspaceId)
  } catch (err) {
    logDiagMain({
      category: 'error',
      level: 'error',
      event: DIAG_EVENTS.ERROR_NATIVE,
      message: `addon.destroy failed: ${err instanceof Error ? err.message : String(err)}`,
      workspaceId,
      data: { stack: err instanceof Error ? err.stack : null }
    })
    throw err
  }
  logDiagMain({
    category: 'lifecycle',
    level: 'info',
    event: DIAG_EVENTS.TERMINAL_DESTROY,
    workspaceId
  })
})

// ---------------------------------------------------------------------------
// Quick Actions — terminal interaction primitives
// ---------------------------------------------------------------------------

handle('terminal:sendInput', (_e, { workspaceId, text }: { workspaceId: string; text: string }) => {
  const addon = loadTerminalAddon()
  return terminalActions.sendInput(addon, workspaceId, text)
})

handle(
  'terminal:sendKeys',
  (_e, { workspaceId, keys }: { workspaceId: string; keys: TerminalSendKeyDescriptor[] }) => {
    const addon = loadTerminalAddon()
    return terminalActions.sendKeys(addon, workspaceId, keys)
  }
)

handle('terminal:submit', (_e, { workspaceId }: { workspaceId: string }) => {
  const addon = loadTerminalAddon()
  return terminalActions.submit(addon, workspaceId)
})

handle('terminal:clearInput', (_e, { workspaceId }: { workspaceId: string }) => {
  const addon = loadTerminalAddon()
  return terminalActions.clearInput(addon, workspaceId)
})

handle('terminal:canInject', (_e, { workspaceId }: { workspaceId: string }): boolean => {
  return terminalActions.canInject(workspaceId)
})

// ---------------------------------------------------------------------------
// Quick Actions — phase 2: registry IPC surface
// ---------------------------------------------------------------------------

handle(
  'actions:invoke',
  (
    _e,
    {
      actionId,
      params,
      workspaceId,
      consumerHint
    }: {
      actionId: string
      params: Record<string, unknown>
      workspaceId: string
      consumerHint?: string
    }
  ) => {
    const invocation: ActionInvocation = { id: actionId, params, workspaceId }
    return actionsInvoke(invocation, consumerHint ?? 'ipc')
  }
)

handle('actions:list', () => actionsList())

handle('actions:history', (_e, { workspaceId, limit }: { workspaceId: string; limit?: number }) =>
  getAuditHistory(workspaceId, limit)
)

handle(
  'actions:subscribe',
  (
    e,
    {
      subscriptionId,
      actionId,
      params,
      workspaceId
    }: {
      subscriptionId: string
      actionId: string
      params: Record<string, unknown>
      workspaceId: string
    }
  ) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    startSubscription(subscriptionId, actionId, params, workspaceId, (value) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('actions:subscription-update', { subscriptionId, value })
      }
    })
    return { ok: true }
  }
)

handle('actions:unsubscribe', (_e, { subscriptionId }: { subscriptionId: string }) => {
  stopSubscription(subscriptionId)
  return { ok: true }
})

// ---------------------------------------------------------------------------
// Footer actions — phase 3a: CRUD + merge IPC surface
// ---------------------------------------------------------------------------

handle('footerActions:listMerged', (_e, { workspaceId }: { workspaceId: string }) =>
  listMergedFooterActions(workspaceId)
)

handle(
  'footerActions:listAtScope',
  (_e, { scope, scopeId }: { scope: FooterActionScope; scopeId?: string }) => {
    if (scope === 'global') return listGlobalFooterActions()
    if (scope === 'project') return listProjectFooterActions(scopeId ?? '')
    return listWorkspaceFooterActions(scopeId ?? '')
  }
)

handle(
  'footerActions:create',
  (
    _e,
    {
      scope,
      scopeId,
      draft
    }: { scope: FooterActionScope; scopeId: string | null; draft: FooterActionDraft }
  ) => createFooterAction(scope, scopeId, draft)
)

handle(
  'footerActions:update',
  (_e, { id, patch }: { id: string; patch: Partial<FooterActionDraft> }) =>
    updateFooterAction(id, patch)
)

handle('footerActions:remove', (_e, { id }: { id: string }) => {
  removeFooterAction(id)
})

handle(
  'footerActions:reorder',
  (
    _e,
    {
      scope,
      scopeId,
      orderedIds
    }: { scope: FooterActionScope; scopeId: string | null; orderedIds: string[] }
  ) => reorderFooterActions(scope, scopeId, orderedIds)
)

handle('footerActions:resetDefaults', () => {
  resetFooterActionsToDefaults()
})

handle(
  'workspace:getTitle',
  (_e, { workspaceId }: { workspaceId: string }): string | null =>
    workspaceTitles.get(workspaceId) ?? null
)

// ---------------------------------------------------------------------------
// Keep Awake IPC
// ---------------------------------------------------------------------------

handle('keepAwake:get', () => getKeepAwakeState())
handle('keepAwake:setMode', (_e, mode: KeepAwakeBaseMode) => setKeepAwakeMode(mode))
handle('keepAwake:setDisplayOn', (_e, on: boolean) => setKeepAwakeDisplayOn(on))
handle('keepAwake:startTimer', (_e, minutes: number) => startKeepAwakeTimer(minutes))

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  // Fire shell PATH resolution immediately so doctor:check doesn't block on first call.
  // This is a no-op after the first call (getUserShellPath caches internally).
  void diag
    .trace('startup.shell_path', {}, async () => {
      const resolvedPath = await getUserShellPath()
      if (!resolvedPath) {
        logDiagMain({
          category: 'anomaly',
          level: 'warn',
          event: DIAG_EVENTS.STARTUP_SHELL_PATH_UNRESOLVED
        })
      }
    })
    .catch(() => {
      /* swallow — getUserShellPath already logs errors internally */
    })

  electronApp.setAppUserModelId(APP_ID)

  // Event-loop delay monitor — logs p99 and max lag every 10s so we have
  // data on whether a future utilityProcess migration is worth the cost.
  // All output is [perf]-tagged for easy grep/removal later.
  {
    const eld = monitorEventLoopDelay({ resolution: 10 })
    eld.enable()
    setInterval(() => {
      console.log(
        '[perf] eventloop p99=%dms max=%dms',
        Math.round(eld.percentile(99) / 1e6),
        Math.round(eld.max / 1e6)
      )
      eld.reset()
    }, 10_000).unref()
  }

  // Initialize / migrate the SQLite database early, before any IPC can fire.
  getDb()
  startDiagnostics()
  syncDiagFlags()

  // Boot Quick Actions registry — registers all action descriptors so they're
  // available before any IPC can invoke them.
  bootActions()

  // Seed default footer actions on first install (idempotent: no-op if rows exist).
  try {
    seedDefaultFooterActions()
  } catch (err) {
    console.error('[footerActions] failed to seed defaults:', err)
  }

  // Refresh model pricing from models.dev — fire-and-forget, never blocks boot.
  refreshFromModelsDev().catch(() => {})

  // Clear stale in_progress / attention statuses left over from a prior
  // session (crash, hard quit). Without this, the WorkspaceView would show a
  // forever-spinning "thinking" indicator until a fresh activity event lands.
  try {
    const cleared = resetTransientStatusesOnStartup()
    if (cleared > 0) {
      console.log('[startup] cleared', cleared, 'stale workspace activity statuses')
    }
  } catch (err) {
    console.error('[startup] failed to clear stale activity statuses:', err)
  }

  // Seed the in-memory workspaceTitles map from the DB so the sidebar /
  // workspace header can show the last observed prompt title immediately on
  // launch — without waiting for Claude to re-emit an OSC title.
  try {
    for (const { id, title } of getAllWorkspaceLastTitles()) {
      workspaceTitles.set(id, title)
    }
  } catch (err) {
    console.error('[startup] failed to seed workspaceTitles from DB:', err)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  createWindow()

  // Kick the active terminal on system wake events so the CVDisplayLink
  // restarts after display sleep / screen lock / user-switch.
  powerMonitor.on('resume', kickActiveTerminal)
  powerMonitor.on('unlock-screen', kickActiveTerminal)
  if (process.platform === 'darwin') {
    powerMonitor.on('user-did-become-active', kickActiveTerminal)
  }

  // Apply OS-level settings after the window exists (hotkey callback needs it)
  try {
    const state = getAppUiState()
    applyLaunchAtLogin(state.launchAtLogin)
    applyGlobalHotkey(state.globalHotkey)
  } catch (err) {
    console.error('[startup] failed to apply launch/hotkey settings:', err)
  }

  // Start the update auto-check loop (30s initial delay, then every 6h).
  // Gated internally on the autoCheckUpdates setting.
  startAutoCheckLoop()

  // Start the Claude service-status poller (3s initial delay, then per user setting).
  // Uses blur/focus backoff so polls slow down when Orpheus is in the background.
  startStatusPoller()

  // Defer notify server + hook reconcile until after the first frame — keeps
  // createWindow() hot so the UI appears faster on launch.
  setImmediate(() => {
    // Wire up the activity batch channel regardless of hook integration state —
    // the batch listener is always needed for file-based status updates.
    onActivityBatch((updates) => {
      const win = getMainWindow()
      if (!win) return
      win.webContents.send('workspace:activityBatch', updates)
      // Push canInject state for each workspace that changed activity so the
      // renderer chips don't need to poll terminal:canInject every second.
      // Use the authoritative terminalActions.canInject() so 'attention' and
      // any future status additions are handled identically to the IPC handler.
      for (const { workspaceId } of updates) {
        if (!win.webContents.isDestroyed()) {
          win.webContents.send('terminal:canInjectChanged', {
            workspaceId,
            canInject: terminalActions.canInject(workspaceId)
          })
        }
      }
    })

    // Declarative hook reconcile: enabled → start server + install hooks;
    // disabled (default) → remove any previously-installed managed hooks and
    // do NOT start the socket server.
    reconcileHooks()

    setAutoCloseHandler((workspaceId) => {
      performClose(workspaceId)
    })

    // Pre-load the native terminal addon during idle time so the first
    // terminal:mount call doesn't pay the dlopen stall (50–300ms).
    // loadTerminalAddon() is idempotent — if already loaded it returns early.
    try {
      loadTerminalAddon()
    } catch {
      // Failure is non-fatal here; terminal:mount will surface the error when needed.
    }

    // Start shadow-mode session state service (Phase 1 — observes and logs only)
    try {
      sessionStateService = startSessionStateService()
    } catch (err) {
      console.error('[sessionState] failed to start:', err)
    }

    try {
      powerAwakeCleanup = startPowerAwake(getMainWindow)
    } catch (err) {
      console.error('[powerAwake] failed to start:', err)
    }
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else kickActiveTerminal()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  notifyServer?.close()
  sessionStateService?.stop()
  powerAwakeCleanup?.()
  stopStatusPoller()
  stopAutoCheckLoop()
  stopAllGitWatches()
  stopDiagnostics()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
