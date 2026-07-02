import type React from 'react'
import {
  GitBranch,
  Files,
  GitPullRequest,
  GitMerge,
  Check,
  X,
  CircleNotch
} from '@phosphor-icons/react'
import type { HoverCardProps } from '@shared/types'
import { ActivityIndicator } from '../../components/dashboard/ActivityIndicator'
import { openPrUrl } from '../../lib/overlayClient'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// HoverCard — sidebar workspace hover popover. Information hierarchy: title
// + status line, git branch/changes rows, PR chip, cwd — using the app's own
// design tokens (Tailwind v4). Width target ~224px.
// ---------------------------------------------------------------------------

function PrRow({ pr }: { pr: NonNullable<HoverCardProps['pr']> }): React.JSX.Element {
  const stateColor =
    pr.state === 'merged'
      ? 'text-gh-merged'
      : pr.state === 'closed'
        ? 'text-gh-closed'
        : pr.state === 'draft'
          ? 'text-gh-draft'
          : 'text-gh-open'
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        if (pr.url) openPrUrl(pr.url)
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded bg-surface-overlay/50 border border-border-default/40 hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
    >
      <span className={`inline-flex items-center ${stateColor}`}>
        {pr.state === 'merged' ? (
          <GitMerge size={12} weight="fill" />
        ) : (
          <GitPullRequest size={12} weight={pr.state === 'draft' ? 'regular' : 'fill'} />
        )}
      </span>
      <span className={stateColor}>#{pr.number}</span>
      {pr.check === 'ok' && <Check size={11} weight="bold" className="text-gh-open" />}
      {pr.check === 'fail' && <X size={11} weight="bold" className="text-gh-closed" />}
      {pr.check === 'pending' && (
        <CircleNotch size={11} weight="bold" className="text-gh-draft animate-spin" />
      )}
    </button>
  )
}

export function HoverCard({ props }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as HoverCardProps
  const { title, activityLabel, activityState, relativeTime, git, pr, cwd } = data

  const statusText =
    relativeTime === 'now'
      ? `${activityLabel} · active now`
      : relativeTime
        ? `${activityLabel} · active ${relativeTime} ago`
        : activityLabel

  return (
    <div className="w-max max-w-[224px] rounded-lg border border-border-default bg-surface-raised shadow-lg font-[family-name:var(--font-sans)] overflow-hidden">
      {/* Header */}
      <div className="px-2.5 py-2.5">
        <p className="text-xs font-medium text-text-primary truncate">{title || 'Workspace'}</p>
        <div className="mt-0.5 flex items-center gap-1.5 min-w-0">
          <ActivityIndicator detail={activityState} animated={false} />
          <span className="text-xs text-text-secondary truncate">{statusText}</span>
        </div>
      </div>

      {git && (
        <>
          <div className="h-px bg-border-default/60" />
          <div className="px-2.5 py-2.5 flex flex-col gap-1">
            <div className="flex items-center gap-1.5 text-xs">
              <GitBranch size={12} className="text-text-muted flex-shrink-0" />
              <span
                className={
                  git.detached ? 'italic text-text-muted truncate' : 'text-text-secondary truncate'
                }
              >
                {git.branch || '(unknown)'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <Files size={12} className="text-text-muted flex-shrink-0" />
              <span className="text-text-secondary truncate flex-1">{git.summary}</span>
              {(git.insertions > 0 || git.deletions > 0) && (
                <span className="font-mono text-[11px] flex-shrink-0">
                  {git.insertions > 0 && (
                    <span className="text-emerald-400">+{git.insertions}</span>
                  )}
                  {git.insertions > 0 && git.deletions > 0 && ' '}
                  {git.deletions > 0 && <span className="text-red-400">−{git.deletions}</span>}
                </span>
              )}
            </div>
          </div>
        </>
      )}

      {pr && (
        <>
          <div className="h-px bg-border-default/60" />
          <div className="px-2.5 py-2.5">
            <PrRow pr={pr} />
          </div>
        </>
      )}

      {cwd && (
        <>
          <div className="h-px bg-border-default/60" />
          <div className="px-2.5 py-2.5">
            <p className="text-[11px] text-text-muted leading-snug break-all">{cwd}</p>
          </div>
        </>
      )}
    </div>
  )
}
