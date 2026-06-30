// ---------------------------------------------------------------------------
// actions/subscriptions.ts — Subscription mechanism for Quick Actions
//
// For session.* actions: fs.watch on the JSONL file (or parent dir if the
// file doesn't exist yet). On file change: invalidate cache, re-query via
// the registry handler, and push the result via sendUpdate. Throttled 1500ms
// (leading + trailing) so the token-counter/context-chip responds immediately
// on the first event but avoids hammering the main process during streaming.
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
import { encodePathToClaudeDir } from '../claudeProjectDir'
import * as os from 'node:os'

// ---------------------------------------------------------------------------
// Subscription state
// ---------------------------------------------------------------------------

type SubscriptionEntry = {
  dispose: () => void
}

const subscriptions = new Map<string, SubscriptionEntry>()

// ---------------------------------------------------------------------------
// Leading+trailing throttle helper
// ---------------------------------------------------------------------------

// Interval for the leading+trailing throttle applied to file-change events.
const SUBSCRIPTION_DEBOUNCE_MS = 1500

/**
 * Returns a throttled version of `fn` that fires immediately on the first
 * call within a quiet window (leading edge) and again after the window
 * expires if any further calls arrived during it (trailing edge).
 */
function throttleLeadingTrailing<T extends unknown[]>(
  fn: (...args: T) => void,
  ms: number
): (...args: T) => void {
  let lastFiredAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let pendingArgs: T | null = null
  return (...args: T) => {
    const now = Date.now()
    if (now - lastFiredAt >= ms) {
      // Leading edge: fire immediately.
      lastFiredAt = now
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
        pendingArgs = null
      }
      fn(...args)
    } else {
      // Within the quiet window — schedule/reset the trailing fire.
      pendingArgs = args
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(
        () => {
          timer = null
          lastFiredAt = Date.now()
          const a = pendingArgs!
          pendingArgs = null
          fn(...a)
        },
        ms - (now - lastFiredAt)
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Ref-counted shared watcher registry
//
// Multiple mounted workspaces watching the same ~/.claude/projects/<cwd>/
// directory used to create N independent fs.watch instances that all wake on
// every write to any file in that dir. This registry collapses N → 1 per
// directory: the first subscriber opens the watcher; subsequent ones
// increment the refCount and register their callback. The watcher is closed
// only when the last subscriber disposes.
// ---------------------------------------------------------------------------

type SharedWatcherEntry = {
  watcher: fs.FSWatcher | null
  refCount: number
  callbacks: Set<(event: fs.WatchEventType, filename: string | null) => void>
}

const sharedWatchers = new Map<string, SharedWatcherEntry>()

function acquireSharedWatcher(
  dir: string,
  cb: (event: fs.WatchEventType, filename: string | null) => void
): () => void {
  let entry = sharedWatchers.get(dir)
  if (!entry) {
    entry = { watcher: null, refCount: 0, callbacks: new Set() }
    sharedWatchers.set(dir, entry)
    try {
      entry.watcher = fs.watch(dir, { persistent: false }, (event, filename) => {
        const e = sharedWatchers.get(dir)
        if (!e) return
        for (const fn of e.callbacks) {
          try {
            fn(event, filename)
          } catch {
            /* ignore */
          }
        }
      })
      entry.watcher.on('error', () => {
        /* dir may be temporarily unavailable — no-op */
      })
    } catch {
      /* dir may not exist yet — callbacks will never fire, that's fine */
    }
  }

  entry.refCount++
  entry.callbacks.add(cb)

  let released = false
  return () => {
    if (released) return
    released = true
    const e = sharedWatchers.get(dir)
    if (!e) return
    e.callbacks.delete(cb)
    e.refCount--
    if (e.refCount <= 0) {
      if (e.watcher) {
        try {
          e.watcher.close()
        } catch {
          /* ignore */
        }
        e.watcher = null
      }
      sharedWatchers.delete(dir)
    }
  }
}

// ---------------------------------------------------------------------------
// Session subscription — watches the JSONL file (or its parent dir until the
// file appears, then re-watches the file directly). Uses acquireSharedWatcher
// for the parent-dir watch so N workspaces in the same project share one
// fs.watch handle instead of N.
// ---------------------------------------------------------------------------

function startSessionSubscription(
  subId: string,
  actionId: string,
  params: Record<string, unknown>,
  workspaceId: string,
  sendUpdate: (value: unknown) => void
): () => void {
  // Track the per-file watcher (for the JSONL file itself) and the shared
  // parent-dir release fn separately so we can cleanly swap between them.
  let fileWatcher: fs.FSWatcher | null = null
  let releaseParentWatcher: (() => void) | null = null
  let disposed = false

  function getParentDir(wid: string): string | null {
    const ws = getWorkspace(wid)
    if (!ws) return null
    const encoded = encodePathToClaudeDir(ws.cwd)
    return nodePath.join(os.homedir(), '.claude', 'projects', encoded)
  }

  const fireUpdate = throttleLeadingTrailing(async () => {
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
  }, SUBSCRIPTION_DEBOUNCE_MS)

  function stopFileWatcher(): void {
    if (fileWatcher) {
      try {
        fileWatcher.close()
      } catch {
        /* ignore */
      }
      fileWatcher = null
    }
  }

  function stopParentWatcher(): void {
    if (releaseParentWatcher) {
      releaseParentWatcher()
      releaseParentWatcher = null
    }
  }

  function watchFile(filePath: string): void {
    if (disposed) return
    stopFileWatcher()
    stopParentWatcher()

    try {
      fileWatcher = fs.watch(filePath, { persistent: false }, (event) => {
        if (event === 'change' || event === 'rename') {
          fireUpdate()
        }
      })
      fileWatcher.on('error', () => {
        // File may have been renamed/deleted — fall back to parent dir watch
        stopFileWatcher()
        watchParentDir()
      })
    } catch {
      watchParentDir()
    }
  }

  function watchParentDir(): void {
    if (disposed) return
    stopFileWatcher()
    stopParentWatcher()

    const dir = getParentDir(workspaceId)
    if (!dir) return

    releaseParentWatcher = acquireSharedWatcher(dir, (_event, filename) => {
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
  }

  // Start watching — file first, fall back to parent dir
  const jsonlPath = resolveJsonlPath(workspaceId)
  if (jsonlPath && fs.existsSync(jsonlPath)) {
    watchFile(jsonlPath)
  } else {
    watchParentDir()
  }

  // Schedule the first update — fireUpdate is throttled (leading+trailing,
  // SUBSCRIPTION_DEBOUNCE_MS). The leading edge fires immediately so new
  // subscribers see an initial value right away. We still go through the
  // throttle rather than calling invoke() directly here to avoid hot-looping
  // when callers re-subscribe rapidly (component remounts).
  fireUpdate()

  return () => {
    disposed = true
    stopFileWatcher()
    stopParentWatcher()
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
