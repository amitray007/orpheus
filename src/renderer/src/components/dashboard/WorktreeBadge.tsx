import type React from 'react'
import { FolderOpen } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'

// ---------------------------------------------------------------------------
// WorktreeBadge — shown beside the workspace name on every render surface when
// the workspace is worktree-backed (worktreeParentCwd is set). Renders nothing
// for plain workspaces. Uses FolderOpen rather than GitBranch: a worktree IS a
// separate working directory, and GitBranch's line-and-node glyph at 10-11px
// is visually near-identical to the fork badge's GitFork glyph (both are
// small branch/node compositions) — the folder silhouette can't be confused
// with it. Fork badge stays GitFork.
// ---------------------------------------------------------------------------

interface WorktreeBadgeProps {
  workspace: WorkspaceRecord
  /** Icon size in px — defaults to 10 to match the adjacent GitFork badge. */
  size?: number
}

export function WorktreeBadge({
  workspace,
  size = 10
}: WorktreeBadgeProps): React.JSX.Element | null {
  if (!workspace.worktreeParentCwd) return null
  return (
    <span
      title={workspace.worktreeBranch ?? 'worktree'}
      aria-label="worktree workspace"
      className="flex-shrink-0 inline-flex items-center"
    >
      <FolderOpen size={size} weight="duotone" className="text-text-muted" />
    </span>
  )
}
