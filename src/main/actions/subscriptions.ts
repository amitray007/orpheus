// ---------------------------------------------------------------------------
// actions/subscriptions.ts — Subscription mechanism for Quick Actions
//
// For session.* actions: fs.watch on the JSONL file (or parent dir if the
// file doesn't exist yet). On file change: invalidate cache, re-query via
// the registry handler, and push the result via sendUpdate. Debounced 200ms.
//
// Subscriptions are tracked in a Map<subId, dispose>. They are automatically
// cleaned up when webContents is destroyed.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import { WebContents } from 'electron'
import { invoke } from './registry'
import { invalidateSessionCache, resolveJsonlPath } from './session'
import { getWorkspace } from '../workspaces'
import * as os from 'node:os'

// ---------------------------------------------------------------------------
// Subscription state
// ---------------------------------------------------------------------------

type SubscriptionEntry = {
  dispose: () => void
}

const subscriptions = new Map<string, SubscriptionEntry>()

// ---------------------------------------------------------------------------
// Debounce helper
// ---------------------------------------------------------------------------

function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  return (...args: T) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
}

// ---------------------------------------------------------------------------
// Session subscription — watches the JSONL file (or its parent dir until the
// file appears, then re-watches the file directly).
// ---------------------------------------------------------------------------

function startSessionSubscription(
  subId: string,
  actionId: string,
  params: Record<string, unknown>,
  workspaceId: string,
  sendUpdate: (value: unknown) => void
): () => void {
  let watcher: fs.FSWatcher | null = null
  let disposed = false

  function getParentDir(workspaceId: string): string | null {
    const ws = getWorkspace(workspaceId)
    if (!ws) return null
    const encoded = ws.cwd.replace(/\//g, '-')
    return nodePath.join(os.homedir(), '.claude', 'projects', encoded)
  }

  const fireUpdate = debounce(async () => {
    if (disposed) return
    invalidateSessionCache(workspaceId)
    try {
      const result = await invoke({ id: actionId, params, workspaceId }, 'subscription')
      if (result.ok && 'value' in result) {
        sendUpdate(result.value)
      }
    } catch (err) {
      console.error('[actions:subscriptions] update invoke failed', { subId, actionId, err })
    }
  }, 200)

  function watchFile(filePath: string): void {
    if (disposed) return
    if (watcher) {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
      watcher = null
    }

    try {
      watcher = fs.watch(filePath, { persistent: false }, (event) => {
        if (event === 'change' || event === 'rename') {
          fireUpdate()
        }
      })
      watcher.on('error', () => {
        // File may have been renamed/deleted — fall back to parent dir watch
        if (watcher) {
          try {
            watcher.close()
          } catch {
            /* ignore */
          }
          watcher = null
        }
        watchParentDir()
      })
    } catch {
      watchParentDir()
    }
  }

  function watchParentDir(): void {
    if (disposed) return
    if (watcher) {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
      watcher = null
    }

    const dir = getParentDir(workspaceId)
    if (!dir) return

    try {
      watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
        // filename is string | null per Node types; coerce to string to be safe
        // before calling .endsWith (avoids potential Buffer on some Node builds).
        const fname = filename != null ? String(filename) : null
        if (!fname?.endsWith('.jsonl')) return

        // Once the target file appears, switch to watching it directly
        const jsonlPath = resolveJsonlPath(workspaceId)
        if (jsonlPath && fs.existsSync(jsonlPath)) {
          watchFile(jsonlPath)
          fireUpdate()
        }
      })
      watcher.on('error', () => {
        /* dir may not exist yet — no-op */
      })
    } catch {
      /* dir may not exist — that's fine, we'll pick it up later */
    }
  }

  // Start watching — file first, fall back to parent dir
  const jsonlPath = resolveJsonlPath(workspaceId)
  if (jsonlPath && fs.existsSync(jsonlPath)) {
    watchFile(jsonlPath)
  } else {
    watchParentDir()
  }

  // Fire an initial update immediately so the subscriber gets the current value
  fireUpdate()

  return () => {
    disposed = true
    if (watcher) {
      try {
        watcher.close()
      } catch {
        /* ignore */
      }
      watcher = null
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startSubscription(
  subId: string,
  actionId: string,
  params: Record<string, unknown>,
  workspaceId: string,
  sendUpdate: (value: unknown) => void
): void {
  if (subscriptions.has(subId)) {
    console.warn('[actions:subscriptions] subscription already exists:', subId)
    return
  }

  let disposeInner: (() => void) | null = null

  if (actionId.startsWith('session.')) {
    disposeInner = startSessionSubscription(subId, actionId, params, workspaceId, sendUpdate)
  } else {
    // Placeholder for future non-session subscriptions
    console.log('[actions:subscriptions] no-op subscription for non-session action:', actionId)
  }

  subscriptions.set(subId, {
    dispose: () => {
      disposeInner?.()
    }
  })
}

export function stopSubscription(subId: string): void {
  const entry = subscriptions.get(subId)
  if (!entry) return
  try {
    entry.dispose()
  } catch (err) {
    console.error('[actions:subscriptions] dispose error:', { subId, err })
  }
  subscriptions.delete(subId)
}

/**
 * Register cleanup on webContents destruction so subscriptions die with the window.
 * Call once per BrowserWindow at creation time.
 */
export function registerWebContentsCleanup(webContents: WebContents): void {
  webContents.on('destroyed', () => {
    // Clean up any subscriptions that were established by this webContents.
    // Since we don't track which sub belongs to which wc, we clean all of them
    // on the only window's destruction (Orpheus is a single-window app).
    for (const [subId, entry] of subscriptions.entries()) {
      try {
        entry.dispose()
      } catch (err) {
        console.error('[actions:subscriptions] cleanup error on destroyed:', { subId, err })
      }
    }
    subscriptions.clear()
  })
}
