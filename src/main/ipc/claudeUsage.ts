// ---------------------------------------------------------------------------
// src/main/ipc/claudeUsage.ts
//
// Dashboard "Usage" card IPC — pure passthrough to ../claudeUsage, same
// shape as ipc/claudeAuth.ts. Closes over no index.ts state; the module-
// level TTL cache + inflight de-dup already lives in claudeUsage.ts, so this
// handler is a one-liner.
// ---------------------------------------------------------------------------

import { getClaudeUsage, getCachedClaudeUsage } from '../claudeUsage'
import { handle } from './handle'

export function registerClaudeUsageIpc(): void {
  handle('claude:usage', () => getClaudeUsage())
  // Dashboard D2 (stale-while-revalidate) — instant, disk-backed read that
  // never touches the network. See claudeUsage.ts::getCachedClaudeUsage.
  handle('claude:usage:cached', () => getCachedClaudeUsage())
}
