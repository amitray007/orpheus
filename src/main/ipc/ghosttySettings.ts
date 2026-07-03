// ---------------------------------------------------------------------------
// src/main/ipc/ghosttySettings.ts
//
// Ghostty Settings IPC — moved verbatim out of index.ts (STR-1).
//
// NOTE: only ghosttySettings:get lives here. ghosttySettings:update is
// deliberately NOT extracted — it calls the private index.ts function
// loadTerminalAddon() (the native addon singleton loader, part of the
// deferred terminal domain) to hot-reload the running addon's config. That's
// genuine index.ts state, not a clean self-contained handler. Left in place.
// ---------------------------------------------------------------------------

import { getGhosttyUserConfig } from '../ghosttyConfig'
import { handle } from './handle'

export function registerGhosttySettingsIpc(): void {
  handle('ghosttySettings:get', () => getGhosttyUserConfig())
}
