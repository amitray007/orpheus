// ---------------------------------------------------------------------------
// src/main/ipc/oauth.ts
//
// OAuth "Connect <provider>" IPC (model-routing unit 07) — thin passthrough
// to src/main/routingProxy/manager.ts's startOAuthLogin/pollOAuthLogin/
// cancelOAuthLogin, mirroring src/main/ipc/routingProxy.ts's and
// src/main/ipc/providers.ts's shape.
// ---------------------------------------------------------------------------

import { startOAuthLogin, pollOAuthLogin, cancelOAuthLogin } from '../routingProxy/manager'
import { handle } from './handle'

export function registerOAuthIpc(): void {
  handle('oauth:start', async (_e, { providerId }) => startOAuthLogin(providerId))

  handle('oauth:poll', async (_e, { state }) => pollOAuthLogin(state))

  handle('oauth:cancel', async (_e, { state }) => {
    await cancelOAuthLogin(state)
  })
}
