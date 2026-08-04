import './safeConsole'
import { APP_NAME, APP_ID, isDev } from './appMode'
import {
  startSessionStateService,
  setSessionReadyHandler,
  setRuntimeSessionObserver,
  isWorkspaceSessionReady,
  getWorkspaceFileInfo
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
import { pathToFileURL } from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AutomationChangedEvent, DoctorResult } from '../shared/types'
import { TRAFFIC_LIGHT_INSET } from '../shared/windowChrome'
import { startGitWatch, stopGitWatch, stopAllGitWatches } from './git'
import { stopFilesWatch } from './filesWatcher'
import { getDb } from './db'
import { getProject } from './projects'
import { isWorktreeDirty, reconcileWorktree } from './worktrees'
import {
  getWorkspace,
  archiveWorkspace,
  closeWorkspace,
  listWorkspacesForProject,
  listChildWorkspaces,
  setWorkspaceLastTitle,
  getAllWorkspaceLastTitles,
  resetTransientStatusesOnStartup,
  setWorkspaceCwd
} from './workspaces'
import { invalidateClaudeWorkspaceSettingsCache } from './claudeWorkspaceSettings'
import {
  createDedicatedWorkspaceTerminal,
  deleteLayout as deletePaneLayoutRow,
  deletePanel as deletePanePanelRow,
  deleteTerminal as deletePaneTerminalRow,
  deleteDedicatedWorkspaceTerminal,
  getLayout,
  getTerminal,
  listAutoStartLayouts,
  listAgentManagedLayoutsByOwner,
  listLayouts,
  listTerminals
} from './paneStore'
import { getAppUiState, updateAppUiState } from './uiState'
import { applyPersistedIconPack } from './iconPacks'
import { onActivityBatch } from './activitySink'
import {
  startNotifyServer,
  ensureManagedHooks,
  uninstallManagedHooks,
  clearWorkspaceActivity,
  setAutoCloseHandler,
  onWorkspaceStatusPersisting,
  onWorkspaceStatusCommitted
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
import { startStatusPoller, stopStatusPoller } from './claudeStatus'
import { startUsagePoller, stopUsagePoller } from './usagePoller'
import { startClaudeActivityPoller, stopClaudeActivityPoller } from './claudeActivityPoller'
import { getUserShellPath, getCachedShellPath } from './shellHelpers'
import type { WorkspaceRecord } from '../shared/types'
import {
  loadOrpheusSurface,
  buildMountEnv,
  isRoutedMount,
  composeLaunchForMount,
  buildTmuxAttachEnv
} from './orpheusSurfaceAdapter'
import type { GhosttySurfaceAddon } from '../../packages/ghostty-surface/index'
import { prepareTerminalLaunchEnv } from './terminalLaunchEnv'
import { buildAppMenu } from './appMenu'
import * as terminalActions from './actions/terminal'
import { writeGhosttyConfigFile, updateGhosttyUserConfig } from './ghosttyConfig'
import type { TerminalSendKeyDescriptor } from '../shared/types'
import type { SplitTree, PaneLayout, TerminalRect, TerminalMountResult } from '../shared/types'
import { bootActions, setTerminalAddonRef, registerWebContentsCleanup } from './actions/index'
import { evictAccumulator } from './actions/session'
import { seedDefaultFooterActions } from './footerActions'
import { refreshModelsDevCache } from './models/registry'
import {
  startDiagnostics,
  stopDiagnostics,
  logDiagMain,
  ingestDiagEvent,
  diag
} from './diagnostics'
import { DIAG_EVENTS } from '../shared/diagEvents'
import { redactErrorForLog, redactErrorMessage, redactLogString } from './logRedaction'
import { startPowerAwake } from './powerAwake'
import { startCommandServer } from './commandServer'
import type { CommandServerDeps } from './commandServer'
import {
  unhostWorkspace,
  hostWorkspace,
  resolveMountStrategy,
  ensureTmuxVersion,
  TmuxNotAvailableError,
  TmuxVersionTooOldError
} from './tmuxHost'
import {
  initOverlayLayer,
  registerOverlayRendererIpc,
  isInteractiveOverlayVisible,
  focusOverlay,
  forceHideOwnedBy,
  setOverlayTheme
} from './overlayLayer'
import { PUSH_CHANNELS } from '../shared/ipc'
import {
  configureWorkspaceResources,
  setLaunchSnapshot,
  getLaunchSnapshot,
  deleteLaunchSnapshot,
  setDirty,
  getTitle,
  setTitle,
  deleteTitle,
  seedTitle,
  setOverlayFallbackTimer,
  clearOverlayFallbackTimer,
  takeOverlayFallbackTimer,
  withInjectLock,
  teardownWorkspaceState
} from './workspaceResources'
import { handle } from './ipc/handle'
import { isSafeExternalUrl } from './ipc/validate'
import { isTrustedRendererUrl } from './rendererTrust'
import { registerGitIpc } from './ipc/git'
import { registerFilesIpc } from './ipc/files'
import { registerShellIpc } from './ipc/shell'
import { registerSystemIpc } from './ipc/system'
import { registerUpdatesIpc } from './ipc/updates'
import { registerProdImportIpc } from './ipc/prodImport'
import { registerRoutingProxyIpc } from './ipc/routingProxy'
import { registerProvidersIpc } from './ipc/providers'
import { registerAliasesIpc } from './ipc/aliases'
import { registerOAuthIpc } from './ipc/oauth'
import {
  hydrateSnapshotAtBoot,
  reconcileRoutingProxy,
  shutdownRoutingProxySync,
  ensureHealthyForRouting
} from './routingProxy/manager'
import { registerMcpIpc } from './ipc/mcp'
import { registerClaudeAgentsIpc } from './ipc/claudeAgents'
import { registerClaudeHooksIpc } from './ipc/claudeHooks'
import { registerClaudeAuthIpc } from './ipc/claudeAuth'
import { getClaudeAuthEnv } from './claudeAuth'
import { registerClaudeUsageIpc } from './ipc/claudeUsage'
import { registerClaudeActivityIpc } from './ipc/claudeActivity'
import { registerFooterActionsIpc } from './ipc/footerActions'
import { registerReviewsIpc } from './ipc/reviews'
import { createRendererCommandTransport, registerWorkbenchControlIpc } from './ipc/workbenchControl'
import { RendererCommandBroker } from './workbenchControl/rendererCommandBroker'
import { WorkbenchControlService } from './workbenchControl/service'
import { createMainPaneControlPort } from './workbenchControl/mainPaneAdapter'
import {
  resolvePaneBackgroundScaleFactor,
  startProvisionedPaneSurface
} from './workbenchControl/paneProvisioningStart'
import { teardownPaneSurfaceStrict } from './workbenchControl/paneSurfaceTeardown'
import { isCanonicalWorkspacePath } from './workbenchControl/pathSafety'
import { createControlAuditStore } from './controlPlane/controlAudit'
import { invokeControl, listControl } from './controlPlane'
import {
  startMainControlPlaneLifecycle,
  type MainControlPlaneLifecycle
} from './controlPlane/mainLifecycle'
import { createTrustedRuntimeReadPolicy } from './controlPlane/readPolicy'
import { createMainReadHandlers } from './controlPlane/mainReadHandlers'
import { createMainSettingsResourceService } from './controlPlane/mainSettingsResourceService'
import { RuntimeLeaseRegistry } from './controlPlane/runtimeLeases'
import type { RuntimeLeaseIssue } from './controlPlane/runtimeLeases'
import {
  createMainWorkspaceOrchestration,
  type WorkspaceOrchestrationService
} from './workspaceOrchestration'
import { RuntimeControlGrantPolicy } from './controlPlane/runtimeGrants'
import { createRuntimeResourceScopeSource } from './controlPlane/runtimeResourceScope'
import {
  WorkspaceOpenRequestQueue,
  type WorkspaceOpenRequest
} from './workspaceOrchestration/openRequestQueue'
import { registerPanesIpc } from './ipc/panes'
import { registerKeepAwakeIpc } from './ipc/keepAwake'
import { registerGhosttySettingsIpc } from './ipc/ghosttySettings'
import { registerClaudeSettingsIpc, recomputeHostingModeDirty } from './ipc/claudeSettings'
import { registerWorktreesIpc } from './ipc/worktrees'
import { registerHooksIpc } from './ipc/hooks'
import { registerUiStateIpc, syncDiagFlags } from './ipc/uiState'
import { registerSessionsIpc } from './ipc/sessions'
import { registerModelsIpc } from './ipc/models'
import { registerProjectsIpc } from './ipc/projects'
import { registerWorkspacesIpc } from './ipc/workspaces'
import { registerActionsIpc } from './ipc/actions'
import { registerOverlayIpc } from './ipc/overlay'
import { registerMiscIpc } from './ipc/misc'
import { registerIconPacksIpc } from './ipc/iconPacks'
import { registerOrpheusConfigIpc } from './ipc/orpheusConfig'
import { WorkspaceControlAdapter } from './workspaceControlAdapter'
import {
  createMainTerminalObservation,
  paneSurfaceId,
  type NativeSurfacePhase,
  type TerminalObservationService
} from './terminalObservation'

let notifyServer: { sockPath: string; close: () => void } | null = null
let commandServer: {
  sockPath: string
  token: string
  ready: Promise<void>
  close: () => void
} | null = null
let sessionStateService: { stop: () => void } | null = null
let powerAwakeCleanup: (() => void) | null = null
const runtimeLeases = new RuntimeLeaseRegistry()
let workspaceOrchestrationService: WorkspaceOrchestrationService | null = null
let terminalObservationService: TerminalObservationService | null = null
let terminalObservationCleanup: (() => void) | null = null
let controlPlaneLifecycle: MainControlPlaneLifecycle | null = null
let unmanagedMountWarningEmitted = false

setRuntimeSessionObserver(({ workspaceId, claudeConversationId, session }) => {
  const binding = runtimeLeases.getBySurfaceId(workspaceId)
  if (binding != null) {
    if (
      binding.claudeConversationId != null &&
      binding.claudeConversationId !== claudeConversationId
    ) {
      runtimeLeases.revokeBySurface(workspaceId)
    } else if (session != null) {
      runtimeLeases.observeClaude({
        workspaceId,
        claudeConversationId,
        pid: session.pid
      })
    } else if (binding.state === 'live') {
      // A fresh pending mount legitimately has no session file during Claude
      // startup. Preserve it until its TTL; once a runtime was observed live,
      // disappearance means the wrapper has fallen through to an interactive
      // shell and must no longer authenticate as the Claude agent.
      runtimeLeases.observeClaude({
        workspaceId,
        claudeConversationId,
        pid: null
      })
    }
  }
  terminalObservationService?.recordRuntimeSessionObservation({
    workspaceId,
    claudeConversationId,
    session
  })
})

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
        console.error('[orpheusNotify] failed to start notify server:', redactErrorForLog(err))
      }
    }
    try {
      ensureManagedHooks()
    } catch (err) {
      console.error('[orpheusNotify] failed to install managed hooks:', redactErrorForLog(err))
    }
  } else {
    if (notifyServer) {
      notifyServer.close()
      notifyServer = null
    }
    try {
      uninstallManagedHooks()
    } catch (err) {
      console.error('[orpheusNotify] failed to uninstall managed hooks:', redactErrorForLog(err))
    }
  }
}

// Cached main window reference — avoids BrowserWindow.getAllWindows() in hot paths.
let mainWindowRef: BrowserWindow | null = null
let rendererWorkspaceOpenReady = false
let nativeWindowOcclusionVisible: boolean | null = null
const workspaceOpenRequests = new WorkspaceOpenRequestQueue()

function getMainWindow(): BrowserWindow | null {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) return mainWindowRef
  // Fallback — should only happen if the window was destroyed unexpectedly.
  mainWindowRef = BrowserWindow.getAllWindows()[0] ?? null
  return mainWindowRef
}

function trustedRendererEntryUrl(): string {
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    return process.env['ELECTRON_RENDERER_URL']
  }
  return pathToFileURL(join(__dirname, '../renderer/index.html')).toString()
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
  workspaceOpenRequests.request(
    { kind: 'renderer-open', workspaceId, focus },
    deliverWorkspaceOpenRequest
  )
}

// Runtime orchestration already holds the project mutation lease. Carry the
// snapshot cwd so the renderer can mount without re-entering workspaces:open.
function requestOrchestrationMount(workspaceId: string, cwd: string): void {
  workspaceOpenRequests.request(
    { kind: 'orchestration-mount', workspaceId, focus: false, cwd },
    deliverWorkspaceOpenRequest
  )
}

function deliverWorkspaceOpenRequest(request: WorkspaceOpenRequest): boolean {
  const window = getMainWindow()
  if (!rendererWorkspaceOpenReady || window == null || window.webContents.isDestroyed()) {
    return false
  }
  try {
    window.webContents.send(PUSH_CHANNELS.workspaceRequestOpen, request)
    return true
  } catch {
    return false
  }
}

let terminalCallbacksRegistered = false
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

function ensureTerminalCallbackWiring(addon: GhosttySurfaceAddon): void {
  if (terminalCallbacksRegistered) return
  addon.setTitleCallback((surfaceKey: string, title: string) => {
    // Panes have persisted user-authored names in paneStore; their shell title
    // is not a workspace title. Ignore it before normalization so command
    // title churn cannot populate workspaceResources or broadcast events for
    // synthetic `pane:<layoutId>:<paneId>` keys.
    if (isPaneSlotId(surfaceKey)) return

    // Claude Code prefixes titles with a cycling spinner glyph (✱ ✶ ✻ ✺ ✦ …)
    // and a space. Strip leading non-letter/non-digit characters so the
    // sidebar shows clean text and so our own loader UI can layer in front.
    // Stripping also collapses the spinner animation to one stable string
    // ("✱ Loading" → "✶ Loading" → … all become "Loading"), which the
    // dedupe below uses to avoid hammering the DB on every frame.
    const cleaned = (title ?? '').replace(/^[^\p{L}\p{N}]+/u, '').trim() || null

    // The addon's title callback fires for ANY surface — it's keyed by the
    // opaque native surface id, not scoped to claude workspaces. Workbench
    // ad-hoc terminals are mounted as `workbench:<workspaceId>:<terminalId>`
    // (see workbenchSlotId above); route those to their own dedicated push
    // channel instead of falling through to the claude-workspace title
    // logic below (getTitle/setTitle/deleteTitle/setWorkspaceLastTitle are
    // all keyed by plain claude workspaceId and must never see a workbench
    // slot key). No dedupe here — the workbench side owns its own
    // last-label comparison in the renderer, and per-terminal title churn is
    // low-volume compared to claude's own spinner-driven updates.
    const workbenchParts = parseWorkbenchSlotId(surfaceKey)
    if (workbenchParts) {
      getMainWindow()?.webContents.send(PUSH_CHANNELS.workbenchTerminalTitleChanged, {
        workspaceId: workbenchParts.workspaceId,
        terminalId: workbenchParts.terminalId,
        title: cleaned
      })
      return
    }

    const workspaceId = surfaceKey

    // Skip if nothing changed — guards the per-frame spinner churn.
    if (getTitle(workspaceId) === (cleaned ?? undefined)) return
    if (!cleaned && getTitle(workspaceId) === undefined) return

    console.log('[title] native fired', {
      workspaceId,
      titleBytes: Buffer.byteLength(title, 'utf8'),
      hasCleanedTitle: cleaned != null
    })
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
      console.error('[title] failed to persist last_title', redactErrorForLog(err))
    }
  })
  addon.setOcclusionCallback((workspaceId: string, occluded: boolean) => {
    nativeWindowOcclusionVisible = !occluded
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
  // Runtime cell-size re-fires (font-size changes at runtime). The initial
  // creation-time resolve doesn't come through here — it's returned directly
  // from terminal:mount's result instead (see cellHeightPx below).
  addon.setCellSizeCallback((workspaceId: string, cellHeightPx: number) => {
    getMainWindow()?.webContents.send(PUSH_CHANNELS.terminalCellSizeChanged, {
      workspaceId,
      cellHeightPx
    })
  })
  // Diagnostic: forward every action_cb tag to the renderer for visibility
  // via DevTools console. Gated on ORPHEUS_DEBUG_ACTION_TRACE=1 because this
  // fires at 60-120 Hz (every RENDER action) and is heavy in production.
  if (process.env['ORPHEUS_DEBUG_ACTION_TRACE'] === '1') {
    addon.setActionTraceCallback((tagName: string) => {
      const win = getMainWindow()
      win?.webContents.send(PUSH_CHANNELS.addonActionTrace, { tagName })
    })
  }
  terminalCallbacksRegistered = true
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
  runtimeLeases.revokeByWorkspace(workspaceId)
  // The 5-map registry slice (launchSnapshots, dirty, titles, overlay
  // fallback timers, injectLocks) lives in workspaceResources.ts, which
  // stays a leaf with no knowledge of these cross-module concerns.
  hideLoadingOverlay(workspaceId)
  cancelAttentionRetry(workspaceId)
  clearWorkspaceActivity(workspaceId)
  evictAccumulator(workspaceId)
  invalidateClaudeWorkspaceSettingsCache(workspaceId)
  teardownWorkspaceState(workspaceId)
  if (cwd) stopGitWatch(workspaceId, cwd)
  // Reap the Files tab's working-tree watcher too, if this workspace happened
  // to be the one watch instance active (no-op otherwise — stopFilesWatch is
  // a targeted, workspaceId-matched stop, see filesWatcher.ts).
  stopFilesWatch(workspaceId)
}

function destroyWorkspaceRuntime(id: string, knownCwd?: string | null): void {
  workspaceOpenRequests.cancel(id)
  const ws = getWorkspace(id)
  if (terminalAddon) {
    try {
      terminalAddon.destroy(id)
      terminalObservationService?.recordWorkspaceLifecycle(id, getNativeSurfacePhase(id))
    } catch {
      // Surface not mounted or already destroyed — ignore.
    }
  }
  // Trigger (g): workspace close is one of the only two allowed workbench
  // terminal destroy points — destroy ALL of this workspace's workbench
  // surfaces here, authoritatively, regardless of what's currently mounted
  // in the renderer (see workbenchSurfacesByWorkspace's header comment).
  destroyWorkbenchSurfacesForWorkspace(id)
  // Same trigger (g) applies to Panes tab surfaces (see
  // paneSurfacesByWorkspace's header comment).
  destroyPaneSurfacesForWorkspace(id)
  destroyAgentPaneSurfacesForOwner(id)
  teardownWorkspaceResources(id, knownCwd ?? ws?.cwd ?? null)
}

function performClose(id: string): WorkspaceRecord | undefined {
  // NOTE: close keeps the worktree on disk (reconciled on next open); only
  // archive/project-delete tears it down. Do NOT add worktree removal here.
  // Capture the live terminal title BEFORE teardownWorkspaceResources clears it,
  // so the closed workspace keeps its name in the sidebar.
  const lastTitle = getTitle(id) ?? null
  const ws = getWorkspace(id)
  destroyWorkspaceRuntime(id)

  // TEAR DOWN THE TMUX SESSION TOO — destroyWorkspaceRuntime above only
  // destroys the libghostty surface, which is a NO-OP for a tmux-hosted
  // workspace (the desktop never mounted a native surface for one — see
  // performArchive's own note on the same asymmetry). Without this, closing
  // a workspace left its tmux session — and the `claude` inside it — running
  // forever, detached from the app and surviving app restarts. Verified
  // empirically: four workspaces marked closed_at in the dev DB still had
  // live sessions and live shell pids days later. That also made
  // workspace.close's declared 'process.terminate' effect (service.ts's
  // CLOSE_EFFECTS) a lie for exactly the workspaces tmux hosts.
  //
  // Fire-and-forget rather than awaited so performClose stays SYNCHRONOUS:
  // its type is part of CommandServerDeps (commandServer.ts) and both call
  // sites here ignore the return, so going async would ripple for no gain.
  // unhostWorkspace() is idempotent/best-effort by construction (tolerates
  // no session, no tmux binary, an already-dead session) and never throws,
  // so it cannot turn a successful close into a failure.
  //
  // REVERSIBILITY: close is still undoable via workspace.reopen — but the
  // reopened workspace starts a FRESH claude rather than reattaching to the
  // old one, since hostWorkspace() is idempotent (has-session check, then
  // reuse or create) and will simply create a new session. Losing in-flight
  // scrollback is the deliberate trade: a "closed" workspace quietly holding
  // a live agent is worse than a clean restart.
  if (ws != null) {
    void unhostWorkspace({ workspaceId: id, workspaceName: ws.name }).catch((err: unknown) => {
      console.warn('[performClose] tmux teardown failed for workspaceId=%s:', id, err)
    })
  }

  return closeWorkspace(id, lastTitle)
}

async function performArchive(
  id: string,
  force: boolean = false
): Promise<{ archived: boolean; wasDirty: boolean }> {
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
  // Archive succeeded: destroy all runtime resources now that the DB row is gone.
  destroyWorkspaceRuntime(id, ws?.cwd ?? null)
  // BUG FIX: archive is terminal (docs/TUI_SPEC.md D2 — "an orphaned session
  // is a leak"), but this path (performArchive/performForcedArchive — the
  // force:true leg re-invoked after a dirty-worktree confirmation, plus any
  // other internal caller of performArchive such as projects:remove) had no
  // tmux awareness at all, so archiving a tmux-hosted workspace from here
  // leaked its session forever. destroyWorkspaceRuntime only tears down the
  // libghostty surface, which is a no-op for a workspace that was hosted via
  // tmux instead (the desktop never mounted a native surface for it — see
  // D1: "two disjoint hosts"). unhostWorkspace() is idempotent/best-effort by
  // construction (tolerates no session, no tmux binary, tmux already gone —
  // see its own doc comment) and never throws, so it cannot turn a
  // successful archive into a failure; a warning is logged on an unexpected
  // failure rather than swallowing it silently. Uses `ws` (captured BEFORE
  // archiveWorkspace() deleted the row) for the name tmuxSessionName() needs.
  if (ws != null) {
    try {
      await unhostWorkspace({ workspaceId: id, workspaceName: ws.name })
    } catch (err) {
      console.warn('[performArchive] tmux teardown failed for workspaceId=%s:', id, err)
    }
  }
  return result
}

const workspaceControlAdapter = new WorkspaceControlAdapter({
  invoke: invokeControl,
  getProject,
  getWorkspace,
  isDirtyArchiveTarget: async (workspaceId) => {
    const workspace = getWorkspace(workspaceId)
    if (workspace?.worktreeParentCwd == null || listChildWorkspaces(workspaceId).length > 0) {
      return false
    }
    return isWorktreeDirty(workspace.cwd)
  },
  acknowledgeRendererOpen: (workspaceId) => {
    if (workspaceOrchestrationService == null) {
      throw new Error('Workspace orchestration is not available.')
    }
    return workspaceOrchestrationService.acknowledgeRendererOpen(workspaceId)
  }
})

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
    console.error('[shortcut] register threw:', redactErrorForLog(err))
    return false
  }
}

// Last-resort crash logging: written straight to disk so a fatal error is
// still diagnosable even if the diagnostics pipeline itself is what failed.
// Must never throw — this runs from inside error handlers.
function writeCrashFile(err: unknown): void {
  try {
    const crashPath = path.join(app.getPath('userData'), 'orpheus-crash.log')
    const detail =
      err instanceof Error ? redactLogString(err.stack ?? err.message) : redactErrorMessage(err)
    fs.writeFileSync(crashPath, `${new Date().toISOString()}\n${detail}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    fs.chmodSync(crashPath, 0o600)
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
    'Orpheus encountered an unexpected error and must close. A redacted crash report was saved.'
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
    console.error('[lifecycle] focusWorkspaceTerminal failed:', redactErrorForLog(err))
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
    console.error('[lifecycle] terminal kick failed:', redactErrorForLog(err))
  }
}

function createWindow(): void {
  nativeWindowOcclusionVisible = null
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

  const pushWindowVisibility = (): void => {
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
    mainWindow.webContents.send(PUSH_CHANNELS.windowVisibilityChanged, {
      visible: mainWindow.isVisible() && !mainWindow.isMinimized()
    })
  }
  mainWindow.on('show', pushWindowVisibility)
  mainWindow.on('hide', pushWindowVisibility)
  mainWindow.on('minimize', pushWindowVisibility)
  mainWindow.on('restore', pushWindowVisibility)

  // Cache the main window reference for use in hot-path broadcasts.
  mainWindowRef = mainWindow
  rendererWorkspaceOpenReady = false
  mainWindow.on('closed', () => {
    if (mainWindowRef === mainWindow) {
      mainWindowRef = null
      rendererWorkspaceOpenReady = false
    }
  })
  mainWindow.webContents.on('did-start-loading', () => {
    rendererWorkspaceOpenReady = false
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindowRef !== mainWindow || mainWindow.webContents.isDestroyed()) return
    rendererWorkspaceOpenReady = true
    workspaceOpenRequests.flush(deliverWorkspaceOpenRequest)
  })

  // Register subscription cleanup so actions:subscribe subscriptions are
  // automatically torn down when the window (and its webContents) is destroyed.
  registerWebContentsCleanup(mainWindow.webContents)
  // Tear down all git watchers when the renderer goes away so we don't hold
  // destroyed WebContents references until will-quit.
  mainWindow.webContents.on('destroyed', () => {
    stopAllGitWatches()
    stopFilesWatch()
  })

  // Restore fullscreen state before the window is shown
  if (savedState.windowFullscreen) {
    mainWindow.setFullScreen(true)
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    try {
      loadTerminalAddon().installBackstop(mainWindow.getNativeWindowHandle())
    } catch (err) {
      console.error('[lifecycle] installBackstop failed:', redactErrorForLog(err))
    }
    try {
      initOverlayLayer(mainWindow, loadTerminalAddon(), {
        getMainWindow,
        focusActiveWorkspaceTerminal: focusWorkspaceTerminal
      })
      setOverlayTheme(getAppUiState().theme)
    } catch (err) {
      console.error('[overlayLayer] init failed:', redactErrorForLog(err))
    }
    if (isDev) {
      mainWindow.setTitle(app.getName())
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl, trustedRendererEntryUrl())) event.preventDefault()
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
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
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
// orpheus CLI on PATH — quiet fallback hint (prod cask only)
//
// scripts/orpheus-cask.template.rb carries a `binary` stanza so `brew install
// --cask orpheus` symlinks Contents/Resources/bin/orpheus onto the user's
// PATH (Homebrew creates/re-points/removes it on install/upgrade/uninstall —
// no app-side code needed for the happy path). This is the fallback for the
// rare case that symlink is missing anyway — a stale install predating the
// `binary` stanza, a user who copied the .app manually instead of using
// brew, etc. Best-effort, log-only, never blocks or dialogs: mirrors the
// other boot-time checks in this file (loadTerminalAddon, startPowerAwake,
// autoStartFlaggedLayouts — see the app.whenReady callback below).
function checkOrpheusOnPath(): void {
  if (APP_NAME !== 'Orpheus') return // dev/WT/nightly builds aren't cask-distributed; skip

  const expectedShim = join(process.resourcesPath, 'bin', 'orpheus')
  try {
    const resolved = childProcess
      .execFileSync('which', ['orpheus'], {
        encoding: 'utf-8',
        timeout: 3000
      })
      .trim()
    if (resolved && fs.realpathSync(resolved) === fs.realpathSync(expectedShim)) return
  } catch {
    // `which` failing (exit 1, not found) is the expected "not on PATH" case — fall through to the hint.
  }
  console.log(
    `[cli-path] 'orpheus' isn't on PATH. Run: brew install --cask orpheus (or, if already installed, brew reinstall --cask orpheus)`
  )
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

registerMiscIpc({
  getProject,
  getNativeWindowOcclusionVisible: () => nativeWindowOcclusionVisible
})

registerIconPacksIpc()

// ---------------------------------------------------------------------------
// Projects IPC
// ---------------------------------------------------------------------------

registerProjectsIpc({
  destroySurface: (workspaceId) => {
    if (terminalAddon) {
      try {
        terminalAddon.destroy(workspaceId)
      } catch {
        // Surface not mounted or already destroyed — ignore.
      }
    }
    // Trigger (g) also covers project removal — every workspace under the
    // removed project is provably dead, so its workbench surfaces must be
    // destroyed here too (see workbenchSurfacesByWorkspace's header comment).
    destroyWorkbenchSurfacesForWorkspace(workspaceId)
    // Same trigger (g) applies to Panes tab surfaces (see
    // paneSurfacesByWorkspace's header comment).
    destroyPaneSurfacesForWorkspace(workspaceId)
    destroyAgentPaneSurfacesForOwner(workspaceId)
  },
  teardownWorkspaceResources
})

// ---------------------------------------------------------------------------
// Workspaces IPC
// ---------------------------------------------------------------------------

registerWorktreesIpc()

registerWorkspacesIpc({
  workspaceControl: workspaceControlAdapter,
  performForcedArchive: (workspaceId) => performArchive(workspaceId, true)
})

// ---------------------------------------------------------------------------
// Sessions IPC — extracted to ipc/sessions.ts.
// ---------------------------------------------------------------------------

registerSessionsIpc()
registerModelsIpc()

// ---------------------------------------------------------------------------
// Claude Settings IPC (global + per-project + per-workspace + footer
// Model/Effort chips) — extracted to ipc/claudeSettings.ts.
// ---------------------------------------------------------------------------

registerClaudeSettingsIpc({ getMainWindow })

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
    // A theme change may have resolved a new terminal background — push it so
    // already-mounted WorkspaceViews can repaint their quantization top-spacer
    // to match instead of showing the previous theme's colour.
    const color = addon.getResolvedBackground()
    if (color) {
      getMainWindow()?.webContents.send(PUSH_CHANNELS.terminalBackgroundColorChanged, { color })
    }
  } catch (err) {
    console.warn(
      '[ghosttySettings] reloadGhosttyConfig failed (non-fatal):',
      redactErrorForLog(err)
    )
  }
  return result
})

registerMcpIpc()

registerClaudeAgentsIpc()

registerClaudeHooksIpc()

registerClaudeAuthIpc()

registerClaudeUsageIpc()

registerClaudeActivityIpc()

registerOrpheusConfigIpc({ getProject })

// ---------------------------------------------------------------------------
// Diagnostics IPC
// ---------------------------------------------------------------------------

ipcMain.on('diag:event', (event, evt: unknown) => {
  const window = getMainWindow()
  if (window == null || window.isDestroyed() || event.sender.id !== window.webContents.id) return
  const senderFrame = event.senderFrame
  if (senderFrame == null || senderFrame !== event.sender.mainFrame) return
  const trustedEntry = trustedRendererEntryUrl()
  if (
    !isTrustedRendererUrl(senderFrame.url, trustedEntry) ||
    !isTrustedRendererUrl(window.webContents.getURL(), trustedEntry)
  ) {
    return
  }
  ingestDiagEvent(evt)
})

// ---------------------------------------------------------------------------
// UI State IPC
// ---------------------------------------------------------------------------

registerUiStateIpc({
  getMainWindow,
  applyLaunchAtLogin,
  applyGlobalHotkey,
  applyLoadingOverlayTheme
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

registerHooksIpc({ reconcileHooks })

registerSystemIpc({ getAppUiState })

registerUpdatesIpc()

registerProdImportIpc()

registerRoutingProxyIpc()

registerProvidersIpc()

registerAliasesIpc()

registerOAuthIpc()

handle('doctor:check', async (): Promise<DoctorResult> => {
  const { installed, version, path: claudePath } = await checkClaude()
  return {
    claudeInstalled: installed,
    claudeVersion: version,
    claudePath
  }
})

registerGitIpc({ getWorkspaceCwd: (workspaceId) => getWorkspace(workspaceId)?.cwd ?? null })

registerFilesIpc({ getWorkspaceCwd: (workspaceId) => getWorkspace(workspaceId)?.cwd ?? null })

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
    const addon = loadOrpheusSurface()
    // Callback wiring is part of addon initialization, not claude-terminal
    // mounting. Workbench and pane surfaces can be the first native surface,
    // and their initial AppKit occlusion snapshot must never be dropped.
    ensureTerminalCallbackWiring(addon)
    terminalAddon = addon
    console.log('[terminal] addon loaded OK')
    // Wire the addon reference into the actions registry so terminal.*
    // actions can delegate through the same addon instance.
    setTerminalAddonRef(addon)
    return addon
  } catch (err) {
    const msg = String(err)
    terminalAddonError = msg
    console.error('[terminal] addon load FAILED:', redactLogString(msg))
    throw err
  }
}

function getNativeSurfacePhase(surfaceId: string): NativeSurfacePhase {
  try {
    const phase = loadTerminalAddon().getSurfacePhase(surfaceId)
    return phase === 'hidden' || phase === 'attached' || phase === 'visible' || phase === 'freeing'
      ? phase
      : 'none'
  } catch {
    return 'none'
  }
}

/** True if the workspace no longer exists or has been archived — the shared
 *  re-validation check run at two points in terminal:mount around await gaps
 *  where the workspace could have been archived concurrently. */
function isWorkspaceGone(workspaceId: string): boolean {
  const wsNow = getWorkspace(workspaceId)
  return !wsNow || wsNow.archivedAt != null
}

type WorktreeReconcileOutcome =
  | { aborted: false; effectiveCwd: string; reconcileNotice: string | undefined }
  | { aborted: true; response: Extract<TerminalMountResult, { worktreeError: unknown }> }

/** Heal-on-mount worktree reconcile. For worktree-backed workspaces, reconcile the
 *  worktree state BEFORE any native surface operation — detects and heals
 *  stale/missing worktrees. Shows the loading overlay FIRST (before the
 *  potentially multi-second git operations) so the user never sees a blank pane.
 *  reconcileWorktree NEVER throws — it returns { ok: false } on all error paths;
 *  the try/catch here is a defensive guard against a bug breaking that contract. */
async function reconcileWorktreeForMount(
  workspaceId: string,
  ws: WorkspaceRecord
): Promise<WorktreeReconcileOutcome> {
  if (ws.worktreeParentCwd == null || ws.worktreeBranch == null) {
    return { aborted: false, effectiveCwd: ws.cwd, reconcileNotice: undefined }
  }

  showLoadingOverlay(workspaceId, { title: 'Preparing worktree…' })
  let r: Awaited<ReturnType<typeof reconcileWorktree>>
  try {
    r = await reconcileWorktree({
      cwd: ws.cwd,
      worktreeParentCwd: ws.worktreeParentCwd,
      worktreeBranch: ws.worktreeBranch
    })
  } catch (err) {
    hideLoadingOverlay(workspaceId)
    return {
      aborted: true,
      response: {
        workspaceId,
        worktreeError: {
          kind: 'parentGone',
          message: `Worktree reconcile threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`
        }
      }
    }
  }
  if (!r.ok) {
    hideLoadingOverlay(workspaceId)
    return {
      aborted: true,
      response: {
        workspaceId,
        worktreeError: { kind: r.kind, message: r.message, conflictPath: r.conflictPath }
      }
    }
  }
  // Reconcile succeeded. Use the reconciled path as mount cwd; if the
  // worktree was recreated at a suffixed path (slug-2), persist the new cwd.
  if (r.path !== ws.cwd) {
    setWorkspaceCwd(workspaceId, r.path)
  }
  return { aborted: false, effectiveCwd: r.path, reconcileNotice: r.notice }
}

/** Compose the launch env + spawn/re-attach the native surface, all as one traced
 *  span. Mutates `launchOut` (a single-slot box) so the caller can read back the
 *  composed launch after the trace completes — mirrors the original closure's
 *  `launch` outer-scope assignment exactly. */
function issueRuntimeLeaseForMount(
  workspace: WorkspaceRecord,
  addon: GhosttySurfaceAddon
): RuntimeLeaseIssue {
  const existingBinding = runtimeLeases.getBySurfaceId(workspace.id)
  if (existingBinding != null) {
    let phase: ReturnType<GhosttySurfaceAddon['getSurfacePhase']> = 'none'
    try {
      phase = addon.getSurfacePhase(workspace.id)
    } catch {
      phase = 'none'
    }
    if (phase === 'none' || phase === 'freeing') {
      runtimeLeases.revokeBySurface(workspace.id)
    }
  }

  return runtimeLeases.issueOrReuseClaude({
    surfaceId: workspace.id,
    workspaceId: workspace.id,
    projectId: workspace.projectId,
    claudeConversationId: workspace.claudeSessionId,
    parentWorkspaceId: workspace.parentWorkspaceId,
    forkedFromConversationId: workspace.forkedFromSessionId
  })
}

function prepareMountControl(
  workspace: WorkspaceRecord,
  addon: GhosttySurfaceAddon
): {
  activeCommandServer: typeof commandServer
  leaseIssue: RuntimeLeaseIssue | null
} {
  const activeCommandServer = commandServer
  if (activeCommandServer == null) {
    if (!unmanagedMountWarningEmitted) {
      unmanagedMountWarningEmitted = true
      console.warn('[terminal] control server unavailable; launching Claude without managed MCP')
    }
    return { activeCommandServer: null, leaseIssue: null }
  }
  return {
    activeCommandServer,
    leaseIssue: issueRuntimeLeaseForMount(workspace, addon)
  }
}

function revokeMountLeaseIfManaged(
  workspaceId: string,
  leaseIssue: RuntimeLeaseIssue | null
): void {
  if (leaseIssue != null) runtimeLeases.revokeBySurface(workspaceId)
}

function reconcileMountLeaseResult(
  workspaceId: string,
  addon: GhosttySurfaceAddon,
  mountResult: { created: boolean },
  leaseIssue: RuntimeLeaseIssue | null
): void {
  if (leaseIssue == null) return
  if (mountResult.created && !leaseIssue.created) {
    runtimeLeases.revokeBySurface(workspaceId)
    try {
      addon.destroy(workspaceId)
    } catch {
      /* surface is already tearing down */
    }
    throw new Error('Runtime lease generation did not match the created surface.')
  }
  if (!mountResult.created && leaseIssue.created) {
    // The existing process cannot receive the newly generated token because
    // native reattach does not relaunch its command environment.
    runtimeLeases.revokeBySurface(workspaceId)
  }
}

async function traceTerminalMount(
  workspace: WorkspaceRecord,
  effectiveCwd: string | undefined,
  nativeHandle: Buffer,
  addon: GhosttySurfaceAddon,
  rect: TerminalRect,
  scaleFactor: number,
  launchOut: {
    launch?: ReturnType<typeof buildMountEnv>['launch']
    authEnv?: ReturnType<typeof buildMountEnv>['authEnv']
  },
  precomposedLaunch: ReturnType<typeof composeLaunchForMount>
): Promise<{ workspaceId: string; created: boolean; cellHeightPx: number }> {
  const workspaceId = workspace.id
  const projectId = workspace.projectId
  const _mountStart = Date.now()
  return diag.trace('terminal.mount', { workspaceId }, (s) => {
    const { activeCommandServer, leaseIssue } = prepareMountControl(workspace, addon)

    // Assemble the surface env as a child span nested under terminal.mount.
    // buildMountEnv is sync; use diag.span (not diag.trace). precomposedLaunch
    // was already composed once by the caller (for the isRoutedMount gate) —
    // passed through so this span does NOT re-run composeClaudeLaunch.
    let buildResult!: ReturnType<typeof buildMountEnv>
    try {
      buildResult = diag.span('launch.compose', { workspaceId, projectId: projectId ?? null }, () =>
        buildMountEnv(
          workspaceId,
          projectId,
          notifyServer?.sockPath,
          activeCommandServer ?? undefined,
          precomposedLaunch,
          leaseIssue == null ? undefined : { binding: leaseIssue.binding, token: leaseIssue.token }
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
      revokeMountLeaseIfManaged(workspaceId, leaseIssue)
      throw err
    }
    const { command, env: surfaceEnv, launch: composedLaunch, authEnv } = buildResult
    launchOut.launch = composedLaunch
    launchOut.authEnv = authEnv

    console.log(
      '[terminal] mount workspaceId=%s flagsBytes=%d settingsBytes=%d envKeys=%s',
      workspaceId,
      Buffer.byteLength(composedLaunch.flags, 'utf8'),
      Buffer.byteLength(composedLaunch.settingsJson, 'utf8'),
      Object.keys(surfaceEnv).sort().join(',')
    )

    let mountResult: { workspaceId: string; created: boolean; cellHeightPx: number }
    try {
      mountResult = addon.mount(nativeHandle, {
        workspaceId,
        rect,
        scaleFactor,
        cwd: effectiveCwd,
        command,
        env: prepareTerminalLaunchEnv(surfaceEnv)
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
      revokeMountLeaseIfManaged(workspaceId, leaseIssue)
      throw err
    }

    reconcileMountLeaseResult(workspaceId, addon, mountResult, leaseIssue)
    terminalObservationService?.recordWorkspaceLifecycle(
      workspaceId,
      getNativeSurfacePhase(workspaceId)
    )
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
}

/**
 * Lean parallel to traceTerminalMount() for the TMUX-ATTACH mount path only.
 * Deliberately does NOT go through buildMountEnv/composeClaudeLaunch,
 * runtime-lease issuance, or model routing — none of that applies to an
 * attach (see buildTmuxAttachEnv's doc comment in orpheusSurfaceAdapter.ts
 * for the "no secrets/no lease on the attach path" rationale). A runtime
 * lease specifically must NOT be (re-)issued here: whatever `claude` process
 * is already running inside the tmux session got its lease context (if any)
 * once, at SESSION-CREATION time via hostWorkspace()'s own buildMountEnv
 * call — issuing a fresh one on every attach would hand out a token the
 * already-running process never reads (it doesn't re-exec on attach) while
 * needlessly rotating/leaking lease state for no behavioral benefit.
 */
async function traceTerminalMountForTmuxAttach(
  workspaceId: string,
  effectiveCwd: string | undefined,
  nativeHandle: Buffer,
  addon: GhosttySurfaceAddon,
  rect: TerminalRect,
  scaleFactor: number,
  attach: { command: string; env: Record<string, string> }
): Promise<{ workspaceId: string; created: boolean; cellHeightPx: number }> {
  const _mountStart = Date.now()
  return diag.trace('terminal.mount', { workspaceId, tmuxAttach: true }, (s) => {
    console.log(
      '[terminal] mount (tmux-attach) workspaceId=%s envKeys=%s',
      workspaceId,
      Object.keys(attach.env).sort().join(',')
    )

    let mountResult: { workspaceId: string; created: boolean; cellHeightPx: number }
    try {
      mountResult = addon.mount(nativeHandle, {
        workspaceId,
        rect,
        scaleFactor,
        cwd: effectiveCwd,
        command: attach.command,
        env: prepareTerminalLaunchEnv(attach.env)
      })
    } catch (err) {
      logDiagMain({
        category: 'error',
        level: 'error',
        event: DIAG_EVENTS.ERROR_NATIVE,
        message: `addon.mount (tmux-attach) failed: ${err instanceof Error ? err.message : String(err)}`,
        workspaceId,
        data: { stack: err instanceof Error ? err.stack : null }
      })
      throw err
    }

    terminalObservationService?.recordWorkspaceLifecycle(
      workspaceId,
      getNativeSurfacePhase(workspaceId)
    )
    s.mark(mountResult.created ? 'surface-created' : 'surface-reattached')
    logDiagMain({
      category: 'lifecycle',
      level: 'info',
      event: DIAG_EVENTS.TERMINAL_MOUNT,
      workspaceId,
      data: { created: mountResult?.created ?? null, tmuxAttach: true }
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
}

/** Post-mount overlay handling: show the "Starting workspace" overlay only when a
 *  new surface was actually created (re-attach/resize of an already-running
 *  workspace has no boot to mask), and arm the 10s fallback dismissal timer.
 *  `routed` (from isRoutedMount(precomposedLaunch), already computed by the
 *  caller for the health-gate check above) picks the slow-watchdog copy and
 *  threshold inside loadingOverlay.ts — a routed mount waits on a proxy
 *  round-trip before claude registers its session file, so the generic
 *  "hooks/auth" slow copy would be wrong and 3s too aggressive for it. */
function handlePostMountOverlay(workspaceId: string, created: boolean, routed: boolean): void {
  if (created) {
    showLoadingOverlay(workspaceId, { title: 'Starting workspace' }, routed)

    // If the session is already past its starting phase (re-mount of a
    // running workspace), dismiss the overlay immediately.
    if (isWorkspaceSessionReady(workspaceId)) {
      hideLoadingOverlay(workspaceId)
    } else {
      // Fallback: ensure the overlay is always dismissed after 10s even if
      // claude never registers a session file (e.g. auth failure, crash).
      const t = setTimeout(() => {
        // Self-deleting: this callback is running because the timer already
        // fired, so remove the map entry directly (takeOverlayFallbackTimer)
        // rather than clearOverlayFallbackTimer, which would call
        // clearTimeout on an already-fired timer — harmless on Node, but
        // semantically wrong for a timer that's mid-callback.
        takeOverlayFallbackTimer(workspaceId)
        logDiagMain({
          category: 'anomaly',
          level: 'warn',
          event: DIAG_EVENTS.OVERLAY_FALLBACK,
          workspaceId,
          message: 'overlay dismissed by fallback timeout'
        })
        hideLoadingOverlay(workspaceId)
      }, 10000)
      setOverlayFallbackTimer(workspaceId, t)
    }
  } else {
    // Surface already existed (re-attach). If a worktree workspace showed the
    // "Preparing worktree…" overlay before reconcile, clear it now — claude is
    // already running and no boot sequence is pending.
    // hideLoadingOverlay is a safe no-op when no overlay is active, so this
    // is unconditional and handles the non-worktree re-mount path too.
    hideLoadingOverlay(workspaceId)
  }
}

/**
 * Pre-mount "will this call actually CREATE a native surface entry, or just
 * re-attach an already-live one" signal — the gate universal tmux hosting
 * needs BEFORE deciding whether to touch tmux at all. This is deliberately
 * NOT a reuse of the existing getNativeSurfacePhase() helper (see index.ts
 * ~line 1370), even though the underlying addon.getSurfacePhase() call is
 * identical, for two reasons specific to this call site:
 *
 *  1. getNativeSurfacePhase() collapses a thrown error from
 *     loadTerminalAddon() to 'none', which is exactly right for its
 *     original telemetry-only callers (a bad reading there just skews a log
 *     line) but WRONG here: at this point in terminal:mount the addon was
 *     ALREADY loaded successfully a few lines above (`const addon =
 *     loadTerminalAddon()`), so a throw from `addon.getSurfacePhase(...)`
 *     here is a genuine, unusual runtime error on an already-working addon
 *     — not "no surface exists". Swallowing it to 'none' would make a
 *     spurious tmux session get created off the back of an addon call
 *     failure we don't understand, which is worse than just propagating the
 *     error. So this function takes the already-loaded `addon` and does NOT
 *     catch — a throw here aborts the mount, matching how every other
 *     addon.* call in this handler already behaves (see traceTerminalMount).
 *  2. 'freeing' is treated as "effectively gone, safe to create" — the SAME
 *     treatment issueRuntimeLeaseForMount() already gives it at
 *     ~line 1462 (`phase === 'none' || phase === 'freeing'` when deciding
 *     whether to revoke a stale runtime lease). A surface mid-teardown from
 *     an in-flight archive/destroy is, for the purposes of "should the NEXT
 *     mount create a fresh entry", indistinguishable from no entry at all —
 *     the native addon's own generation-guarded deferred-free machinery
 *     (packages/ghostty-surface) is what actually protects the destroy-then-
 *     recreate race at the native layer; this function does not need to
 *     duplicate that protection, only pick the same side of the line the
 *     rest of this codebase already picks for 'freeing'.
 *
 * MIRROR RELATIONSHIP: this function protects the DESKTOP-creating-onto-tmux
 * direction (don't spawn a tmux session if a native surface already owns
 * this workspace). shouldBlockTmuxHost (tmuxHost.ts), used by
 * commandServer.ts's `workspace.host` action, protects the OPPOSITE
 * direction (don't let the TUI/CLI spawn a tmux session onto a workspace
 * that's already live natively on the desktop). Both are required — neither
 * subsumes the other, since they run in response to different triggers
 * (a desktop mount vs. a command-socket call) and check different local
 * state (this process's addon surface map plus, for the mirror, claude's
 * own on-disk session registry). Do not "simplify" by removing either
 * thinking it's redundant with the other.
 */
function willMountCreateSurface(addon: GhosttySurfaceAddon, workspaceId: string): boolean {
  const phase = addon.getSurfacePhase(workspaceId)
  return phase === 'none' || phase === 'freeing'
}

/** Discriminated pre-decision for whether this mount should go through tmux
 *  at all — resolved once, before either tmux or the routed-model gate is
 *  touched, so downstream code branches on a plain value instead of
 *  re-deriving availability. See resolveMountStrategy() (tmuxHost.ts) for
 *  the pure decision this wraps with the actual ensureTmuxVersion() I/O. */
async function resolveTmuxMountAvailability(): Promise<
  ReturnType<typeof resolveMountStrategy> extends infer T ? T : never
> {
  try {
    await ensureTmuxVersion()
    return resolveMountStrategy({ ok: true })
  } catch (err) {
    if (err instanceof TmuxVersionTooOldError) {
      return resolveMountStrategy({ ok: false, reason: 'version-too-old', detail: err.message })
    }
    if (err instanceof TmuxNotAvailableError) {
      return resolveMountStrategy({ ok: false, reason: 'not-installed', detail: err.message })
    }
    // Unexpected error from `tmux -V` itself (e.g. unparseable output) —
    // treat exactly like "not installed" for fallback purposes: tmux hosting
    // cannot proceed, but the mount itself must not fail over it.
    return resolveMountStrategy({
      ok: false,
      reason: 'not-installed',
      detail: err instanceof Error ? err.message : String(err)
    })
  }
}

type TmuxFallbackInfo = { reason: 'not-installed' | 'version-too-old'; detail: string }
type TmuxAttachPlan = { command: string; env: Record<string, string> }

/**
 * ── Universal tmux hosting decision (docs/TUI_SPEC.md D1) ─────────────────
 * Only decide anything tmux-related when this mount is actually going to
 * CREATE a native surface entry. A re-attach of an already-live entry
 * (workspace nav back, resize, etc) ignores `opts.command` entirely at the
 * native layer (packages/ghostty-surface's Mount short-circuits BEFORE
 * reading opts.command for an existing entry — see addon.mm) — so calling
 * hostWorkspace() here for that case would be worse than a no-op: it would
 * spawn a BRAND NEW tmux session + a second `claude --resume <sessionId>`
 * process for a workspace whose (possibly pre-conversion, native, non-tmux)
 * `claude` is already running, live, under the SAME session id — the exact
 * double-writer transcript corruption this whole design exists to avoid.
 * willMountCreateSurface() is the pre-mount signal that prevents that.
 *
 * Returns `{ tmuxAttach }` when this mount should attach the native surface
 * to a tmux session, `{ tmuxFallback }` when tmux is missing/too old and the
 * native path (orpheus-claude.sh directly) should run instead, or `{}` when
 * neither applies (a plain re-attach — willMountCreateSurface was false).
 */
async function resolveTmuxForMount(
  addon: GhosttySurfaceAddon,
  ws: WorkspaceRecord | null | undefined,
  workspaceId: string,
  projectId: string | undefined,
  effectiveCwd: string | undefined
): Promise<{ tmuxAttach?: TmuxAttachPlan; tmuxFallback?: TmuxFallbackInfo }> {
  if (!ws || !willMountCreateSurface(addon, workspaceId)) return {}

  const strategy = await resolveTmuxMountAvailability()
  // Whatever the outcome, tmux availability is now KNOWN for this app run —
  // recheck every tracked workspace's hosting-mode dirtiness once, right
  // now, rather than waiting for an unrelated settings change to surface
  // the "Restart to enable remote access" chip for pre-existing native
  // workspaces (Gap 2 of the staged-rollout design — see
  // currentEffectiveHostingPolicy()'s doc comment in tmuxHost.ts).
  recomputeHostingModeDirty()

  if (strategy.kind === 'native-fallback') {
    // tmux missing or too old — fall back to the CURRENT native path
    // (orpheus-claude.sh directly, unchanged) with a visible, non-silent
    // notice rather than silently degrading or erroring.
    const howToFix =
      strategy.reason === 'not-installed'
        ? 'Install it with `brew install tmux` to enable tmux hosting (survives app restarts, and lets you reconnect from `orpheus tui`).'
        : 'Upgrade it with `brew upgrade tmux` to enable tmux hosting (survives app restarts, and lets you reconnect from `orpheus tui`).'
    console.warn(
      '[terminal:mount] tmux unavailable (%s), falling back to native hosting: %s',
      strategy.reason,
      strategy.detail
    )
    return { tmuxFallback: { reason: strategy.reason, detail: `${strategy.detail} ${howToFix}` } }
  }

  // tmux available. hostWorkspace() is the ONLY place that ever runs
  // `tmux new-session` (see its own doc comment in tmuxHost.ts) — idempotent
  // by construction (has-session check → reuse-or-create, with
  // duplicate-session race recovery), so this call is safe to make
  // unconditionally here: it either creates a fresh session for a truly new
  // workspace, or (the "session vanished between an earlier check and now"
  // race, or simply "tmux session outlived an app restart and this is the
  // first mount since") transparently attaches to whatever's already there.
  // No separate recreate-retry loop is needed — hostWorkspace()'s own
  // has-session check IS that recreation, and orpheus-attach.sh's own
  // "any exit -> exec zsh -i" tail covers the vanishingly rare remaining
  // race where the session disappears again in the gap between this call
  // and the attach wrapper actually running (see that script's own comments).
  const hostResult = await hostWorkspace(
    { workspaceId, projectId, workspaceName: ws.name, cwd: effectiveCwd ?? ws.cwd },
    commandServer ? { sockPath: commandServer.sockPath, token: commandServer.token } : undefined
  )
  return { tmuxAttach: buildTmuxAttachEnv(hostResult.socketName, hostResult.sessionName) }
}

/**
 * ── Tmux-attach mount path ─────────────────────────────────────────────
 * Mounts the native surface running the attach wrapper, then handles
 * post-mount bookkeeping specific to the attach case (no routed-model gate,
 * conditional snapshot re-seed — see the inline comments for the exact
 * subtle reasoning on each). Returns null if the workspace went away
 * mid-flight (caller returns the standard 'gone' response in that case).
 */
async function finishTmuxAttachMount(
  e: Electron.IpcMainInvokeEvent,
  workspaceId: string,
  projectId: string | undefined,
  effectiveCwd: string | undefined,
  nativeHandle: Buffer,
  addon: GhosttySurfaceAddon,
  rect: TerminalRect,
  scaleFactor: number,
  tmuxAttach: TmuxAttachPlan,
  reconcileNotice: string | undefined,
  tmuxFallback: TmuxFallbackInfo | undefined
): Promise<TerminalMountResult | null> {
  const runtimeWorkspace = getWorkspace(workspaceId)
  if (runtimeWorkspace == null || runtimeWorkspace.archivedAt != null) return null

  const result = await traceTerminalMountForTmuxAttach(
    workspaceId,
    effectiveCwd,
    nativeHandle,
    addon,
    rect,
    scaleFactor,
    tmuxAttach
  )

  if (result.created) {
    logDiagMain({
      category: 'lifecycle',
      level: 'info',
      event: DIAG_EVENTS.TERMINAL_SURFACE_CREATED,
      workspaceId
    })
  }

  // Routed-model health gate deliberately NOT run here — see the
  // isRoutedMount(precomposedLaunch) call in the native path below, which
  // only runs on the native/create path. Re-attaching to an already-running
  // tmux session must never re-probe proxy health: that gate exists to fail
  // fast before spawning a NEW `claude` process against an unreachable
  // routing proxy, and no new `claude` process is spawned here.
  handlePostMountOverlay(workspaceId, result.created, false)

  // Snapshot handling on the tmux-attach path — subtle, documented in full
  // here since this is the exact decision point:
  //   - If a snapshot ALREADY exists for this workspace (this app process
  //     created the tmux session earlier in its own lifetime, OR attached
  //     to it once already this run), leave it untouched. Re-snapshotting
  //     with a freshly-recomposed launch here would silently "launder" any
  //     REAL settings drift that happened after creation — the whole point
  //     of the dirty chip.
  //   - If NO snapshot exists yet (the gap case: the tmux session survived
  //     an app restart — tmux is a separate process tree — but the
  //     in-memory launchSnapshots Map, which lives only in THIS process,
  //     did not), re-seed it by composing composeClaudeLaunch fresh right
  //     now and treating it as "assumed accurate until we have a better
  //     source of truth." KNOWN GAP, accepted deliberately: any settings
  //     changed WHILE THE APP WAS CLOSED, strictly between the tmux
  //     session's actual creation and this restart, will NOT show as dirty
  //     until something else changes the effective launch afterward (at
  //     which point recomputeDirty's normal comparison against this
  //     re-seeded snapshot starts working correctly again). Doing better
  //     than this would require persisting the snapshot itself to disk,
  //     out of scope for this change.
  if (getLaunchSnapshot(workspaceId) === undefined) {
    const seeded = composeLaunchForMount(projectId, workspaceId)
    setLaunchSnapshot(workspaceId, { ...seeded, authEnv: getClaudeAuthEnv(), hostingMode: 'tmux' })
    setDirty(workspaceId, false)
  }

  {
    const injectable = terminalActions.canInject(workspaceId)
    e.sender.send(PUSH_CHANNELS.terminalCanInjectChanged, { workspaceId, canInject: injectable })
  }

  if (effectiveCwd) {
    startGitWatch(workspaceId, effectiveCwd, e.sender)
  }

  const notice = [reconcileNotice].filter((n): n is string => n != null).join(' ')
  return {
    ...result,
    cellHeightPx: result.cellHeightPx || null,
    backgroundColor: addon.getResolvedBackground(),
    ...(notice ? { notice } : {}),
    ...(tmuxFallback ? { tmuxFallback } : {})
  }
}

handle('terminal:mount', async (e, { workspaceId, rect, scaleFactor, cwd }) => {
  const addon = loadTerminalAddon()
  ensureLoadingOverlayWiring(addon)
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) throw new Error('terminal:mount — no BrowserWindow for sender')
  const nativeHandle = win.getNativeWindowHandle()

  // Look up the workspace's projectId for per-project override resolution
  const ws = getWorkspace(workspaceId)
  const projectId = ws?.projectId

  // ── Worktree reconcile (heal-on-mount) ─────────────────────────────────
  // reconcileWorktreeForMount NEVER throws — it returns aborted:true on all
  // error paths. If reconcile fails, we return the error without mounting and
  // without touching the surface, leaving it retryable.
  //
  // MUST run BEFORE the tmux create-vs-attach decision below: the worktree
  // must exist on disk (at its FINAL, possibly-healed/recreated path) before
  // a NEW tmux session gets created with it as `-c <cwd>` — hostWorkspace()
  // has no worktree awareness of its own, it just execs into whatever cwd
  // it's given, so reconcile's resolved effectiveCwd is what a fresh tmux
  // session must be created with.
  let reconcileNotice: string | undefined
  let effectiveCwd = cwd
  if (ws) {
    const outcome = await reconcileWorktreeForMount(workspaceId, ws)
    if (outcome.aborted) return outcome.response
    effectiveCwd = outcome.effectiveCwd
    reconcileNotice = outcome.reconcileNotice
  }

  // Re-validate: the workspace may have been archived while reconcileWorktree
  // was in flight (potentially multi-second git operations). Mounting a
  // gone workspace would recreate its worktree and spawn a zombie claude
  // process for a row that no longer exists.
  if (isWorkspaceGone(workspaceId)) {
    hideLoadingOverlay(workspaceId)
    return { workspaceId, aborted: 'gone' as const }
  }

  // Close the cold-mount PATH race BEFORE anything spawns a binary.
  //
  // This await used to sit AFTER resolveTmuxForMount() below, which meant the
  // very first mount of an app run probed for `tmux` with an unprimed PATH
  // cache — and a Finder-launched Electron process has a stripped PATH with
  // no Homebrew bin dir, so the probe ENOENT'd and the UI announced "tmux is
  // not installed" to users who have it installed. Priming first fixes the
  // tmux probe and still serves its original purpose (buildMountEnv can
  // inject ORPHEUS_USER_PATH rather than falling back to .zshrc, +100–800 ms).
  if (getCachedShellPath() === null) {
    await getUserShellPath()
  }

  const { tmuxAttach, tmuxFallback } = await resolveTmuxForMount(
    addon,
    ws,
    workspaceId,
    projectId,
    effectiveCwd
  )

  // Re-validate again: the workspace may have been archived while
  // getUserShellPath was in flight. This is the last check before
  // addon.mount actually spawns the native surface + claude process.
  if (isWorkspaceGone(workspaceId)) {
    hideLoadingOverlay(workspaceId)
    return { workspaceId, aborted: 'gone' as const }
  }

  if (tmuxAttach) {
    const attachResult = await finishTmuxAttachMount(
      e,
      workspaceId,
      projectId,
      effectiveCwd,
      nativeHandle,
      addon,
      rect,
      scaleFactor,
      tmuxAttach,
      reconcileNotice,
      tmuxFallback
    )
    if (attachResult == null) {
      hideLoadingOverlay(workspaceId)
      return { workspaceId, aborted: 'gone' as const }
    }
    return attachResult
  }

  // ── Native mount path (unchanged — direct orpheus-claude.sh, either a
  // re-attach of an already-live surface, or the tmux-missing/too-old
  // fallback for a fresh create) ──────────────────────────────────────────

  // Compose claude settings -> ClaudeLaunch ONCE for this mount. Both the
  // routed-model health gate below and traceTerminalMount's env assembly
  // need the composed launch; previously each called composeClaudeLaunch
  // independently (a real DB read of global/project/workspace settings rows
  // every time), so every single mount — including Claude-only ones — paid
  // for settings composition twice. Composing once here and threading the
  // result through both call sites halves that cost for every workspace.
  const precomposedLaunch = composeLaunchForMount(projectId, workspaceId)

  // Fail-closed gate (model-routing unit 04): an unreachable routing proxy
  // makes Claude Code hang ~44-128s silently (measured) once addon.mount
  // spawns the wrapper script against it. Check reachability BEFORE spawning
  // for routed-model workspaces only — this is a strict no-op (zero extra
  // network calls, zero added latency, zero extra composition) for
  // Claude-model workspaces, mirroring computeRoutingEnv's own no-op
  // guarantee for the Claude path. Also correctly skipped for a plain
  // re-attach of an already-live surface: hostWorkspace/tmuxAttach is never
  // set in that case (willMountCreateSurface was false), so this whole
  // native path only runs for either a genuine re-attach OR a fresh native
  // (tmux-fallback) create — the gate itself is still keyed off whether
  // addon.mount will actually create a new entry, exactly as before.
  if (isRoutedMount(precomposedLaunch)) {
    try {
      await ensureHealthyForRouting()
    } catch (err) {
      hideLoadingOverlay(workspaceId)
      throw err
    }
  }

  const launchBox: {
    launch?: ReturnType<typeof buildMountEnv>['launch']
    authEnv?: ReturnType<typeof buildMountEnv>['authEnv']
  } = {}
  const runtimeWorkspace = getWorkspace(workspaceId)
  if (runtimeWorkspace == null || runtimeWorkspace.archivedAt != null) {
    hideLoadingOverlay(workspaceId)
    return { workspaceId, aborted: 'gone' as const }
  }

  const result = await traceTerminalMount(
    runtimeWorkspace,
    effectiveCwd,
    nativeHandle,
    addon,
    rect,
    scaleFactor,
    launchBox,
    precomposedLaunch
  )
  const launch = launchBox.launch!
  const authEnv = launchBox.authEnv!

  if (result.created) {
    logDiagMain({
      category: 'lifecycle',
      level: 'info',
      event: DIAG_EVENTS.TERMINAL_SURFACE_CREATED,
      workspaceId
    })
  }

  handlePostMountOverlay(workspaceId, result.created, isRoutedMount(precomposedLaunch))

  // Snapshot the composed launch (+ auth env layer) so we can detect settings
  // AND auth drift later — see LaunchSnapshot in workspaceResources.ts.
  // hostingMode is 'native' unconditionally here — this whole branch is
  // reached only for a plain re-attach (hostingMode of the ALREADY-live
  // surface is whatever it was, but a re-attach never had tmuxAttach set so
  // result.created is false and this snapshot write is effectively a no-op
  // refresh) or a genuine native-fallback CREATE (tmux missing/too old),
  // which is unambiguously 'native'.
  setLaunchSnapshot(workspaceId, { ...launch, authEnv, hostingMode: 'native' })
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

  return {
    ...result,
    cellHeightPx: result.cellHeightPx || null,
    backgroundColor: addon.getResolvedBackground(),
    ...(reconcileNotice != null ? { notice: reconcileNotice } : {}),
    ...(tmuxFallback ? { tmuxFallback } : {})
  }
})

handle('terminal:hide', (_e, { workspaceId }): void => {
  const addon = loadTerminalAddon()
  // If the user navigates away mid-boot, dismiss the overlay so it doesn't
  // outlive its parent surface in the contentView.
  clearOverlayFallbackTimer(workspaceId)
  hideLoadingOverlay(workspaceId)
  try {
    addon.hide(workspaceId)
    terminalObservationService?.recordWorkspaceLifecycle(workspaceId, 'hidden')
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

// ---------------------------------------------------------------------------
// Workbench Terminal-tab IPC — U6b (P2), generalized to a strip in U8 (P3)
//
// Mounts plain interactive login shells ($SHELL, not orpheus-claude.sh) per
// claude workspace, surfaced inside the Workbench's Terminal tab. This is
// the minimal U7 (generalized launch composer): no claudeSettings layering,
// no worktree reconcile, no activity pipeline — just a real shell at the
// workspace's cwd. It reuses the native addon's slot model proven in U6a:
// keying the surface `workbench:<claudeWorkspaceId>[:<terminalId>]` routes
// it to the single Workbench slot, so it coexists with claude's
// `workspaceId`-keyed surface without evicting it, AND any two ad-hoc
// terminals under the same claude workspace auto-evict one another within
// that slot (see docs/learnings/native-multisurface-investigation.md §1) —
// exactly the "one visible at a time" behavior U8's tab strip needs, for
// free, with no addon changes.
//
// `terminalId` is the renderer's own monotonic per-terminal counter (U8);
// omitted, the slot key collapses back to U6b's single-shell form so old
// call sites are unaffected. `workspaceId` passed to getWorkspace() below is
// always the plain claude workspace id — never the derived slot key — so
// the cwd lookup is unaffected by how many terminals the caller has open.
// ---------------------------------------------------------------------------

function workbenchSlotId(claudeWorkspaceId: string, terminalId?: number): string {
  return terminalId === undefined
    ? `workbench:${claudeWorkspaceId}`
    : `workbench:${claudeWorkspaceId}:${terminalId}`
}

/** Inverse of `workbenchSlotId`'s two-arg (per-terminal) form — parses a
 *  native surface key of the shape `workbench:<claudeWorkspaceId>:<terminalId>`
 *  back into its parts. Returns null for anything else, including the
 *  single-shell `workbench:<claudeWorkspaceId>` form (no terminalId to
 *  recover) and any non-workbench key (plain claude `workspaceId`s never
 *  contain a `:`, but this guards the parse either way). Used by the title
 *  callback below to route workbench-keyed title events to their own push
 *  channel instead of the claude-workspace-scoped `workspace:titleChanged`. */
function parseWorkbenchSlotId(
  surfaceKey: string
): { workspaceId: string; terminalId: number } | null {
  if (!surfaceKey.startsWith('workbench:')) return null
  const rest = surfaceKey.slice('workbench:'.length)
  const lastColon = rest.lastIndexOf(':')
  if (lastColon === -1) return null
  const terminalId = Number(rest.slice(lastColon + 1))
  if (!Number.isInteger(terminalId)) return null
  return { workspaceId: rest.slice(0, lastColon), terminalId }
}

// ---------------------------------------------------------------------------
// Workbench surface registry (U9) — the authoritative record of which
// workbench terminal surfaces exist per claude workspace.
//
// WHY: the renderer's TerminalTab now only ever HIDES surfaces on its own
// unmount (nav-away, LRU eviction, remount) — never destroys — so hidden
// surfaces persist addon-side indefinitely, exactly mirroring claude's own
// terminal. The only two triggers allowed to actually destroy a workbench
// surface are (f) a terminal's own ✕-close (renderer-initiated, already
// explicit) and (g) the owning workspace being closed/archived/removed. But
// by the time (g) fires, the renderer that knew which terminal ids existed
// may be long unmounted (or was never the active view), so main cannot rely
// on the renderer to tell it what to destroy. This map is main's own
// bookkeeping of live `workbench:<workspaceId>:<terminalId>` slots so
// close/archive/project-remove can deterministically destroy ALL of a
// workspace's workbench surfaces regardless of render state.
//
// Populated on every successful workbench:mount, cleaned on every
// workbench:destroy (both explicit ✕-close and the bulk destroy below).
// ---------------------------------------------------------------------------

const workbenchSurfacesByWorkspace = new Map<string, Set<number>>()

function registerWorkbenchSurface(workspaceId: string, terminalId?: number): void {
  if (terminalId === undefined) return // legacy single-shell form — not terminal-id-addressable
  let ids = workbenchSurfacesByWorkspace.get(workspaceId)
  if (!ids) {
    ids = new Set()
    workbenchSurfacesByWorkspace.set(workspaceId, ids)
  }
  ids.add(terminalId)
}

function unregisterWorkbenchSurface(workspaceId: string, terminalId?: number): void {
  if (terminalId === undefined) return
  const ids = workbenchSurfacesByWorkspace.get(workspaceId)
  if (!ids) return
  ids.delete(terminalId)
  if (ids.size === 0) workbenchSurfacesByWorkspace.delete(workspaceId)
}

/** Destroys every known workbench terminal surface for `workspaceId` — the
 *  ONE authoritative bulk-destroy path for trigger (g) (workspace
 *  close/archive/project-remove). Idempotent: safe to call even when the
 *  workspace never had any workbench terminals, or has already been torn
 *  down (registry entries are removed as they're destroyed). Never called
 *  from anywhere else — nav/LRU/remount must never reach this. */
function destroyWorkbenchSurfacesForWorkspace(workspaceId: string): void {
  const ids = workbenchSurfacesByWorkspace.get(workspaceId)
  if (!ids || ids.size === 0) return
  const addon = loadTerminalAddon()
  for (const terminalId of ids) {
    try {
      const surfaceId = workbenchSlotId(workspaceId, terminalId)
      addon.destroy(surfaceId)
      terminalObservationService?.recordWorkbenchLifecycle(
        workspaceId,
        terminalId,
        getNativeSurfacePhase(surfaceId)
      )
    } catch {
      // Surface not mounted or already destroyed — ignore.
    }
  }
  workbenchSurfacesByWorkspace.delete(workspaceId)
}

handle('workbench:mount', (e, { workspaceId, rect, scaleFactor, terminalId }) => {
  const addon = loadTerminalAddon()
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) throw new Error('workbench:mount — no BrowserWindow for sender')
  const nativeHandle = win.getNativeWindowHandle()

  const ws = getWorkspace(workspaceId)
  const cwd = ws?.cwd ?? process.env['HOME']

  // Plain interactive login shell — NOT orpheus-claude.sh (that unconditionally
  // execs `claude`; the Workbench Terminal tab must not spawn a second claude
  // session). Falls back to /bin/zsh (always present on macOS) when $SHELL is
  // unset in the main process environment.
  const shell = process.env['SHELL'] || '/bin/zsh'

  const slotId = workbenchSlotId(workspaceId, terminalId)
  const result = addon.mount(nativeHandle, {
    workspaceId: slotId,
    rect,
    scaleFactor,
    cwd,
    command: shell,
    env: prepareTerminalLaunchEnv({})
  })
  registerWorkbenchSurface(workspaceId, terminalId)
  if (terminalId !== undefined) {
    terminalObservationService?.recordWorkbenchLifecycle(
      workspaceId,
      terminalId,
      getNativeSurfacePhase(slotId)
    )
  }
  logDiagMain({
    category: 'lifecycle',
    level: 'info',
    event: DIAG_EVENTS.TERMINAL_MOUNT,
    workspaceId: slotId,
    data: { created: result.created, workbench: true }
  })
  // Return the CALLER's workspaceId (the owning claude workspace), not the
  // derived slotId — the slot key is an internal addon-routing detail.
  // Callers that need to address the surface directly go through
  // workbenchSlotId(...) themselves (or, more commonly, through the other
  // workbench:* handlers here, which already derive it internally).
  return { workspaceId, created: result.created }
})

handle('workbench:resize', (_e, { workspaceId, rect, scaleFactor, terminalId }): void => {
  const addon = loadTerminalAddon()
  addon.resize(workbenchSlotId(workspaceId, terminalId), rect, scaleFactor)
})

handle('workbench:hide', (_e, { workspaceId, terminalId }): void => {
  const addon = loadTerminalAddon()
  addon.hide(workbenchSlotId(workspaceId, terminalId))
  if (terminalId !== undefined) {
    terminalObservationService?.recordWorkbenchLifecycle(workspaceId, terminalId, 'hidden')
  }
})

handle('workbench:destroy', (_e, { workspaceId, terminalId }): void => {
  const addon = loadTerminalAddon()
  const surfaceId = workbenchSlotId(workspaceId, terminalId)
  addon.destroy(surfaceId)
  if (terminalId !== undefined) {
    terminalObservationService?.recordWorkbenchLifecycle(
      workspaceId,
      terminalId,
      getNativeSurfacePhase(surfaceId)
    )
  }
  unregisterWorkbenchSurface(workspaceId, terminalId)
})

// ---------------------------------------------------------------------------
// Workbench Panes tab IPC (U12)
//
// A SIBLING of the workbench:* terminal-strip machinery above, not a variant
// of it. workbench:* keys every ad-hoc terminal `workbench:<workspaceId>
// [:<terminalId>]` into ONE shared slot per claude workspace, so opening a
// second terminal auto-evicts the first (the "one visible at a time" model
// U8's tab strip wants). Panes need the opposite: N declared panes tiled and
// SIMULTANEOUSLY visible/interactive within the Panes tab, so each pane gets
// its OWN dedicated slot, keyed `pane:<workspaceId>:<paneId>` — no eviction
// between sibling panes of the same workspace.
//
// Each pane also runs a user-declared COMMAND (persisted in `panes.command`,
// src/main/paneStore.ts), not just an interactive shell. Rather than pass
// the raw command string straight to the addon's `command` param (which
// expects an absolute path to a script/binary to exec, not an arbitrary
// shell command line), we point `command` at the generic
// resources/orpheus-pane.sh wrapper and pass the user's command through
// ORPHEUS_PANE_CMD — mirroring how orpheus-claude.sh/buildMountEnv thread
// ORPHEUS_CLAUDE_FLAGS through env rather than argv. The wrapper runs the
// command, then drops to an interactive shell once it exits (or immediately,
// for an empty command — "just a shell") so the pane surface never dies.
// ---------------------------------------------------------------------------

function paneSlotId(workspaceId: string, paneId: string): string {
  return `pane:${workspaceId}:${paneId}`
}

function isPaneSlotId(surfaceKey: string): boolean {
  return surfaceKey.startsWith('pane:')
}

/** Resolves the orpheus-pane.sh wrapper's absolute path — same packaged-vs-
 *  dev resolution buildMountEnv uses for orpheus-claude.sh. */
function paneWrapperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'orpheus-pane.sh')
    : join(__dirname, '../../resources/orpheus-pane.sh')
}

// Pane surface registry — mirrors workbenchSurfacesByWorkspace's own header
// comment: the renderer only ever HIDES a pane surface on ordinary
// nav-away/unmount (surfaces are sticky, per CLAUDE.md), so this map is
// main's own bookkeeping of live `pane:<workspaceId>:<paneId>` slots, keyed
// workspaceId -> the set of live paneIds, letting workspace close/archive/
// project-remove destroy ALL of a workspace's pane surfaces deterministically
// regardless of render state. Populated on every successful pane:mount,
// cleaned on every pane:destroy (both explicit and the bulk destroy below).
const paneSurfacesByWorkspace = new Map<string, Set<string>>()

function registerPaneSurface(workspaceId: string, paneId: string): void {
  let ids = paneSurfacesByWorkspace.get(workspaceId)
  if (!ids) {
    ids = new Set()
    paneSurfacesByWorkspace.set(workspaceId, ids)
  }
  ids.add(paneId)
  broadcastLiveLayouts()
}

function unregisterPaneSurface(workspaceId: string, paneId: string): void {
  const ids = paneSurfacesByWorkspace.get(workspaceId)
  if (!ids) return
  ids.delete(paneId)
  if (ids.size === 0) paneSurfacesByWorkspace.delete(workspaceId)
  broadcastLiveLayouts()
}

// Issue #24 — pushes the CURRENT set of layout ids with >=1 live pane
// surface to the renderer, so the Panels sidebar's running loader reflects
// real (and background/hidden) surface liveness instead of the old
// active-tab-only placeholder. paneSurfacesByWorkspace's keys are layout
// ids (see that map's own header comment for why the "Workspace" naming is
// misleading here) — a layout with a non-empty pane-id set is "live"
// whether or not it's the currently open layout, which is exactly the
// background-running semantics issue #24 asks for. Called after every
// mutation of the map (register/unregister/bulk-destroy) so the renderer's
// paneLiveLayoutsStore.ts never drifts from main's own bookkeeping.
function broadcastLiveLayouts(): void {
  const layoutIds = [...paneSurfacesByWorkspace.keys()].filter(
    (k) => (paneSurfacesByWorkspace.get(k)?.size ?? 0) > 0
  )
  getMainWindow()?.webContents.send(PUSH_CHANNELS.panesLiveLayoutsChanged, { layoutIds })
}

/** Destroys every known pane surface for `workspaceId` — the ONE
 *  authoritative bulk-destroy path for workspace close/archive/project-
 *  remove, mirroring destroyWorkbenchSurfacesForWorkspace. Idempotent: safe
 *  to call even when the workspace never had any panes, or has already been
 *  torn down. */
function destroyPaneSurfacesForWorkspace(workspaceId: string): void {
  const ids = paneSurfacesByWorkspace.get(workspaceId)
  if (!ids || ids.size === 0) return
  const addon = loadTerminalAddon()
  for (const paneId of ids) {
    try {
      const surfaceId = paneSlotId(workspaceId, paneId)
      addon.destroy(surfaceId)
      terminalObservationService?.recordPaneLifecycle(
        workspaceId,
        paneId,
        getNativeSurfacePhase(surfaceId)
      )
    } catch {
      // Surface not mounted or already destroyed — ignore.
    }
  }
  paneSurfacesByWorkspace.delete(workspaceId)
  broadcastLiveLayouts()
}

function destroyPaneSurface(layoutId: string, paneId: string): 'stopped' | 'absent' {
  return teardownPaneSurfaceStrict({
    layoutId,
    terminalId: paneId,
    getPhase: (surfaceId) => {
      const phase = loadTerminalAddon().getSurfacePhase(surfaceId)
      if (
        phase !== 'none' &&
        phase !== 'hidden' &&
        phase !== 'attached' &&
        phase !== 'visible' &&
        phase !== 'freeing'
      ) {
        throw new Error(`Unknown pane native surface phase: ${String(phase)}`)
      }
      return phase
    },
    isRegistered: (targetLayoutId, targetPaneId) =>
      paneSurfacesByWorkspace.get(targetLayoutId)?.has(targetPaneId) === true,
    destroy: (surfaceId) => {
      loadTerminalAddon().destroy(surfaceId)
      terminalObservationService?.recordPaneLifecycle(
        layoutId,
        paneId,
        getNativeSurfacePhase(surfaceId)
      )
    },
    unregister: unregisterPaneSurface
  })
}

/** Strict delete-path teardown: unlike lifecycle cleanup, any registered
 * surface destroy failure aborts the renderer-requested DB delete. */
function destroyPaneSurfacesForDelete(layoutId: string): void {
  const paneIds = new Set([
    ...(paneSurfacesByWorkspace.get(layoutId) ?? []),
    ...listTerminals(layoutId).map((terminal) => terminal.id)
  ])
  for (const paneId of paneIds) {
    destroyPaneSurface(layoutId, paneId)
  }
}

function destroyAgentPaneSurfacesForOwner(workspaceId: string): void {
  for (const layout of listAgentManagedLayoutsByOwner(workspaceId)) {
    destroyPaneSurfacesForDelete(layout.id)
  }
}

// Fix #23 — for panes, the `workspaceId` param slot actually carries the
// LAYOUT id (PaneCell calls window.api.panes.mount(layoutId, paneId, ...);
// the param is named workspaceId only because pane:mount's shape mirrors
// the workspace terminal:mount handler). getWorkspace(workspaceId) would
// therefore always miss (a layout id never matches a workspace row),
// silently falling back to $HOME and running the pane's setup command in
// the wrong folder. Each layout is folder-bound (PaneLayout.dir) — that's
// the correct cwd, resolved via paneStore's getLayout. Keep the $HOME
// fallback for safety (e.g. a stale/deleted layout id).
//
// Factored out of the pane:mount IPC handler (Fix 4) so background
// auto-start (boot) and the on-demand Start-layout path can mount a pane
// exactly the same way an interactive PaneCell mount does, without needing
// an IPC sender/event. `nativeHandle` is passed in rather than resolved
// here since callers differ in how they obtain the BrowserWindow (IPC
// sender vs. getMainWindow()).
function mountPaneBackground(
  nativeHandle: Buffer,
  layoutId: string,
  paneId: string,
  rect: TerminalRect,
  scaleFactor: number,
  command: string
): { created: boolean } {
  const addon = loadTerminalAddon()
  const layout = getLayout(layoutId)
  const cwd = layout?.dir ?? process.env['HOME']
  const slotId = paneSlotId(layoutId, paneId)
  const result = addon.mount(nativeHandle, {
    workspaceId: slotId,
    rect,
    scaleFactor,
    cwd,
    command: paneWrapperPath(),
    env: prepareTerminalLaunchEnv({ ORPHEUS_PANE_CMD: command })
  })
  registerPaneSurface(layoutId, paneId)
  terminalObservationService?.recordPaneLifecycle(layoutId, paneId, getNativeSurfacePhase(slotId))
  logDiagMain({
    category: 'lifecycle',
    level: 'info',
    event: DIAG_EVENTS.TERMINAL_MOUNT,
    workspaceId: slotId,
    data: { created: result.created, pane: true }
  })
  return { created: result.created }
}

/** Local leaf-id walk over SplitTree — deliberately NOT importing
 *  splitTreeOps.ts's leafIds (renderer code); main must never import from
 *  src/renderer, so this is the same ~4-line recursive walk duplicated here. */
function collectLeafPaneIds(tree: SplitTree): string[] {
  if ('paneId' in tree) return [tree.paneId]
  return [...collectLeafPaneIds(tree.a), ...collectLeafPaneIds(tree.b)]
}

/** Walks a layout's split tree, mounts every leaf pane in the background
 *  (mount then immediately hide, mirroring Dashboard.tsx's
 *  backgroundMountWorkspace shape), and skips cleanly (no throw) when the
 *  layout has no tree, no panes, or a leaf paneId with no matching
 *  pane_terminals row. Shared by boot auto-start and the on-demand
 *  panes:startLayoutBackground IPC path so "auto-start at launch" and
 *  "Start layout from the sidebar" are identical in behavior. Synchronous
 *  (mountPaneBackground/addon.hide are both sync) — callers invoke it
 *  alongside genuinely async neighbors (getMainWindow/IPC), but there is no
 *  await inside it. */
function mountLayoutBackground(window: BrowserWindow, layout: PaneLayout): void {
  if (!layout.splitTree) return
  const leafPaneIds = collectLeafPaneIds(layout.splitTree)
  if (leafPaneIds.length === 0) return

  const nativeHandle = window.getNativeWindowHandle()
  const terminals = listTerminals(layout.id)
  const commandByPaneId = new Map(terminals.map((t) => [t.id, t.command]))

  // Synthetic default rect — panes get real bounds once the layout is
  // actually shown; a hidden surface's rect doesn't need to be accurate.
  const rect: TerminalRect = { x: 0, y: 0, w: 800, h: 600 }
  const scaleFactor = resolvePaneBackgroundScaleFactor({
    getWindowBounds: () => window.getBounds(),
    resolveDisplayScaleFactor: (bounds) => screen.getDisplayMatching(bounds).scaleFactor
  })

  for (const paneId of leafPaneIds) {
    const command = commandByPaneId.get(paneId)
    if (command === undefined) continue // stale leaf id with no terminal row — skip
    try {
      mountPaneBackground(nativeHandle, layout.id, paneId, rect, scaleFactor, command)
      try {
        loadTerminalAddon().hide(paneSlotId(layout.id, paneId))
        terminalObservationService?.recordPaneLifecycle(layout.id, paneId, 'hidden')
      } catch (err) {
        console.error(
          `[panes] background hide failed for pane ${paneId} in layout ${layout.id}:`,
          redactErrorForLog(err)
        )
      }
    } catch (err) {
      console.error(
        `[panes] background mount failed for pane ${paneId} in layout ${layout.id}:`,
        redactErrorForLog(err)
      )
    }
  }
}

/** Fix 4 — background-mounts every pane of every auto-start-flagged layout
 *  at app boot, regardless of which surface is visible. Mirrors the shape of
 *  Dashboard.tsx's backgroundMountWorkspace (mount with a synthetic rect,
 *  then immediately hide) but driven from MAIN so it runs unconditionally at
 *  launch instead of depending on any renderer view being mounted (PanesView
 *  is only mounted when the user navigates to the Panes surface — see
 *  MainContent.tsx's view.kind early return). Best-effort: a bad layout
 *  (null splitTree, no panes, addon throw) is logged and skipped, never
 *  thrown — a broken auto-start layout must not crash boot. Synchronous, same
 *  reasoning as mountLayoutBackground — kept a plain function, not async. */
function autoStartFlaggedLayouts(): void {
  const win = getMainWindow()
  if (!win) return

  let layouts: PaneLayout[]
  try {
    layouts = listAutoStartLayouts()
  } catch (err) {
    console.error('[panes] auto-start: failed to list auto-start layouts:', redactErrorForLog(err))
    return
  }

  for (const layout of layouts) {
    try {
      mountLayoutBackground(win, layout)
    } catch (err) {
      console.error(`[panes] auto-start: failed for layout ${layout.id}:`, redactErrorForLog(err))
    }
  }
}

handle('pane:mount', (e, { workspaceId, paneId, rect, scaleFactor, command }) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) throw new Error('pane:mount — no BrowserWindow for sender')
  const nativeHandle = win.getNativeWindowHandle()
  const result = mountPaneBackground(nativeHandle, workspaceId, paneId, rect, scaleFactor, command)
  return { workspaceId, created: result.created }
})

handle('pane:resize', (_e, { workspaceId, paneId, rect, scaleFactor }): void => {
  const addon = loadTerminalAddon()
  addon.resize(paneSlotId(workspaceId, paneId), rect, scaleFactor)
})

handle('pane:hide', (_e, { workspaceId, paneId }): void => {
  const addon = loadTerminalAddon()
  addon.hide(paneSlotId(workspaceId, paneId))
  terminalObservationService?.recordPaneLifecycle(workspaceId, paneId, 'hidden')
})

handle('pane:destroy', (_e, { workspaceId, paneId }): void => {
  const addon = loadTerminalAddon()
  const surfaceId = paneSlotId(workspaceId, paneId)
  addon.destroy(surfaceId)
  terminalObservationService?.recordPaneLifecycle(
    workspaceId,
    paneId,
    getNativeSurfacePhase(surfaceId)
  )
  unregisterPaneSurface(workspaceId, paneId)
})

// Fix 4 — on-demand per-layout background Start/Stop, driven from the
// sidebar layout context menu. Shares mountLayoutBackground with boot
// auto-start so both paths mount identically; Stop reuses the one
// authoritative bulk-destroy path (destroyPaneSurfacesForWorkspace).
handle('panes:startLayoutBackground', (_e, { id }): void => {
  const win = getMainWindow()
  if (!win) return
  const layout = getLayout(id)
  if (!layout) return
  mountLayoutBackground(win, layout)
})

handle('panes:stopLayout', (_e, { id }): void => {
  destroyPaneSurfacesForWorkspace(id)
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
  //
  // Deliberately a SUBSET of teardownWorkspaceState's 5 maps — NOT that
  // helper — because live restart must NOT evict injectLocks (an in-flight
  // inject must keep its lock across the surface bounce). Uses the
  // registry's granular per-map accessors instead.
  clearOverlayFallbackTimer(workspaceId)
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
    terminalObservationService?.recordWorkspaceLifecycle(
      workspaceId,
      getNativeSurfacePhase(workspaceId)
    )
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
  } finally {
    // Revocation is independent of native destruction completing. In
    // particular, live restart can leave the native surface in `freeing`
    // briefly; the next mount must receive a fresh runtime generation.
    runtimeLeases.revokeBySurface(workspaceId)
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

registerOverlayIpc()

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
const UNKNOWN_ERROR_MESSAGE = 'unknown error'

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

registerActionsIpc()

registerFooterActionsIpc()

registerReviewsIpc()

registerPanesIpc({
  deletePanel: (panelId) => {
    for (const layout of listLayouts(panelId)) {
      destroyPaneSurfacesForDelete(layout.id)
    }
    deletePanePanelRow(panelId)
  },
  deleteLayout: (layoutId) => {
    destroyPaneSurfacesForDelete(layoutId)
    deletePaneLayoutRow(layoutId)
  },
  deleteTerminal: (terminalId) => {
    const terminal = getTerminal(terminalId)
    if (terminal != null) destroyPaneSurface(terminal.layoutId, terminal.id)
    deletePaneTerminalRow(terminalId)
  }
})

const rendererCommandBroker = new RendererCommandBroker(
  createRendererCommandTransport(getMainWindow)
)
registerWorkbenchControlIpc({ broker: rendererCommandBroker, getMainWindow })

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
        console.error('[startup] database migration failed:', redactErrorForLog(err))
        writeCrashFile(err)
        dialog.showErrorBox(
          'Orpheus — Database Error',
          'The database could not be migrated to the latest version and the app cannot start safely.\n\n' +
            'Your data has not been modified. A backup may exist alongside the database file.\n\n' +
            redactErrorMessage(err)
        )
        app.exit(1)
        return
      }

      // Apply the persisted icon pack to the live Dock icon on launch (Task 3
      // — "survives relaunch"). Fire-and-forget: total/never-throws internally
      // (see applyPersistedIconPack's doc comment), and must never block
      // window creation on a slow/missing catalog. Runs as early as possible —
      // right after getDb() succeeds, since applyPersistedIconPack reads
      // getAppUiState() which requires a migrated DB connection — so it can't
      // run any earlier than this. Placed before startDiagnostics()/
      // syncDiagFlags() so it no longer waits on those steps.
      void applyPersistedIconPack(getAppUiState().iconPackId)

      startDiagnostics()
      syncDiagFlags()

      // Build the native app menu with the Privacy Mode checkbox item wired to
      // uiState — best-effort so a menu failure never blocks boot.
      try {
        buildAppMenu({
          privacyMode: getAppUiState().privacyMode,
          onTogglePrivacyMode: (checked) => {
            const result = updateAppUiState({ privacyMode: checked })
            const win = getMainWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send(PUSH_CHANNELS.uiStateChanged, result)
            }
          }
        })
      } catch (err) {
        console.error('[startup] failed to build application menu:', redactErrorForLog(err))
      }

      // Wire the workspaceResources registry's main→renderer broadcast bridge
      // once at boot (mirrors configureLoadingOverlay's injection pattern) —
      // keeps workspaceResources.ts a leaf with no import back on index.ts.
      configureWorkspaceResources({
        broadcast: (channel, payload) => getMainWindow()?.webContents.send(channel, payload)
      })

      const workspaceOrchestration = createMainWorkspaceOrchestration({
        runtimeLeases,
        requestOpenWorkspace,
        requestOrchestrationMount,
        getSurfacePhase: getNativeSurfacePhase,
        isWorkspaceSessionReady,
        canInject: terminalActions.canInject,
        sendInput: (workspaceId, text) =>
          terminalActions.sendInput(loadTerminalAddon(), workspaceId, text),
        submit: (workspaceId) => terminalActions.submit(loadTerminalAddon(), workspaceId),
        destroyWorkspaceRuntime
      })
      workspaceOrchestrationService = workspaceOrchestration.service
      const runtimeControlGrants = new RuntimeControlGrantPolicy(undefined, {
        getCurrentBinding: (runtimeId) => runtimeLeases.getByRuntimeId(runtimeId),
        getResourceScope: createRuntimeResourceScopeSource(getDb())
      })
      const workbenchControlAudit = createControlAuditStore(getDb())
      const workbenchControl = new WorkbenchControlService({
        renderer: {
          execute: (requestId, command) => rendererCommandBroker.execute(requestId, command)
        },
        authorization: {
          revalidate: ({ context, permission, layoutId, terminalId }) => {
            const trusted = context.trustedRuntime
            if (trusted == null) return 'forbidden'
            const binding = runtimeLeases.getByRuntimeId(trusted.runtimeId)
            if (
              binding == null ||
              binding.workspaceId !== trusted.workspaceId ||
              binding.projectId !== trusted.projectId ||
              binding.surfaceId !== trusted.surfaceId
            ) {
              return 'forbidden'
            }
            if (!runtimeControlGrants.permissionsFor(binding).includes(permission)) {
              return 'forbidden'
            }
            if (layoutId == null) return 'allow'
            const scope = runtimeControlGrants.scopeFor(binding)
            if (!scope?.layoutIds.includes(layoutId)) return 'not_found'
            if (
              terminalId != null &&
              !scope.surfaceIds.includes(`pane:${layoutId}:${terminalId}`)
            ) {
              return 'not_found'
            }
            return 'allow'
          }
        },
        paths: {
          isSafe: (workspaceId, relativePath, options) => {
            const workspace = getWorkspace(workspaceId)
            return workspace == null
              ? false
              : isCanonicalWorkspacePath(workspace.cwd, relativePath, options)
          }
        },
        panes: createMainPaneControlPort({
          getLayout,
          listTerminals,
          getWorkspace: (workspaceId) => getWorkspace(workspaceId) ?? null,
          createDedicated: createDedicatedWorkspaceTerminal,
          deleteDedicated: deleteDedicatedWorkspaceTerminal,
          startConfigured: (layout, terminal) => {
            const window = getMainWindow()
            if (window == null || window.isDestroyed()) {
              throw new Error('Pane terminal is unavailable.')
            }
            const slotId = paneSlotId(layout.id, terminal.id)
            return startProvisionedPaneSurface({
              getWindowBounds: () => window.getBounds(),
              resolveDisplayScaleFactor: (bounds) => screen.getDisplayMatching(bounds).scaleFactor,
              getSurfacePhase: () => loadTerminalAddon().getSurfacePhase(slotId),
              mount: (scaleFactor) => {
                mountPaneBackground(
                  window.getNativeWindowHandle(),
                  layout.id,
                  terminal.id,
                  { x: 0, y: 0, w: 800, h: 600 },
                  scaleFactor,
                  terminal.command
                )
              },
              hide: () => loadTerminalAddon().hide(slotId)
            })
          },
          stopSurface: (layoutId, terminalId) => {
            return destroyPaneSurface(layoutId, terminalId)
          },
          focusSurface: (layoutId, terminalId) => {
            loadTerminalAddon().focus(paneSlotId(layoutId, terminalId))
          }
        }),
        audit: workbenchControlAudit,
        onAuditFailure: (error, record) => {
          console.error(
            '[controlAudit] Phase 4 append failed:',
            record.auditId,
            redactErrorForLog(error)
          )
        }
      })
      const mainReads = createMainReadHandlers({
        statusObservation: (workspaceId, observedAt) => {
          const workspace = getWorkspace(workspaceId)
          const live = getWorkspaceFileInfo(workspaceId)
          return {
            value:
              workspace == null
                ? null
                : {
                    persistedStatus: workspace.status,
                    liveStatus: live.status,
                    ...(live.waitingFor ? { waitingFor: live.waitingFor } : {})
                  },
            source: 'claude-session-file',
            observedAt,
            sourceUpdatedAt: live.statusUpdatedAt ?? null,
            availability:
              workspace == null || live.availability === 'unavailable'
                ? 'unavailable'
                : 'available',
            stale: live.availability === 'unavailable' ? null : false,
            ...(workspace == null
              ? { reason: 'Workspace was not found.' }
              : live.availability === 'unavailable'
                ? { reason: 'Claude live session is unavailable.' }
                : {})
          }
        }
      })
      const terminalObservation = createMainTerminalObservation({
        runtimeLeases,
        reads: mainReads,
        listWorkspaces: (projectId) => listWorkspacesForProject(projectId, { scope: 'active' }),
        getWorkspace: (workspaceId) => getWorkspace(workspaceId) ?? null,
        listWorkbenchTerminalIds: (workspaceId) => [
          ...(workbenchSurfacesByWorkspace.get(workspaceId) ?? [])
        ],
        hasWorkbenchTerminal: (workspaceId, terminalId) =>
          workbenchSurfacesByWorkspace.get(workspaceId)?.has(terminalId) === true,
        hasPaneSurface: (layoutId, paneId) =>
          paneSurfacesByWorkspace.get(layoutId)?.has(paneId) === true,
        getPaneTargetBySurfaceId: (surfaceId) => {
          for (const [layoutId, paneIds] of paneSurfacesByWorkspace) {
            for (const paneId of paneIds) {
              if (paneSurfaceId(layoutId, paneId) !== surfaceId) continue
              const layout = getLayout(layoutId)
              const terminal = listTerminals(layoutId).find((candidate) => candidate.id === paneId)
              if (layout == null || terminal == null) return null
              return {
                layoutId,
                paneId,
                cwd: layout.dir,
                command: terminal.command,
                updatedAt: Math.max(layout.updatedAt, terminal.updatedAt)
              }
            }
          }
          return null
        },
        getNativePhase: getNativeSurfacePhase
      })
      terminalObservationService = terminalObservation.service
      terminalObservationCleanup = terminalObservation.dispose

      // Boot the control registry, durable automation runtime, IPC surfaces,
      // scheduler, and event bridge under one paired lifecycle owner.
      const broadcastAutomationChanged = (event: AutomationChangedEvent): void => {
        const win = getMainWindow()
        if (win == null || win.isDestroyed() || win.webContents.isDestroyed()) return
        try {
          win.webContents.send(PUSH_CHANNELS.automationsChanged, event)
        } catch {
          // Best-effort invalidation: a window teardown race must not change
          // the result of a mutation that has already committed.
        }
      }
      controlPlaneLifecycle = startMainControlPlaneLifecycle({
        db: getDb(),
        controlPlane: {
          authorization: createTrustedRuntimeReadPolicy({
            getWorkspaceProjectId: (workspaceId) => getWorkspace(workspaceId)?.projectId ?? null
          }),
          reads: mainReads,
          workspaceOrchestration: workspaceOrchestration.service,
          workbenchControl,
          terminalObservation: terminalObservation.service,
          settingsResources: createMainSettingsResourceService()
        },
        getProject,
        getWorkspace,
        broadcastAutomationChanged,
        subscribePersisting: onWorkspaceStatusPersisting,
        subscribeCommitted: onWorkspaceStatusCommitted,
        onAutomationEventError: (error) => {
          console.error('[automations] workspace event failed:', redactErrorForLog(error))
        },
        onSchedulerStartError: () => {
          console.error('[automations] startup reconciliation failed')
        }
      })
      const controlToolExposure = controlPlaneLifecycle.toolExposure
      bootActions(workspaceControlAdapter)

      // Seed default footer actions on first install (idempotent: no-op if rows exist).
      try {
        seedDefaultFooterActions()
      } catch (err) {
        console.error('[footerActions] failed to seed defaults:', redactErrorForLog(err))
      }

      // Refresh model context/pricing from models.dev — fire-and-forget, never
      // blocks boot. See src/main/models/registry.ts.
      refreshModelsDevCache().catch(() => {})

      // Clear stale in_progress / attention statuses left over from a prior
      // session (crash, hard quit). Without this, the WorkspaceView would show a
      // forever-spinning "thinking" indicator until a fresh activity event lands.
      try {
        const cleared = resetTransientStatusesOnStartup()
        if (cleared > 0) {
          console.log('[startup] cleared', cleared, 'stale workspace activity statuses')
        }
      } catch (err) {
        console.error('[startup] failed to clear stale activity statuses:', redactErrorForLog(err))
      }

      // Seed the in-memory workspaceTitles map from the DB so the sidebar /
      // workspace header can show the last observed prompt title immediately on
      // launch — without waiting for Claude to re-emit an OSC title.
      try {
        for (const { id, title } of getAllWorkspaceLastTitles()) {
          seedTitle(id, title)
        }
      } catch (err) {
        console.error('[startup] failed to seed workspaceTitles from DB:', redactErrorForLog(err))
      }

      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      // Kick the active terminal on system wake events so the CVDisplayLink
      // restarts after display sleep / screen lock / user-switch.
      powerMonitor.on('resume', kickActiveTerminal)
      powerMonitor.on('unlock-screen', kickActiveTerminal)
      if (process.platform === 'darwin') {
        powerMonitor.on('user-did-become-active', kickActiveTerminal)
      }

      // Re-reconcile the managed routing proxy on the same system-wake
      // events — a sleep/lock cycle can leave the child process wedged or
      // silently killed by the OS without ever firing a normal 'exit' event
      // the supervisor would see. reconcileRoutingProxy() is idempotent and
      // self-healing (see its own doc comment): a no-op when everything is
      // already fine, and a full reclaim-orphan+start when the proxy is
      // enabled but not actually running. Fire-and-forget, same as every
      // other reconcile call site (boot, enable-toggle) — never blocks the
      // wake event itself.
      powerMonitor.on('resume', () => void reconcileRoutingProxy())
      powerMonitor.on('unlock-screen', () => void reconcileRoutingProxy())

      // Apply OS-level settings after the window exists (hotkey callback needs it)
      try {
        const state = getAppUiState()
        applyLaunchAtLogin(state.launchAtLogin)
        applyGlobalHotkey(state.globalHotkey)
      } catch (err) {
        console.error('[startup] failed to apply launch/hotkey settings:', redactErrorForLog(err))
      }

      // Start the update auto-check loop (30s initial delay, then every 6h).
      // Gated internally on the autoCheckUpdates setting.
      startAutoCheckLoop()

      // Start the Claude service-status poller (3s initial delay, then per user setting).
      // Uses blur/focus backoff so polls slow down when Orpheus is in the background.
      startStatusPoller()

      // Start the Dashboard "Usage" card background poller (D3) — 5s initial
      // delay, then per user setting (usagePollIntervalSec). Pushes fresh
      // usage to the renderer silently on each successful tick.
      startUsagePoller()

      // Start the Dashboard "Your pulse" real-activity background poller —
      // 5s initial delay, then every 3min. Scans ~/.claude/projects/**/*.jsonl
      // (per-file mtime/size cached, so steady-state re-scans are cheap) and
      // pushes fresh totals to the renderer silently on each tick.
      startClaudeActivityPoller()

      // Defer background service composition by one event-loop turn. The
      // command server is still created before createWindow below, so no
      // renderer can race its first terminal mount ahead of the control socket.
      async function startDeferredServices(): Promise<void> {
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

        // Managed routing proxy (model-routing unit 04) — mirrors reconcileHooks
        // exactly: hydrate the snapshot (detect an already-installed binary),
        // then start/stop the child process to match routingProxyEnabled
        // (default off). Never blocks first-frame paint — deferred into this
        // same setImmediate as the hook reconcile above.
        void hydrateSnapshotAtBoot().then(() => reconcileRoutingProxy())

        // Start the command server unconditionally — the CLI shouldn't depend on
        // hooks being enabled. Provides a request/response channel for CLI workspace
        // actions (create, archive, close, reopen, rename, whoami.resolve).
        if (!commandServer) {
          try {
            const cmdDeps: CommandServerDeps = {
              runtimeLeases,
              listControl,
              invokeControl,
              getControlCatalogRevision: () => controlToolExposure.getCatalogRevision(),
              waitForControlCatalogRevision: (afterRevision, timeoutMs, signal) =>
                controlToolExposure.waitForCatalogRevision(afterRevision, timeoutMs, signal),
              workspaceOrchestration: workspaceOrchestration.service,
              workspaceWaitEngine: workspaceOrchestration.waits,
              runtimeControlGrants,
              destroySurface: (workspaceId) => {
                runtimeLeases.revokeBySurface(workspaceId)
                if (terminalAddon) {
                  try {
                    terminalAddon.destroy(workspaceId)
                  } catch {
                    // Surface not mounted or already destroyed — ignore.
                  }
                }
                // Trigger (g) — mirrors performClose/performArchive/projects:remove
                // (see workbenchSurfacesByWorkspace's header comment).
                destroyWorkbenchSurfacesForWorkspace(workspaceId)
                // Same trigger (g) applies to Panes tab surfaces (see
                // paneSurfacesByWorkspace's header comment).
                destroyPaneSurfacesForWorkspace(workspaceId)
                destroyAgentPaneSurfacesForOwner(workspaceId)
              },
              teardownWorkspaceResources,
              performClose: (workspaceId) => performClose(workspaceId),
              performArchive: (workspaceId) => performArchive(workspaceId, true),
              getSurfacePhase: getNativeSurfacePhase,
              requestOpenWorkspace,
              openAndSeed: async (
                workspaceId: string,
                taskText: string,
                focus: boolean = true,
                submit: boolean = true
              ): Promise<string | null> => {
                requestOpenWorkspace(workspaceId, focus)
                const TIMEOUT_MS = 25_000
                const ready = await workspaceOrchestration.runtime.waitUntilReady(
                  workspaceId,
                  Date.now() + TIMEOUT_MS
                )
                if (!ready) {
                  return (
                    `seed-timeout: claude did not become ready within ${Math.round(TIMEOUT_MS / 1000)}s; ` +
                    'task not injected. The workspace was created but claude may still be booting ' +
                    '— open it manually and paste the task text once it reaches the prompt.'
                  )
                }
                const result = await workspaceOrchestration.runtime.stageText(
                  workspaceId,
                  taskText,
                  submit
                )
                if (result.ok) return null
                if (result.stage === 'send') {
                  return `seed-failed: could not send task text — ${result.error ?? UNKNOWN_ERROR_MESSAGE}`
                }
                if (result.code === 'busy') {
                  return `seed-submit-busy: text was sent; workspace became busy before the explicit submit — it may have already been submitted`
                }
                return `seed-submit-failed: text was sent but submit failed — ${result.error ?? UNKNOWN_ERROR_MESSAGE}`
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
                        error: `send-text failed: ${inputResult.error ?? UNKNOWN_ERROR_MESSAGE}`
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
                        error: `send-key failed: ${keysResult.error ?? UNKNOWN_ERROR_MESSAGE}`
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
                        error: `submit failed: ${submitResult.error ?? UNKNOWN_ERROR_MESSAGE}`
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
            const startedCommandServer = startCommandServer(cmdDeps)
            try {
              await startedCommandServer.ready
              commandServer = startedCommandServer
            } catch (err) {
              startedCommandServer.close()
              throw err
            }
          } catch (err) {
            console.error('[commandServer] failed to start:', redactErrorForLog(err))
          }
        }

        createWindow()

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
          console.error('[sessionState] failed to start:', redactErrorForLog(err))
        }

        try {
          powerAwakeCleanup = startPowerAwake(getMainWindow)
        } catch (err) {
          console.error('[powerAwake] failed to start:', redactErrorForLog(err))
        }

        // Fix 4 — background-mount every auto-start-flagged pane layout now that
        // the window + native handle exist. Never block or throw during boot.
        try {
          autoStartFlaggedLayouts()
        } catch (err) {
          console.error('[panes] auto-start: unexpected failure:', redactErrorForLog(err))
        }

        try {
          checkOrpheusOnPath()
        } catch (err) {
          console.error('[cli-path] on-PATH check failed:', redactErrorForLog(err))
        }

        app.on('activate', function () {
          if (BrowserWindow.getAllWindows().length === 0) createWindow()
          else kickActiveTerminal()
        })
      }

      setImmediate(() => {
        void startDeferredServices().catch((err: unknown) => {
          console.error('[startup] deferred service composition failed:', redactErrorForLog(err))
        })
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
        'Orpheus failed to start.\n\n' + redactErrorMessage(err)
      )
      app.exit(1)
    })

  app.on('will-quit', () => {
    controlPlaneLifecycle?.dispose()
    controlPlaneLifecycle = null
    globalShortcut.unregisterAll()
    runtimeLeases.revokeAll()
    notifyServer?.close()
    commandServer?.close()
    sessionStateService?.stop()
    terminalObservationCleanup?.()
    terminalObservationCleanup = null
    terminalObservationService = null
    powerAwakeCleanup?.()
    stopStatusPoller()
    stopUsagePoller()
    stopClaudeActivityPoller()
    stopAutoCheckLoop()
    stopAllGitWatches()
    stopFilesWatch()
    stopDiagnostics()
    shutdownRoutingProxySync()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
} // end single-instance else block
