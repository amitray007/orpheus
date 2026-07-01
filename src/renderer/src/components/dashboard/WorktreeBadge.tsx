import type React from 'react'
import { GitBranch } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'

// ---------------------------------------------------------------------------
// WorktreeBadge — shown beside the workspace name on every render surface when
// the workspace is worktree-backed (worktreeParentCwd is set). Renders nothing
// for plain workspaces. Distinct icon (GitBranch) from the fork badge (GitFork)
// and the branch-cell icon (GitMerge).
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
      <GitBranch size={size} weight="duotone" className="text-text-muted" />
    </span>
  )
}
