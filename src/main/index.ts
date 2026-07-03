import { APP_NAME, APP_ID, isDev } from './appMode'
import {
  startSessionStateService,
  setSessionReadyHandler,
  isWorkspaceSessionReady
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
  powerMonitor
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
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { DoctorResult } from '../shared/types'
import { TRAFFIC_LIGHT_INSET } from '../shared/windowChrome'
import { startGitWatch, stopGitWatch, stopAllGitWatches } from './git'
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
import { resolveOfferedModes } from './orpheusConfig'
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
  cancelAttentionRetry
} from './osNotifications'
import { startAutoCheckLoop, stopAutoCheckLoop } from './updates'
import { startStatusPoller, stopStatusPoller, rescheduleStatusPoll } from './claudeStatus'
import { getUserShellPath, getCachedShellPath } from './shellHelpers'
import type {
  AppUiStatePatch,
  ClaudeWorkspaceSettings,
  ClaudeEffort,
  WorkspaceRecord
} from '../shared/types'
import type { ClaudeLaunch } from './claudeSettings'
import { loadOrpheusSurface, buildMountEnv } from './orpheusSurfaceAdapter'
import type { GhosttySurfaceAddon } from '../../packages/ghostty-surface/index'
import * as terminalActions from './actions/terminal'
import { writeGhosttyConfigFile, updateGhosttyUserConfig } from './ghosttyConfig'
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
import { seedDefaultFooterActions } from './footerActions'
import { refreshFromModelsDev } from './pricing'
import {
  startDiagnostics,
  stopDiagnostics,
  logDiagMain,
  ingestDiagEvent,
  setDiagCategoryFlags,
  diag
} from './diagnostics'
import { DIAG_EVENTS } from '../shared/diagEvents'
import { startPowerAwake } from './powerAwake'
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
import { PUSH_CHANNELS } from '../shared/ipc'
import {
  configureWorkspaceResources,
  getLaunchSnapshot,
  setLaunchSnapshot,
  deleteLaunchSnapshot,
  launchSnapshotEntries,
  launchSnapshotCount,
  isDirty,
  setDirty,
  getTitle,
  setTitle,
  deleteTitle,
  seedTitle
} from './workspaceResources'
import { handle } from './ipc/handle'
import { isSafeExternalUrl } from './ipc/validate'
import { registerGitIpc } from './ipc/git'
import { registerShellIpc } from './ipc/shell'
import { registerSystemIpc } from './ipc/system'
import { registerUpdatesIpc } from './ipc/updates'
import { registerMcpIpc } from './ipc/mcp'
import { registerClaudeAgentsIpc } from './ipc/claudeAgents'
import { registerClaudeHooksIpc } from './ipc/claudeHooks'
import { registerClaudeAuthIpc } from './ipc/claudeAuth'
import { registerFooterActionsIpc } from './ipc/footerActions'
import { registerKeepAwakeIpc } from './ipc/keepAwake'
import { registerGhosttySettingsIpc } from './ipc/ghosttySettings'
import { registerMiscIpc } from './ipc/misc'
import { registerOrpheusConfigIpc } from './ipc/orpheusConfig'

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
    if (getTitle(workspaceId) === (cleaned ?? undefined)) return
    if (!cleaned && getTitle(workspaceId) === undefined) return

    console.log('[title] native fired', { workspaceId, raw: title, cleaned })
    if (cleaned) {
      setTitle(workspaceId, cleaned)
    } else {
      deleteTitle(workspaceId)
    }
    // Persist so the next launch can seed from the DB and the sidebar/header
    // shows the prior title instead of the default workspace name.
    try {
      setWorkspaceLastTitle(workspaceId, cleaned)
    } catch (err) {
      console.error('[title] failed to persist last_title', err)
    }
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
  deleteLaunchSnapshot(workspaceId)
  setDirty(workspaceId, false)
  evictAccumulator(workspaceId)
  invalidateClaudeWorkspaceSettingsCache(workspaceId)
  deleteTitle(workspaceId)
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
  const lastTitle = getTitle(id) ?? null
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
  if (launchSnapshotCount() === 0) return
  // Fetch global settings once — shared across all workspaces in the loop.
  // Each composeClaudeLaunch would otherwise run a redundant DB read.
  const globalSettings = getClaudeGlobalSettings()
  for (const [workspaceId, snap] of launchSnapshotEntries()) {
    const ws = getWorkspace(workspaceId)
    if (!ws) {
      // Workspace was archived/removed while a snapshot was still tracked
      // (e.g. archived mid-mount) — evict the stale entry instead of
      // leaving it around forever.
      deleteLaunchSnapshot(workspaceId)
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

  const snap = getLaunchSnapshot(workspaceId)
  if (snap) {
    const ws = getWorkspace(workspaceId)
    if (ws) {
      // Recompose fresh — this reflects the NEW value (already persisted
      // above) plus whatever ELSE currently differs from the snapshot.
      const fresh = composeClaudeLaunch(ws.projectId, workspaceId)
      const patchedFlags = reconcileFlagsExceptTarget(snap.flags, fresh.flags, flagName)

      // Only `flags` changes; settingsJson/env stay from the OLD snapshot.
      setLaunchSnapshot(workspaceId, { ...snap, flags: patchedFlags })
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

registerMiscIpc({ getProject })

// ---------------------------------------------------------------------------
// Projects IPC
// ---------------------------------------------------------------------------

handle('projects:list', () => listProjects())

handle('projects:add', (_e, { path }) => addProject(path))

handle('projects:pickAndAdd', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory', 'promptToCreate']
  })
  if (result.canceled || !result.filePaths[0]) return null
  const chosen = result.filePaths[0]
  console.log('[orpheus] project folder selected:', chosen)
  return addProject(chosen)
})

handle('projects:open', (_e, { id }) => openProject(id))

handle('projects:remove', async (_e, { id, deleteWorktrees = false, force = false }) => {
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
})

handle('projects:worktreeSummary', (_e, { projectId }) => {
  return { count: countWorktreeWorkspaces(projectId) }
})

handle('projects:rename', (_e, { id, name }) => renameProject(id, name))

// ---------------------------------------------------------------------------
// Workspaces IPC
// ---------------------------------------------------------------------------

handle('workspaces:listForProject', (_e, { projectId, scope }) =>
  listWorkspacesForProject(projectId, { scope })
)

handle('workspaces:create', (_e, args) => createWorkspace(args))

// Create a worktree-backed workspace. Async + git-first transaction order:
// resolve repo root → authoritatively enforce the offered-modes config →
// (under the per-repo mutex) decide new-vs-existing branch → create the git
// worktree → insert the DB row, rolling the worktree back if the insert fails.
// Nothing is persisted until the worktree exists, and a failed insert leaves no
// orphaned worktree behind.
handle('workspaces:createWorktree', async (_e, { projectId, params }) => {
  const project = getProject(projectId)
  if (!project) throw new Error(`workspaces:createWorktree: project not found: ${projectId}`)

  // Resolve the main worktree root. A non-git cwd throws NotAGitRepoError —
  // worktree workspaces are impossible there, so reject with a clear message.
  let repoRoot: string
  try {
    repoRoot = await resolveMainWorktree(project.path)
  } catch (err) {
    if (err instanceof NotAGitRepoError) {
      throw new Error(`Cannot create a worktree workspace: ${project.path} is not a git repository`)
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
})

// Thin existence check used by NewWorkspaceMenu to flip the branch-field hint.
handle('worktrees:branchExists', async (_e, { projectId, branch }) => {
  const project = getProject(projectId)
  if (!project) return false
  let repoRoot: string
  try {
    repoRoot = await resolveMainWorktree(project.path)
  } catch {
    return false
  }
  return branchExists(repoRoot, branch)
})

handle('workspaces:open', (_e, { id }) => openWorkspace(id))

handle('workspaces:setPinned', (_e, { id, pinned }) => setWorkspacePinned(id, pinned))

handle('workspaces:archive', async (_e, { id, force = false }) => {
  return await performArchive(id, force)
})

handle('workspace:close', (_e, { id }) => {
  const status = getWorkspaceActivity(id)
  if (status === 'in_progress') {
    return { ok: false as const, error: 'busy' as const }
  }
  const workspace = performClose(id)
  return { ok: true as const, workspace: workspace ?? null }
})

handle('workspace:reopen', (_e, { id }) => {
  const workspace = reopenWorkspace(id)
  return { ok: true as const, workspace: workspace ?? null }
})

handle('workspaces:rename', (_e, { id, name }) => renameWorkspace(id, name))

// Convert a worktree-backed workspace to a plain local workspace (non-destructive:
// does NOT delete the branch or worktree directory). Sets cwd = worktreeParentCwd
// and nulls the worktree fields, then broadcasts workspaces:changed.
handle('workspaces:convertToLocal', (_e, { id }) => convertWorktreeToLocal(id))

handle('workspaces:reorder', (_e, { projectId, orderedIds }) =>
  reorderWorkspaces(projectId, orderedIds)
)

handle('workspace:isDirty', (_e, { workspaceId }) => isDirty(workspaceId))

// ---------------------------------------------------------------------------
// Sessions IPC
// ---------------------------------------------------------------------------

handle('sessions:listForProject', (_e, { projectId, includeArchived }) =>
  listSessionsForProject(projectId, { includeArchived })
)

handle('sessions:listAll', (_e, opts) => listAllSessions(opts))

handle('sessions:setStatus', (_e, { id, status }) => setSessionStatus(id, status))

handle('sessions:listForProjectPaged', (_e, req) => listSessionsForProjectPaged(req))

handle('sessions:resumeInNewWorkspace', (_e, { sessionId, projectId }) =>
  createWorkspaceResumingSession(projectId, sessionId)
)

handle('sessions:resumeInWorktreeWorkspace', (_e, { sessionId, projectId }) =>
  createWorktreeResumingSession(projectId, sessionId)
)

handle('sessions:refreshMetadata', async (_e, { projectId }) => {
  await refreshSessionMetadata(projectId)
})

handle('sessions:delete', (_e, { id }) => deleteSession(id))

handle('sessions:getContextBudget', (_e, { workspaceId }) => getContextBudget(workspaceId))

// ---------------------------------------------------------------------------
// Claude Settings IPC
// ---------------------------------------------------------------------------

handle('claudeSettings:get', () => getClaudeGlobalSettings())

handle('claudeSettings:update', (_e, patch) => {
  const result = updateClaudeGlobalSettings(patch)
  recomputeDirty()
  return result
})

// ---------------------------------------------------------------------------
// Ghostty Settings IPC
//
// ghosttySettings:get is extracted to ipc/ghosttySettings.ts.
// ghosttySettings:update stays here — it depends on loadTerminalAddon(),
// the private native-addon singleton loader (deferred terminal domain).
// ---------------------------------------------------------------------------

registerGhosttySettingsIpc()

handle('ghosttySettings:update', (_e, patch) => {
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

registerMcpIpc()

registerClaudeAgentsIpc()

registerClaudeHooksIpc()

registerClaudeAuthIpc()

// ---------------------------------------------------------------------------
// Per-project Claude Settings IPC
// ---------------------------------------------------------------------------

handle('claudeProjectSettings:get', (_e, { projectId }) => getClaudeProjectSettings(projectId))

handle('claudeProjectSettings:update', (_e, args) => {
  const result = updateClaudeProjectSettings(args.projectId, args.patch)
  recomputeDirty()
  return result
})

// ---------------------------------------------------------------------------
// Per-workspace Claude Settings IPC
// ---------------------------------------------------------------------------

handle('claudeWorkspaceSettings:get', (_e, { workspaceId }) =>
  getClaudeWorkspaceSettings(workspaceId)
)

handle('claudeWorkspaceSettings:update', (_e, args) => {
  const result = updateClaudeWorkspaceSettings(args.workspaceId, args.patch)
  recomputeDirty()
  return result
})

// Footer Model chip: persist a model override and suppress the resulting
// dirty delta (the chip also injects `/model <value>` into the terminal live
// right after this resolves, so the running process already matches — see
// setWorkspaceSettingAndSuppressDirty above).
handle('workspace:setModel', (_e, args) => {
  return setWorkspaceSettingAndSuppressDirty(args.workspaceId, { model: args.model }, 'model')
})

// Footer Model chip: read the TRUE effective model a workspace would launch
// with right now (workspace override → project override → global setting),
// by reusing composeClaudeLaunch verbatim — the single source of truth for
// launch composition — instead of duplicating its resolution precedence.
handle('workspace:getEffectiveModel', (_e, args) => {
  const ws = getWorkspace(args.workspaceId)
  const launch = composeClaudeLaunch(ws?.projectId, args.workspaceId)
  const m = launch.flags.match(/^--model\s+(\S+)/)
  return { model: m ? m[1] : '' }
})

// Footer Effort chip: persist an effort override and suppress the resulting
// dirty delta (the chip also injects `/effort <value>` into the terminal live
// right after this resolves, so the running process already matches — see
// setWorkspaceSettingAndSuppressDirty above).
handle('workspace:setEffort', (_e, args) => {
  return setWorkspaceSettingAndSuppressDirty(args.workspaceId, { effort: args.effort }, 'effort')
})

// Footer Effort chip: read the TRUE effective effort a workspace would launch
// with right now, by reusing composeClaudeLaunch verbatim. Not anchored to
// start-of-string (unlike model) because --effort is not always flagParts[0].
handle('workspace:getEffectiveEffort', (_e, args) => {
  const ws = getWorkspace(args.workspaceId)
  const launch = composeClaudeLaunch(ws?.projectId, args.workspaceId)
  const m = launch.flags.match(/(?:^|\s)--effort\s+(\S+)/)
  return { effort: m ? m[1] : '' }
})

registerOrpheusConfigIpc({ getProject })

// ---------------------------------------------------------------------------
// Diagnostics IPC
// ---------------------------------------------------------------------------

ipcMain.on('diag:event', (_e, evt) => {
  ingestDiagEvent(evt)
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

registerSystemIpc({ getAppUiState })

registerUpdatesIpc()

handle('projects:setExpandedInSidebar', (_e, { id, expanded }) =>
  setProjectExpandedInSidebar(id, expanded)
)

handle('projects:reorder', (_e, { orderedIds }) => reorderProjects(orderedIds))

handle('projects:setPinned', (_e, { id, pinned }) => setProjectPinned(id, pinned))

handle('projects:refreshGithub', (_e, projectId) => refreshGithubData(projectId))

handle('doctor:check', async (): Promise<DoctorResult> => {
  const { installed, version, path: claudePath } = await checkClaude()
  return {
    claudeInstalled: installed,
    claudeVersion: version,
    claudePath
  }
})

registerGitIpc()

registerShellIpc({ getAppUiState })

// ---------------------------------------------------------------------------
// Terminal IPC — ghostty-surface lifecycle
// ---------------------------------------------------------------------------

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

handle('terminal:mount', async (e, { workspaceId, rect, scaleFactor, cwd }) => {
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
      buildResult = diag.span('launch.compose', { workspaceId, projectId: projectId ?? null }, () =>
        buildMountEnv(workspaceId, projectId, notifyServer?.sockPath, commandServer ?? undefined)
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
  setLaunchSnapshot(workspaceId, launch)
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
})

handle('terminal:hide', (_e, { workspaceId }): void => {
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

handle('terminal:focus', (_e, { workspaceId }): void => {
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

handle('terminal:getSurfacePhase', (_e, { workspaceId }) => {
  try {
    // The native addon's getSurfacePhase is declared as a plain `string`
    // (packages/ghostty-surface/index.ts keeps that package's public surface
    // free of src/ imports), but addon.mm's GetSurfacePhase only ever
    // produces one of these five literals (see the NAPI export comment at
    // packages/ghostty-surface/addon.mm:3799).
    return loadTerminalAddon().getSurfacePhase(workspaceId) as
      | 'none'
      | 'hidden'
      | 'attached'
      | 'visible'
      | 'freeing'
  } catch {
    return 'none'
  }
})

handle('terminal:resize', (_e, { workspaceId, rect, scaleFactor }): void => {
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
})

handle('terminal:destroy', (_e, { workspaceId }): void => {
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
  deleteLaunchSnapshot(workspaceId)
  setDirty(workspaceId, false)
  // Clear title and notify renderer so stale claude titles don't linger
  deleteTitle(workspaceId)
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

handle('overlay:showDescriptor', (_e, { descriptor }) => showOverlay(descriptor))

handle('overlay:update', (_e, { id, props }): void => updateOverlay(id, props))

handle('overlay:hide', (_e, { id }) => hideOverlay(id))

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

handle('terminal:sendInput', (_e, { workspaceId, text }) => {
  const addon = loadTerminalAddon()
  return terminalActions.sendInput(addon, workspaceId, text)
})

handle('terminal:sendKeys', (_e, { workspaceId, keys }) => {
  const addon = loadTerminalAddon()
  return terminalActions.sendKeys(addon, workspaceId, keys)
})

handle('terminal:submit', (_e, { workspaceId }) => {
  const addon = loadTerminalAddon()
  return terminalActions.submit(addon, workspaceId)
})

handle('terminal:clearInput', (_e, { workspaceId }) => {
  const addon = loadTerminalAddon()
  return terminalActions.clearInput(addon, workspaceId)
})

handle('terminal:canInject', (_e, { workspaceId }): boolean => {
  return terminalActions.canInject(workspaceId)
})

// ---------------------------------------------------------------------------
// Quick Actions — phase 2: registry IPC surface
// ---------------------------------------------------------------------------

handle('actions:invoke', (_e, { actionId, params, workspaceId, consumerHint }) => {
  const invocation: ActionInvocation = { id: actionId, params, workspaceId }
  return actionsInvoke(invocation, consumerHint ?? 'ipc')
})

handle('actions:list', () => actionsList())

handle('actions:history', (_e, { workspaceId, limit }) => getAuditHistory(workspaceId, limit))

handle('actions:subscribe', (e, { subscriptionId, actionId, params, workspaceId }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  startSubscription(subscriptionId, actionId, params, workspaceId, (value) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send(PUSH_CHANNELS.actionsSubscriptionUpdate, { subscriptionId, value })
    }
  })
  return { ok: true as const }
})

handle('actions:unsubscribe', (_e, { subscriptionId }) => {
  stopSubscription(subscriptionId)
  return { ok: true as const }
})

registerFooterActionsIpc()

handle('workspace:getTitle', (_e, { workspaceId }) => getTitle(workspaceId) ?? null)

registerKeepAwakeIpc()

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

      // Wire the workspaceResources registry's main→renderer broadcast bridge
      // once at boot (mirrors configureLoadingOverlay's injection pattern) —
      // keeps workspaceResources.ts a leaf with no import back on index.ts.
      configureWorkspaceResources({
        broadcast: (channel, payload) => getMainWindow()?.webContents.send(channel, payload)
      })

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
          seedTitle(id, title)
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
