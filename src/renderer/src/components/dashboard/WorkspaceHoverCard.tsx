import type React from 'react'
import { GitBranch } from '@phosphor-icons/react'
import type { GitStatus, GhPullRequest, WorkspaceActivityDetail } from '@shared/types'
import { ActivityIndicator } from './ActivityIndicator'
import { PrChip } from '../github/PrChip'

interface WorkspaceHoverCardProps {
  title: string
  activity: WorkspaceActivityDetail | undefined
  relativeTime: string
  gitStatus: GitStatus | null
  pr: GhPullRequest | null
  cwd: string
}

const ACTIVITY_LABEL: Partial<Record<WorkspaceActivityDetail, string>> = {
  thinking: 'thinking',
  tool: 'running tool',
  compacting: 'compacting',
  asking: 'awaiting input',
  ready: 'ready',
  idle: 'idle',
  attention: 'needs attention'
}

export function WorkspaceHoverCard({
  title,
  activity,
  relativeTime,
  gitStatus,
  pr,
  cwd
}: WorkspaceHoverCardProps): React.JSX.Element {
  const hasDetail = gitStatus !== null || pr !== null
  const activityLabel =
    activity && activity !== 'archived' ? (ACTIVITY_LABEL[activity] ?? activity) : null

  return (
    <div className="w-64 bg-surface-overlay border border-white/10 rounded-lg shadow-lg p-3 text-xs space-y-2 z-50">
      <div className="text-text-primary font-medium truncate" title={title}>
        {title}
      </div>
      {activityLabel !== null ? (
        <div className="flex items-center gap-1.5 text-text-secondary">
          {activity && activity !== 'archived' && <ActivityIndicator detail={activity} />}
          <span>
            {activityLabel}
            {relativeTime ? ` · ${relativeTime} ago` : ''}
          </span>
        </div>
      ) : (
        <div className="text-text-muted">
          {relativeTime ? `active ${relativeTime} ago` : 'no recent activity'}
        </div>
      )}
      {hasDetail && <div className="border-t border-white/10" />}
      {gitStatus !== null && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <GitBranch size={12} className="text-text-muted flex-shrink-0" />
            <span
              className={
                gitStatus.branch === null ? 'italic text-text-muted' : 'text-text-secondary'
              }
            >
              {gitStatus.branch ?? 'detached'}
            </span>
          </div>
          {(gitStatus.insertions > 0 || gitStatus.deletions > 0) && (
            <div className="flex items-center gap-2 font-mono text-[11px]">
              {gitStatus.insertions > 0 && (
                <span className="text-emerald-400">+{gitStatus.insertions}</span>
              )}
              {gitStatus.deletions > 0 && (
                <span className="text-red-400">−{gitStatus.deletions}</span>
              )}
            </div>
          )}
        </div>
      )}
      {pr && (
        <div className="flex items-center gap-1.5">
          <PrChip pr={pr} variant="chip" clickable={true} />
        </div>
      )}
      <div className="border-t border-white/10" />
      <div className="text-text-muted text-[11px] break-all" title={cwd}>
        {cwd}
      </div>
    </div>
  )
}
