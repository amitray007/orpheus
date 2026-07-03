// ---------------------------------------------------------------------------
// src/main/ipc/claudeAuth.ts
//
// Claude Auth IPC — moved verbatim out of index.ts (STR-1). Pure passthrough
// to ./claudeAuth; closes over no index.ts state.
// ---------------------------------------------------------------------------

import { getClaudeAuthState, updateClaudeAuth, testAnthropicConnection } from '../claudeAuth'
import { handle } from './handle'

export function registerClaudeAuthIpc(): void {
  handle('claudeAuth:get', () => getClaudeAuthState())

  handle('claudeAuth:update', (_e, patch) => updateClaudeAuth(patch))

  handle('claudeAuth:testConnection', () => testAnthropicConnection())
}
