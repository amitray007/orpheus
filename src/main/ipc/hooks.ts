// ---------------------------------------------------------------------------
// src/main/ipc/hooks.ts
//
// Hooks integration IPC — moved verbatim out of index.ts (STR-1).
//
// `reconcileHooks` itself stays in index.ts: it closes over the `notifyServer`
// singleton (a module-level mutable reference also touched by the boot
// sequence, `terminal:mount`'s buildMountEnv call, the command-server deps
// bag, and `will-quit` cleanup) — genuine index.ts state, not a leaf. It's
// injected here via deps instead of duplicated.
// ---------------------------------------------------------------------------

import { getAppUiState, updateAppUiState } from '../uiState'
import { countManagedHooks } from '../orpheusNotify'
import { handle } from './handle'

export interface HooksIpcDeps {
  reconcileHooks: () => void
}

export function registerHooksIpc(deps: HooksIpcDeps): void {
  handle('hooks:setEnabled', (_e, enabled: boolean) => {
    updateAppUiState({ hooksIntegrationEnabled: enabled })
    deps.reconcileHooks()
    return { enabled }
  })

  handle('hooks:getStatus', () => {
    const enabled = getAppUiState().hooksIntegrationEnabled
    const installed = countManagedHooks()
    return { enabled, installed }
  })
}
