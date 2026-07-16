// ---------------------------------------------------------------------------
// src/main/claudeActivityPoller.ts
//
// Dashboard "Your pulse" background poller — same self-rescheduling
// setTimeout shape as usagePoller.ts, but for the real-activity transcript
// scan (src/main/claudeActivity.ts) rather than the usage/limits endpoint.
// Keeps the on-disk cache (dashboard_cache) fresh as new `.jsonl` files
// appear/grow, and pushes each scan result to the renderer so the pulse
// numbers update silently in place — no skeleton, no focus steal.
//
// getClaudeActivity() already owns the per-file mtime/size cache + inflight
// de-dup + disk persistence — this module only decides WHEN to re-scan. A
// fixed interval (not user-configurable, unlike the usage poller) is plenty:
// unlike the usage endpoint this is a local filesystem scan, not a
// rate-limited external API, and getClaudeActivity()'s per-file caching
// means a re-scan when nothing changed is nearly free (all stats, no reads).
// ---------------------------------------------------------------------------

import { BrowserWindow } from 'electron'
import { getClaudeActivity } from './claudeActivity'
import { PUSH_CHANNELS } from '../shared/ipc'
import type { ClaudeActivitySummary } from '../shared/types'

const INITIAL_DELAY_MS = 5_000
const POLL_INTERVAL_MS = 3 * 60 * 1000

function broadcast(summary: ClaudeActivitySummary): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(PUSH_CHANNELS.claudeActivityPushed, summary)
  }
}

let pollTimer: NodeJS.Timeout | null = null

async function runPoll(): Promise<void> {
  try {
    const summary = await getClaudeActivity()
    broadcast(summary)
  } catch (err) {
    // Total — never throw out of the timer callback. getClaudeActivity() is
    // itself total (never throws), so this is belt-and-braces.
    console.warn('[claudeActivityPoller] poll failed:', err)
  }
}

function scheduleNextPoll(): void {
  if (pollTimer !== null) return
  pollTimer = setTimeout(() => {
    pollTimer = null
    void runPoll().then(() => {
      scheduleNextPoll()
    })
  }, POLL_INTERVAL_MS)
}

/**
 * Start the background activity-scan poller. First scan after a short delay
 * to not compete with critical-path boot, then re-scans every
 * POLL_INTERVAL_MS thereafter.
 */
export function startClaudeActivityPoller(): void {
  pollTimer = setTimeout(() => {
    pollTimer = null
    void runPoll().then(() => {
      scheduleNextPoll()
    })
  }, INITIAL_DELAY_MS)
}

export function stopClaudeActivityPoller(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}
