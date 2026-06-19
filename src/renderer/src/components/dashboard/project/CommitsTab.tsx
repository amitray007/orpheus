import { useEffect, useState } from 'react'
import type React from 'react'
import { Check, Copy, Files, GitBranch, MagnifyingGlass } from '@phosphor-icons/react'
import type { GitBranchInfo, GitCommit } from '@shared/types'
import { Select } from '../settings/primitives'
import { CommitListSkeleton } from '../../Skeleton'
import { PaginationFooter } from '../../DataTable'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Show 10 commits per page, paged with prev/next like the tables above.
const PAGE_SIZE = 10

const DATE_RANGE_OPTIONS = [
  { value: 'd1', label: 'Last 24h' },
  { value: 'd3', label: 'Last 3 days' },
  { value: 'd7', label: 'Last 7 days' },
  { value: 'd30', label: 'Last 30 days' },
  { value: 'd90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' }
] as const

type DateRange = (typeof DATE_RANGE_OPTIONS)[number]['value']

function dateRangeToSinceMs(range: DateRange): number | undefined {
  if (range === 'all') return undefined
  const day = 24 * 60 * 60 * 1000
  if (range === 'd1') return Date.now() - 1 * day
  if (range === 'd3') return Date.now() - 3 * day
  if (range === 'd7') return Date.now() - 7 * day
  if (range === 'd30') return Date.now() - 30 * day
  if (range === 'd90') return Date.now() - 90 * day
  return undefined
}

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
// Commit row — extracted so each row owns its own "copied" state. Keeping it
// on the parent via a Map would force every row to re-render on each copy.
// ---------------------------------------------------------------------------

function CommitRow({ commit }: { commit: GitCommit }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  // Reset the copied flag ~1.2s after it flips true. Cleanup clears the
  // pending timer so unmounting (paging / filter change) or re-clicking the
  // button before the timer fires can't set state on an unmounted row.
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(id)
  }, [copied])

  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(commit.fullSha)
      setCopied(true)
    } catch (err) {
      console.error('[CommitsTab] clipboard copy failed', err)
    }
  }

  const hasStats = commit.filesChanged > 0 || commit.insertions > 0 || commit.deletions > 0

  return (
    <div className="rounded-lg border border-border-default bg-surface-raised px-4 py-3 hover:bg-surface-overlay/30 transition-colors">
      <p className="text-sm text-text-primary leading-snug">{commit.subject}</p>
      <p className="mt-1 text-xs text-text-muted flex items-center gap-2 flex-wrap">
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-text-secondary">{commit.sha}</span>
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? 'Copied full SHA' : `Copy full SHA ${commit.fullSha}`}
            title={copied ? 'Copied' : 'Copy full SHA'}
            className="inline-flex items-center justify-center w-4 h-4 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 cursor-pointer"
          >
            {copied ? (
              <Check size={10} weight="bold" className="text-emerald-400" />
            ) : (
              <Copy size={10} weight="bold" />
            )}
          </button>
        </span>
        <span>·</span>
        <span title={commit.authorEmail || undefined}>{commit.author}</span>
        <span>·</span>
        <span title={new Date(commit.timestamp).toLocaleString()}>
          {relativeTime(commit.timestamp)}
        </span>
        {hasStats && (
          <span className="ml-auto inline-flex items-center gap-2 font-mono text-sm">
            <span
              className="inline-flex items-center gap-1 text-text-muted"
              title={`${commit.filesChanged} file${commit.filesChanged === 1 ? '' : 's'} changed`}
            >
              <Files size={11} weight="bold" />
              {commit.filesChanged}
            </span>
            {commit.insertions > 0 && (
              <span className="text-emerald-400">+{commit.insertions}</span>
            )}
            {commit.deletions > 0 && <span className="text-red-400">−{commit.deletions}</span>}
          </span>
        )}
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

interface CommitsTabProps {
  cwd: string
}

export function CommitsTab({ cwd }: CommitsTabProps): React.JSX.Element {
  const [branches, setBranches] = useState<GitBranchInfo[]>([])
  const [branch, setBranch] = useState<string>('')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [dateRange, setDateRange] = useState<DateRange>('d3')

  const [commits, setCommits] = useState<GitCommit[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false)
  // Total commits on the selected branch with no filters applied. Used to
  // distinguish "no commits at all on this branch" from "filtered to zero".
  const [allTimeTotal, setAllTimeTotal] = useState<number | null>(null)

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  // Load branch list (and pre-select current branch)
  useEffect(() => {
    let cancelled = false
    window.api.git
      .branches(cwd)
      .then((list) => {
        if (cancelled) return
        setError(null)
        setBranches(list)
        if (list.length === 0) {
          setBranch('')
          // No branches means there's nothing for the commits effect to fetch,
          // so flip the fetched flag here to surface the empty state instead
          // of leaving the skeleton spinning forever.
          setHasFetchedOnce(true)
          return
        }
        const current = list.find((b) => b.isCurrent)
        setBranch(current?.name ?? list[0].name)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[commits-tab] failed to load branches', err)
        setError('Could not read git branches for this project.')
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  // Fetch unfiltered commit count for the selected branch so we can distinguish
  // "no commits at all" from "filtered to zero" for the empty-state UI.
  useEffect(() => {
    if (!branch) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting derived state before async fetch is the idiomatic pattern
    setAllTimeTotal(null)
    window.api.git
      .count(cwd, { branch })
      .then((count) => {
        if (!cancelled) setAllTimeTotal(count)
      })
      .catch(() => {
        // On error assume there could be commits — keeps controls visible.
        if (!cancelled) setAllTimeTotal(1)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, branch])

  // Reset to page 1 whenever the filters change (branch / search / date range)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- pagination reset on filter change; this is the idiomatic pattern
    setPage(1)
  }, [branch, dateRange, debouncedSearch])

  // Load commits + total whenever filters or page change
  useEffect(() => {
    if (!branch) return
    let cancelled = false
    const sinceMs = dateRangeToSinceMs(dateRange)
    const grep = debouncedSearch || undefined

    Promise.all([
      window.api.git.log(cwd, {
        branch,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
        sinceMs,
        grep
      }),
      window.api.git.count(cwd, { branch, sinceMs, grep })
    ])
      .then(([list, count]) => {
        if (cancelled) return
        setError(null)
        setCommits(list)
        setTotal(count)
        setHasFetchedOnce(true)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[commits-tab] failed to load commits', err)
        setError('Could not read git log for this branch.')
        setHasFetchedOnce(true)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, branch, dateRange, debouncedSearch, page])

  const branchOptions = branches.map((b) => ({ value: b.name, label: b.name }))

  // No git repo at all, or no commits on this branch (unfiltered).
  const noDataAtAll = hasFetchedOnce && (branches.length === 0 || allTimeTotal === 0) && !error
  // Data exists but current filter/search/date-range yields zero results.
  // Guard with allTimeTotal !== null to avoid a brief flash while the unfiltered
  // count resolves on branch switch — without the guard the list may briefly
  // show "No matching commits." before allTimeTotal arrives and flips noDataAtAll.
  const filteredToZero =
    allTimeTotal !== null && !noDataAtAll && hasFetchedOnce && commits.length === 0 && !error

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar — hidden when there are no commits to search/filter */}
      {!noDataAtAll && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[180px] max-w-sm">
            <MagnifyingGlass
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search commits"
              className="w-full pl-7 pr-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:border-accent/40 transition-colors"
            />
          </div>
          <div className="w-44">
            <Select<DateRange>
              ariaLabel="Date range"
              options={DATE_RANGE_OPTIONS as ReadonlyArray<{ value: DateRange; label: string }>}
              value={dateRange}
              onChange={setDateRange}
            />
          </div>
          <div className="ml-auto inline-flex items-center gap-2">
            <span className="text-xs text-text-muted">Branch</span>
            <div className="w-44">
              {branches.length > 0 ? (
                <Select
                  ariaLabel="Branch"
                  options={branchOptions}
                  value={branch}
                  onChange={(v) => setBranch(v)}
                />
              ) : (
                <div className="px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-muted">
                  —
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Commits list */}
      {error ? (
        <div className="rounded-lg border border-border-default bg-surface-raised py-10 text-center">
          <GitBranch size={22} className="text-text-muted mx-auto mb-2" />
          <p className="text-sm text-text-muted">{error}</p>
        </div>
      ) : !hasFetchedOnce ? (
        <CommitListSkeleton count={5} />
      ) : noDataAtAll || filteredToZero ? (
        <div className="relative rounded-lg border border-border-default bg-surface-raised overflow-hidden">
          <div aria-hidden className="blur-[3px] opacity-40 pointer-events-none select-none">
            <CommitListSkeleton count={5} />
          </div>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center">
            <GitBranch size={20} className="text-text-muted" />
            <p className="text-sm text-text-muted">
              {noDataAtAll ? 'No commits yet on this branch.' : 'No matching commits.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {commits.map((c) => (
            <CommitRow key={c.fullSha} commit={c} />
          ))}
          {total > PAGE_SIZE && (
            <div className="rounded-lg border border-border-default bg-surface-raised mt-1">
              <PaginationFooter
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                onPageChange={setPage}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
