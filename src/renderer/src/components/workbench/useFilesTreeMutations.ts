// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/useFilesTreeMutations.ts
//
// Phase 4 — the disk-mutation + tree-view wiring for the Files tab tree,
// extracted from FilesTab so TreePane's own body stays under the
// cognitive-complexity ceiling. Owns:
//   - New File / New Folder: CREATE-ON-COMMIT. Nothing is written to disk when
//     the user clicks "New File"/"New Folder" — only a VIEW-ONLY placeholder
//     row (`model.add`, no disk I/O — verified against
//     node_modules/@pierre/trees/dist/model/FileTreeController.js's `add` →
//     `#store.add`) is added and the tree's inline rename UX is started on it
//     (`model.startRenaming(path, { removeIfCanceled: true })`,
//     docs/learnings/pierre-libraries.md §10.2). The placeholder path is
//     tracked in `pendingNewRef` (a "this row doesn't exist on disk yet, and
//     is either a file or a folder" map) so the eventual rename-commit knows
//     to CREATE rather than RENAME. Actual disk creation happens in
//     `handleRename` when (and only when) the user commits a real, different
//     name. Two bail paths write NOTHING to disk and leave no ghost row:
//     Escape/empty-commit is handled natively by the controller's own
//     `removeIfCanceled: true` (see `create`'s doc comment); blur-WITHOUT-
//     typing (a same-name commit, which the controller does NOT treat as
//     "empty" and for which it never calls `onRename`) is caught by the
//     reconciler effect below `create` — see its doc comment for the exact
//     mechanism (`model.subscribe` + a live DOM-focus check).
//   - Rename commit (an EXISTING file/folder): onRename → files:rename; on
//     error, revert by re-fetching.
//   - Delete: files:delete (moves to OS Trash — recoverable), then
//     model.remove(path, { recursive }).
//   - Reveal in Finder / Open in Editor / Copy Path: resolve item.path →
//     absolute (files:absolutePath) then hand to the existing shell:* IPCs.
//
// Errors are surfaced via the `onError` callback (a transient inline banner in
// FilesTab) — never silently swallowed. After any successful create/delete the
// caller's `refetch` re-reads listDir so the tier/dim map stays correct.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ContextMenuItem as FileTreeContextMenuItem, FileTreeRenameEvent } from '@pierre/trees'
import type { FilesMutationResult } from '@shared/types'
import type { FilesTreeContextMenuActions } from './FilesTreeContextMenu'

// The subset of the Pierre FileTree model this hook drives. Kept narrow so the
// hook doesn't depend on the whole (large) FileTree type surface.
//
// `subscribe` + `getItem` back the BLUR-WITHOUT-TYPING reconciler (see
// `handleRename`'s doc comment): `subscribe` is `FileTree.subscribe` (dist/
// render/FileTree.js), a bare "something changed" ping fired on every
// `FileTreeController` `#emit()` — including the no-op same-name-commit path
// that ends a rename WITHOUT calling `onRename`. `getItem` (dist/render/
// FileTree.js → `#controller.getItem`) is the one public way to ask "does
// this path still have a row" — `null` once the row's gone.
export interface TreeModel {
  add: (path: string) => void
  remove: (path: string, options?: { recursive?: boolean }) => void
  move: (fromPath: string, toPath: string) => void
  startRenaming: (path?: string, options?: { removeIfCanceled?: boolean }) => boolean
  scrollToPath: (path: string, options?: { focus?: boolean }) => void
  subscribe: (listener: () => void) => () => void
  getItem: (path: string) => unknown
}

/** A tree-view row `model.add()`ed as a New File/Folder placeholder that has
 *  NOT yet been written to disk — see the module header's CREATE-ON-COMMIT
 *  writeup. Tracked so `handleRename` can tell "this commit should CREATE a
 *  new entry" apart from "this commit should RENAME an existing one," and so
 *  the blur-without-typing reconciler (below) knows which still-present rows
 *  are placeholders eligible for cleanup.
 *
 *  `armed` guards against a startup race in that reconciler: `startRenaming`
 *  fires a synchronous `#emit()` whose OWN subscribe tick lands before React
 *  has committed the re-render that focuses the rename `<input>` (React's
 *  `useLayoutEffect` in FileTreeView.js runs after this synchronous call
 *  returns, not during it — verified by reading the emit or the input
 *  wouldn't exist yet for `isRenameInputActive()` to find). Treating that
 *  first tick as a real "renaming ended" signal would false-positive and
 *  delete the placeholder the instant it's created. `armed` starts `false`
 *  and flips to `true` on the next animation frame after `create()` calls
 *  `startRenaming` — by which point the input has definitely mounted +
 *  focused — so the reconciler ignores any pending entry until then. */
interface PendingNewEntry {
  isFolder: boolean
  armed: boolean
}

const ERROR_COPY: Record<Exclude<FilesMutationResult, { ok: true }>['error'], string> = {
  exists: 'A file or folder with that name already exists.',
  traversal: 'That path is outside the workspace.',
  denied: 'Operation failed (permission denied).',
  missing: 'That file or folder no longer exists.',
  'no-workspace': 'No workspace is available.'
}

/** Directory portion of a repo-relative path (Pierre paths: dirs carry a
 *  trailing slash, files do not). For a file → its parent dir (with trailing
 *  slash, '' for a root file); for a directory → itself; the synthetic tree-
 *  ROOT item (`path: ''`, used by the toolbar's create buttons — there's no
 *  real row for the root) stays `''`, not a stray leading `/`. */
function targetDir(item: FileTreeContextMenuItem): string {
  if (item.kind === 'directory') {
    if (item.path === '') return ''
    return item.path.endsWith('/') ? item.path : `${item.path}/`
  }
  const slash = item.path.lastIndexOf('/')
  return slash === -1 ? '' : item.path.slice(0, slash + 1)
}

/** The Nth candidate placeholder path inside `dir` (n=0 → `untitled`, n=1 →
 *  `untitled-1`, …). Pierre folder paths carry a trailing slash; files don't. */
function placeholderPath(dir: string, isFolder: boolean, n: number): string {
  const base = isFolder ? 'untitled-folder' : 'untitled'
  const name = n === 0 ? base : `${base}-${n}`
  return isFolder ? `${dir}${name}/` : `${dir}${name}`
}

/** First candidate index not already known to the view (a starting point — the
 *  create IPC still guards the actual on-disk collision with 'wx'/mkdir). */
function firstFreeIndex(dir: string, isFolder: boolean, existing: ReadonlySet<string>): number {
  for (let n = 0; n < 1000; n++) {
    if (!existing.has(placeholderPath(dir, isFolder, n))) return n
  }
  return 0
}

export interface FilesTreeMutationsDeps {
  workspaceId: string
  model: TreeModel
  /** Current known paths (for placeholder-name collision avoidance). */
  getKnownPaths: () => ReadonlySet<string>
  /** Re-read listDir after a create/delete so tiers/dims stay correct. */
  refetch: () => void
  /** Surface a human-readable error (transient banner). Cleared by the caller. */
  onError: (message: string) => void
  /** Ask the user to confirm a DIRECTORY delete (recursive → Trash). Resolves
   *  true to proceed, false to abort. Files delete without a prompt (a single
   *  trashed file is low-risk + recoverable). */
  confirmDirDelete: (item: FileTreeContextMenuItem) => Promise<boolean>
  /** Is the tree's inline rename `<input>` CURRENTLY focused? Backs the
   *  blur-without-typing reconciler (see the `create`/reconciler-effect doc
   *  comments below): Pierre's `renaming` config has no "renaming ended
   *  without a commit" callback, and `model.subscribe` fires on every
   *  keystroke too (not just the terminal transition) — so a placeholder row
   *  that's still present on a subscribe tick is ambiguous ("still being
   *  typed into" vs. "renaming just ended") UNLESS we also know whether the
   *  rename input itself still holds DOM focus. FilesTab owns the `<FileTree>`
   *  host ref (the input lives inside its shadow root — reading
   *  `hostElement.shadowRoot.activeElement` is a direct property read, not an
   *  event that has to cross the shadow boundary, so it's reliable where a
   *  bubbled `focusout` listener on the host was verified NOT to fire).
   *  Live (not a snapshot): called fresh on every reconciler tick. */
  isRenameInputActive: () => boolean
}

export interface FilesTreeMutations {
  /** Build the context-menu action callbacks for a given item + close fn. */
  buildActions: (item: FileTreeContextMenuItem, close: () => void) => FilesTreeContextMenuActions
  /** onRename handler for useFileTree({ renaming: { onRename } }). */
  handleRename: (event: FileTreeRenameEvent) => void
  /** onError handler for useFileTree({ renaming: { onError } }). */
  handleRenamingError: (message: string) => void
  /** Create a file/folder, targeting `targetPath` when given (used by the
   *  toolbar's New File / New Folder buttons, which have no right-clicked item
   *  to derive a target dir from the way the context menu does). `targetPath`
   *  should be the SELECTED item's tree path: a directory path (trailing
   *  slash) creates INSIDE it, a file path creates in its PARENT dir. Omitted
   *  (or `undefined`) falls back to the tree ROOT via a synthetic `path: ''`
   *  item — same as the prior no-selection behavior. Drives the same
   *  create→startRenaming flow as the context menu's per-row create. Purely
   *  synchronous (view-only, CREATE-ON-COMMIT — see the module header): no
   *  disk I/O happens until the user actually commits a name in
   *  `handleRename`, so there's nothing to await here anymore. */
  createAtRoot: (isFolder: boolean, targetPath?: string) => void
}

export function useFilesTreeMutations(deps: FilesTreeMutationsDeps): FilesTreeMutations {
  const {
    workspaceId,
    model,
    getKnownPaths,
    refetch,
    onError,
    confirmDirDelete,
    isRenameInputActive
  } = deps

  const surface = useCallback(
    (result: FilesMutationResult): boolean => {
      if (result.ok) return true
      onError(ERROR_COPY[result.error])
      return false
    },
    [onError]
  )

  // New-File/New-Folder placeholder rows that exist ONLY in the view (never
  // written to disk) and are still waiting on the user's first commit — see
  // the module header's CREATE-ON-COMMIT writeup. Keyed by the placeholder's
  // tree path. A ref (not state): every consumer (`handleRename`, the
  // reconciler effect below) needs the LATEST map synchronously inside
  // callbacks/subscriptions that don't themselves re-run on every mutation.
  const pendingNewRef = useRef<Map<string, PendingNewEntry>>(new Map())

  // Create (file or folder): VIEW-ONLY. Adds a placeholder row (`model.add` —
  // no disk I/O, verified against FileTreeController's `add` → `#store.add`)
  // and starts the inline rename on it so the user names it in place. NOTHING
  // is written to disk here — the actual `files:createFile`/`createDir` call
  // happens in `handleRename`, and only once the user commits a real, changed
  // name (see that function's doc comment). `removeIfCanceled: true`: since
  // there's no disk file to keep in sync, Escape/empty-commit should just
  // drop the row (the controller's own `#completeRenaming` empty-value branch
  // handles that natively — see node_modules/@pierre/trees/dist/model/
  // FileTreeController.js ~line 626). The blur-WITHOUT-typing case (same-name
  // commit — the controller does NOT treat that as "empty" and does NOT call
  // `onRename`) is caught by the reconciler effect below.
  //
  // Placeholder naming still tries a few incrementing names so a stale
  // pending/leftover `untitled` row doesn't collide in the VIEW (the eventual
  // disk create in `handleRename` is the authoritative on-disk collision
  // check via its `exists` result).
  const create = useCallback(
    (item: FileTreeContextMenuItem, isFolder: boolean): void => {
      const dir = targetDir(item)
      const start = firstFreeIndex(dir, isFolder, getKnownPaths())
      const path = placeholderPath(dir, isFolder, start)
      pendingNewRef.current.set(path, { isFolder, armed: false })
      model.add(path)
      model.scrollToPath(path, { focus: true })
      model.startRenaming(path, { removeIfCanceled: true })
      // Arm next frame — see PendingNewEntry's doc comment for why: by the
      // next animation frame React has committed the re-render that mounts +
      // focuses the rename input, so the reconciler's `isRenameInputActive()`
      // check is meaningful from here on. `pendingNewRef` (not the entry
      // object) is re-read so a fast Escape/commit that already deleted the
      // entry before this frame fires is a safe no-op.
      requestAnimationFrame(() => {
        const entry = pendingNewRef.current.get(path)
        if (entry != null) entry.armed = true
      })
    },
    [model, getKnownPaths]
  )

  // Reconciler: catches "renaming ended WITHOUT a commit" — the one
  // transition Pierre's public `renaming` config has no callback for.
  // `#completeRenaming`'s same-path branch (FileTreeController.js ~line 649 —
  // a blur that leaves the placeholder's seeded name unchanged) keeps the row
  // and does NOT call `onRename`, so `handleRename` never fires for it. It
  // DOES still `#emit()` (a bare "state changed" ping delivered via
  // `model.subscribe`, which `FileTree.subscribe` thinly wraps), so we get a
  // tick — but `#emit()` ALSO fires on every keystroke (`#setRenamingValue`),
  // so "the placeholder row is still present" alone can't tell "still being
  // typed into" apart from "renaming just ended": both look identical to
  // `getItem`. The one thing that DOES differ is DOM focus — the rename
  // `<input>` holds it throughout typing and loses it the instant renaming
  // ends (commit or cancel) — so each tick also checks `isRenameInputActive()`
  // (see that dep's doc comment for why a live shadow-DOM read, not an event
  // listener). A pending placeholder is only cleaned up here when: its `armed`
  // flag is set (see PendingNewEntry's doc comment for the startup-race this
  // guards), its row is STILL present (not already handled by the
  // controller's native `removeIfCanceled` empty-value removal, or by
  // `handleRename`'s own pending-entry consumption on a real commit), AND the
  // rename input is no longer focused anywhere — i.e. renaming has DEFINITELY
  // ended, and this placeholder's commit was a no-op (unchanged name).
  useEffect(() => {
    const unsubscribe = model.subscribe(() => {
      if (pendingNewRef.current.size === 0) return
      if (isRenameInputActive()) return // still mid-rename (typing) — not our moment.
      for (const [path, entry] of pendingNewRef.current) {
        if (!entry.armed) continue // still inside the just-created startup window.
        if (model.getItem(path) == null) {
          // Already gone (Escape/empty-commit's native removal, or
          // `handleRename` already consumed + cleared it on a real commit).
          pendingNewRef.current.delete(path)
          continue
        }
        // Rename input isn't focused anywhere, yet this placeholder's row is
        // still here and still pending — its commit left the name unchanged
        // (blur-without-typing). Drop the disk-less placeholder.
        model.remove(path)
        pendingNewRef.current.delete(path)
      }
    })
    return unsubscribe
  }, [model, isRenameInputActive])

  // Delete → OS Trash, then drop from the view. Directories confirm first
  // (recursive removal is higher-stakes, even if trash-recoverable).
  const del = useCallback(
    async (item: FileTreeContextMenuItem): Promise<void> => {
      const isDir = item.kind === 'directory'
      if (isDir && !(await confirmDirDelete(item))) return
      const diskPath = isDir && item.path.endsWith('/') ? item.path.slice(0, -1) : item.path
      const result = await window.api.files.delete(workspaceId, diskPath)
      if (!surface(result)) return
      model.remove(item.path, { recursive: isDir })
      refetch()
    },
    [workspaceId, model, refetch, surface, confirmDirDelete]
  )

  // Resolve item.path → absolute, then invoke a shell:* action with it.
  const withAbsolute = useCallback(
    async (item: FileTreeContextMenuItem, fn: (abs: string) => Promise<void>): Promise<void> => {
      const diskPath =
        item.kind === 'directory' && item.path.endsWith('/') ? item.path.slice(0, -1) : item.path
      const abs = await window.api.files.absolutePath(workspaceId, diskPath)
      if (!abs) {
        onError(ERROR_COPY.traversal)
        return
      }
      await fn(abs)
    },
    [workspaceId, onError]
  )

  const buildActions = useCallback(
    (item: FileTreeContextMenuItem, close: () => void): FilesTreeContextMenuActions => {
      // A menu action: close the menu, then run the (async) effect. `keepFocus`
      // is passed for actions that hand focus to another owned surface (rename).
      const run = (fn: () => void | Promise<void>, keepFocus = false): (() => void) => {
        return () => {
          close()
          void Promise.resolve(fn()).catch((e) => {
            console.error('[FilesTab] tree action failed:', e)
            onError('Something went wrong.')
          })
          void keepFocus
        }
      }
      return {
        onNewFile: run(() => create(item, false)),
        onNewFolder: run(() => create(item, true)),
        onRename: run(() => {
          model.startRenaming(item.path)
        }, true),
        onDelete: run(() => del(item)),
        onRevealInFinder: run(() =>
          withAbsolute(item, (abs) => window.api.shell.revealInFinder(abs))
        ),
        onOpenInEditor: run(() => withAbsolute(item, (abs) => window.api.shell.openInEditor(abs))),
        onCopyPath: run(() => withAbsolute(item, (abs) => window.api.shell.copyToClipboard(abs)))
      }
    },
    [create, del, withAbsolute, model, onError]
  )

  // Fires ONLY on a committed, CHANGED name (publicTypes.d.ts's
  // `FileTreeRenamingConfig.onRename` — the controller's same-path branch
  // returns before calling this, which is exactly why the reconciler effect
  // above exists for the unchanged-name case). Branches on whether
  // `sourcePath` is one of our own disk-less placeholders:
  //   - PENDING-NEW (`pendingNewRef` has it): this is the user's first real
  //     commit for a brand-new File/Folder — CREATE on disk at the COMMITTED
  //     name (never at the placeholder name; nothing was ever written for the
  //     placeholder). No `files:rename` call — there is nothing on disk yet
  //     to rename FROM. On success, re-tag from disk. On error (e.g. `exists`
  //     if the typed name collides with something real), remove the
  //     now-invalid placeholder row so no ghost/ambiguous row is left in the
  //     view, and surface the message. Either way, clear the pending entry —
  //     this placeholder's one commit attempt is resolved.
  //   - EXISTING entry: unchanged prior behavior — `files:rename`, revert the
  //     optimistic view move on error.
  const handleRename = useCallback(
    (event: FileTreeRenameEvent): void => {
      const { sourcePath, destinationPath, isFolder } = event
      const pending = pendingNewRef.current.get(sourcePath)
      // Strip trailing slashes for the disk IPCs (Pierre folder paths carry one).
      const to =
        isFolder && destinationPath.endsWith('/') ? destinationPath.slice(0, -1) : destinationPath

      if (pending != null) {
        pendingNewRef.current.delete(sourcePath)
        const createCall = pending.isFolder
          ? window.api.files.createDir(workspaceId, to)
          : window.api.files.createFile(workspaceId, to)
        void createCall
          .then((result) => {
            if (result.ok) {
              refetch()
              return
            }
            onError(ERROR_COPY[result.error])
            // By the time this async handler runs, the view row has already
            // moved to `destinationPath` — `#completeRenaming` calls
            // `this.move(sourcePath, destinationPath)` synchronously right
            // after invoking `onRename` (FileTreeController.js ~line 658),
            // which runs before this promise can resolve. Nothing exists on
            // disk under that name (the create failed), so remove the row
            // rather than leave a ghost that looks real.
            try {
              model.remove(destinationPath, isFolder ? { recursive: true } : undefined)
            } catch {
              // Already gone / view diverged — refetch below reconciles.
            }
            refetch()
          })
          .catch((e) => {
            console.error('[FilesTab] create-on-commit failed:', e)
            onError('Something went wrong.')
            try {
              model.remove(destinationPath, isFolder ? { recursive: true } : undefined)
            } catch {
              // Already gone / view diverged — refetch below reconciles.
            }
            refetch()
          })
        return
      }

      const from = isFolder && sourcePath.endsWith('/') ? sourcePath.slice(0, -1) : sourcePath
      void window.api.files
        .rename(workspaceId, from, to)
        .then((result) => {
          if (result.ok) {
            // The tree already applied the rename optimistically; just re-tag.
            refetch()
            return
          }
          onError(ERROR_COPY[result.error])
          // Revert the optimistic view rename, then re-sync from disk.
          try {
            model.move(destinationPath, sourcePath)
          } catch {
            // move-back can fail if the view already diverged — refetch fixes it.
          }
          refetch()
        })
        .catch((e) => {
          console.error('[FilesTab] rename failed:', e)
          onError('Rename failed.')
          refetch()
        })
    },
    [workspaceId, model, refetch, onError]
  )

  const handleRenamingError = useCallback(
    (message: string): void => {
      onError(message || 'Rename failed.')
    },
    [onError]
  )

  // Toolbar create: no right-clicked row to derive a target dir from, so the
  // caller (TreePane) passes the currently-selected item's tree path instead —
  // a directory path (trailing slash) creates INSIDE it, a file path creates
  // in its PARENT dir (both via `targetDir`'s existing item-kind branching).
  // No selection (or a path we can't classify) falls back to a synthetic root
  // directory item (`path: ''`) — `targetDir` special-cases `path: ''` to stay
  // `''` (tree root) rather than becoming a stray leading `/`.
  const createAtRoot = useCallback(
    (isFolder: boolean, targetPath?: string): void => {
      const item: FileTreeContextMenuItem =
        targetPath != null
          ? {
              kind: targetPath.endsWith('/') ? 'directory' : 'file',
              name: '',
              path: targetPath
            }
          : { kind: 'directory', name: '', path: '' }
      create(item, isFolder)
    },
    [create]
  )

  return useMemo(
    () => ({ buildActions, handleRename, handleRenamingError, createAtRoot }),
    [buildActions, handleRename, handleRenamingError, createAtRoot]
  )
}
