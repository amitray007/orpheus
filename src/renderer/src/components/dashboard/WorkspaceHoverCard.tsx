import type React from 'react'
import { GitBranch, Files } from '@phosphor-icons/react'
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
  const activityLabel =
    activity && activity !== 'archived' ? (ACTIVITY_LABEL[activity] ?? activity) : null

  const fileSummaryParts: string[] = []
  if (gitStatus) {
    if (gitStatus.newFiles > 0) fileSummaryParts.push(`${gitStatus.newFiles} new`)
    if (gitStatus.modifiedFiles > 0) fileSummaryParts.push(`${gitStatus.modifiedFiles} modified`)
    if (gitStatus.deletedFiles > 0) fileSummaryParts.push(`${gitStatus.deletedFiles} deleted`)
  }
  const fileSummary = fileSummaryParts.join(' · ')
  const hasLineChanges = gitStatus !== null && (gitStatus.insertions > 0 || gitStatus.deletions > 0)

  return (
    <div className="w-64 bg-surface-overlay border border-white/10 rounded-lg shadow-lg text-xs z-50 pointer-events-auto overflow-hidden">
      {/* Header: title + status line */}
      <div className="p-3">
        <div className="text-text-primary font-medium truncate" title={title}>
          {title}
        </div>
        <div className="flex items-center gap-1.5 mt-1 text-text-secondary">
          {activityLabel !== null && activity && activity !== 'archived' && (
            <ActivityIndicator detail={activity} />
          )}
          <span>
            {activityLabel ?? 'idle'}
            {relativeTime ? ` · active ${relativeTime} ago` : ''}
          </span>
        </div>
      </div>

      {/* Git block */}
      {gitStatus !== null && (
        <>
          <div className="border-t border-white/10" />
          <div className="p-3 space-y-1.5">
            {/* Branch row */}
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
            {/* Change summary row */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Files size={12} className="text-text-muted flex-shrink-0" />
                <span className="text-text-secondary truncate">
                  {fileSummary || (!hasLineChanges ? 'No changes' : '')}
                </span>
              </div>
              {hasLineChanges && (
                <div className="flex items-center gap-1 font-mono text-[11px] flex-shrink-0">
                  {gitStatus.insertions > 0 && (
                    <span className="text-emerald-400">+{gitStatus.insertions}</span>
                  )}
                  {gitStatus.deletions > 0 && (
                    <span className="text-red-400">−{gitStatus.deletions}</span>
                  )}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* PR row */}
      {pr && (
        <>
          <div className="border-t border-white/10" />
          <div className="p-3">
            <PrChip pr={pr} variant="chip" clickable={true} />
          </div>
        </>
      )}

      {/* cwd footer */}
      <div className="border-t border-white/10" />
      <div className="p-3 text-text-muted text-[11px] break-all" title={cwd}>
        {cwd}
      </div>
    </div>
  )
}
