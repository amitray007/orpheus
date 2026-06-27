import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { useFocusOnMount } from '@/lib/useFocusOnMount'
import {
  DotsThree,
  MagnifyingGlass,
  PencilSimple,
  PushPin,
  Trash,
  GitMerge
} from '@phosphor-icons/react'
import type { GitStatus, WorkspaceRecord } from '@shared/types'
import { ContextMenu, type ContextMenuItem } from '../../ContextMenu'
import { DataTable, type DataTableColumn } from '../../DataTable'
import { ActivityIndicator } from '../ActivityIndicator'
import { Eyebrow, Select } from '../settings/primitives'
import { resolveWorkspaceName } from '../resolveWorkspaceName'
import { CommitsTab } from './CommitsTab'
import { SessionsTab } from './SessionsTab'
import { useWorkspaceActivity } from '@/lib/activityStore'
import { useWorkspaceTitle, getTitleSnapshot } from '@/lib/titleStore'

// ---------------------------------------------------------------------------
// Project body — active workspaces on the left, sessions on the right, recent
// commits below. Replaces the old Active|Archived split tables now that
// archiving is a hard delete (v34+) and old conversations are reached through
// the Sessions panel instead.
// ---------------------------------------------------------------------------

// Matches SessionsTab's compact PAGE_SIZE (10) so the two side-by-side panels
// land at the same vertical extent and the Recent commits row below stays
// aligned with both footers.
const PAGE_SIZE = 10

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

type ActivityFilterKey = 'all' | 'in_review' | 'in_progress' | 'waiting'

const FILTER_OPTIONS: ReadonlyArray<{ value: ActivityFilterKey; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'in_review', label: 'In Review' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'waiting', label: 'Waiting' }
]

/**
 * Maps persisted workspace status to a filter group without requiring live
 * activity data. Mirrors the persisted-status branch of deriveGroup in
 * WorkspacesView.tsx but intentionally excludes 'done' (not tracked in
 * persisted status — only known via live activity events).
 */
function statusToGroup(ws: WorkspaceRecord): ActivityFilterKey {
  if (!ws.claudeSessionId) return 'waiting'
  if (ws.status === 'attention' || ws.status === 'awaiting_input') return 'in_review'
  if (ws.status === 'in_progress') return 'in_progress'
  return 'waiting'
}

function nullsLastCmp<T>(a: T | null | undefined, b: T | null | undefined): number {
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  if (a < b) return -1
  if (a > b) return 1
  return 0
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

interface WorkspacesTabProps {
  projectId: string
  /** Project filesystem path — used by the embedded Recent commits + Sessions panels. */
  projectPath: string
  workspaces: WorkspaceRecord[] | null
  onSelectWorkspace: (workspaceId: string) => void
  onRenameWorkspace: (
    workspaceId: string,
    projectId: string,
    newName: string
  ) => void | Promise<void>
  /** "Archive" is a hard delete in v34+. Kept the label for user familiarity. */
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void | Promise<void>
  onResumedInWorkspace: (workspace: WorkspaceRecord) => void
}

// Small component so useFocusOnMount fires when the rename input mounts
function WorkspaceRenameInput({
  value,
  onChange,
  onKeyDown,
  onBlur,
  onClick,
  className
}: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onBlur: () => void
  onClick: (e: React.MouseEvent<HTMLInputElement>) => void
  className: string
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  useFocusOnMount(ref)
  return (
    <input
      ref={ref}
      aria-label="Rename workspace"
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onClick={onClick}
      className={className}
    />
  )
}

// ---------------------------------------------------------------------------
// WorkspaceNameCell — isolated sub-component so useWorkspaceActivity is called
// as a proper hook (not inside a DataTable render callback). Re-renders only
// when this workspace's activity key changes.
// ---------------------------------------------------------------------------

interface WorkspaceNameCellProps {
  ws: WorkspaceRecord
  renamingId: string | null
  renameValue: string
  sessionStats: Record<
    string,
    { messageCount: number | null; jsonlSizeBytes: number | null; title: string | null }
  >
  setRenameValue: (v: string) => void
  commitRename: (ws: WorkspaceRecord) => void
  setRenamingId: (id: string | null) => void
}

const WorkspaceNameCell = memo(function WorkspaceNameCell({
  ws,
  renamingId,
  renameValue,
  sessionStats,
  setRenameValue,
  commitRename,
  setRenamingId
}: WorkspaceNameCellProps): React.JSX.Element {
  // Subscribe to this workspace's key only — re-renders only when this key changes.
  const activity = useWorkspaceActivity(ws.id)
  const terminalTitle = useWorkspaceTitle(ws.id)
  const isPinned = ws.pinnedAt !== null
  const dn = resolveWorkspaceName({
    workspace: ws,
    terminalTitle,
    sessionTitle: ws.claudeSessionId ? (sessionStats[ws.claudeSessionId]?.title ?? null) : null
  })
  return (
    <span className="flex items-center gap-2 min-w-0">
      <span className="flex items-center justify-center w-3 flex-shrink-0">
        {activity && activity !== 'archived' ? (
          <ActivityIndicator detail={activity} />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted/40" />
        )}
      </span>
      {renamingId === ws.id ? (
        <WorkspaceRenameInput
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename(ws)
            if (e.key === 'Escape') setRenamingId(null)
          }}
          onBlur={() => commitRename(ws)}
          onClick={(e) => e.stopPropagation()}
          className="text-sm bg-surface-overlay border border-accent/40 rounded px-1.5 py-0.5 outline-none text-text-primary min-w-0 flex-1"
        />
      ) : (
        <span
          className={['truncate', dn.muted ? 'text-text-muted italic' : ''].join(' ')}
          title={dn.text}
        >
          {dn.text}
        </span>
      )}
      {isPinned && !renamingId && (
        <PushPin size={10} weight="fill" className="text-accent flex-shrink-0" />
      )}
    </span>
  )
})

export function WorkspacesTab({
  projectId,
  projectPath,
  workspaces,
  onSelectWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onToggleWorkspacePin,
  onResumedInWorkspace
}: WorkspacesTabProps): React.JSX.Element {
  const loading = workspaces === null

  // Defensive id-dedup over the workspaces prop. The DB enforces a PK so this
  // is a no-op today; it's insurance against any future regression in the
  // optimistic-update paths producing React-key collisions in this table.
  const all = useMemo(() => {
    if (!workspaces) return []
    const byId = new Map<string, WorkspaceRecord>()
    for (const w of workspaces) byId.set(w.id, w)
    return [...byId.values()]
  }, [workspaces])

  // Archive is now hard delete — there are no archived rows to filter. Anything
  // present is active. The archivedAt field can stay populated on legacy rows
  // that survived between v33 and v34, but the v34 migration cleared those.
  const active = useMemo(() => all.filter((w) => w.archivedAt === null), [all])

  const [activePage, setActivePage] = useState(1)
  const [activeSortBy, setActiveSortBy] = useState<'lastOpenedAt' | 'messages'>('lastOpenedAt')
  const [activeSortDir, setActiveSortDir] = useState<'asc' | 'desc'>('desc')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; ws: WorkspaceRecord } | null>(null)
  const [gitByWs, setGitByWs] = useState<Record<string, GitStatus | null>>({})
  const [sessionStats, setSessionStats] = useState<
    Record<
      string,
      { messageCount: number | null; jsonlSizeBytes: number | null; title: string | null }
    >
  >({})

  // Search + filter state
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [activityFilter, setActivityFilter] = useState<ActivityFilterKey>('all')

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 250)
    return () => clearTimeout(t)
  }, [search])

  // Background git status for visible active rows.
  useEffect(() => {
    let cancelled = false
    for (const ws of active) {
      if (gitByWs[ws.id] !== undefined) continue
      window.api.git
        .status(ws.cwd)
        .then((s) => {
          if (cancelled) return
          setGitByWs((prev) => ({ ...prev, [ws.id]: s }))
        })
        .catch(() => {
          if (cancelled) return
          setGitByWs((prev) => ({ ...prev, [ws.id]: null }))
        })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.map((w) => w.id).join('|')])

  // Terminal titles are now served by the global titleStore (seeded from Dashboard's
  // hoisted onTitleChanged subscription). WorkspaceNameCell calls useWorkspaceTitle
  // directly, so no per-row subscription is needed here.

  // Refresh session metadata then load it for the Messages column lookup.
  useEffect(() => {
    let cancelled = false
    window.api.sessions
      .refreshMetadata(projectId)
      .then(() => window.api.sessions.listForProject(projectId, { includeArchived: true }))
      .then((sessions) => {
        if (cancelled) return
        const map: typeof sessionStats = {}
        for (const s of sessions) {
          map[s.id] = {
            messageCount: s.messageCount ?? null,
            jsonlSizeBytes: s.jsonlSizeBytes ?? null,
            title: s.title ?? null
          }
        }
        setSessionStats(map)
      })
      .catch((err) => console.error('[workspaces-tab] sessions load failed', err))
    return () => {
      cancelled = true
    }
  }, [projectId])

  function messageCountForWorkspace(ws: WorkspaceRecord): number | null {
    if (!ws.claudeSessionId) return null
    return sessionStats[ws.claudeSessionId]?.messageCount ?? null
  }

  function openMenu(e: React.MouseEvent, ws: WorkspaceRecord): void {
    e.stopPropagation()
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: rect.right - 180, y: rect.bottom + 4, ws })
  }

  function beginRename(ws: WorkspaceRecord): void {
    setRenamingId(ws.id)
    setRenameValue(ws.name)
  }

  const commitRename = useCallback(
    (ws: WorkspaceRecord): void => {
      const trimmed = renameValue.trim()
      if (trimmed && trimmed !== ws.name) {
        onRenameWorkspace(ws.id, projectId, trimmed)
      }
      setRenamingId(null)
    },
    [renameValue, onRenameWorkspace, projectId]
  )

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!menu) return []
    const ws = menu.ws
    const isPinned = ws.pinnedAt !== null
    return [
      { label: 'Rename', icon: <PencilSimple size={13} />, onClick: () => beginRename(ws) },
      {
        label: isPinned ? 'Unpin' : 'Pin',
        icon: <PushPin size={13} weight={isPinned ? 'fill' : 'regular'} />,
        onClick: () => onToggleWorkspacePin(ws.id, projectId)
      },
      { divider: true, label: '', onClick: () => {} },
      {
        // v34+: archive is a hard delete. Label it honestly.
        label: 'Delete workspace',
        icon: <Trash size={13} />,
        onClick: () => onArchiveWorkspace(ws.id, projectId),
        destructive: true
      }
    ]
  }, [menu, projectId, onArchiveWorkspace, onToggleWorkspacePin])

  // Filter active workspaces by activity group and search term.
  const filtered = useMemo(() => {
    let out = active

    if (activityFilter !== 'all') {
      out = out.filter((ws) => statusToGroup(ws) === activityFilter)
    }

    if (debouncedSearch) {
      const q = debouncedSearch // already lowercased
      // Read titles from the module-level titleStore snapshot at filter time.
      // This is not reactive — search re-runs when debouncedSearch changes,
      // which is the right trigger. Live title updates will apply on next search.
      const titleSnapshot = getTitleSnapshot()
      out = out.filter((ws) => {
        const dn = resolveWorkspaceName({
          workspace: ws,
          terminalTitle: titleSnapshot.get(ws.id) ?? null,
          sessionTitle: ws.claudeSessionId
            ? (sessionStats[ws.claudeSessionId]?.title ?? null)
            : null
        }).text.toLowerCase()
        const basename = ws.cwd.split('/').pop()?.toLowerCase() ?? ''
        return dn.includes(q) || basename.includes(q)
      })
    }

    return out
  }, [active, activityFilter, debouncedSearch, sessionStats])

  const activeSorted = useMemo(() => {
    const copy = [...filtered]
    copy.sort((a, b) => {
      let cmp: number
      if (activeSortBy === 'messages') {
        cmp = nullsLastCmp(messageCountForWorkspace(a), messageCountForWorkspace(b))
      } else {
        cmp = nullsLastCmp(a.lastOpenedAt, b.lastOpenedAt)
      }
      return activeSortDir === 'asc' ? cmp : -cmp
    })
    return copy
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, activeSortBy, activeSortDir, sessionStats])

  const activePaginated = useMemo(
    () => activeSorted.slice((activePage - 1) * PAGE_SIZE, activePage * PAGE_SIZE),
    [activeSorted, activePage]
  )

  const activeColumns: DataTableColumn<WorkspaceRecord>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Workspace',
        render: (ws) => (
          <WorkspaceNameCell
            ws={ws}
            renamingId={renamingId}
            renameValue={renameValue}
            sessionStats={sessionStats}
            setRenameValue={setRenameValue}
            commitRename={commitRename}
            setRenamingId={setRenamingId}
          />
        )
      },
      {
        key: 'branch',
        label: 'Branch',
        width: '140px',
        render: (ws) => {
          const gs = gitByWs[ws.id]
          if (!gs?.branch) return <span className="text-text-muted">—</span>
          return (
            <span
              className="inline-flex items-center gap-1 text-xs min-w-0"
              title={`Branch: ${gs.branch}`}
            >
              <GitMerge size={11} className="flex-shrink-0 text-text-muted" />
              <span className="font-mono truncate">{gs.branch}</span>
            </span>
          )
        }
      },
      {
        key: 'messages',
        label: 'Msgs',
        width: '70px',
        align: 'right',
        sortable: true,
        render: (ws) => {
          const n = messageCountForWorkspace(ws)
          return (
            <span className="text-text-muted text-xs tabular-nums">
              {typeof n === 'number' ? n : '—'}
            </span>
          )
        }
      },
      {
        key: 'lastOpenedAt',
        label: 'Last opened',
        width: '140px',
        sortable: true,
        render: (ws) => (
          <span className="text-text-muted text-xs whitespace-nowrap">
            {ws.lastOpenedAt ? relativeTime(ws.lastOpenedAt) : 'never'}
          </span>
        )
      },
      {
        key: 'menu',
        label: '',
        width: '52px',
        cellPadded: false,
        align: 'right',
        render: (ws) => (
          <button
            type="button"
            onClick={(e) => openMenu(e, ws)}
            aria-label="Row actions"
            className={[
              'inline-flex items-center justify-center w-8 h-8 rounded-md',
              'text-text-muted transition-colors duration-150 cursor-pointer',
              'hover:text-text-primary hover:bg-surface-overlay',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
            ].join(' ')}
          >
            <DotsThree size={18} weight="bold" />
          </button>
        )
      }
    ],
    [gitByWs, renamingId, renameValue, sessionStats, commitRename]
  )

  // Whether the raw workspace list (before any filtering) has any entries.
  // Used to distinguish "no workspaces at all" from "filtered to zero".
  const hasWorkspaces = active.length > 0

  // The activity filter narrowed everything away even though workspaces exist —
  // surface a one-click "Show all" so the list isn't a confusing empty state
  // (mirrors the SessionsTab auto-widen hint).
  const filteredToEmpty = hasWorkspaces && filtered.length === 0 && activityFilter !== 'all'

  return (
    <div className="flex flex-col gap-4">
      {/* Active workspaces (left) + Sessions panel (right) — Sessions
          replaces the archived table that lived here before v34. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2 min-w-0">
          <Eyebrow>
            Workspaces · {filtered.length}
            {filtered.length !== active.length && ` of ${active.length}`}
          </Eyebrow>

          {/* Filter bar — always present so search + filter stay available, even when empty */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1 min-w-0">
              <MagnifyingGlass
                size={12}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
              />
              <input
                type="text"
                aria-label="Search workspaces"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                  setActivePage(1)
                }}
                placeholder="Search workspaces"
                className="w-full pl-7 pr-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:border-accent/40 transition-colors"
              />
            </div>
            <div className="w-44 flex-shrink-0">
              <Select<ActivityFilterKey>
                ariaLabel="Activity filter"
                options={FILTER_OPTIONS}
                value={activityFilter}
                onChange={(v) => {
                  setActivityFilter(v)
                  setActivePage(1)
                }}
              />
            </div>
          </div>

          <DataTable<WorkspaceRecord>
            columns={activeColumns}
            rows={activePaginated}
            rowKey={(ws) => ws.id}
            loading={loading}
            emptyState={
              !hasWorkspaces ? (
                <p className="text-sm text-text-muted text-center">
                  No workspaces yet. Use + New workspace to start one.
                </p>
              ) : filteredToEmpty ? (
                <p className="text-sm text-text-muted text-center">
                  No workspaces match this filter.{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setActivityFilter('all')
                      setActivePage(1)
                    }}
                    className="text-accent hover:underline cursor-pointer"
                  >
                    Show all
                  </button>
                </p>
              ) : (
                <p className="text-sm text-text-muted text-center">No matching workspaces.</p>
              )
            }
            sortBy={activeSortBy}
            sortDir={activeSortDir}
            onSortChange={(by, dir) => {
              if (by === 'lastOpenedAt' || by === 'messages') {
                setActiveSortBy(by)
                setActiveSortDir(dir)
                setActivePage(1)
              }
            }}
            onRowClick={(ws) => {
              if (renamingId === ws.id) return
              onSelectWorkspace(ws.id)
            }}
            pagination={{
              page: activePage,
              pageSize: PAGE_SIZE,
              total: filtered.length,
              onPageChange: setActivePage
            }}
          />
        </div>

        <div className="flex flex-col gap-2 min-w-0">
          <Eyebrow>Sessions</Eyebrow>
          <SessionsTab projectId={projectId} onResumedInWorkspace={onResumedInWorkspace} compact />
        </div>
      </div>

      <div className="flex flex-col gap-2 mt-2">
        <Eyebrow>Recent commits</Eyebrow>
        <CommitsTab cwd={projectPath} />
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} />
      )}
    </div>
  )
}
