// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/useFilesTreeMutations.ts
//
// Phase 4 — the disk-mutation + tree-view wiring for the Files tab tree,
// extracted from FilesTab so TreePane's own body stays under the
// cognitive-complexity ceiling. Owns:
//   - New File / New Folder: create on disk with a placeholder name via the
//     files:createFile / files:createDir IPC, model.add(path) to reflect it,
//     then model.startRenaming(path) so the user names it inline using the
//     tree's built-in rename UX (docs/learnings/pierre-libraries.md §10.2).
//   - Rename commit: onRename → files:rename; on error, revert by re-fetching.
//   - Delete: files:delete (moves to OS Trash — recoverable), then
//     model.remove(path, { recursive }).
//   - Reveal in Finder / Open in Editor / Copy Path: resolve item.path →
//     absolute (files:absolutePath) then hand to the existing shell:* IPCs.
//
// Errors are surfaced via the `onError` callback (a transient inline banner in
// FilesTab) — never silently swallowed. After any successful create/delete the
// caller's `refetch` re-reads listDir so the tier/dim map stays correct.
// ---------------------------------------------------------------------------

import { useCallback, useMemo } from 'react'
import type { ContextMenuItem as FileTreeContextMenuItem, FileTreeRenameEvent } from '@pierre/trees'
import type { FilesMutationResult } from '@shared/types'
import type { FilesTreeContextMenuActions } from './FilesTreeContextMenu'

// The subset of the Pierre FileTree model this hook drives. Kept narrow so the
// hook doesn't depend on the whole (large) FileTree type surface.
export interface TreeModel {
  add: (path: string) => void
  remove: (path: string, options?: { recursive?: boolean }) => void
  move: (fromPath: string, toPath: string) => void
  startRenaming: (path?: string, options?: { removeIfCanceled?: boolean }) => boolean
  scrollToPath: (path: string, options?: { focus?: boolean }) => void
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
}

export interface FilesTreeMutations {
  /** Build the context-menu action callbacks for a given item + close fn. */
  buildActions: (item: FileTreeContextMenuItem, close: () => void) => FilesTreeContextMenuActions
  /** onRename handler for useFileTree({ renaming: { onRename } }). */
  handleRename: (event: FileTreeRenameEvent) => void
  /** onError handler for useFileTree({ renaming: { onError } }). */
  handleRenamingError: (message: string) => void
  /** Create a file/folder at the tree ROOT — used by the toolbar's New File /
   *  New Folder buttons, which have no right-clicked item to derive a target
   *  dir from (unlike the context menu's per-row create). Drives the same
   *  create→startRenaming flow via a synthetic root item (`path: ''`). */
  createAtRoot: (isFolder: boolean) => Promise<void>
}

export function useFilesTreeMutations(deps: FilesTreeMutationsDeps): FilesTreeMutations {
  const { workspaceId, model, getKnownPaths, refetch, onError, confirmDirDelete } = deps

  const surface = useCallback(
    (result: FilesMutationResult): boolean => {
      if (result.ok) return true
      onError(ERROR_COPY[result.error])
      return false
    },
    [onError]
  )

  // Create (file or folder): create a placeholder on disk, add it to the view,
  // then start the inline rename so the user names it in place. Tries a few
  // incrementing placeholder names so a leftover `untitled` from a prior
  // cancelled create (which stays on disk) doesn't block a new one — the create
  // IPC's `exists` result is the authoritative on-disk collision signal.
  const create = useCallback(
    async (item: FileTreeContextMenuItem, isFolder: boolean): Promise<void> => {
      const dir = targetDir(item)
      const start = firstFreeIndex(dir, isFolder, getKnownPaths())
      for (let n = start; n < start + 8; n++) {
        const path = placeholderPath(dir, isFolder, n)
        const diskPath = isFolder ? path.slice(0, -1) : path // IPC path has no trailing slash.
        const result = isFolder
          ? await window.api.files.createDir(workspaceId, diskPath)
          : await window.api.files.createFile(workspaceId, diskPath)
        if (result.ok) {
          // Add to the view + start the inline rename so the user names it in
          // place. We do NOT refetch here — an async resetPaths would wipe the
          // freshly-added row and cancel the in-progress rename mid-edit. The
          // eventual disk rename (handleRename → files:rename) refetches on
          // commit. `removeIfCanceled: false`: the placeholder file already
          // exists on disk, so a cancel keeps the row (tree/disk stay in sync).
          model.add(path)
          model.scrollToPath(path, { focus: true })
          model.startRenaming(path, { removeIfCanceled: false })
          return
        }
        if (result.error !== 'exists') {
          surface(result) // a real error (traversal/denied/...) — surface + stop.
          return
        }
        // 'exists' — a leftover placeholder occupies this name; try the next.
      }
      onError('Could not find a free name for the new file.')
    },
    [workspaceId, model, getKnownPaths, surface, onError]
  )

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

  const handleRename = useCallback(
    (event: FileTreeRenameEvent): void => {
      const { sourcePath, destinationPath, isFolder } = event
      // Strip trailing slashes for the disk IPC (Pierre folder paths carry one).
      const from = isFolder && sourcePath.endsWith('/') ? sourcePath.slice(0, -1) : sourcePath
      const to =
        isFolder && destinationPath.endsWith('/') ? destinationPath.slice(0, -1) : destinationPath
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

  // Toolbar create: no right-clicked row to derive a target dir from, so a
  // synthetic root directory item (`path: ''`) is handed to the same `create`
  // used by the context menu — `targetDir` special-cases `path: ''` to stay
  // `''` (tree root) rather than becoming a stray leading `/`.
  const createAtRoot = useCallback(
    (isFolder: boolean): Promise<void> =>
      create({ kind: 'directory', name: '', path: '' }, isFolder),
    [create]
  )

  return useMemo(
    () => ({ buildActions, handleRename, handleRenamingError, createAtRoot }),
    [buildActions, handleRename, handleRenamingError, createAtRoot]
  )
}
