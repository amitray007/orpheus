import type React from 'react'
import { GitPullRequest, GitMerge, Check, X, CircleNotch } from '@phosphor-icons/react'
import type { GhPullRequest, GhPullRequestState } from '@shared/types'

// ---------------------------------------------------------------------------
// PrChip — single source of truth for how an open / draft / merged / closed
// PR renders across the sidebar, kanban card, and workspace title bar. Icon
// + color always match GitHub's own state vocabulary (Primer palette) so the
// chip reads identically to a github.com header.
// ---------------------------------------------------------------------------

const STATE_COLOR: Record<GhPullRequestState, string> = {
  open: 'text-gh-open',
  draft: 'text-gh-draft',
  merged: 'text-gh-merged',
  closed: 'text-gh-closed'
}

const STATE_LABEL: Record<GhPullRequestState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}

function StateIcon({
  state,
  size
}: {
  state: GhPullRequestState
  size: number
}): React.JSX.Element {
  // GitMerge for merged, GitPullRequest for everything else — same as
  // github.com's own PR header glyphs.
  if (state === 'merged') return <GitMerge size={size} weight="fill" />
  // Drafts: regular weight + gray reads as the disabled/open-but-not-ready state.
  return <GitPullRequest size={size} weight={state === 'draft' ? 'regular' : 'fill'} />
}

function CheckIcon({
  checks,
  size
}: {
  checks: GhPullRequest['checks']
  size: number
}): React.JSX.Element | null {
  if (checks === 'success') return <Check size={size} weight="bold" className="text-gh-open" />
  if (checks === 'failure') return <X size={size} weight="bold" className="text-gh-closed" />
  if (checks === 'pending')
    return <CircleNotch size={size} weight="bold" className="text-gh-draft animate-spin" />
  return null
}

function buildTooltip(pr: GhPullRequest): string {
  const parts: string[] = [`PR #${pr.number}`, STATE_LABEL[pr.state]]
  if (pr.title) parts.push(`— ${pr.title}`)
  if (pr.reviewDecision === 'approved') parts.push('· approved')
  else if (pr.reviewDecision === 'changes_requested') parts.push('· changes requested')
  else if (pr.reviewDecision === 'review_required') parts.push('· review required')
  if (pr.checks === 'success') parts.push('· checks passing')
  else if (pr.checks === 'failure') parts.push('· checks failing')
  else if (pr.checks === 'pending') parts.push('· checks running')
  return parts.join(' ')
}

function openInBrowser(url: string): void {
  // Electron's window.open routes through the shell.openExternal handler we
  // already register for external links; falling back to plain window.open is
  // fine in the renderer.
  window.open(url, '_blank', 'noopener,noreferrer')
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export interface PrChipProps {
  pr: GhPullRequest
  /** icon-only is the tight prefix variant (sidebar). chip is the labelled
   *  variant used on the kanban card and workspace title bar. */
  variant?: 'icon' | 'chip'
  /** Render the chip as a button that opens the PR in the user's browser.
   *  Set to false when the row already owns the click handler. */
  clickable?: boolean
}

export function PrChip({ pr, variant = 'chip', clickable = true }: PrChipProps): React.JSX.Element {
  const tooltip = buildTooltip(pr)
  const stateColor = STATE_COLOR[pr.state]

  const content =
    variant === 'icon' ? (
      // Match ActivityIndicator's container shape (w-3 + flex-centered +
      // leading-none) so the chip and the activity dot share the same visual
      // baseline. SVG sized at 11 so its visual footprint matches the small
      // text glyph (`●`) the activity indicator uses; otherwise the SVG fills
      // edge-to-edge and reads as visually higher than the dot.
      <span
        className={`inline-flex items-center justify-center flex-shrink-0 leading-none w-3 h-3 ${stateColor}`}
        title={tooltip}
      >
        <StateIcon state={pr.state} size={11} />
      </span>
    ) : (
      <span
        className="inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded bg-surface-overlay/50 border border-border-default/40"
        title={tooltip}
      >
        <span className={`inline-flex items-center ${stateColor}`}>
          <StateIcon state={pr.state} size={12} />
        </span>
        <span className={`${stateColor}`}>#{pr.number}</span>
        <CheckIcon checks={pr.checks} size={11} />
      </span>
    )

  if (!clickable) return content

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        openInBrowser(pr.url)
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="inline-flex items-center rounded hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 cursor-pointer"
      aria-label={tooltip}
    >
      {content}
    </button>
  )
}
