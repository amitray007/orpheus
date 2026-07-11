// ---------------------------------------------------------------------------
// src/main/usagePoller.ts
//
// Dashboard D3 — background poller for the "Usage" card. Self-rescheduling
// setTimeout loop (mirrors claudeStatus.ts's shape exactly) that periodically
// calls getClaudeUsage() so the DB cache (dashboard_cache) stays fresh even
// when no renderer is actively polling, and pushes each SUCCESSFUL result to
// the renderer so the card updates silently in place — no skeleton, no focus
// steal, no manual refresh required.
//
// getClaudeUsage() already owns the TTL cache (~3min) + inflight de-dup +
// disk persistence (src/main/claudeUsage.ts) — this module only decides WHEN
// to call it, driven by the user-configurable usagePollIntervalSec setting.
// On failure/unavailable we deliberately do NOT push — the renderer keeps
// showing its last-good cached data rather than flashing an error state.
// ---------------------------------------------------------------------------

import { BrowserWindow } from 'electron'
import { getAppUiState } from './uiState'
import { getClaudeUsage } from './claudeUsage'
import { PUSH_CHANNELS } from '../shared/ipc'
import { UI_STATE_DEFAULTS, VALID_USAGE_POLL_INTERVALS_SEC } from '../shared/uiStateDefaults'
import type { ClaudeUsage } from '../shared/types'

const DEFAULT_INTERVAL_SEC = UI_STATE_DEFAULTS.usagePollIntervalSec
const INITIAL_DELAY_MS = 5_000

function validateIntervalSec(sec: number | undefined): number {
  if (!sec) return DEFAULT_INTERVAL_SEC
  return VALID_USAGE_POLL_INTERVALS_SEC.includes(sec) ? sec : DEFAULT_INTERVAL_SEC
}

function getPollIntervalMs(): number {
  try {
    const state = getAppUiState()
    return validateIntervalSec(state.usagePollIntervalSec) * 1_000
  } catch {
    return DEFAULT_INTERVAL_SEC * 1_000
  }
}

function broadcast(usage: ClaudeUsage): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(PUSH_CHANNELS.claudeUsagePushed, usage)
  }
}

let pollTimer: NodeJS.Timeout | null = null

async function runPoll(): Promise<void> {
  try {
    const result = await getClaudeUsage()
    // getClaudeUsage() already persisted the cache on success; only push a
    // successful, non-unavailable result — failures leave the renderer on
    // its last-good cached value rather than flashing an error state.
    if (!('unavailable' in result)) {
      broadcast(result)
    }
  } catch (err) {
    // Total — never throw out of the timer callback. getClaudeUsage() is
    // itself total (never throws), so this is belt-and-braces.
    console.warn('[usagePoller] poll failed:', err)
  }
}

function scheduleNextPoll(): void {
  if (pollTimer !== null) return
  const delay = getPollIntervalMs()
  pollTimer = setTimeout(() => {
    pollTimer = null
    void runPoll().then(() => {
      scheduleNextPoll()
    })
  }, delay)
}

/**
 * Start the background usage poller. First fetch after a short delay to not
 * compete with critical-path boot, then self-reschedules using the
 * (validated) user-configured interval on every subsequent tick — a settings
 * change takes effect on the next tick with no restart needed.
 */
export function startUsagePoller(): void {
  pollTimer = setTimeout(() => {
    pollTimer = null
    void runPoll().then(() => {
      scheduleNextPoll()
    })
  }, INITIAL_DELAY_MS)
}

export function stopUsagePoller(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}
