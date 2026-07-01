import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { GitBranch, Play, Trash } from '@phosphor-icons/react'
import type { SessionRecord, SessionsPagedRequest, WorkspaceRecord } from '@shared/types'
import { DataTable, type DataTableColumn } from '../../DataTable'
import { DotmSquare13 } from '../../ui/dotm-square-13'
import { ConfirmModal } from '../../ConfirmModal'
import { SessionsFilterBar } from './SessionsFilterBar'
import {
  PAGE_SIZE_FULL,
  PAGE_SIZE_COMPACT,
  dateRangeToFrom,
  relativeTime,
  formatBytes,
  shortModel,
  type DateRange,
  type SortBy
} from './sessions-tab-helpers'

// ---------------------------------------------------------------------------
// Worktree-origin detection (render-time, no IPC)
// ---------------------------------------------------------------------------

const WORKTREE_MARKER = '--claude-worktrees-'

/**
 * Returns the worktree slug from a session's jsonlPath if the session originated
 * in a git worktree (i.e. its encoded dir contains '--claude-worktrees-').
 * Returns null for sessions from the main project directory.
 */
function worktreeSlugFromPath(jsonlPath: string): string | null {
  // jsonlPath = ~/.claude/projects/<encodedDir>/<sessionId>.jsonl
  // encodedDir for a worktree: ...<repoEncoded>--claude-worktrees-<slug>
  const parts = jsonlPath.split('/')
  // The encoded dir is the second-to-last segment (last is the .jsonl filename)
  const encodedDir = parts.length >= 2 ? parts[parts.length - 2] : ''
  const markerIdx = encodedDir.indexOf(WORKTREE_MARKER)
  if (markerIdx === -1) return null
  return encodedDir.slice(markerIdx + WORKTREE_MARKER.length) || null
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

interface SessionsTabProps {
  projectId: string
  onSessionCountChange?: (count: number) => void
  onResumedInWorkspace: (workspace: WorkspaceRecord) => void
  /**
   * Compact column set for side-by-side embedding (e.g. next to the Active
   * workspaces table inside the project view). Hides Model / Messages /
   * Size / Created and keeps Prompt + Updated + resume action. Filters and
   * pagination still render so the panel is fully usable in narrow space.
   */
  compact?: boolean
}

// Constant JSX — no component scope references; hoisted to avoid rebuilding each render.
const filteredEmptyState = (
  <p className="text-sm text-text-muted py-6 text-center">No matching sessions.</p>
)

export function SessionsTab({
  projectId,
  onSessionCountChange,
  onResumedInWorkspace,
  compact = false
}: SessionsTabProps): React.JSX.Element {
  const PAGE_SIZE = compact ? PAGE_SIZE_COMPACT : PAGE_SIZE_FULL
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [dateRange, setDateRange] = useState<DateRange>('d3')
  const [sortBy, setSortBy] = useState<SortBy>('updatedAt')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)

  const [rows, setRows] = useState<SessionRecord[]>([])
  const [total, setTotal] = useState(0)
  // Loading shows the skeleton on first load only. Subsequent filter/page
  // changes show stale data until the next fetch resolves — keeps the UI
  // from flashing on rapid input.
  const [loading, setLoading] = useState(true)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null)

  // Tracks whether the project has any sessions at all (unfiltered). Used to
  // distinguish "no sessions ever" from "filtered to zero" so we can hide
  // search/filter controls only in the former case.
  const [hasAnySessions, setHasAnySessions] = useState<boolean | null>(null)

  // When the default date window (e.g. "Last 3 days") hides every session but
  // the project actually has older ones, we auto-widen to "All time" once so
  // the list isn't silently empty. We store the project id we widened for (not
  // a bare boolean) so switching projects re-arms the one-shot automatically
  // without a reset effect, and a manual date change clears it (set to null).
  const [autoWidenedFor, setAutoWidenedFor] = useState<string | null>(null)
  const autoWidened = autoWidenedFor === projectId

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  // One-shot metadata backfill on project change — fills in any null titles
  // and models from JSONL files. Then the next paged query picks up the
  // freshly-extracted values.
  const [metadataVersion, setMetadataVersion] = useState(0)
  useEffect(() => {
    let cancelled = false
    window.api.sessions
      .refreshMetadata(projectId)
      .then(() => {
        if (!cancelled) setMetadataVersion((v) => v + 1)
      })
      .catch((err) => console.error('[sessions-tab] refresh failed', err))
    return () => {
      cancelled = true
    }
  }, [projectId])

  // One-shot check: does this project have any sessions at all (ignoring all
  // filters)? Re-runs when sessions are deleted (metadataVersion bump).
  useEffect(() => {
    let cancelled = false
    window.api.sessions
      .listForProjectPaged({ projectId, offset: 0, limit: 1 })
      .then((res) => {
        if (!cancelled) setHasAnySessions(res.total > 0)
      })
      .catch(() => {
        // On error assume there could be sessions — keeps controls visible.
        if (!cancelled) setHasAnySessions(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectId, metadataVersion])

  // Keep a ref to onSessionCountChange so the fetch effect can call the latest
  // version without listing it as a dep (an un-memoized callback from the parent
  // would otherwise cause a full refetch every render).
  const onSessionCountChangeRef = useRef(onSessionCountChange)
  useEffect(() => {
    onSessionCountChangeRef.current = onSessionCountChange
  })

  // Snapshot the IPC call so a stale request can be ignored once it returns.
  const reqIdRef = useRef(0)

  useEffect(() => {
    const req: SessionsPagedRequest = {
      projectId,
      search: debouncedSearch || undefined,
      dateFrom: dateRangeToFrom(dateRange),
      sortBy,
      sortDir,
      offset: (page - 1) * PAGE_SIZE,
      limit: PAGE_SIZE
    }
    const reqId = ++reqIdRef.current
    window.api.sessions
      .listForProjectPaged(req)
      .then((res) => {
        if (reqId !== reqIdRef.current) return
        // Auto-widen guard: a date window other than "all" returned nothing,
        // yet the project has sessions (hasAnySessions). The user is almost
        // certainly staring at an empty list for a project whose work is just
        // older than the default window — widen to "All time" once. We only do
        // this when no search/page narrowing is in play, so an intentional
        // empty search result is respected.
        if (
          res.total === 0 &&
          dateRange !== 'all' &&
          !debouncedSearch &&
          page === 1 &&
          hasAnySessions === true &&
          !autoWidened
        ) {
          setAutoWidenedFor(projectId)
          setDateRange('all')
          return
        }
        setRows(res.rows)
        setTotal(res.total)
        setLoading(false)
        onSessionCountChangeRef.current?.(res.total)
      })
      .catch((err) => {
        if (reqId !== reqIdRef.current) return
        console.error('[sessions-tab] paged load failed', err)
        setRows([])
        setTotal(0)
        setLoading(false)
      })
  }, [
    projectId,
    debouncedSearch,
    dateRange,
    sortBy,
    sortDir,
    page,
    metadataVersion,
    hasAnySessions,
    autoWidened
  ])

  // Filter changes reset to page 1; these go through handlers so we never set
  // state synchronously from an effect.
  //
  // useCallback([]) is safe here — each handler only calls stable useState
  // setters and has no closure over other state. Stable refs let SessionsFilterBar
  // (memo'd) skip rerenders when only data-layer state changes.
  const changeSearch = useCallback((v: string): void => {
    setSearch(v)
    setPage(1)
  }, [])

  const changeDateRange = useCallback((v: DateRange): void => {
    setDateRange(v)
    setPage(1)
    // User took control of the window — don't auto-widen again, and clear the
    // hint if they re-narrow.
    setAutoWidenedFor(null)
  }, [])

  function changeSort(by: SortBy, dir: 'asc' | 'desc'): void {
    setSortBy(by)
    setSortDir(dir)
    setPage(1)
  }

  async function handleRowClick(row: SessionRecord): Promise<void> {
    if (resumingId) return
    setResumingId(row.id)
    try {
      const isWorktree = worktreeSlugFromPath(row.jsonlPath) !== null
      const ws = isWorktree
        ? await window.api.sessions.resumeInWorktreeWorkspace(row.id, projectId)
        : await window.api.sessions.resumeInNewWorkspace(row.id, projectId)
      onResumedInWorkspace(ws)
    } catch (err) {
      console.error('[sessions-tab] resume failed', err)
    } finally {
      setResumingId(null)
    }
  }

  const columns = useMemo<DataTableColumn<SessionRecord>[]>(() => {
    const promptCol: DataTableColumn<SessionRecord> = {
      key: 'title',
      label: 'Prompt',
      sortable: true,
      render: (r) => {
        const worktreeSlug = worktreeSlugFromPath(r.jsonlPath)
        return (
          <span className="flex items-center gap-1.5 min-w-0">
            {worktreeSlug && (
              <span
                title={worktreeSlug}
                aria-label="worktree session"
                className="flex-shrink-0 inline-flex items-center gap-0.5 text-text-muted"
              >
                <GitBranch size={10} weight="duotone" />
              </span>
            )}
            <span className="truncate" title={r.title ?? r.id}>
              {r.title ?? <span className="text-text-muted italic">untitled</span>}
            </span>
          </span>
        )
      }
    }
    const updatedCol: DataTableColumn<SessionRecord> = {
      key: 'updatedAt',
      label: 'Updated',
      sortable: true,
      width: '110px',
      render: (r) => <span className="text-text-muted">{relativeTime(r.updatedAt)}</span>
    }
    const resumeCol: DataTableColumn<SessionRecord> = {
      key: 'resume',
      label: '',
      width: '56px',
      align: 'right',
      cellPadded: false,
      render: (r) => {
        const isResuming = resumingId === r.id
        return (
          <button
            type="button"
            onClick={(e) => {
              // Row's onClick also triggers resume; stopping here so the
              // button is a no-op-duplicate rather than a double-fire path.
              e.stopPropagation()
              if (!isResuming) void handleRowClick(r)
            }}
            disabled={isResuming}
            aria-label={isResuming ? 'Resuming session' : 'Resume in new workspace'}
            title={isResuming ? 'Opening workspace…' : 'Resume in new workspace'}
            className={[
              'inline-flex items-center justify-center w-8 h-8 rounded-md',
              'transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              isResuming
                ? 'text-accent cursor-wait'
                : 'text-text-muted hover:text-accent hover:bg-accent/10 cursor-pointer'
            ].join(' ')}
          >
            {isResuming ? (
              <DotmSquare13 size={14} dotSize={2} speed={1.4} animated />
            ) : (
              <Play size={13} weight="fill" />
            )}
          </button>
        )
      }
    }
    const deleteCol: DataTableColumn<SessionRecord> = {
      key: 'delete',
      label: '',
      width: '52px',
      align: 'right',
      cellPadded: false,
      render: (r) => (
        <button
          type="button"
          onClick={(e) => {
            // Stop the row's onClick (which would resume the session).
            e.stopPropagation()
            setPendingDelete(r)
          }}
          aria-label={`Delete session${r.title ? ` "${r.title}"` : ''}`}
          title="Delete session"
          className={[
            'inline-flex items-center justify-center w-8 h-8 rounded-md',
            'text-text-muted transition-colors duration-150 cursor-pointer',
            'hover:text-red-400 hover:bg-red-500/10',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50'
          ].join(' ')}
        >
          <Trash size={13} />
        </button>
      )
    }

    if (compact) {
      return [promptCol, updatedCol, deleteCol, resumeCol]
    }
    return [
      promptCol,
      {
        key: 'model',
        label: 'Model',
        width: '90px',
        render: (r) => (
          <span className="text-xs font-mono text-text-secondary">{shortModel(r.model)}</span>
        )
      },
      {
        key: 'messageCount',
        label: 'Messages',
        width: '90px',
        align: 'right',
        render: (r) => (
          <span className="text-xs text-text-muted tabular-nums">
            {typeof r.messageCount === 'number' ? r.messageCount : '—'}
          </span>
        )
      },
      {
        key: 'jsonlSizeBytes',
        label: 'Size',
        width: '80px',
        align: 'right',
        render: (r) => (
          <span className="text-xs text-text-muted tabular-nums">
            {typeof r.jsonlSizeBytes === 'number' ? formatBytes(r.jsonlSizeBytes) : '—'}
          </span>
        )
      },
      {
        key: 'createdAt',
        label: 'Created',
        sortable: true,
        width: '110px',
        render: (r) => <span className="text-text-muted">{relativeTime(r.createdAt)}</span>
      },
      updatedCol,
      deleteCol,
      resumeCol
    ]
  }, [resumingId, compact, onResumedInWorkspace])

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    const id = pendingDelete.id
    setPendingDelete(null)
    try {
      await window.api.sessions.delete(id)
      // Drop the row optimistically; a refetch follows via metadata bump.
      setRows((prev) => prev.filter((r) => r.id !== id))
      setTotal((prev) => Math.max(0, prev - 1))
      setMetadataVersion((v) => v + 1)
    } catch (err) {
      console.error('[sessions-tab] delete failed', err)
    }
  }

  // hasAnySessions=null means the unfiltered check is still in flight — treat
  // as indeterminate (don't hide controls prematurely).
  const noSessionsAtAll = hasAnySessions === false && !loading

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar — always shown, even when the project has no sessions */}
      <SessionsFilterBar
        search={search}
        onSearchChange={changeSearch}
        dateRange={dateRange}
        onDateRangeChange={changeDateRange}
      />

      {/* Auto-widen hint: shown when the default date window hid everything and
          we fell back to "All time" so the list isn't mysteriously empty. */}
      {autoWidened && dateRange === 'all' && !debouncedSearch && (
        <p className="text-xs text-text-muted -mt-1">
          No sessions in the recent window — showing all sessions.
        </p>
      )}

      <DataTable<SessionRecord>
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyState={
          noSessionsAtAll ? (
            <p className="text-sm text-text-muted text-center">
              No sessions yet — start Claude Code in this project and your sessions will appear
              here.
            </p>
          ) : (
            filteredEmptyState
          )
        }
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={(by, dir) => changeSort(by as SortBy, dir)}
        pagination={{
          page,
          pageSize: PAGE_SIZE,
          total,
          onPageChange: setPage
        }}
        onRowClick={handleRowClick}
      />

      {pendingDelete && (
        <ConfirmModal
          title="Delete session?"
          body={
            <>
              <p>
                This will move the JSONL transcript to your Trash and remove the session from
                Orpheus&apos;s list. You can recover from Finder Trash if you change your mind.
              </p>
              {pendingDelete.title && (
                <p className="mt-2 text-xs text-text-muted italic truncate">
                  &quot;{pendingDelete.title}&quot;
                </p>
              )}
            </>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  )
}
