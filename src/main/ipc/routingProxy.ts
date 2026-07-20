// ---------------------------------------------------------------------------
// src/main/ipc/routingProxy.ts
//
// Managed routing-proxy IPC — thin passthrough to
// src/main/routingProxy/manager.ts, mirroring src/main/ipc/updates.ts's
// shape (getState/check/install-style handlers backed by a module-level
// snapshot the manager owns).
// ---------------------------------------------------------------------------

import {
  getRoutingProxySnapshot,
  setEnabled,
  install,
  getAssetInfo,
  checkForComponentUpdate,
  refreshAuthFilesNow
} from '../routingProxy/manager'
import { handle } from './handle'

export function registerRoutingProxyIpc(): void {
  handle('routingProxy:getState', () => getRoutingProxySnapshot())

  handle('routingProxy:setEnabled', async (_e, { enabled }) => setEnabled(enabled))

  handle('routingProxy:install', async () => {
    await install()
    return getRoutingProxySnapshot()
  })

  handle('routingProxy:getAssetInfo', async () => getAssetInfo())

  handle('routingProxy:checkForUpdate', async () => checkForComponentUpdate())

  handle('routingProxy:refreshAuthFiles', async () => refreshAuthFilesNow())
}
