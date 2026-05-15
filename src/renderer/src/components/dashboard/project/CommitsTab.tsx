import { useEffect, useState } from 'react'
import type React from 'react'
import { GitBranch, GitCommit as GitCommitIcon, MagnifyingGlass } from '@phosphor-icons/react'
import type { GitBranchInfo, GitCommit } from '@shared/types'
import { Select } from '../settings/primitives'
import { CommitListSkeleton } from '../../Skeleton'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25

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
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasFetchedOnce, setHasFetchedOnce] = useState(false)

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

  // Load commits when filters change
  useEffect(() => {
    if (!branch) return
    let cancelled = false
    window.api.git
      .log(cwd, {
        branch,
        limit: PAGE_SIZE,
        offset: 0,
        sinceMs: dateRangeToSinceMs(dateRange),
        grep: debouncedSearch || undefined
      })
      .then((list) => {
        if (cancelled) return
        setError(null)
        setCommits(list)
        setHasMore(list.length === PAGE_SIZE)
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
  }, [cwd, branch, dateRange, debouncedSearch])

  async function loadMore(): Promise<void> {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const more = await window.api.git.log(cwd, {
        branch,
        limit: PAGE_SIZE,
        offset: commits.length,
        sinceMs: dateRangeToSinceMs(dateRange),
        grep: debouncedSearch || undefined
      })
      setCommits((prev) => [...prev, ...more])
      setHasMore(more.length === PAGE_SIZE)
    } catch (err) {
      console.error('[commits-tab] failed to load more commits', err)
    } finally {
      setLoadingMore(false)
    }
  }

  const branchOptions = branches.map((b) => ({ value: b.name, label: b.name }))

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
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

      {/* Commits list */}
      {error ? (
        <div className="rounded-lg border border-border-default bg-surface-raised py-10 text-center">
          <GitBranch size={22} className="text-text-muted opacity-50 mx-auto mb-2" />
          <p className="text-sm text-text-muted">{error}</p>
        </div>
      ) : !hasFetchedOnce ? (
        <CommitListSkeleton count={5} />
      ) : hasFetchedOnce && commits.length === 0 ? (
        <div className="rounded-lg border border-border-default bg-surface-raised py-10 text-center">
          <GitCommitIcon size={22} className="text-text-muted opacity-50 mx-auto mb-2" />
          <p className="text-sm text-text-muted">
            {debouncedSearch ? 'No commits match your search' : 'No commits in this range'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {commits.map((c) => (
            <div
              key={c.fullSha}
              className="rounded-lg border border-border-default bg-surface-raised px-4 py-3 hover:bg-surface-overlay/30 transition-colors"
            >
              <p className="text-sm text-text-primary leading-snug">{c.subject}</p>
              <p className="mt-1 text-xs text-text-muted flex items-center gap-2 flex-wrap">
                <span className="font-mono text-text-secondary">{c.sha}</span>
                <span>·</span>
                <span>{c.author}</span>
                <span>·</span>
                <span>{relativeTime(c.timestamp)}</span>
              </p>
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              aria-label={loadingMore ? 'Loading more commits' : 'Load more commits'}
              className={[
                'self-center mt-2 inline-flex items-center px-3 h-8 rounded-md text-xs',
                'border border-border-default text-text-secondary',
                'transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                loadingMore
                  ? 'opacity-50 cursor-wait'
                  : 'hover:text-text-primary hover:bg-surface-overlay cursor-pointer'
              ].join(' ')}
            >
              {loadingMore ? 'Loading…' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
