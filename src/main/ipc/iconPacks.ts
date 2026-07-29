// ---------------------------------------------------------------------------
// src/main/ipc/iconPacks.ts
//
// IPC surface for Settings > General "App icon" picker. Thin glue over
// src/main/iconPacks.ts (discovery/validation/live-apply) + src/main/uiState.ts
// (persistence of the selected pack `id` — never a path or version).
// ---------------------------------------------------------------------------

import { getAppUiState, updateAppUiState } from '../uiState'
import { applyPersistedIconPack, getIconPackCatalog } from '../iconPacks'
import type { IconPackCatalogResult } from '../../shared/types'
import { handle } from './handle'

async function currentCatalog(): Promise<IconPackCatalogResult> {
  const state = getAppUiState()
  return getIconPackCatalog(state.iconPackId)
}

export function registerIconPacksIpc(): void {
  handle('iconPacks:list', () => currentCatalog())

  handle('iconPacks:select', async (_e, { id }: { id: string }) => {
    updateAppUiState({ iconPackId: id })
    // Re-resolve against the live catalog (handles an unknown id via the
    // same fallback resolveSelectedPack uses) and apply immediately to the
    // running Dock icon — see applyPersistedIconPack's doc comment for why
    // this can never change the packaged Finder/.app icon.
    await applyPersistedIconPack(id)
    return currentCatalog()
  })
}
