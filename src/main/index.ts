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
import type {
  DoctorResult,
  GitStatus,
  HealthReport,
  CreateWorktreeParams,
  TerminalMountResult
} from '../shared/types'
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
  getProject,
  deleteProject,
  renameProject,
  setProjectExpandedInSidebar,
  reorderProjects,
  setProjectPinned
} from './projects'
import {
  resolveMainWorktree,
  withRepoLock,
  createWorktree,
  removeWorktree,
  isWorktreeDirty,
  worktreeSlug,
  readWorktreeBaseRef,
  branchExists,
  NotAGitRepoError,
  reconcileWorktree
} from './worktrees'
import { resolveOfferedModes, resolveWorkspacesConfig, writeProjectOverride } from './orpheusConfig'
import { refreshGithubData } from './githubAvatar'
import {
  listSessionsForProject,
  listSessionsForProjectPaged,
  listAllSessions,
  setSessionStatus,
  createWorkspaceResumingSession,
  createWorktreeResumingSession,
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
  resetTransientStatusesOnStartup,
  setWorkspaceCwd,
  convertWorktreeToLocal,
  countWorktreeWorkspaces,
  listWorktreeWorkspaces
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
  ClaudeWorkspaceSettings,
  ClaudeEffort,
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
import { startCommandServer } from './commandServer'
import type { CommandServerDeps } from './commandServer'
import {
  initOverlayLayer,
  registerOverlayRendererIpc,
  showOverlay,
  updateOverlay,
  hideOverlay,
  isInteractiveOverlayVisible,
  focusOverlay,
  forceHideOwnedBy,
  setOverlayTheme
} from './overlayLayer'
import type { OverlayDescriptor } from '../shared/types'
import { PUSH_CHANNELS } from '../shared/ipc'
import type { InvokeChannel, Req, Res } from '../shared/ipc'

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
let commandServer: { sockPath: string; token: string; close: () => void } | null = null
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

// Ask the renderer to open (and mount) the given workspace. Mirrors the
// pattern used by other main→renderer signals (e.g. workspace:activityBatch,
// workspace:navigateTo).
//
// `focus` controls whether the renderer NAVIGATES the UI to this workspace
// (handleSelectWorkspace: setView + mount) or performs a BACKGROUND MOUNT
// (mount the terminal surface so it becomes injectable, without changing
// what the user is looking at). Defaults to true so existing callers that
// don't pass it keep the pre-existing "always navigate" behavior.
function requestOpenWorkspace(workspaceId: string, focus: boolean = true): void {
  getMainWindow()?.webContents.send(PUSH_CHANNELS.workspaceRequestOpen, { workspaceId, focus })
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
  const currentTheme = getAppUiState().theme
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
    getMainWindow()?.webContents.send(PUSH_CHANNELS.workspaceTitleChanged, {
      workspaceId,
      title: cleaned
    })
  })
  addon.setOcclusionCallback((workspaceId: string, occluded: boolean) => {
    getMainWindow()?.webContents.send(PUSH_CHANNELS.terminalSleepStateChanged, {
      workspaceId,
      sleeping: occluded
    })
  })
  // Liveness ticks (global) for the renderer freeze watchdog: inputTick bumps on
  // native key/mouse input, liveTick bumps on every draw/IO wakeup. Throttled
  // native-side. The watchdog applies them to the active workspace.
  addon.setLivenessCallback(
    (workspaceId: string, inputTick: number, liveTick: number, occluded: boolean) => {
      getMainWindow()?.webContents.send(PUSH_CHANNELS.terminalLiveness, {
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
      win?.webContents.send(PUSH_CHANNELS.addonActionTrace, { tagName })
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
    if (a.env[ak[i]] !== b.env[ak[i]]) return false
  }
  return true
}

function broadcastDirty(workspaceId: string, dirty: boolean): void {
  getMainWindow()?.webContents.send(PUSH_CHANNELS.workspaceDirtyChanged, { workspaceId, dirty })
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
    getMainWindow()?.webContents.send(PUSH_CHANNELS.workspaceTitleChanged, {
      workspaceId,
      title: null
    })
  }
  const overlayTimer = overlayFallbackTimers.get(workspaceId)
  if (overlayTimer) {
    clearTimeout(overlayTimer)
    overlayFallbackTimers.delete(workspaceId)
  }
  injectLocks.delete(workspaceId)
  if (cwd) stopGitWatch(workspaceId, cwd)
}

function performClose(id: string): WorkspaceRecord | undefined {
  // NOTE: close keeps the worktree on disk (reconciled on next open); only
  // archive/project-delete tears it down. Do NOT add worktree removal here.
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

async function performArchive(
  id: string,
  force: boolean = false
): Promise<{ archived: boolean; wasDirty: boolean }> {
  // Capture cwd before the DB row is gone so teardown can stop the git watcher.
  const ws = getWorkspace(id)
  // Run archiveWorkspace FIRST. For worktree-backed workspaces with a dirty
  // worktree and force=false it returns { archived: false, wasDirty: true }
  // without touching the DB row — in that case we must NOT destroy the surface
  // so the workspace terminal stays alive for the user.
  const result = await archiveWorkspace(id, force)
  if (!result.archived) {
    // Dirty worktree without force — row and surface are intact; caller should
    // show a confirm dialog and re-invoke with force:true.
    return result
  }
  // Archive succeeded: destroy the libghostty surface now that the DB row is
  // gone. Silently no-ops when the terminal was never mounted.
  if (terminalAddon) {
    try {
      terminalAddon.destroy(id)
    } catch {
      // Surface not mounted or already destroyed — ignore.
    }
  }
  // Evict all per-workspace in-memory state via the unified teardown so
  // archived workspaces don't leak into any runtime cache.
  teardownWorkspaceResources(id, ws?.cwd ?? null)
  return result
}

function recomputeDirty(): void {
  if (launchSnapshots.size === 0) return
  // Fetch global settings once — shared across all workspaces in the loop.
  // Each composeClaudeLaunch would otherwise run a redundant DB read.
  const globalSettings = getClaudeGlobalSettings()
  for (const [workspaceId, snap] of launchSnapshots.entries()) {
    const ws = getWorkspace(workspaceId)
    if (!ws) {
      // Workspace was archived/removed while a snapshot was still tracked
      // (e.g. archived mid-mount) — evict the stale entry instead of
      // leaving it around forever.
      launchSnapshots.delete(workspaceId)
      setDirty(workspaceId, false)
      continue
    }
    const fresh = composeClaudeLaunch(ws.projectId, workspaceId, globalSettings)
    setDirty(workspaceId, !launchEquals(snap, fresh))
  }
}

// Tokenizes a composed `flags` string into `{ name, raw }` pairs, one per
// `--flag [value]` occurrence. `raw` is the exact matched substring (leading
// whitespace trimmed) so tokens can be spliced back into a flags string
// losslessly — e.g. "--model claude-opus-4-8" or "--debug" (no value).
function parseFlagTokens(flags: string): Array<{ name: string; raw: string }> {
  const tokens: Array<{ name: string; raw: string }> = []
  const re = /(?:^|\s)--([a-zA-Z-]+)(?:\s+(\S+))?/g
  let match: RegExpExecArray | null
  while ((match = re.exec(flags)) !== null) {
    tokens.push({ name: match[1], raw: match[0].trim() })
  }
  return tokens
}

// Persists a model/effort change made via a footer dropdown chip (Model or
// Effort) AND neutralizes the resulting dirty delta for JUST that ONE flag
// dimension of the launch snapshot — because `/model <value>` or
// `/effort <value>` is typed into the terminal live by the caller immediately
// after this resolves, the running claude process already reflects the new
// value, so the stored snapshot must be updated to match reality without
// touching any OTHER pending genuine dirty delta (e.g. if the user separately
// changed permission-mode and hasn't restarted yet, that delta must still
// show "Restart to apply" afterwards).
//
// Algorithm (position-independent, multi-flag-safe — "reconstruct from
// fresh"): start from `fresh.flags` (guarantees compose's own deterministic
// token ordering), then for every flag NAME other than `flagName` whose token
// differs between the OLD snapshot and FRESH (including one having it and the
// other not), rewrite the working string so that name's token matches OLD's
// value again — i.e. undo everything fresh changed EXCEPT the one flag we
// intentionally want reflected. The `flagName` token itself is always left as
// fresh's value. This guarantees `launchEquals(patchedSnapshot, fresh)` is
// true iff `flagName` was the ONLY thing that changed since mount: if nothing
// else changed, every non-`flagName` token is restored to OLD's (== fresh's,
// since nothing else diverged) value, so patched === fresh. If something else
// DID change, that other token is deliberately reverted to OLD's stale value,
// so patched !== fresh and recomputeDirty() below still correctly flags it.
// Reconstructs `fresh.flags` with every flag NAME other than `flagName`
// restored to its OLD token text wherever old and fresh disagree (including
// one side having the flag and the other not). `flagName` itself is always
// left as fresh's value. See `setWorkspaceSettingAndSuppressDirty` for why.
function reconcileFlagsExceptTarget(
  oldFlags: string,
  freshFlags: string,
  flagName: 'model' | 'effort'
): string {
  const oldByName = new Map(parseFlagTokens(oldFlags).map((t) => [t.name, t.raw]))
  const freshByName = new Map(parseFlagTokens(freshFlags).map((t) => [t.name, t.raw]))
  const allNames = new Set([...oldByName.keys(), ...freshByName.keys()])

  let patchedFlags = freshFlags
  for (const name of allNames) {
    if (name === flagName) continue // leave fresh's value — this is the wanted change
    const oldRaw = oldByName.get(name)
    const freshRaw = freshByName.get(name)
    if (oldRaw === freshRaw) continue // unchanged — nothing to restore

    if (freshRaw !== undefined && oldRaw !== undefined) {
      // Present in both, but differing value — replace fresh's token text
      // with old's token text.
      patchedFlags = patchedFlags.replace(freshRaw, oldRaw)
    } else if (freshRaw !== undefined && oldRaw === undefined) {
      // Fresh has it, old didn't — remove fresh's token.
      patchedFlags = patchedFlags.replace(freshRaw, '').trim()
    } else if (oldRaw !== undefined && freshRaw === undefined) {
      // Old had it, fresh doesn't — append old's token back (exact insertion
      // position doesn't matter: this branch only runs when some OTHER flag
      // already changed, which already makes patched !== fresh, satisfying
      // the invariant regardless of where we splice it back in).
      patchedFlags = `${patchedFlags} ${oldRaw}`.trim()
    }
  }
  // Normalize whitespace left behind by removals/replacements.
  return patchedFlags.replace(/\s+/g, ' ').trim()
}

function setWorkspaceSettingAndSuppressDirty(
  workspaceId: string,
  patch: Partial<{ model: string; effort: ClaudeEffort }>,
  flagName: 'model' | 'effort'
): ClaudeWorkspaceSettings {
  const result = updateClaudeWorkspaceSettings(workspaceId, patch)

  const snap = launchSnapshots.get(workspaceId)
  if (snap) {
    const ws = getWorkspace(workspaceId)
    if (ws) {
      // Recompose fresh — this reflects the NEW value (already persisted
      // above) plus whatever ELSE currently differs from the snapshot.
      const fresh = composeClaudeLaunch(ws.projectId, workspaceId)
      const patchedFlags = reconcileFlagsExceptTarget(snap.flags, fresh.flags, flagName)

      // Only `flags` changes; settingsJson/env stay from the OLD snapshot.
      launchSnapshots.set(workspaceId, { ...snap, flags: patchedFlags })
    }
  }

  // Recompute dirty for ALL workspaces (cheap, existing behavior) — now that
  // the target flag's dimension of this workspace's snapshot matches fresh,
  // only a GENUINE pre-existing divergence (unrelated to flagName) would
  // still flag dirty.
  recomputeDirty()

  return result
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

// Last-resort crash logging: written straight to disk so a fatal error is
// still diagnosable even if the diagnostics pipeline itself is what failed.
// Must never throw — this runs from inside error handlers.
function writeCrashFile(err: unknown): void {
  try {
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'orpheus-crash.log'),
      `${new Date().toISOString()}\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    )
  } catch {
    /* last-resort logging must never throw */
  }
}

// Diagnostics: record uncaught errors, write a crash file, and fail fast.
// Registering this listener suppresses Node's default uncaughtException
// behavior (print + exit), so we must replicate an exit here ourselves —
// otherwise the process would stay alive in a corrupted state.
let handlingFatal = false
process.on('uncaughtException', (err) => {
  logDiagMain({
    category: 'error',
    level: 'fatal',
    event: DIAG_EVENTS.ERROR_UNCAUGHT,
    message: err?.message ?? String(err),
    data: { stack: err?.stack ?? null, name: err?.name ?? null }
  })
  if (handlingFatal) return
  handlingFatal = true
  logDiagMain({
    category: 'error',
    level: 'fatal',
    event: DIAG_EVENTS.UNCAUGHT_EXCEPTION,
    message: err?.message ?? String(err),
    data: { stack: err?.stack ?? null, name: err?.name ?? null }
  })
  writeCrashFile(err)
  dialog.showErrorBox(
    'Orpheus — Unexpected Error',
    'Orpheus encountered an unexpected error and must close.\n\n' + (err?.message ?? String(err))
  )
  app.exit(1)
})
// Diagnostics: record unhandled promise rejections. Logging only — does NOT
// alter Electron's default handling; logDiagMain never throws.
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

// Focuses the currently-viewed workspace's terminal via the addon. Shared by
// the `terminal:focus` IPC handler's internal logic and overlayLayer's
// hide-flow focus-restore fallback chain (which knows "the active workspace"
// but not a specific workspaceId to target). Returns false when there's no
// currently-viewed workspace so callers can continue their own fallback chain.
function focusWorkspaceTerminal(): boolean {
  try {
    const ws = getCurrentlyViewedWorkspace()
    if (!ws) return false
    loadTerminalAddon().focus(ws)
    return true
  } catch (err) {
    console.error('[lifecycle] focusWorkspaceTerminal failed:', err)
    return false
  }
}

function kickActiveTerminal(): void {
  try {
    // Use the in-memory currently-viewed workspace (no SQLite dependency, so
    // this works even if the main thread / DB is mid-stall). Reclaim focus
    // unconditionally on app return — the addon.focus force-cycles the surface
    // so it wakes even when the terminal was frozen / input was stuck.
    const ws = getCurrentlyViewedWorkspace()
    if (!ws) return
    // While a takesFocus overlay is pending/visible, refocus the overlay
    // instead of yanking focus back to the terminal underneath it (R6/R7).
    if (isInteractiveOverlayVisible()) {
      console.log('[lifecycle] terminal kick (wake) — overlay has focus, refocusing overlay')
      focusOverlay()
      return
    }
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
    try {
      initOverlayLayer(mainWindow, loadTerminalAddon(), {
        getMainWindow,
        focusActiveWorkspaceTerminal: focusWorkspaceTerminal
      })
      setOverlayTheme(getAppUiState().theme)
    } catch (err) {
      console.error('[overlayLayer] init failed:', err)
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

// Overload 1: channel is a key of InvokeChannelMap — args/return are typed
// against the shared ChannelMap (src/shared/ipc.ts).
function handle<C extends InvokeChannel>(
  channel: C,
  fn: (e: Electron.IpcMainInvokeEvent, ...args: Req<C>) => Res<C> | Promise<Res<C>>
): void
// Overload 2: permissive fallback for the ~100+ channels not yet migrated
// into InvokeChannelMap — zero behavior change, zero migration forced.
function handle(
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- IPC handlers are inherently untyped at this boundary
  fn: (e: Electron.IpcMainInvokeEvent, ...args: any[]) => any
): void
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
  const v = value
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
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  })
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

// Which workspace-creation modes the UI should offer for this project. Computes
// is-git-repo authoritatively (resolveMainWorktree throws NotAGitRepoError for a
// non-git cwd) and narrows the resolver result to the bare {local, worktree} the
// renderer needs. Non-NotAGitRepo errors propagate.
handle('app:offeredModes', async (_e, { projectId }: { projectId: string }) => {
  const project = getProject(projectId)
  if (!project) throw new Error(`app:offeredModes: project not found: ${projectId}`)

  let isGit = true
  try {
    await resolveMainWorktree(project.path)
  } catch (err) {
    if (err instanceof NotAGitRepoError) {
      isGit = false
    } else {
      throw err
    }
  }

  const modes = await resolveOfferedModes(project.path, isGit)
  return { local: modes.local, worktree: modes.worktree }
})

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
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  })
  if (result.canceled || !result.filePaths[0]) return null
  const chosen = result.filePaths[0]
  console.log('[orpheus] project folder selected:', chosen)
  return addProject(chosen)
})

handle('projects:open', (_e, { id }: { id: string }) => openProject(id))

handle(
  'projects:remove',
  async (
    _e,
    {
      id,
      deleteWorktrees = false,
      force = false
    }: { id: string; deleteWorktrees?: boolean; force?: boolean }
  ): Promise<{ deleted: boolean; dirtyWorktrees: number }> => {
    // Optional worktree teardown before cascade-delete.
    // Must happen before deleteProject() so we still have workspace rows to query.
    if (deleteWorktrees) {
      const worktreeWorkspaces = listWorktreeWorkspaces(id)

      // ── Phase 1 (pre-check, NO removal): count dirty worktrees ───────────
      // Check dirtiness WITHOUT removing anything. If any are dirty and the
      // caller hasn't set force, return early having removed NOTHING — so the
      // user can cancel the confirmation without losing clean worktrees.
      if (!force) {
        const results = await Promise.all(worktreeWorkspaces.map((ws) => isWorktreeDirty(ws.cwd)))
        const dirtyCount = results.filter(Boolean).length
        if (dirtyCount > 0) {
          return { deleted: false, dirtyWorktrees: dirtyCount }
        }
      }

      // ── Phase 2 (removal): only reached when dirtyCount===0 or force ─────
      // Remove each worktree best-effort; log non-fatal errors and continue so
      // a single failure does not leave the project permanently undeletable.
      for (const ws of worktreeWorkspaces) {
        try {
          await withRepoLock(ws.worktreeParentCwd, () =>
            removeWorktree({ path: ws.cwd, force, repoRoot: ws.worktreeParentCwd })
          )
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logDiagMain({
            category: 'error',
            level: 'error',
            event: DIAG_EVENTS.WORKTREE_REMOVAL_FAILED,
            workspaceId: ws.id,
            message: `non-fatal error removing worktree at ${ws.cwd}: ${message}`,
            data: { cwd: ws.cwd }
          })
          console.warn(`[projects:remove] non-fatal error removing worktree at ${ws.cwd}:`, message)
          // Continue — best-effort removal; don't abort the whole delete.
        }
      }
    }

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
    return { deleted: true, dirtyWorktrees: 0 }
  }
)

handle('projects:worktreeSummary', (_e, { projectId }: { projectId: string }) => {
  return { count: countWorktreeWorkspaces(projectId) }
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

// Create a worktree-backed workspace. Async + git-first transaction order:
// resolve repo root → authoritatively enforce the offered-modes config →
// (under the per-repo mutex) decide new-vs-existing branch → create the git
// worktree → insert the DB row, rolling the worktree back if the insert fails.
// Nothing is persisted until the worktree exists, and a failed insert leaves no
// orphaned worktree behind.
handle(
  'workspaces:createWorktree',
  async (_e, { projectId, params }: { projectId: string; params: CreateWorktreeParams }) => {
    const project = getProject(projectId)
    if (!project) throw new Error(`workspaces:createWorktree: project not found: ${projectId}`)

    // Resolve the main worktree root. A non-git cwd throws NotAGitRepoError —
    // worktree workspaces are impossible there, so reject with a clear message.
    let repoRoot: string
    try {
      repoRoot = await resolveMainWorktree(project.path)
    } catch (err) {
      if (err instanceof NotAGitRepoError) {
        throw new Error(
          `Cannot create a worktree workspace: ${project.path} is not a git repository`
        )
      }
      throw err
    }

    // Authoritative enforcement (spec §7.2): re-read the offered modes in the
    // main process and reject if worktree creation is disabled by config. The
    // UI gate is advisory; this is the real gate.
    const modes = await resolveOfferedModes(project.path, true)
    if (!modes.worktree) {
      throw new Error('Worktree workspaces are disabled for this project by .orpheus/config.yml')
    }

    const slug = worktreeSlug(params.name)
    const branch = params.branch?.trim() || `worktree-${slug}`

    return withRepoLock(repoRoot, async () => {
      const mode = (await branchExists(repoRoot, branch)) ? 'existing' : 'new'
      const baseRef = await readWorktreeBaseRef()

      // If createWorktree throws, propagate — no DB row has been inserted yet.
      const { path: worktreePath, branch: finalBranch } = await createWorktree({
        repoRoot,
        slug,
        branch,
        mode,
        baseRef
      })

      try {
        // createWorkspace broadcasts workspaces:created internally (same as the
        // normal create path), so no separate broadcast is needed here.
        return createWorkspace({
          projectId,
          name: params.name,
          cwd: worktreePath,
          worktreeParentCwd: repoRoot,
          worktreeBranch: finalBranch
        })
      } catch (rowErr) {
        // Roll back the freshly created worktree so a failed insert can't leak a
        // dangling worktree. Force-remove since it's brand new (no user changes).
        try {
          await removeWorktree({ path: worktreePath, force: true })
        } catch {
          // Best-effort rollback; surface the original insert error regardless.
        }
        throw rowErr
      }
    })
  }
)

// Thin existence check used by NewWorkspaceMenu to flip the branch-field hint.
handle(
  'worktrees:branchExists',
  async (_e, { projectId, branch }: { projectId: string; branch: string }) => {
    const project = getProject(projectId)
    if (!project) return false
    let repoRoot: string
    try {
      repoRoot = await resolveMainWorktree(project.path)
    } catch {
      return false
    }
    return branchExists(repoRoot, branch)
  }
)

handle('workspaces:open', (_e, { id }: { id: string }) => openWorkspace(id))

handle('workspaces:setPinned', (_e, { id, pinned }: { id: string; pinned: boolean }) =>
  setWorkspacePinned(id, pinned)
)

handle('workspaces:archive', async (_e, { id, force = false }: { id: string; force?: boolean }) => {
  return await performArchive(id, force)
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

// Convert a worktree-backed workspace to a plain local workspace (non-destructive:
// does NOT delete the branch or worktree directory). Sets cwd = worktreeParentCwd
// and nulls the worktree fields, then broadcasts workspaces:changed.
handle('workspaces:convertToLocal', (_e, { id }: { id: string }) => convertWorktreeToLocal(id))

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

handle(
  'sessions:resumeInWorktreeWorkspace',
  (_e, { sessionId, projectId }: { sessionId: string; projectId: string }) =>
    createWorktreeResumingSession(projectId, sessionId)
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

// Footer Model chip: persist a model override and suppress the resulting
// dirty delta (the chip also injects `/model <value>` into the terminal live
// right after this resolves, so the running process already matches — see
// setWorkspaceSettingAndSuppressDirty above).
handle('workspace:setModel', (_e, args: { workspaceId: string; model: string }) => {
  return setWorkspaceSettingAndSuppressDirty(args.workspaceId, { model: args.model }, 'model')
})

// Footer Model chip: read the TRUE effective model a workspace would launch
// with right now (workspace override → project override → global setting),
// by reusing composeClaudeLaunch verbatim — the single source of truth for
// launch composition — instead of duplicating its resolution precedence.
handle('workspace:getEffectiveModel', (_e, args: { workspaceId: string }) => {
  const ws = getWorkspace(args.workspaceId)
  const launch = composeClaudeLaunch(ws?.projectId, args.workspaceId)
  const m = launch.flags.match(/^--model\s+(\S+)/)
  return { model: m ? m[1] : '' }
})

// Footer Effort chip: persist an effort override and suppress the resulting
// dirty delta (the chip also injects `/effort <value>` into the terminal live
// right after this resolves, so the running process already matches — see
// setWorkspaceSettingAndSuppressDirty above).
handle('workspace:setEffort', (_e, args: { workspaceId: string; effort: ClaudeEffort }) => {
  return setWorkspaceSettingAndSuppressDirty(args.workspaceId, { effort: args.effort }, 'effort')
})

// Footer Effort chip: read the TRUE effective effort a workspace would launch
// with right now, by reusing composeClaudeLaunch verbatim. Not anchored to
// start-of-string (unlike model) because --effort is not always flagParts[0].
handle('workspace:getEffectiveEffort', (_e, args: { workspaceId: string }) => {
  const ws = getWorkspace(args.workspaceId)
  const launch = composeClaudeLaunch(ws?.projectId, args.workspaceId)
  const m = launch.flags.match(/(?:^|\s)--effort\s+(\S+)/)
  return { effort: m ? m[1] : '' }
})

// ---------------------------------------------------------------------------
// Orpheus project config IPC (.orpheus/config.yml)
// ---------------------------------------------------------------------------

handle('orpheusConfig:get', async (_e, { projectId }) => {
  const project = getProject(projectId)
  if (!project) throw new Error(`orpheusConfig:get: project not found: ${projectId}`)
  return resolveWorkspacesConfig(project.path)
})

handle('orpheusConfig:setOverride', async (_e, { projectId, patch }) => {
  const project = getProject(projectId)
  if (!project) throw new Error(`orpheusConfig:setOverride: project not found: ${projectId}`)
  await writeProjectOverride(project.path, patch)
  return resolveWorkspacesConfig(project.path)
})

// ---------------------------------------------------------------------------
// Diagnostics IPC
// ---------------------------------------------------------------------------

ipcMain.on('diag:event', (_e, evt) => {
  ingestDiagEvent(evt)
})

handle('diag:openConsole', () => {
  openDiagConsole()
})

handle('diag:export', async (_e, { sinceMs }) => {
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
    applyLoadingOverlayTheme(patch.theme)
    setOverlayTheme(patch.theme)
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
    win.webContents.send(PUSH_CHANNELS.uiStateChanged, result)
  }
  return result
})

ipcMain.on(
  'workspace:setCurrentlyViewed',
  (_e, { workspaceId }: { workspaceId: string | null }) => {
    setCurrentlyViewedWorkspace(workspaceId)
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(PUSH_CHANNELS.terminalActiveWorkspaceChanged, { workspaceId })
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

handle('projects:setPinned', (_e, { id, pinned }: { id: string; pinned: boolean }) =>
  setProjectPinned(id, pinned)
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
  ): Promise<TerminalMountResult> => {
    const addon = loadTerminalAddon()
    ensureTitleCallback(addon)
    ensureLoadingOverlayWiring(addon)
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) throw new Error('terminal:mount — no BrowserWindow for sender')
    const nativeHandle = win.getNativeWindowHandle()

    // Look up the workspace's projectId for per-project override resolution
    const ws = getWorkspace(workspaceId)
    const projectId = ws?.projectId

    // ── Worktree reconcile (heal-on-mount) ─────────────────────────────────
    // For worktree-backed workspaces, reconcile the worktree state BEFORE any
    // native surface operation. This detects and heals stale/missing worktrees.
    //
    // We show the loading overlay FIRST (before the potentially multi-second
    // git operations) so the user never sees a blank pane.
    //
    // reconcileWorktree NEVER throws — it returns { ok: false } on all error
    // paths. If reconcile fails, we return the error without mounting and
    // without touching the surface, leaving it retryable.
    let reconcileNotice: string | undefined
    let effectiveCwd = cwd
    if (ws?.worktreeParentCwd != null && ws.worktreeBranch != null) {
      showLoadingOverlay(workspaceId, { title: 'Preparing worktree…' })
      let r: Awaited<ReturnType<typeof reconcileWorktree>>
      try {
        r = await reconcileWorktree({
          cwd: ws.cwd,
          worktreeParentCwd: ws.worktreeParentCwd,
          worktreeBranch: ws.worktreeBranch
        })
      } catch (err) {
        // reconcileWorktree guarantees no throws, but guard anyway so a bug
        // there cannot propagate to an unrecoverable blank surface.
        hideLoadingOverlay(workspaceId)
        return {
          workspaceId,
          worktreeError: {
            kind: 'parentGone',
            message: `Worktree reconcile threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`
          }
        }
      }
      if (!r.ok) {
        hideLoadingOverlay(workspaceId)
        return {
          workspaceId,
          worktreeError: { kind: r.kind, message: r.message, conflictPath: r.conflictPath }
        }
      }
      // Reconcile succeeded. Use the reconciled path as mount cwd; if the
      // worktree was recreated at a suffixed path (slug-2), persist the new cwd.
      if (r.path !== ws.cwd) {
        setWorkspaceCwd(workspaceId, r.path)
      }
      effectiveCwd = r.path
      reconcileNotice = r.notice
    }

    // Re-validate: the workspace may have been archived while reconcileWorktree
    // was in flight (potentially multi-second git operations). Mounting a
    // gone workspace would recreate its worktree and spawn a zombie claude
    // process for a row that no longer exists.
    {
      const wsNow = getWorkspace(workspaceId)
      if (!wsNow || wsNow.archivedAt != null) {
        hideLoadingOverlay(workspaceId)
        return { workspaceId, aborted: 'gone' as const }
      }
    }

    // Close the cold-mount PATH race: if the boot-time shell-path spawn hasn't
    // settled yet, await it now so buildMountEnv can inject ORPHEUS_USER_PATH
    // instead of forcing the .zshrc fallback (+100–800 ms).
    if (getCachedShellPath() === null) {
      await getUserShellPath()
    }

    // Re-validate again: the workspace may have been archived while
    // getUserShellPath was in flight. This is the last check before
    // addon.mount actually spawns the native surface + claude process.
    {
      const wsNow = getWorkspace(workspaceId)
      if (!wsNow || wsNow.archivedAt != null) {
        hideLoadingOverlay(workspaceId)
        return { workspaceId, aborted: 'gone' as const }
      }
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
          () =>
            buildMountEnv(
              workspaceId,
              projectId,
              notifyServer?.sockPath,
              commandServer ?? undefined
            )
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
          cwd: effectiveCwd,
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
    } else {
      // Surface already existed (re-attach). If a worktree workspace showed the
      // "Preparing worktree…" overlay before reconcile, clear it now — claude is
      // already running and no boot sequence is pending.
      // hideLoadingOverlay is a safe no-op when no overlay is active, so this
      // is unconditional and handles the non-worktree re-mount path too.
      hideLoadingOverlay(workspaceId)
    }

    // Snapshot the composed launch so we can detect settings drift later.
    launchSnapshots.set(workspaceId, launch)
    setDirty(workspaceId, false)

    // Push the current canInject state so the renderer chip gets an immediate
    // value without waiting for the next activity transition.
    {
      const injectable = terminalActions.canInject(workspaceId)
      e.sender.send(PUSH_CHANNELS.terminalCanInjectChanged, { workspaceId, canInject: injectable })
    }

    // Start (or re-join) the fs.watch watcher for this workspace's git repo so
    // status is pushed on change instead of polled every 30s.
    if (effectiveCwd) {
      startGitWatch(workspaceId, effectiveCwd, e.sender)
    }

    return reconcileNotice != null ? { ...result, notice: reconcileNotice } : result
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
  // ownerWorkspaceId backstop: force-hide any anchored overlay owned by this
  // workspace so it doesn't outlive its parent surface.
  forceHideOwnedBy(workspaceId)
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
    getMainWindow()?.webContents.send(PUSH_CHANNELS.workspaceTitleChanged, {
      workspaceId,
      title: null
    })
  }
  // Settings cache is cheap to evict — will be re-read on the next mount.
  invalidateClaudeWorkspaceSettingsCache(workspaceId)
  // ownerWorkspaceId backstop: force-hide any anchored overlay owned by this
  // workspace so it doesn't outlive the destroyed surface.
  forceHideOwnedBy(workspaceId)
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
// Overlay layer IPC (React overlays above the terminal)
// ---------------------------------------------------------------------------

handle('overlay:showDescriptor', (_e, { descriptor }: { descriptor: OverlayDescriptor }) =>
  showOverlay(descriptor)
)

handle(
  'overlay:update',
  (_e, { id, props }: { id: string; props: Record<string, unknown> }): void =>
    updateOverlay(id, props)
)

handle('overlay:hide', (_e, { id }: { id: string }) => hideOverlay(id))

// ipcMain.on registrations for the overlayRenderer:* channels (sends from the
// overlay WebContentsView, not invokes) live inside overlayLayer.ts itself.
// Registered once here at module init (process-global by channel name).
registerOverlayRendererIpc()

// ---------------------------------------------------------------------------
// resolveNamedKey — map CLI key names to TerminalSendKeyDescriptor
//
// Maps common human-readable key names (used by `ws send --key`) to the
// macOS virtual key codes that TerminalSendKeyDescriptor expects.
// kVK constants from <Carbon/Carbon.h>.
// ---------------------------------------------------------------------------

const NAMED_KEY_MAP: Record<string, TerminalSendKeyDescriptor> = {
  // Return / Enter
  enter: { keycode: 0x24, mods: 0 },
  return: { keycode: 0x24, mods: 0 },
  // Escape
  escape: { keycode: 0x35, mods: 0 },
  esc: { keycode: 0x35, mods: 0 },
  // Arrows
  up: { keycode: 0x7e, mods: 0 },
  down: { keycode: 0x7d, mods: 0 },
  left: { keycode: 0x7b, mods: 0 },
  right: { keycode: 0x7c, mods: 0 },
  // Tab
  tab: { keycode: 0x30, mods: 0 },
  // Backspace / Delete
  backspace: { keycode: 0x33, mods: 0 },
  delete: { keycode: 0x33, mods: 0 },
  // Space
  space: { keycode: 0x31, mods: 0 }
}

function resolveNamedKey(name: string): TerminalSendKeyDescriptor | null {
  return NAMED_KEY_MAP[name.toLowerCase()] ?? null
}

// ---------------------------------------------------------------------------
// delay / SUBMIT_DELAY_MS — bridge the text-ingest race between staging text
// (ghostty_surface_text, via terminalActions.sendInput/sendKeys) and
// submitting it (ghostty_surface_key Return, via terminalActions.submit).
// Those are two different libghostty code paths, and claude's full-screen TUI
// reads the PTY asynchronously — it needs a brief moment to ingest the
// just-committed text before a Return keypress means anything. Firing Return
// synchronously right after the text commit races ahead of that ingestion, so
// the line visibly sits in the input box without being submitted. 150ms is
// imperceptible to a human but ample for the TUI's read loop (terminal
// paste-then-submit automation typically needs 50-200ms).
const SUBMIT_DELAY_MS = 150
const delay = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Per-workspace injection mutex (RACE-10) — mirrors withRepoLock's
// promise-chain pattern (worktrees.ts) but keyed by workspaceId, a separate
// lock domain. Without this, two concurrent CLI injections into the SAME
// workspace (e.g. two `ws send` calls) can interleave their
// sendInput/sendKeys → delay → submit sequences: A stages text, B stages
// text, A submits (submitting A+B concatenated), B submits into a now-empty
// input box. Serialising the stage-then-submit critical section per
// workspace prevents that interleaving while leaving unrelated workspaces
// fully concurrent.
// ---------------------------------------------------------------------------
const injectLocks = new Map<string, Promise<unknown>>()
function withInjectLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = injectLocks.get(workspaceId) ?? Promise.resolve()
  const next = prev.then(
    () => fn(),
    () => fn()
  )
  // Store a silent version so map entry errors don't surface as unhandled rejections
  injectLocks.set(
    workspaceId,
    next.then(
      () => undefined,
      () => undefined
    )
  )
  return next
}

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
        win.webContents.send(PUSH_CHANNELS.actionsSubscriptionUpdate, { subscriptionId, value })
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

// Single-instance lock — acquired before any heavy init so a second launch
// exits cleanly without starting the command server, DB writers, etc.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Register second-instance handler BEFORE whenReady so it is in place by
  // the time a racing second launch fires the event on us.
  app.on('second-instance', () => {
    // The CLI (or user) re-launched while the app is already running.
    // Surface the existing main window instead of starting a new instance.
    const win = getMainWindow()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app
    .whenReady()
    .then(() => {
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
      // All output is [perf]-tagged for easy grep/removal later. Gated behind
      // dev builds (or an explicit opt-in env var in packaged builds) so a
      // background timer + monitor handle isn't allocated in production by
      // default.
      if (is.dev || process.env.ORPHEUS_PERF_EVENTLOOP === '1') {
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
      // Every other startup step here is try/catch-wrapped with console.error,
      // but this one is the most upstream: a migration throw must not silently
      // kill the app with no window and no visible error. Fail fast and
      // visibly instead — a half-migrated DB must not run a half-app.
      try {
        getDb()
      } catch (err) {
        console.error('[startup] database migration failed:', err)
        writeCrashFile(err)
        dialog.showErrorBox(
          'Orpheus — Database Error',
          'The database could not be migrated to the latest version and the app cannot start safely.\n\n' +
            'Your data has not been modified. A backup may exist alongside the database file.\n\n' +
            String(err instanceof Error ? err.message : err)
        )
        app.exit(1)
        return
      }
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
          win.webContents.send(PUSH_CHANNELS.workspaceActivityBatch, updates)
          // Push canInject state for each workspace that changed activity so the
          // renderer chips don't need to poll terminal:canInject every second.
          // Use the authoritative terminalActions.canInject() so 'attention' and
          // any future status additions are handled identically to the IPC handler.
          for (const { workspaceId } of updates) {
            if (!win.webContents.isDestroyed()) {
              win.webContents.send(PUSH_CHANNELS.terminalCanInjectChanged, {
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

        // Start the command server unconditionally — the CLI shouldn't depend on
        // hooks being enabled. Provides a request/response channel for CLI workspace
        // actions (create, archive, close, reopen, rename, whoami.resolve).
        if (!commandServer) {
          try {
            const cmdDeps: CommandServerDeps = {
              destroySurface: (workspaceId) => {
                if (terminalAddon) {
                  try {
                    terminalAddon.destroy(workspaceId)
                  } catch {
                    // Surface not mounted or already destroyed — ignore.
                  }
                }
              },
              teardownWorkspaceResources,
              performClose: (workspaceId) => performClose(workspaceId),
              performArchive: (workspaceId) => performArchive(workspaceId, true),
              requestOpenWorkspace,
              openAndSeed: async (
                workspaceId: string,
                taskText: string,
                focus: boolean = true,
                submit: boolean = true
              ): Promise<string | null> => {
                // Ask the renderer to open + mount the workspace. focus=true (default)
                // navigates the UI there (the normal nav path); focus=false performs a
                // background mount — the surface becomes injectable without stealing
                // the user's view.
                requestOpenWorkspace(workspaceId, focus)
                // Poll with a bounded timeout (25 s) for THREE conditions:
                //   1. getSurfacePhase() confirms an actual mounted surface (not 'none') —
                //      QA fix #3: a brand-new workspace has no activityMap entry yet, and
                //      getWorkspaceActivity() defaults an absent entry to 'idle', so
                //      canInject() alone reports "injectable" on the very first poll tick,
                //      before requestOpenWorkspace() has actually finished mounting the NSView.
                //   2. terminalActions.canInject() — status is 'idle' or 'awaiting_input'.
                //   3. isWorkspaceSessionReady() — CLAUDE ITSELF has booted and registered
                //      its ~/.claude/sessions/<pid>.json (status busy/idle/waiting). For a
                //      FRESHLY-CREATED workspace the terminal surface mounts within ~100ms,
                //      but claude takes several seconds to launch + reach its interactive
                //      prompt. Without this check, injection races ahead of claude's boot —
                //      the text lands in an empty shell (or before claude's TUI is reading
                //      input) and is silently lost: no transcript is ever written, even
                //      though this function reports success. This was the root cause of
                //      `ws new --task` reporting seedWarning:null while producing no
                //      transcript and leaving status at awaiting_input forever.
                //
                // TIMEOUT: bumped from 10 s → 25 s. The old timeout only had to cover
                // surface-mount time (~100ms); now the poll also waits out claude's full
                // boot + session-registration sequence, which can take 3-8 s in practice
                // (binary launch, MCP/tool init, session file write). 25 s leaves generous
                // headroom over the observed worst case without hanging indefinitely.
                const POLL_INTERVAL_MS = 300
                const TIMEOUT_MS = 25_000
                const deadline = Date.now() + TIMEOUT_MS
                let injectable = false
                while (Date.now() < deadline) {
                  let mounted = false
                  try {
                    const phase = loadTerminalAddon().getSurfacePhase(workspaceId)
                    mounted = phase === 'hidden' || phase === 'attached' || phase === 'visible'
                  } catch {
                    mounted = false
                  }
                  if (
                    mounted &&
                    terminalActions.canInject(workspaceId) &&
                    isWorkspaceSessionReady(workspaceId)
                  ) {
                    injectable = true
                    break
                  }
                  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
                }
                if (!injectable) {
                  return (
                    `seed-timeout: claude did not become ready within ${Math.round(TIMEOUT_MS / 1000)}s; ` +
                    'task not injected. The workspace was created but claude may still be booting ' +
                    '— open it manually and paste the task text once it reaches the prompt.'
                  )
                }
                // Critical section: stage text and (optionally) submit it. Locked per
                // workspace (RACE-10) so a concurrent injection into the same workspace
                // can't interleave its own stage/submit sequence with this one — the
                // 25s open+poll above intentionally runs OUTSIDE the lock so concurrent
                // calls don't stack slow waits behind each other.
                return withInjectLock(workspaceId, async (): Promise<string | null> => {
                  const addon = loadTerminalAddon()
                  const inputResult = terminalActions.sendInput(addon, workspaceId, taskText)
                  if (!inputResult.ok) {
                    return `seed-failed: could not send task text — ${inputResult.error ?? 'unknown error'}`
                  }
                  // submit=false: caller wants the task STAGED (typed into claude's input
                  // box) but not sent — e.g. for review/editing before the user presses
                  // Enter themselves. Skip the delay + submit entirely; the text sitting
                  // in the input box is the desired end state, not an intermediate one.
                  if (!submit) {
                    return null
                  }
                  // sendInput (ghostty_surface_text) and submit (ghostty_surface_key,
                  // a synthetic Return) are two different libghostty code paths. Claude's
                  // full-screen TUI reads the PTY asynchronously, so it needs a moment to
                  // ingest the just-committed text before a Return keypress is meaningful.
                  // Firing Return microseconds later races ahead of that ingestion and the
                  // line never actually submits — the text just sits in the input box.
                  // SUBMIT_DELAY_MS bridges that gap: imperceptible to a human, ample for
                  // the TUI's read loop (terminal paste-then-submit automation typically
                  // needs 50-200ms; 150 is a safe middle).
                  await delay(SUBMIT_DELAY_MS)
                  const submitResult = terminalActions.submit(addon, workspaceId)
                  if (!submitResult.ok) {
                    // If the workspace flipped to 'busy' during the delay, that most
                    // likely means claude already started processing the text we just
                    // staged (canInject() — and therefore submit — goes false the moment
                    // status leaves idle/awaiting_input). Treat this as a soft signal
                    // rather than a hard failure: the submit may well have raced a
                    // status flip caused by the text itself landing. Only a genuine,
                    // non-busy failure is reported as an error.
                    if (submitResult.code === 'busy') {
                      return `seed-submit-busy: text was sent; workspace became busy before the explicit submit — it may have already been submitted`
                    }
                    return `seed-submit-failed: text was sent but submit failed — ${submitResult.error ?? 'unknown error'}`
                  }
                  return null
                })
              },
              sendToWorkspace: async (
                workspaceId: string,
                payload: { text?: string; submit?: boolean; key?: string },
                focus: boolean = true
              ): Promise<{ ok: boolean; error?: string }> => {
                // QA #7 fix — verified root cause: terminalActions.canInject() reads
                // getWorkspaceActivity(), which defaults to 'idle' for ANY workspace with
                // no in-memory activity entry (orpheusNotify.ts: `activityMap.get(id) ??
                // 'idle'`) — including a workspace whose surface was never mounted, or one
                // that is closedAt-closed. So `!canInject(workspaceId)` was FALSE for an
                // unopened workspace (it looked injectable), the auto-open branch below was
                // skipped entirely, and the raw addon call failed with the unhelpful
                // 'No terminal surface for workspace' (code: 'not_found').
                //
                // Fix, two parts:
                //  (a) up front, if the workspace is known-closed (closedAt != null), always
                //      go through the open+poll path — closedAt is an authoritative DB
                //      signal that canInject's in-memory default can't see.
                //  (b) defense in depth: after the open+poll path (or when skipped because
                //      canInject looked true), if the actual send/key/submit call comes back
                //      with code 'not_found' (surface genuinely not mounted), open the
                //      workspace and retry once — this covers the exact false-'idle' case
                //      above for a workspace that was never mounted at all, not just closed.
                //
                // QA fix #3 — the poll itself had the SAME stale-default bug it was meant to
                // fix: openAndWaitInjectable() polled ONLY terminalActions.canInject(), which
                // is the same activityMap-defaults-to-'idle' check from (a) above. So the very
                // first poll iteration after requestOpenWorkspace() (fired but not yet actually
                // mounted the NSView) already reported "injectable" — the loop exited after 0ms
                // of real waiting, attemptSend() ran immediately against a not-yet-mounted
                // surface, got 'not_found', and even the (b) retry-once repeated the exact same
                // instant-false-positive poll. Net effect: `ws send` on a closed/unmounted
                // workspace failed ~100% of the time regardless of --submit — the reported
                // "text-only reports sent:true before the surface exists" asymmetry didn't
                // reproduce directly (both paths shared attemptSend and failed identically),
                // but the underlying not-ready detection was broken for both, which is the
                // real bug worth fixing here: the poll must confirm a surface ACTUALLY exists
                // via the addon's authoritative getSurfacePhase() (not the activity-map
                // default) before considering the workspace injectable.
                const POLL_INTERVAL_MS = 300
                const TIMEOUT_MS = 10_000
                const ACTIONABLE_ERROR_SUFFIX =
                  ' — run: orpheus ws open ' +
                  workspaceId +
                  ' (or it will be opened automatically; retry the send after it starts)'

                /**
                 * True only when the addon reports an actual mounted surface for this
                 * workspace ('hidden' | 'attached' | 'visible') — 'none' (never mounted)
                 * and 'freeing' (being torn down) are NOT ready. This is the authoritative
                 * truth query; unlike terminalActions.canInject() it cannot be fooled by
                 * the activity map's 'idle' default for a workspace with no activity entry.
                 */
                function hasMountedSurface(): boolean {
                  try {
                    const phase = loadTerminalAddon().getSurfacePhase(workspaceId)
                    return phase === 'hidden' || phase === 'attached' || phase === 'visible'
                  } catch {
                    return false
                  }
                }

                async function openAndWaitInjectable(): Promise<boolean> {
                  requestOpenWorkspace(workspaceId, focus)
                  const deadline = Date.now() + TIMEOUT_MS
                  while (Date.now() < deadline) {
                    if (hasMountedSurface() && terminalActions.canInject(workspaceId)) return true
                    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
                  }
                  return false
                }

                const ws = getWorkspace(workspaceId)
                if (ws == null) {
                  return { ok: false, error: `workspace not found: ${workspaceId}` }
                }

                // (a) Known-closed, or no confirmed mounted surface yet, or the in-memory
                // canInject default can't be trusted — don't trust it; always open + wait.
                if (
                  ws.closedAt != null ||
                  !hasMountedSurface() ||
                  !terminalActions.canInject(workspaceId)
                ) {
                  const injectable = await openAndWaitInjectable()
                  if (!injectable) {
                    return {
                      ok: false,
                      error:
                        'workspace not ready: the surface did not become injectable within 10 s.' +
                        ACTIONABLE_ERROR_SUFFIX
                    }
                  }
                }

                const addon = loadTerminalAddon()

                // Runs one full text/key/submit pass. Returns the first failure (if any).
                // Note: `wasStaged` tracks whether this pass wrote text/keys into the PTY
                // before any submit — used below to decide whether a 'busy' submit result
                // is a soft (likely-already-submitted) signal rather than a hard failure.
                async function attemptSend(): Promise<{
                  ok: boolean
                  error?: string
                  notFound?: boolean
                  softBusy?: boolean
                }> {
                  let wasStaged = false
                  if (payload.text != null && payload.text !== '') {
                    const inputResult = terminalActions.sendInput(addon, workspaceId, payload.text)
                    if (!inputResult.ok) {
                      return {
                        ok: false,
                        notFound: inputResult.code === 'not_found',
                        error: `send-text failed: ${inputResult.error ?? 'unknown error'}`
                      }
                    }
                    wasStaged = true
                  }
                  if (payload.key != null && payload.key !== '') {
                    const keyDescriptor = resolveNamedKey(payload.key)
                    if (keyDescriptor == null) {
                      return { ok: false, error: `unknown key name: "${payload.key}"` }
                    }
                    const keysResult = terminalActions.sendKeys(addon, workspaceId, [keyDescriptor])
                    if (!keysResult.ok) {
                      return {
                        ok: false,
                        notFound: keysResult.code === 'not_found',
                        error: `send-key failed: ${keysResult.error ?? 'unknown error'}`
                      }
                    }
                    wasStaged = true
                  }
                  if (payload.submit === true) {
                    // sendInput/sendKeys (text/key commit) and submit (a synthetic Return
                    // key event) are two different libghostty code paths. Claude's
                    // full-screen TUI reads the PTY asynchronously, so it needs a moment
                    // to ingest the just-staged text/key before Return is meaningful —
                    // firing it immediately races ahead of that ingestion and the line
                    // never actually submits. Only wait when something was actually
                    // staged this pass; a submit with no preceding text/key doesn't need
                    // the ingest gap.
                    if (wasStaged) {
                      await delay(SUBMIT_DELAY_MS)
                    }
                    const submitResult = terminalActions.submit(addon, workspaceId)
                    if (!submitResult.ok) {
                      if (wasStaged && submitResult.code === 'busy') {
                        // The workspace flipped to 'busy' during the delay — most likely
                        // claude already started processing the text/key we just staged
                        // (canInject/submit go false the moment status leaves
                        // idle/awaiting_input). Treat as a soft signal, not a hard
                        // failure: the content may well have already been submitted.
                        return { ok: true, softBusy: true }
                      }
                      return {
                        ok: false,
                        notFound: submitResult.code === 'not_found',
                        error: `submit failed: ${submitResult.error ?? 'unknown error'}`
                      }
                    }
                  }
                  return { ok: true }
                }

                // Locked per workspace (RACE-10) so a concurrent injection into the
                // same workspace can't interleave its own stage/submit sequence with
                // this one. openAndWaitInjectable() above intentionally runs OUTSIDE
                // the lock so concurrent calls don't stack slow (10s) opens behind
                // each other.
                const firstAttempt = await withInjectLock(workspaceId, attemptSend)
                if (firstAttempt.ok) {
                  if (firstAttempt.softBusy) {
                    return {
                      ok: true,
                      error:
                        'submit-busy: text/key was sent; workspace became busy before the explicit submit — it may have already been submitted'
                    }
                  }
                  return { ok: true }
                }

                // (b) Defense in depth: the surface genuinely isn't mounted despite
                // canInject saying otherwise (stale/defaulted activity). Open + wait, then
                // retry exactly once before giving up with an actionable error.
                if (firstAttempt.notFound === true) {
                  const injectable = await openAndWaitInjectable()
                  if (injectable) {
                    // Same per-workspace lock as the first attempt above (RACE-10).
                    const retryAttempt = await withInjectLock(workspaceId, attemptSend)
                    if (retryAttempt.ok) {
                      if (retryAttempt.softBusy) {
                        return {
                          ok: true,
                          error:
                            'submit-busy: text/key was sent; workspace became busy before the explicit submit — it may have already been submitted'
                        }
                      }
                      return { ok: true }
                    }
                    return { ok: false, error: retryAttempt.error ?? 'send failed' }
                  }
                  return {
                    ok: false,
                    error: `workspace not open${ACTIONABLE_ERROR_SUFFIX}`
                  }
                }

                return { ok: false, error: firstAttempt.error ?? 'send failed' }
              }
            }
            commandServer = startCommandServer(cmdDeps)
          } catch (err) {
            console.error('[commandServer] failed to start:', err)
          }
        }

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
    .catch((err: unknown) => {
      writeCrashFile(err)
      logDiagMain({
        category: 'error',
        level: 'fatal',
        event: DIAG_EVENTS.STARTUP_FATAL,
        message: err instanceof Error ? err.message : String(err)
      })
      dialog.showErrorBox(
        'Orpheus — Startup Error',
        'Orpheus failed to start.\n\n' + String(err instanceof Error ? err.message : err)
      )
      app.exit(1)
    })

  app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    notifyServer?.close()
    commandServer?.close()
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
} // end single-instance else block
