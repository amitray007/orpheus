import { useEffect, useState } from 'react'
import type React from 'react'
import { GitBranch, GitCommit as GitCommitIcon } from '@phosphor-icons/react'
import type { GitBranchInfo, GitCommit } from '@shared/types'
import { Select } from '../settings/primitives'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 25

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
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load branch list (and pre-select the current branch).
  // Loading stays true from initial state — branch fetch on cwd change reuses
  // the initial loading state from the parent mount.
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
          setLoading(false)
          return
        }
        const current = list.find((b) => b.isCurrent)
        setBranch(current?.name ?? list[0].name)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[commits-tab] failed to load branches', err)
        setError('Could not read git branches for this project.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd])

  // Load commits for the chosen branch
  useEffect(() => {
    if (!branch) return
    let cancelled = false
    window.api.git
      .log(cwd, { branch, limit: PAGE_SIZE, offset: 0 })
      .then((list) => {
        if (cancelled) return
        setError(null)
        setCommits(list)
        setHasMore(list.length === PAGE_SIZE)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.error('[commits-tab] failed to load commits', err)
        setError('Could not read git log for this branch.')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, branch])

  async function loadMore(): Promise<void> {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      const more = await window.api.git.log(cwd, {
        branch,
        limit: PAGE_SIZE,
        offset: commits.length
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
      {/* Branch selector */}
      <div className="flex items-center justify-end gap-2">
        <span className="text-xs text-text-muted">Branch</span>
        <div className="w-56">
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

      {/* Commits */}
      {error ? (
        <div className="rounded-lg border border-border-default bg-surface-raised py-10 text-center">
          <GitBranch size={22} className="text-text-muted opacity-50 mx-auto mb-2" />
          <p className="text-sm text-text-muted">{error}</p>
        </div>
      ) : loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-lg border border-border-default bg-surface-raised px-4 py-3"
              style={{ opacity: 0.5 - i * 0.1 }}
            >
              <div className="h-3 bg-surface-overlay rounded w-2/3 mb-2" />
              <div className="h-2.5 bg-surface-overlay rounded w-1/3" />
            </div>
          ))}
        </div>
      ) : commits.length === 0 ? (
        <div className="rounded-lg border border-border-default bg-surface-raised py-10 text-center">
          <GitCommitIcon size={22} className="text-text-muted opacity-50 mx-auto mb-2" />
          <p className="text-sm text-text-muted">No commits on this branch yet.</p>
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
              onClick={loadMore}
              disabled={loadingMore}
              className={[
                'self-center mt-2 px-3 py-1.5 rounded-md text-xs',
                'border border-border-default text-text-secondary',
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
