// ---------------------------------------------------------------------------
// src/main/ipc/overlay.ts
//
// Overlay layer IPC (React overlays rendered above the terminal) — moved
// verbatim out of index.ts (STR-1). Pure passthrough to ./overlayLayer;
// closes over no index.ts state.
//
// NOTE: the ipcMain.on registrations for the overlayRenderer:* channels
// (sends FROM the overlay WebContentsView, not invokes) stay wired via
// registerOverlayRendererIpc(), called from index.ts alongside
// initOverlayLayer() — that's process-global send/receive wiring tied to the
// overlay WebContentsView lifecycle, not a request/response IPC handler, so
// it isn't part of this handle()-based domain.
// ---------------------------------------------------------------------------

import { showOverlay, updateOverlay, hideOverlay } from '../overlayLayer'
import { handle } from './handle'

export function registerOverlayIpc(): void {
  handle('overlay:showDescriptor', (_e, { descriptor }) => showOverlay(descriptor))

  handle('overlay:update', (_e, { id, props }): void => updateOverlay(id, props))

  handle('overlay:hide', (_e, { id }) => hideOverlay(id))
}
