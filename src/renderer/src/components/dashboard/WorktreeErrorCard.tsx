import { memo } from 'react'
import type React from 'react'
import {
  ArrowsClockwise,
  FolderOpen,
  ArrowCounterClockwise,
  WarningCircle
} from '@phosphor-icons/react'

export type WorktreeErrorKind = 'checkedOutElsewhere' | 'corruptDir' | 'parentGone'

export interface WorktreeError {
  kind: WorktreeErrorKind
  message: string
  conflictPath?: string
}

interface WorktreeErrorCardProps {
  error: WorktreeError
  /** Path of the worktree parent (repo root) — used as fallback for Open location */
  worktreeParentCwd: string | null
  onRetry: () => void
  onOpenLocation: (p: string) => void
  onConvertToLocal: () => void
}

/**
 * Shown in the terminal surface area when terminal:mount returns a worktreeError.
 * Non-destructive: no action here deletes branches or directories.
 */
export const WorktreeErrorCard = memo(function WorktreeErrorCard({
  error,
  worktreeParentCwd,
  onRetry,
  onOpenLocation,
  onConvertToLocal
}: WorktreeErrorCardProps): React.JSX.Element {
  const revealPath = error.conflictPath ?? worktreeParentCwd

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-surface-base">
      <div className="w-full max-w-md mx-6 rounded-xl border border-border-default bg-surface-raised shadow-lg overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border-default">
          <WarningCircle size={18} weight="fill" className="text-amber-400 flex-shrink-0" />
          <span className="text-sm font-semibold text-text-primary">Worktree unavailable</span>
        </div>

        {/* Body */}
        <div className="px-5 py-4">
          <p className="text-sm text-text-secondary leading-relaxed">{error.message}</p>
          {error.kind === 'checkedOutElsewhere' && (
            <p className="mt-2 text-xs text-text-muted">
              Convert to local to use this workspace from the repository root instead, or check out
              a different branch in the conflicting location and retry.
            </p>
          )}
          {error.kind === 'corruptDir' && (
            <p className="mt-2 text-xs text-text-muted">
              The worktree directory is in an unrecoverable state. Retry to attempt re-creation, or
              convert to local to continue from the repository root.
            </p>
          )}
          {error.kind === 'parentGone' && (
            <p className="mt-2 text-xs text-text-muted">
              The parent repository could not be found. Convert to local to detach from the worktree
              configuration.
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="px-5 pb-5 flex flex-col gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium bg-accent text-text-on-accent hover:bg-accent-hover transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <ArrowsClockwise size={14} weight="bold" />
            Retry
          </button>

          {revealPath && (
            <button
              type="button"
              onClick={() => onOpenLocation(revealPath)}
              className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium border border-border-default bg-surface-base hover:bg-surface-overlay text-text-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <FolderOpen size={14} weight="regular" />
              Open location in Finder
            </button>
          )}

          <button
            type="button"
            onClick={onConvertToLocal}
            className="w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium border border-border-default bg-surface-base hover:bg-surface-overlay text-text-primary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            <ArrowCounterClockwise size={14} weight="regular" />
            Convert to local workspace
          </button>
        </div>
      </div>
    </div>
  )
})
