// ---------------------------------------------------------------------------
// src/main/ipc/claudeUsage.ts
//
// Dashboard "Usage" card IPC — pure passthrough to ../claudeUsage, same
// shape as ipc/claudeAuth.ts. Closes over no index.ts state; the module-
// level TTL cache + inflight de-dup already lives in claudeUsage.ts, so this
// handler is a one-liner.
// ---------------------------------------------------------------------------

import { getClaudeUsage } from '../claudeUsage'
import { handle } from './handle'

export function registerClaudeUsageIpc(): void {
  handle('claude:usage', () => getClaudeUsage())
}
