import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { MagnifyingGlass, ChatCircle, Play, Trash } from '@phosphor-icons/react'
import type { SessionRecord, SessionsPagedRequest, WorkspaceRecord } from '@shared/types'
import { DataTable, type DataTableColumn } from '../../DataTable'
import { Select } from '../settings/primitives'
import { Spinner } from '../../Spinner'
import { ConfirmModal } from '../../ConfirmModal'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Full sessions view shows 20 per page; compact embedding (next to workspaces
// in the project view) shows fewer rows so the panel doesn't grow the page
// out of comfortable read height.
const PAGE_SIZE_FULL = 20
const PAGE_SIZE_COMPACT = 10

const DATE_RANGE_OPTIONS = [
  { value: 'd1', label: 'Last 24h' },
  { value: 'd3', label: 'Last 3 days' },
  { value: 'd7', label: 'Last 7 days' },
  { value: 'd30', label: 'Last 30 days' },
  { value: 'd90', label: 'Last 90 days' },
  { value: 'all', label: 'All time' }
] as const

type DateRange = (typeof DATE_RANGE_OPTIONS)[number]['value']

function dateRangeToFrom(range: DateRange): number | undefined {
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function shortModel(model: string | null): string {
  if (!model) return '—'
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'Opus'
  if (m.includes('sonnet')) return 'Sonnet'
  if (m.includes('haiku')) return 'Haiku'
  return model
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

type SortBy = 'updatedAt' | 'createdAt' | 'title'

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
        setRows(res.rows)
        setTotal(res.total)
        setLoading(false)
        onSessionCountChange?.(res.total)
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
    onSessionCountChange
  ])

  // Filter changes reset to page 1; these go through handlers so we never set
  // state synchronously from an effect.
  function changeSearch(v: string): void {
    setSearch(v)
    setPage(1)
  }
  function changeDateRange(v: DateRange): void {
    setDateRange(v)
    setPage(1)
  }
  function changeSort(by: SortBy, dir: 'asc' | 'desc'): void {
    setSortBy(by)
    setSortDir(dir)
    setPage(1)
  }

  async function handleRowClick(row: SessionRecord): Promise<void> {
    if (resumingId) return
    setResumingId(row.id)
    try {
      const ws = await window.api.sessions.resumeInNewWorkspace(row.id, projectId)
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
      render: (r) => (
        <span className="truncate" title={r.title ?? r.id}>
          {r.title ?? <span className="text-text-muted italic">untitled</span>}
        </span>
      )
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
      width: '44px',
      align: 'right',
      render: (r) => {
        const isResuming = resumingId === r.id
        return (
          <span
            className={[
              'inline-flex items-center justify-center w-6 h-6 rounded-md',
              isResuming ? 'text-accent' : 'text-text-muted'
            ].join(' ')}
            title={isResuming ? 'Opening workspace…' : 'Resume in new workspace'}
            aria-label={isResuming ? 'Resuming' : 'Resume in new workspace'}
          >
            {isResuming ? <Spinner size="sm" /> : <Play size={11} weight="fill" />}
          </span>
        )
      }
    }
    const deleteCol: DataTableColumn<SessionRecord> = {
      key: 'delete',
      label: '',
      width: '36px',
      align: 'right',
      render: (r) => (
        <button
          type="button"
          onClick={(e) => {
            // Stop the row's onClick (which would resume the session).
            e.stopPropagation()
            setPendingDelete(r)
          }}
          aria-label="Delete session"
          title="Delete session"
          className="inline-flex items-center justify-center w-6 h-6 rounded-md text-text-muted hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
        >
          <Trash size={11} />
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
  }, [resumingId, compact])

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

  const emptyState = (
    <div className="flex flex-col items-center gap-2">
      <ChatCircle size={22} className="text-text-muted opacity-50" />
      <p className="text-sm text-text-muted">
        {debouncedSearch ? 'No sessions match your search' : 'No sessions yet'}
      </p>
      {!debouncedSearch && (
        <p className="text-xs text-text-muted max-w-xs text-center">
          Start Claude Code in this project and your sessions will appear here.
        </p>
      )}
    </div>
  )

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <MagnifyingGlass
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => changeSearch(e.target.value)}
            placeholder="Search prompts"
            className="w-full pl-7 pr-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:border-accent/40 transition-colors"
          />
        </div>
        <div className="w-44">
          <Select<DateRange>
            ariaLabel="Date range"
            options={DATE_RANGE_OPTIONS as ReadonlyArray<{ value: DateRange; label: string }>}
            value={dateRange}
            onChange={changeDateRange}
          />
        </div>
      </div>

      <DataTable<SessionRecord>
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyState={emptyState}
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
                This will move the JSONL transcript to your Trash and remove the session
                from Orpheus's list. You can recover from Finder Trash if you change your
                mind.
              </p>
              {pendingDelete.title && (
                <p className="mt-2 text-xs text-text-muted italic truncate">
                  "{pendingDelete.title}"
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
