// ---------------------------------------------------------------------------
// src/main/ipc/claudeAuth.ts
//
// Claude Auth IPC — moved verbatim out of index.ts (STR-1). Pure passthrough
// to ./claudeAuth; closes over no index.ts state.
// ---------------------------------------------------------------------------

import { getClaudeAuthState, updateClaudeAuth, testAnthropicConnection } from '../claudeAuth'
import { handle } from './handle'
import { recomputeDirty } from './claudeSettings'

export function registerClaudeAuthIpc(): void {
  handle('claudeAuth:get', () => getClaudeAuthState())

  handle('claudeAuth:update', (_e, patch) => {
    const result = updateClaudeAuth(patch)
    // Auth (cloud_provider, api key/token, base URL, ...) is merged into the
    // launch env downstream of composeClaudeLaunch, so a change here must
    // also recheck every mounted workspace's dirty state — see
    // LaunchSnapshot.authEnv in workspaceResources.ts.
    recomputeDirty()
    return result
  })

  handle('claudeAuth:testConnection', () => testAnthropicConnection())
}
