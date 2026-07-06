// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/CommitsTab.tsx
//
// Git tab — Commits sub-tab (PHASE 3c). Renders the current branch's commit
// list, grouped by date (GitHub-style "Commits on <date>" headers), matching
// docs/brainstorms/git-tab-mockup's Commits tab (renderCommitsTab in its
// script.js + the `.commit-*` rules in its styles.css).
//
// Two data sources, mutually exclusive:
//   - PR exists (`prDetail !== null`): use `prDetail.commits: GhCommit[]`
//     (src/shared/types.ts) — GitHub's own commit list for the PR, each with
//     a real `url` (derived server-side as `${repoUrl}/commit/${oid}`), so
//     every row is clickable → opens the commit on GitHub via `openPrUrl`
//     (same helper GitTab's slim header uses for the PR title).
//   - No PR (`prDetail === null`): fall back to the branch's LOCAL commit
//     list via the new `git:logForWorkspace` IPC (src/main/ipc/git.ts;
//     resolves `workspaceId` -> cwd internally, same pattern as git:diff/
//     git:init — this tab, like the rest of GitTab's props, only ever has a
//     `workspaceId`). `GitCommit` (shared/types.ts) carries no `url` — gh's
//     local `git log` has no notion of a remote commit page — so these rows
//     render as inert (not clickable) with a "local" badge, exactly the
//     mockup's `commit-row--local` treatment for its one unpushed commit.
//     This is deliberately NOT a "pushed vs. unpushed" distinction (that
//     would need a `git rev-list <remote>..HEAD` check we don't have data
//     for here) — it's "has a PR" vs. "doesn't", which is the same
//     information the rest of this tab (and GitTab's tab-strip growth) is
//     already keyed on.
//
// Per-commit +/- stats: `GhCommit` (the PR path) carries no per-commit
// additions/deletions — `gh pr view --json commits` doesn't expose stats per
// commit, only `prDetail`'s PR-level additions/deletions/changedFiles — so
// the PR-path rows show no stat pills (the mockup's +/-/file-count line is
// aspirational there; not exposed by data we have). The no-PR path's
// `GitCommit` DOES carry real per-commit `filesChanged`/`insertions`/
// `deletions` (see src/main/git.ts's listCommits `--shortstat` parse) — that
// path's rows do show the stat pills, same as the existing
// dashboard/project/CommitsTab.tsx's CommitRow (a different, project-level
// commit browser — not reused directly here since it's keyed on a raw `cwd`
// this tab doesn't have, and has its own branch/date-range/pagination
// filter bar this compact Workbench tab doesn't need).
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react'
import type React from 'react'
import { Check, Copy, GitCommit as GitCommitIcon } from '@phosphor-icons/react'
import type { GhCommit, GhPullRequestDetail, GitCommit } from '@shared/types'
import { openPrUrl } from '../../../lib/overlayClient'

export interface CommitsTabProps {
  /** The current branch's PR detail, or null when there's no PR for this
   *  branch (no `gh` / no remote / detached HEAD / not-yet-pushed). */
  prDetail: GhPullRequestDetail | null
  /** The owning claude workspace's id — resolves to the workspace cwd in the
   *  main process, same as GitTab's own `workspaceId` prop. */
  workspaceId: string
  /** The current branch name (from GitTab's `git:statusChanged` push), or
   *  null before the first push arrives / on a detached HEAD. Needed for the
   *  no-PR "local commits ahead of base" fallback described above. */
  branch: string | null
}

// ---------------------------------------------------------------------------
// A single row shape both data sources normalize into, so the date-grouping
// + row-render code below doesn't need two parallel branches for PR vs.
// local commits — only the (small) mapping step differs.
// ---------------------------------------------------------------------------

interface CommitRowData {
  /** Stable React key + copy target's short display. */
  sha: string
  fullSha: string
  headline: string
  authorName: string
  /** Epoch ms — drives both date-grouping and the relative-time label. */
  dateMs: number
  /** Commit page URL when known (PR path only) — null means "not clickable,
   *  no PR yet" (the local/no-PR fallback). */
  url: string | null
  /** Per-commit diff stats — only available from the local git:log path
   *  (see module header); null for PR commits. */
  stats: { filesChanged: number; insertions: number; deletions: number } | null
}

function fromGhCommit(c: GhCommit): CommitRowData {
  return {
    sha: c.oid.slice(0, 7),
    fullSha: c.oid,
    headline: c.messageHeadline,
    authorName: c.authorLogin ?? c.authorName,
    dateMs: Date.parse(c.authoredDate),
    url: c.url,
    stats: null
  }
}

function fromGitCommit(c: GitCommit): CommitRowData {
  return {
    sha: c.sha,
    fullSha: c.fullSha,
    headline: c.subject,
    authorName: c.author,
    dateMs: c.timestamp,
    url: null,
    stats: { filesChanged: c.filesChanged, insertions: c.insertions, deletions: c.deletions }
  }
}

// ---------------------------------------------------------------------------
// Date-grouping — GitHub's own "Commits on <date>" convention. Extracted from
// the render body (rather than inlined) to keep CommitsTab's own cognitive
// complexity under the repo's ceiling (see CLAUDE.md's lint section).
// ---------------------------------------------------------------------------

interface CommitDateGroup {
  label: string
  commits: CommitRowData[]
}

const DATE_LABEL_FORMAT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  year: 'numeric'
}

/** Groups commits (already in the caller's original — i.e. newest-first —
 *  order) by their local calendar date, preserving each group's first-seen
 *  order. A `Map` keeps insertion order for free, so no separate sort pass is
 *  needed once the input itself is ordered (both data sources already return
 *  newest-first: `gh`'s commits[] and `git log`'s default order). */
function groupCommitsByDate(commits: readonly CommitRowData[]): CommitDateGroup[] {
  const groups = new Map<string, CommitRowData[]>()
  for (const c of commits) {
    const label = new Date(c.dateMs).toLocaleDateString(undefined, DATE_LABEL_FORMAT)
    const existing = groups.get(label)
    if (existing) existing.push(c)
    else groups.set(label, [c])
  }
  return Array.from(groups.entries(), ([label, items]) => ({ label, commits: items }))
}

// ---------------------------------------------------------------------------
// Relative time — no existing shared helper in the renderer (checked); kept
// tiny and local rather than pulling in a date library for one label.
// ---------------------------------------------------------------------------

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  return `${mo}mo ago`
}

// ---------------------------------------------------------------------------
// Commit row
// ---------------------------------------------------------------------------

function CommitShaCopyButton({ fullSha }: { fullSha: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  // Reset the copied flag ~1.2s after it flips true — same pattern the
  // existing dashboard/project/CommitsTab.tsx CommitRow uses. Cleanup clears
  // the pending timer so a fast re-click or unmount (sub-tab switch) can't
  // set state after the fact.
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(id)
  }, [copied])

  async function handleCopy(e: React.MouseEvent): Promise<void> {
    // Stop the click from also bubbling to the row's own onClick (which
    // opens the commit in the browser) — copying the SHA and opening the
    // commit are two distinct actions on the same row.
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(fullSha)
      setCopied(true)
    } catch (err) {
      console.error('[CommitsTab] clipboard copy failed:', err)
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => void handleCopy(e)}
      aria-label={copied ? 'Copied full SHA' : `Copy full SHA ${fullSha}`}
      title={copied ? 'Copied' : 'Copy full SHA'}
      className="inline-flex items-center gap-1 font-mono text-[11px] px-1.5 py-0 rounded bg-surface-overlay border border-border-default text-text-secondary hover:text-text-primary hover:border-accent/60 transition-colors duration-150 cursor-pointer"
    >
      {fullSha.slice(0, 7)}
      {copied ? (
        <Check size={9} weight="bold" className="text-emerald-400" />
      ) : (
        <Copy size={9} weight="bold" />
      )}
    </button>
  )
}

function CommitStatsPills({
  stats
}: {
  stats: NonNullable<CommitRowData['stats']>
}): React.JSX.Element | null {
  const hasStats = stats.filesChanged > 0 || stats.insertions > 0 || stats.deletions > 0
  if (!hasStats) return null
  return (
    <>
      <span>
        {stats.filesChanged} file{stats.filesChanged === 1 ? '' : 's'} changed
      </span>
      {stats.insertions > 0 && (
        <span className="text-emerald-400 font-mono">+{stats.insertions}</span>
      )}
      {stats.deletions > 0 && <span className="text-red-400 font-mono">−{stats.deletions}</span>}
    </>
  )
}

function CommitRow({ commit }: { commit: CommitRowData }): React.JSX.Element {
  const clickable = commit.url !== null
  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => openPrUrl(commit.url as string) : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') openPrUrl(commit.url as string)
            }
          : undefined
      }
      title={clickable ? 'Open commit on GitHub' : 'Not pushed yet — no PR for this branch'}
      className={[
        'flex items-start gap-2.5 px-2.5 py-2 rounded-lg border mb-1.5 transition-colors duration-100',
        clickable
          ? 'border-border-default bg-surface-raised hover:border-border-hover cursor-pointer'
          : 'border-dashed border-border-default bg-surface-base cursor-default opacity-90'
      ].join(' ')}
    >
      <span
        className={[
          'mt-1 w-2 h-2 rounded-full flex-shrink-0',
          clickable ? 'bg-accent' : 'bg-text-muted'
        ].join(' ')}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-medium text-text-primary truncate">{commit.headline}</div>
        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-text-muted flex-wrap">
          <CommitShaCopyButton fullSha={commit.fullSha} />
          {commit.stats !== null && <CommitStatsPills stats={commit.stats} />}
          <span>{commit.authorName}</span>
          <span title={new Date(commit.dateMs).toLocaleString()}>
            {relativeTime(commit.dateMs)}
          </span>
          {!clickable && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 rounded-full bg-surface-overlay border border-border-default text-text-muted">
              <span className="w-1 h-1 rounded-full bg-text-muted" aria-hidden />
              local
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Empty / loading states
// ---------------------------------------------------------------------------

function CommitsMessage({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="flex-1 flex items-center justify-center min-h-0">
      <span className="text-xs text-text-muted select-none">{text}</span>
    </div>
  )
}

function NoCommitsState(): React.JSX.Element {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 min-h-0 text-center px-8">
      <GitCommitIcon size={32} weight="regular" className="text-text-muted opacity-55" />
      <span className="text-[13px] font-medium text-text-primary">No commits</span>
      <span className="text-xs text-text-muted max-w-[280px]">
        This branch has no commits yet relative to its base.
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Local (no-PR) commit fetch — src/main/ipc/git.ts's git:logForWorkspace.
// Re-fetches whenever `workspaceId` or `branch` changes; branch changes are
// informational only here (the IPC always reads HEAD server-side via cwd —
// see listCommits — so this doesn't pass `branch` through), it's included in
// the deps purely so a branch SWITCH re-triggers a fetch of the new HEAD's
// commits rather than showing the previous branch's stale list.
// ---------------------------------------------------------------------------

const LOCAL_COMMITS_LIMIT = 50

function useLocalCommits(
  workspaceId: string,
  branch: string | null,
  enabled: boolean
): { commits: GitCommit[]; loading: boolean } {
  const [commits, setCommits] = useState<GitCommit[]>([])
  // Starts true whenever `enabled` — the fetch effect below settles it;
  // when disabled (a PR exists, so this hook's result is never rendered)
  // it simply never fires and this initial value is discarded.
  const [loading, setLoading] = useState(enabled)

  useEffect(() => {
    if (!enabled) return undefined
    let cancelled = false
    window.api.git
      .logForWorkspace(workspaceId, LOCAL_COMMITS_LIMIT)
      .then((list) => {
        if (!cancelled) setCommits(list)
      })
      .catch((e) => {
        console.error('[CommitsTab] git:logForWorkspace failed:', e)
        if (!cancelled) setCommits([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, branch, enabled])

  return { commits, loading }
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/** Git tab — Commits sub-tab: the PR's (or, absent a PR, the branch's local)
 *  commit list, grouped by date, newest group first — matches the mockup's
 *  `renderCommitsTab`. PR commits are clickable (open the commit on GitHub);
 *  local-only commits (no PR yet) render with a dashed border + "local"
 *  badge and aren't clickable (no commit-page URL to open). */
export function CommitsTab({ prDetail, workspaceId, branch }: CommitsTabProps): React.JSX.Element {
  const hasPr = prDetail !== null
  const { commits: localCommits, loading: localLoading } = useLocalCommits(
    workspaceId,
    branch,
    !hasPr
  )

  if (hasPr) {
    const rows = prDetail.commits.map(fromGhCommit)
    if (rows.length === 0) return <NoCommitsState />
    const groups = groupCommitsByDate(rows)
    return <CommitsList groups={groups} />
  }

  if (localLoading) return <CommitsMessage text="Loading…" />
  if (localCommits.length === 0) return <NoCommitsState />
  const groups = groupCommitsByDate(localCommits.map(fromGitCommit))
  return <CommitsList groups={groups} />
}

function CommitsList({ groups }: { groups: CommitDateGroup[] }): React.JSX.Element {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3.5 py-2.5">
      {groups.map((group) => (
        <div key={group.label} className="mb-4">
          <div className="text-[10.5px] font-bold uppercase tracking-wide text-text-muted py-1">
            Commits on {group.label}
          </div>
          {group.commits.map((c) => (
            <CommitRow key={c.fullSha} commit={c} />
          ))}
        </div>
      ))}
    </div>
  )
}
