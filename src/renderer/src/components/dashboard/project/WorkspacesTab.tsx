import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import {
  DotsThree,
  PencilSimple,
  PushPin,
  Terminal,
  Trash,
  GitMerge
} from '@phosphor-icons/react'
import type {
  GitStatus,
  WorkspaceActivityDetail,
  WorkspaceRecord
} from '@shared/types'
import { ContextMenu, type ContextMenuItem } from '../../ContextMenu'
import { DataTable, type DataTableColumn } from '../../DataTable'
import { ActivityIndicator } from '../ActivityIndicator'
import { CommitsTab } from './CommitsTab'
import { SessionsTab } from './SessionsTab'

// ---------------------------------------------------------------------------
// Project body — active workspaces on the left, sessions on the right, recent
// commits below. Replaces the old Active|Archived split tables now that
// archiving is a hard delete (v34+) and old conversations are reached through
// the Sessions panel instead.
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

interface WorkspacesTabProps {
  projectId: string
  /** Project filesystem path — used by the embedded Recent commits + Sessions panels. */
  projectPath: string
  workspaces: WorkspaceRecord[] | null
  workspaceActivities: Record<string, WorkspaceActivityDetail>
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

export function WorkspacesTab({
  projectId,
  projectPath,
  workspaces,
  workspaceActivities,
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
  const [titleByWs, setTitleByWs] = useState<Record<string, string | null>>({})
  const [sessionStats, setSessionStats] = useState<
    Record<
      string,
      { messageCount: number | null; jsonlSizeBytes: number | null; title: string | null }
    >
  >({})

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

  // Subscribe to terminal title for every workspace in the list — the Name
  // column shows the latest OSC title when one's available.
  useEffect(() => {
    let cancelled = false
    for (const ws of all) {
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
  }, [all.map((w) => w.id).join('|')])

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

  /**
   * Display-name resolution (mirrors the same fallback ladder used elsewhere):
   *   1. Manual rename → the explicit name
   *   2. Live terminal OSC title
   *   3. First user prompt from the workspace's claude_session_id session
   *   4. Muted "untitled · createdAt · short-id" so multiple never-opened stubs
   *      never look identical.
   */
  function displayNameForWorkspace(ws: WorkspaceRecord): { text: string; muted: boolean } {
    if (!ws.nameIsAuto) return { text: ws.name, muted: false }
    const terminalTitle = titleByWs[ws.id]
    if (terminalTitle) return { text: terminalTitle, muted: false }
    const sessionTitle = ws.claudeSessionId
      ? (sessionStats[ws.claudeSessionId]?.title ?? null)
      : null
    if (sessionTitle) return { text: sessionTitle, muted: false }
    const shortId = ws.id.slice(0, 6)
    const when = relativeTime(ws.createdAt)
    return { text: `untitled · ${when} · ${shortId}`, muted: true }
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

  const activePaginated = activeSorted.slice(
    (activePage - 1) * PAGE_SIZE,
    activePage * PAGE_SIZE
  )

  const activeColumns: DataTableColumn<WorkspaceRecord>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Workspace',
        render: (ws) => {
          const activity = workspaceActivities[ws.id]
          const isPinned = ws.pinnedAt !== null
          const dn = displayNameForWorkspace(ws)
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
        width: '52px',
        cellPadded: false,
        align: 'right',
        render: (ws) => (
          <button
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
    [gitByWs, titleByWs, workspaceActivities, renamingId, renameValue, sessionStats]
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Active workspaces (left) + Sessions panel (right) — Sessions
          replaces the archived table that lived here before v34. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2 min-w-0">
          <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Workspaces{active.length > 0 && ` · ${active.length}`}
          </h3>
          {!loading && active.length === 0 ? (
            <div className="rounded-lg border border-border-default bg-surface-raised py-8 flex flex-col items-center gap-2">
              <Terminal size={20} className="text-text-muted opacity-50" />
              <p className="text-xs text-text-muted">No workspaces yet</p>
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
            Sessions
          </h3>
          <SessionsTab
            projectId={projectId}
            onResumedInWorkspace={onResumedInWorkspace}
            compact
          />
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
