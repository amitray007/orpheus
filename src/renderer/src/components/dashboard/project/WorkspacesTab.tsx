import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import {
  Archive,
  ArrowUUpLeft,
  DotsThree,
  GitMerge,
  PencilSimple,
  PushPin,
  Terminal
} from '@phosphor-icons/react'
import type { GitStatus, WorkspaceActivityDetail, WorkspaceRecord } from '@shared/types'
import { ContextMenu, type ContextMenuItem } from '../../ContextMenu'
import { DataTable, type DataTableColumn } from '../../DataTable'
import { ActivityIndicator } from '../ActivityIndicator'
import { CommitsTab } from './CommitsTab'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAGE_SIZE = 8

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

interface WorkspacesTabProps {
  projectId: string
  /** Project filesystem path — used to feed the embedded Recent commits panel. */
  projectPath: string
  workspaces: WorkspaceRecord[] | null
  workspaceActivities: Record<string, WorkspaceActivityDetail>
  onSelectWorkspace: (workspaceId: string) => void
  onRenameWorkspace: (
    workspaceId: string,
    projectId: string,
    newName: string
  ) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onUnarchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void | Promise<void>
}

export function WorkspacesTab({
  projectId,
  projectPath,
  workspaces,
  workspaceActivities,
  onSelectWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onUnarchiveWorkspace,
  onToggleWorkspacePin
}: WorkspacesTabProps): React.JSX.Element {
  const loading = workspaces === null
  const all = workspaces ?? []
  const active = useMemo(() => all.filter((w) => w.archivedAt === null), [all])
  const archived = useMemo(() => all.filter((w) => w.archivedAt !== null), [all])

  const [activePage, setActivePage] = useState(1)
  const [archivedPage, setArchivedPage] = useState(1)
  const [activeSortBy, setActiveSortBy] = useState<'lastOpenedAt' | 'messages'>('lastOpenedAt')
  const [activeSortDir, setActiveSortDir] = useState<'asc' | 'desc'>('desc')
  const [archivedSortBy, setArchivedSortBy] = useState<'archivedAt' | 'lastOpenedAt'>('archivedAt')
  const [archivedSortDir, setArchivedSortDir] = useState<'asc' | 'desc'>('desc')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [menu, setMenu] = useState<{ x: number; y: number; ws: WorkspaceRecord } | null>(null)
  const [gitByWs, setGitByWs] = useState<Record<string, GitStatus | null>>({})
  const [titleByWs, setTitleByWs] = useState<Record<string, string | null>>({})
  const [sessionStats, setSessionStats] = useState<
    Record<string, { messageCount: number | null; jsonlSizeBytes: number | null }>
  >({})

  // Refresh session metadata then load it so the Messages column reflects
  // the current JSONL state. Cheap: refreshMetadata is idempotent and only
  // does work where rows are stale or new.
  useEffect(() => {
    let cancelled = false
    window.api.sessions
      .refreshMetadata(projectId)
      .then(() => window.api.sessions.listForProject(projectId, { includeArchived: true }))
      .then((sessions) => {
        if (cancelled) return
        const map: Record<string, { messageCount: number | null; jsonlSizeBytes: number | null }> =
          {}
        for (const s of sessions) {
          map[s.id] = {
            messageCount: s.messageCount ?? null,
            jsonlSizeBytes: s.jsonlSizeBytes ?? null
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

  // Seed and subscribe to terminal titles for visible active rows so the
  // Name column reflects the live OSC title (matching Sidebar behavior).
  useEffect(() => {
    let cancelled = false
    for (const ws of active) {
      if (titleByWs[ws.id] !== undefined) continue
      window.api.workspaces
        .getTitle(ws.id)
        .then((t) => {
          if (cancelled) return
          setTitleByWs((prev) => ({ ...prev, [ws.id]: t ?? null }))
        })
        .catch(() => {
          if (cancelled) return
          setTitleByWs((prev) => ({ ...prev, [ws.id]: null }))
        })
    }
    const unsub = window.api.workspaces.onTitleChanged((e) => {
      if (cancelled) return
      setTitleByWs((prev) => ({ ...prev, [e.workspaceId]: e.title || null }))
    })
    return () => {
      cancelled = true
      unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.map((w) => w.id).join('|')])

  // Background git status for visible active rows (each call is short-timeout
  // + error-swallowing so worst case is no branch decoration).
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

  function commitRename(ws: WorkspaceRecord): void {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== ws.name) {
      onRenameWorkspace(ws.id, projectId, trimmed)
    }
    setRenamingId(null)
  }

  const menuItems: ContextMenuItem[] = useMemo(() => {
    if (!menu) return []
    const ws = menu.ws
    const isPinned = ws.pinnedAt !== null
    if (ws.archivedAt !== null) {
      return [
        {
          label: 'Unarchive',
          icon: <ArrowUUpLeft size={13} />,
          onClick: () => onUnarchiveWorkspace(ws.id, projectId)
        },
        {
          label: 'Rename',
          icon: <PencilSimple size={13} />,
          onClick: () => beginRename(ws)
        }
      ]
    }
    return [
      {
        label: 'Rename',
        icon: <PencilSimple size={13} />,
        onClick: () => beginRename(ws)
      },
      {
        label: isPinned ? 'Unpin' : 'Pin',
        icon: <PushPin size={13} weight={isPinned ? 'fill' : 'regular'} />,
        onClick: () => onToggleWorkspacePin(ws.id, projectId)
      },
      { divider: true, label: '', onClick: () => {} },
      {
        label: 'Archive',
        icon: <Archive size={13} />,
        onClick: () => onArchiveWorkspace(ws.id, projectId),
        destructive: true
      }
    ]
  }, [menu, projectId, onArchiveWorkspace, onUnarchiveWorkspace, onToggleWorkspacePin])

  const activeColumns: DataTableColumn<WorkspaceRecord>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Workspace',
        render: (ws) => {
          const activity = workspaceActivities[ws.id]
          const isPinned = ws.pinnedAt !== null
          // Mirror Sidebar.tsx: auto-named workspaces show the live terminal
          // title when one exists. Manually-renamed workspaces always show
          // their persisted name.
          const terminalTitle = titleByWs[ws.id] ?? null
          const displayName = ws.nameIsAuto ? terminalTitle || ws.name : ws.name
          return (
            <span className="flex items-center gap-2 min-w-0">
              <span className="flex items-center justify-center w-3 flex-shrink-0">
                {activity ? (
                  <ActivityIndicator detail={activity} />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-text-muted/40" />
                )}
              </span>
              {renamingId === ws.id ? (
                <input
                  autoFocus
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
                <span className="truncate" title={displayName}>
                  {displayName}
                </span>
              )}
              {isPinned && !renamingId && (
                <PushPin size={10} weight="fill" className="text-accent flex-shrink-0" />
              )}
            </span>
          )
        }
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
        width: '44px',
        align: 'right',
        render: (ws) => (
          <button
            onClick={(e) => openMenu(e, ws)}
            aria-label="Row actions"
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors cursor-pointer"
          >
            <DotsThree size={18} weight="bold" />
          </button>
        )
      }
    ],
    [gitByWs, titleByWs, workspaceActivities, renamingId, renameValue, sessionStats]
  )

  const archivedColumns: DataTableColumn<WorkspaceRecord>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Workspace',
        render: (ws) => (
          <span className="truncate text-text-secondary" title={ws.name}>
            {ws.name}
          </span>
        )
      },
      {
        key: 'messages',
        label: 'Msgs',
        width: '70px',
        align: 'right',
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
        key: 'archivedAt',
        label: 'Archived',
        width: '120px',
        sortable: true,
        render: (ws) => (
          <span className="text-text-muted text-xs whitespace-nowrap">
            {ws.archivedAt ? relativeTime(ws.archivedAt) : '—'}
          </span>
        )
      },
      {
        key: 'lastOpenedAt',
        label: 'Last opened',
        width: '120px',
        sortable: true,
        render: (ws) => (
          <span className="text-text-muted text-xs whitespace-nowrap">
            {ws.lastOpenedAt ? relativeTime(ws.lastOpenedAt) : 'never'}
          </span>
        )
      },
      {
        key: 'unarchive',
        label: '',
        width: '44px',
        align: 'right',
        render: (ws) => (
          <button
            onClick={(e) => {
              e.stopPropagation()
              onUnarchiveWorkspace(ws.id, projectId)
            }}
            aria-label="Unarchive"
            title="Unarchive"
            className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors cursor-pointer"
          >
            <ArrowUUpLeft size={14} />
          </button>
        )
      }
    ],
    [onUnarchiveWorkspace, projectId, sessionStats]
  )

  function nullsLastCmp<T>(a: T | null | undefined, b: T | null | undefined): number {
    if (a === null || a === undefined) return 1
    if (b === null || b === undefined) return -1
    if (a < b) return -1
    if (a > b) return 1
    return 0
  }

  const activeSorted = useMemo(() => {
    const copy = [...active]
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
  }, [active, activeSortBy, activeSortDir, sessionStats])

  const archivedSorted = useMemo(() => {
    const copy = [...archived]
    copy.sort((a, b) => {
      const cmp =
        archivedSortBy === 'lastOpenedAt'
          ? nullsLastCmp(a.lastOpenedAt, b.lastOpenedAt)
          : nullsLastCmp(a.archivedAt, b.archivedAt)
      return archivedSortDir === 'asc' ? cmp : -cmp
    })
    return copy
  }, [archived, archivedSortBy, archivedSortDir])

  const activePaginated = activeSorted.slice(
    (activePage - 1) * PAGE_SIZE,
    activePage * PAGE_SIZE
  )
  const archivedPaginated = archivedSorted.slice(
    (archivedPage - 1) * PAGE_SIZE,
    archivedPage * PAGE_SIZE
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2 min-w-0">
          <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Active{active.length > 0 && ` · ${active.length}`}
          </h3>
          {!loading && active.length === 0 ? (
            <div className="rounded-lg border border-border-default bg-surface-raised py-8 flex flex-col items-center gap-2">
              <Terminal size={20} className="text-text-muted opacity-50" />
              <p className="text-xs text-text-muted">No active workspaces</p>
            </div>
          ) : (
            <DataTable<WorkspaceRecord>
              columns={activeColumns}
              rows={activePaginated}
              rowKey={(ws) => ws.id}
              loading={loading}
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
              pagination={
                active.length > PAGE_SIZE
                  ? {
                      page: activePage,
                      pageSize: PAGE_SIZE,
                      total: active.length,
                      onPageChange: setActivePage
                    }
                  : undefined
              }
            />
          )}
        </div>

        <div className="flex flex-col gap-2 min-w-0">
          <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Archived{archived.length > 0 && ` · ${archived.length}`}
          </h3>
          {!loading && archived.length === 0 ? (
            <div className="rounded-lg border border-border-default bg-surface-raised py-8 flex flex-col items-center gap-2">
              <Archive size={18} className="text-text-muted opacity-50" />
              <p className="text-xs text-text-muted">Nothing archived</p>
            </div>
          ) : (
            <DataTable<WorkspaceRecord>
              columns={archivedColumns}
              rows={archivedPaginated}
              rowKey={(ws) => ws.id}
              loading={loading}
              sortBy={archivedSortBy}
              sortDir={archivedSortDir}
              onSortChange={(by, dir) => {
                if (by === 'archivedAt' || by === 'lastOpenedAt') {
                  setArchivedSortBy(by)
                  setArchivedSortDir(dir)
                  setArchivedPage(1)
                }
              }}
              onRowClick={async (ws) => {
                // Opening an archived workspace promotes it to active first —
                // the user clearly wants to keep working in it.
                await onUnarchiveWorkspace(ws.id, projectId)
                onSelectWorkspace(ws.id)
              }}
              pagination={
                archived.length > PAGE_SIZE
                  ? {
                      page: archivedPage,
                      pageSize: PAGE_SIZE,
                      total: archived.length,
                      onPageChange: setArchivedPage
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 mt-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
          Recent commits
        </h3>
        <CommitsTab cwd={projectPath} />
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} />
      )}
    </div>
  )
}
