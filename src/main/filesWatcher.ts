// ---------------------------------------------------------------------------
// src/main/filesWatcher.ts
//
// Working-tree file watcher for the Workbench Files tab. While the tab is
// open + active for a workspace, an external change (Claude editing a file, a
// terminal `touch`/build, a `git checkout`) doesn't reach the renderer today:
// the Files tab only refetches on its OWN actions (create/rename/delete),
// editor saves, and on tab-open. `src/main/git.ts`'s watcher only covers
// `.git/HEAD` + `.git/index` (branch/index changes), not working-tree file
// edits.
//
// Scope (deliberately narrow — mirrors "only the visible Files tab" in the
// brief): AT MOST ONE watcher is active at a time, keyed by workspaceId.
// Starting a new workspace's watch stops whatever was previously running —
// there is no ref-counting or multi-client fan-out like git.ts's watcher,
// because only the single visible Files tab ever calls watchStart.
//
// Pattern mirrors sessionState.ts (fs.watch + debounce + torn-handle
// tolerance + watcher.close() cleanup) and git.ts (debounced push via
// webContents.send). See both for the precedent this follows.
// ---------------------------------------------------------------------------

import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import type { WebContents } from 'electron'
import { PUSH_CHANNELS } from '../shared/ipc'

// Debounce window for coalescing bursts (a save, a `git checkout`, a build
// step can each fire many raw fs events in quick succession).
const FILES_WATCH_DEBOUNCE_MS = 200

// Reuse files.ts's denylist so `.git/` churn, node_modules, build output, etc.
// don't thrash the watcher with refresh pushes. Duplicated here (not imported
// from files.ts) to keep this module a leaf with no dependency on the IPC
// layer — see the module header in files.ts for the canonical list this
// mirrors.
const DENYLIST_DIRS = new Set(['node_modules', '.git', 'vendor', 'out', 'dist', 'build', 'target'])

type WatchEntry = {
  workspaceId: string
  cwd: string
  watcher: fs.FSWatcher
  webContents: WebContents
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// AT MOST ONE entry at a time — the single visible Files tab (see module
// header). Not a Map keyed by workspaceId; a single nullable slot makes the
// "only one active" invariant structurally obvious.
let active: WatchEntry | null = null

/**
 * True if `filename` (a path fs.watch reports, relative-ish to the watched
 * root — may be null on some platforms/events) falls under a denylisted
 * top-level-ish directory segment. Checks every path segment (not just the
 * first) so a nested denylisted dir (e.g. `packages/foo/node_modules/...`)
 * is still ignored.
 */
function isDenylistedPath(filename: string | null): boolean {
  if (!filename) return false
  const segments = filename.split(nodePath.sep).filter(Boolean)
  return segments.some((seg) => DENYLIST_DIRS.has(seg))
}

function clearDebounce(entry: WatchEntry): void {
  if (entry.debounceTimer !== null) {
    clearTimeout(entry.debounceTimer)
    entry.debounceTimer = null
  }
}

function scheduleFilesChangedPush(entry: WatchEntry): void {
  clearDebounce(entry)
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = null
    if (!entry.webContents.isDestroyed()) {
      entry.webContents.send(PUSH_CHANNELS.filesChanged, { workspaceId: entry.workspaceId })
    }
  }, FILES_WATCH_DEBOUNCE_MS)
}

/** Close the underlying fs.watch handle + clear its debounce timer. Tolerates
 *  a handle that's already closed/erroring. */
function closeEntry(entry: WatchEntry): void {
  clearDebounce(entry)
  try {
    entry.watcher.close()
  } catch {
    /* already closed — ignore */
  }
}

/**
 * Start watching `cwd`'s working tree for a workspace's Files tab. Recursive
 * macOS FSEvents-backed watch (`recursive: true` is supported on darwin).
 * Only ONE watcher is ever active — starting a new one stops any previous
 * watcher unconditionally (even for a different workspace), matching the
 * "only the visible Files tab" scope. Safe to call again for the SAME
 * workspaceId (e.g. a re-render) — it just restarts the watch.
 */
export function startFilesWatch(workspaceId: string, cwd: string, webContents: WebContents): void {
  if (!cwd) return

  // Stop whatever was previously active (different workspace OR a stale
  // instance for the same one) before starting fresh.
  stopFilesWatch()

  // `box` holds the entry this specific watcher instance closes over — the
  // fs.watch callback checks `active === box.entry` (not the bare mutable
  // `active`) so a late event from a watcher that's since been superseded (a
  // new startFilesWatch call swapped `active` to a DIFFERENT entry) can never
  // misattribute its push to the new workspace. `box` itself is a `const`
  // (satisfies prefer-const) while `box.entry` is filled in right after
  // fs.watch() returns, before any event can fire synchronously.
  const box: { entry: WatchEntry | null } = { entry: null }
  let watcher: fs.FSWatcher
  try {
    watcher = fs.watch(cwd, { recursive: true, persistent: false }, (_event, filename) => {
      // box.entry is null only in the impossible window before it's set
      // below (synchronous, before fs.watch can deliver any event) — guard
      // it anyway so the superseded-check can't pass on a double-null match.
      if (box.entry === null || active !== box.entry) return
      if (isDenylistedPath(filename)) return
      scheduleFilesChangedPush(box.entry)
    })
  } catch (err) {
    console.warn('[filesWatcher] failed to start watch for', cwd, err)
    return
  }

  const entry: WatchEntry = { workspaceId, cwd, watcher, webContents, debounceTimer: null }
  box.entry = entry
  active = entry

  watcher.on('error', (err) => {
    console.warn('[filesWatcher] fs.watch error — stopping watch:', err)
    if (active === entry) {
      closeEntry(entry)
      active = null
    }
  })
}

/**
 * Stop the active watcher. If `workspaceId` is provided, only stops when it
 * matches the currently-active watcher (a stale stopFilesWatch call from an
 * already-superseded tab is a no-op instead of tearing down the NEW watch).
 * Called with no argument to unconditionally tear down whatever is active
 * (app quit, or starting a fresh watch).
 */
export function stopFilesWatch(workspaceId?: string): void {
  if (!active) return
  if (workspaceId !== undefined && active.workspaceId !== workspaceId) return
  closeEntry(active)
  active = null
}

/** True if a watcher is currently active for this workspaceId. Test/verify hook. */
export function isWatchingFiles(workspaceId: string): boolean {
  return active?.workspaceId === workspaceId
}
