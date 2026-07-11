// ---------------------------------------------------------------------------
// src/main/ipc/claudeActivity.ts
//
// Dashboard "Your pulse" real-activity IPC — pure passthrough to
// ../claudeActivity, same shape as ipc/claudeUsage.ts. Closes over no
// index.ts state; the module-level scan/cache/de-dup already lives in
// claudeActivity.ts, so this handler is a one-liner pair.
// ---------------------------------------------------------------------------

import { getClaudeActivity, getCachedClaudeActivity } from '../claudeActivity'
import { handle } from './handle'

export function registerClaudeActivityIpc(): void {
  handle('claude:activity', () => getClaudeActivity())
  // Dashboard D2 (stale-while-revalidate) — instant, disk-backed read that
  // never touches the filesystem scan. See claudeActivity.ts::getCachedClaudeActivity.
  handle('claude:activity:cached', () => getCachedClaudeActivity())
}
