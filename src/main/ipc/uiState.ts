// ---------------------------------------------------------------------------
// src/main/ipc/uiState.ts
//
// UI State IPC — moved verbatim out of index.ts (STR-1).
//
// uiState:update fans out into several index.ts-local side effects
// (launch-at-login, global hotkey, loading-overlay theme, main-window
// broadcast) that close over module-level singletons (mainWindowRef,
// terminalAddon, registeredHotkey) — none of these are leaves, so they're
// injected via deps rather than duplicated here. setDiagCategoryFlags /
// invalidateWatchdogCache / rescheduleStatusPoll / setOverlayTheme are leaf
// imports and used directly.
// ---------------------------------------------------------------------------

import type { BrowserWindow } from 'electron'
import { getAppUiState, updateAppUiState } from '../uiState'
import { setDiagCategoryFlags } from '../diagnostics'
import { invalidateWatchdogCache } from '../orpheusNotify'
import { rescheduleStatusPoll } from '../claudeStatus'
import { setOverlayTheme } from '../overlayLayer'
import { PUSH_CHANNELS } from '../../shared/ipc'
import type { AppUiStatePatch, Theme } from '../../shared/types'
import { handle } from './handle'

export interface UiStateIpcDeps {
  getMainWindow: () => BrowserWindow | null
  applyLaunchAtLogin: (enabled: boolean) => void
  applyGlobalHotkey: (hotkey: string) => boolean
  applyLoadingOverlayTheme: (theme: Theme) => void
}

// Exported so index.ts's boot sequence (which also needs to sync diag flags
// once at startup) can call the same logic instead of duplicating it.
export function syncDiagFlags(): void {
  const s = getAppUiState()
  setDiagCategoryFlags({
    error: s.diagError,
    lifecycle: s.diagLifecycle,
    perf: s.diagPerf,
    anomaly: s.diagAnomaly,
    trace: s.diagTrace
  })
}

export function registerUiStateIpc(deps: UiStateIpcDeps): void {
  handle('uiState:get', () => getAppUiState())

  handle('uiState:update', (_e, patch: AppUiStatePatch) => {
    const result = updateAppUiState(patch)
    if (patch.launchAtLogin !== undefined) deps.applyLaunchAtLogin(patch.launchAtLogin)
    if (patch.globalHotkey !== undefined) deps.applyGlobalHotkey(patch.globalHotkey)
    if (patch.theme !== undefined) {
      deps.applyLoadingOverlayTheme(patch.theme)
      setOverlayTheme(patch.theme)
    }
    if (patch.inProgressWatchdogSec !== undefined) invalidateWatchdogCache()
    if (patch.staleAfterMinutes !== undefined) invalidateWatchdogCache()
    if (patch.autoCloseAfterMinutes !== undefined) invalidateWatchdogCache()
    if (patch.statusPollIntervalSec !== undefined) rescheduleStatusPoll()
    syncDiagFlags()
    // Broadcast the updated state so renderer subscribers (e.g. WorkspaceFooter)
    // can react without polling.
    const win = deps.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send(PUSH_CHANNELS.uiStateChanged, result)
    }
    return result
  })
}
