/**
 * Per-key external git-status store — eliminates full-tree re-renders on every
 * git status update. Each leaf subscribes to its own workspace key; unrelated
 * keys fire no re-render in that component.
 *
 * API:
 *   setGitStatus(workspaceId, status)   — set a single key (no-op on identity or shallow-field match)
 *   deleteGitStatus(workspaceId)        — remove a key (e.g. on archive)
 *   useGitStatus(workspaceId)           — hook: subscribe to ONE key only
 */

import type { GitStatus } from '@shared/types'
import { createPerKeyStore } from './createPerKeyStore'

// Shallow-field equality — prevents spurious subscriber notifications when
// IPC returns a structurally identical status object (new object reference,
// same content). Matches the original field list exactly.
const store = createPerKeyStore<GitStatus | null>({
  equals: (prev, next) =>
    prev != null &&
    next != null &&
    prev.branch === next.branch &&
    prev.insertions === next.insertions &&
    prev.deletions === next.deletions &&
    prev.hasChanges === next.hasChanges &&
    prev.newFiles === next.newFiles &&
    prev.modifiedFiles === next.modifiedFiles &&
    prev.deletedFiles === next.deletedFiles
})

/** Update a single workspace's git status.
 *  No-op on identity match OR when all meaningful fields are equal — prevents
 *  spurious subscriber notifications when IPC returns a structurally identical
 *  status object (new object reference, same content). */
export function setGitStatus(workspaceId: string, status: GitStatus | null): void {
  store.set(workspaceId, status)
}

/** Remove a workspace's git status entry (e.g. on archive). */
export function deleteGitStatus(workspaceId: string): void {
  store.remove(workspaceId)
}

/**
 * Subscribe to a single workspace's git status.
 * Components calling this re-render ONLY when that specific key changes,
 * not when any other workspace's git status changes.
 */
export function useGitStatus(workspaceId: string): GitStatus | null {
  return store.useKey(workspaceId) ?? null
}
