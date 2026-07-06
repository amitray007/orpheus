// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/ChecksTab.tsx
//
// Git tab — Checks sub-tab (PHASE 3e). Renders the current PR's un-reduced
// per-check list (`prDetail.checks: GhCheck[]`, src/shared/types.ts) — the
// individual CI/action runs behind the aggregate rollup badge shown
// elsewhere (PrChip's 3-state `pr.checks`). Matches
// docs/brainstorms/git-tab-mockup's Checks tab (`renderChecksTab` in its
// script.js, `.checks-summary`/`.check-row`/`.check-icon` in its styles.css):
// a summary line ("N passed · M failing · K pending") followed by a flat
// list of check rows (state icon + name), reordered so FAILING checks
// surface first (most actionable), then pending, then passed — the mockup
// itself doesn't reorder (fixture data happens to lead with its one failing
// check), but the task explicitly calls out "failing-visible" as the goal,
// so this pass buckets by state rather than relying on source order.
//
// Colors: same diff-status green/red/amber hexes GitTab's own
// TREE_GIT_STATUS_VARS / FilesTab's tree overrides already use for git
// status (#3fb950/#f85149/#d29922) — NOT the `--color-gh-*` PR-state palette
// (that's GitHub's open/draft/merged/closed vocabulary, a different
// semantic axis from pass/fail/pending). Applied as Tailwind arbitrary-value
// classes since these hexes have never been promoted to named tokens
// anywhere in the app (they only exist as literal CSS custom-property
// values today — see FilesTab.tsx/GitTab.tsx).
//
// Rows with a `url` are clickable — opens the check's run page in the
// browser via the same `openPrUrl` helper (overlayClient.ts) GitTab's own PR
// title link uses, rather than re-deriving a second window.open wrapper.
// Rows without a url (rare — some check providers omit detailsUrl) render as
// plain inert rows.
//
// Empty states: `prDetail === null` (no PR, or mid-refetch) → a neutral
// "No checks" placeholder, matching CommitsTab/DetailsTab's own
// prDetail-null convention. `prDetail !== null && checks.length === 0` (a PR
// with no CI configured at all) → "No status checks configured" — distinct
// copy so it doesn't read as "still loading" or "no PR".
// ---------------------------------------------------------------------------

import type React from 'react'
import { Check, X, CircleNotch, Clock } from '@phosphor-icons/react'
import type { GhCheck, GhCheckState, GhPullRequestDetail } from '@shared/types'

export interface ChecksTabProps {
  /** The current branch's PR detail, or null when there's no PR for this
   *  branch (no `gh` / no remote / detached HEAD / not-yet-pushed) — this
   *  sub-tab is only reachable while a PR exists, but stays nullable to
   *  match CommitsTab/DetailsTab's shared signature. */
  prDetail: GhPullRequestDetail | null
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process, same as GitTab's own `workspaceId` prop. Unused by this
   *  tab's own rendering (checks are entirely `prDetail`-sourced, no
   *  workspace-scoped IPC of its own) but kept in the signature to match the
   *  shared CommitsTab/DetailsTab prop shape GitTab feeds all three tabs. */
  workspaceId: string
  /** The current branch name — likewise unused by this tab's rendering
   *  (checks are a PR-scoped, not branch-scoped, concept) but kept for the
   *  same shared-signature reason as `workspaceId` above. */
  branch: string | null
}

// Diff-status palette (see module header) — literal hexes rather than named
// tokens, matching how FilesTab.tsx/GitTab.tsx already use these same values.
const STATE_ICON_CLASS: Record<GhCheckState, string> = {
  success: 'text-[#3fb950]',
  failure: 'text-[#f85149]',
  pending: 'text-[#d29922]',
  neutral: 'text-text-muted'
}

/** One check's state glyph — Check/X/CircleNotch(spinning)/Clock, colored
 *  per STATE_ICON_CLASS. `pending` spins (mirrors PrChip's own CheckIcon
 *  convention for its aggregate rollup) since a still-running check is an
 *  active, not static, state; `neutral` (e.g. a skipped/cancelled run) gets
 *  a static clock rather than a spinner. */
function CheckStateIcon({ state }: { state: GhCheckState }): React.JSX.Element {
  const className = STATE_ICON_CLASS[state]
  if (state === 'success') return <Check size={13} weight="bold" className={className} />
  if (state === 'failure') return <X size={13} weight="bold" className={className} />
  if (state === 'pending') {
    return <CircleNotch size={13} weight="bold" className={`${className} animate-spin`} />
  }
  return <Clock size={13} weight="bold" className={className} />
}

/** Overall summary icon — green check only when every check passed, red X
 *  when any failed (failures dominate the headline regardless of how many
 *  passed), amber spinner while anything is still pending/neutral. */
function SummaryIcon({ counts }: { counts: Record<GhCheckState, number> }): React.JSX.Element {
  if (counts.failure > 0) return <X size={14} weight="bold" className="text-[#f85149]" />
  if (counts.pending > 0 || counts.neutral > 0) {
    return <CircleNotch size={14} weight="bold" className="text-[#d29922] animate-spin" />
  }
  return <Check size={14} weight="bold" className="text-[#3fb950]" />
}

function countByState(checks: readonly GhCheck[]): Record<GhCheckState, number> {
  const counts: Record<GhCheckState, number> = { success: 0, failure: 0, pending: 0, neutral: 0 }
  for (const c of checks) counts[c.state] += 1
  return counts
}

/** "N passed · M failing · K pending" — only the non-zero counts are shown
 *  (mirrors the mockup's own "1 check failing / 7 passed" style, which
 *  likewise omits a zero pending count), joined with the app's standard
 *  " · " separator. Falls back to "No checks configured" text is handled by
 *  the caller (empty-list short-circuit) — this always has >=1 check by the
 *  time it's called. */
function summaryText(counts: Record<GhCheckState, number>): string {
  const parts: string[] = []
  if (counts.failure > 0) parts.push(`${counts.failure} failing`)
  if (counts.success > 0) parts.push(`${counts.success} passed`)
  if (counts.pending > 0) parts.push(`${counts.pending} pending`)
  if (counts.neutral > 0) parts.push(`${counts.neutral} neutral`)
  return parts.join(' · ')
}

function ChecksSummary({ checks }: { checks: readonly GhCheck[] }): React.JSX.Element {
  const counts = countByState(checks)
  return (
    <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border-default flex-shrink-0">
      <SummaryIcon counts={counts} />
      <span className="text-[12.5px] font-medium text-text-secondary">{summaryText(counts)}</span>
    </div>
  )
}

/** Buckets checks failing-first (most actionable), then pending/neutral
 *  (still in flight), then passed last — see module header. Stable within
 *  each bucket (Array.prototype.sort is stable; ties keep source order). */
function orderChecks(checks: readonly GhCheck[]): GhCheck[] {
  const rank: Record<GhCheckState, number> = { failure: 0, pending: 1, neutral: 1, success: 2 }
  return [...checks].sort((a, b) => rank[a.state] - rank[b.state])
}

function openCheckUrl(url: string): void {
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    // no-op — same best-effort convention as overlayClient.ts's openPrUrl
  }
}

function CheckRow({ check }: { check: GhCheck }): React.JSX.Element {
  // Guard against an empty-string url, not just null: the main-process
  // normalizer (github.ts's parseChecks) falls back detailsUrl ?? targetUrl
  // ?? null, and a legacy StatusContext check (e.g. a third-party status
  // check like CodeRabbit's) can have `targetUrl: ""` rather than an absent
  // field — that resolves to `url: ''`, which is non-null but not a real
  // link to open.
  const clickable = check.url !== null && check.url !== ''
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => openCheckUrl(check.url as string) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                openCheckUrl(check.url as string)
              }
            }
          : undefined
      }
      title={clickable ? 'Open run in browser' : undefined}
      className={[
        'flex items-center gap-2 px-3.5 py-1.5 text-[12px]',
        clickable
          ? 'cursor-pointer hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
          : ''
      ].join(' ')}
    >
      <span className="flex-shrink-0 inline-flex items-center justify-center w-3.5 h-3.5">
        <CheckStateIcon state={check.state} />
      </span>
      <span className="flex-1 min-w-0 truncate text-text-primary">{check.name}</span>
      {check.workflowName !== null && (
        <span className="flex-shrink-0 text-text-muted text-[11px] truncate max-w-[140px]">
          {check.workflowName}
        </span>
      )}
    </div>
  )
}

function EmptyChecksMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center min-h-0">
      <span className="text-xs text-text-muted select-none">{text}</span>
    </div>
  )
}

/** Checks sub-tab — a summary line ("N passed · M failing · K pending") plus
 *  a failing-first-ordered list of every check on the PR, each row clickable
 *  through to its run URL when one is present. */
export function ChecksTab({ prDetail, workspaceId, branch }: ChecksTabProps): React.JSX.Element {
  if (prDetail === null) {
    return (
      <div
        className="flex-1 flex flex-col min-h-0"
        data-workspace-id={workspaceId}
        data-branch={branch ?? undefined}
        data-has-pr-detail={false}
      >
        <EmptyChecksMessage text="No checks" />
      </div>
    )
  }

  const checks = prDetail.checks
  if (checks.length === 0) {
    return (
      <div
        className="flex-1 flex flex-col min-h-0"
        data-workspace-id={workspaceId}
        data-branch={branch ?? undefined}
        data-has-pr-detail={true}
      >
        <EmptyChecksMessage text="No status checks configured" />
      </div>
    )
  }

  const ordered = orderChecks(checks)
  return (
    <div
      className="flex-1 flex flex-col min-h-0"
      data-workspace-id={workspaceId}
      data-branch={branch ?? undefined}
      data-has-pr-detail={true}
    >
      <ChecksSummary checks={checks} />
      <div className="flex-1 min-h-0 overflow-auto py-1">
        {ordered.map((c, i) => (
          // Check names aren't guaranteed unique across different workflow
          // runs (e.g. a matrix build repeating the same job name) — index
          // is stable here since `ordered` is freshly derived from `checks`
          // on every render, not independently reordered by user action.
          <CheckRow key={`${c.name}-${i}`} check={c} />
        ))}
      </div>
    </div>
  )
}
