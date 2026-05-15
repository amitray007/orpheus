import { useEffect, useState } from 'react'
import type React from 'react'
import {
  Archive,
  ArrowUUpLeft,
  CaretDown,
  CaretRight,
  Folder,
  GitBranch,
  PencilSimple,
  Plus,
  PushPin,
  Terminal
} from '@phosphor-icons/react'
import type { GitStatus, WorkspaceActivityDetail, WorkspaceRecord } from '@shared/types'
import { ContextMenu, type ContextMenuItem } from '../../ContextMenu'
import { ActivityIndicator } from '../ActivityIndicator'

// ---------------------------------------------------------------------------
// Helpers
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
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  workspace: WorkspaceRecord
  archived?: boolean
  activity?: WorkspaceActivityDetail
  gitStatus?: GitStatus | null
  renaming: boolean
  onSelect: () => void
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onTogglePin: () => void
  onArchive: () => void
  onUnarchive?: () => void
}

function WorkspaceRow({
  workspace,
  archived = false,
  activity,
  gitStatus,
  renaming,
  onSelect,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onTogglePin,
  onArchive,
  onUnarchive
}: RowProps): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renameValue, setRenameValue] = useState(workspace.name)

  if (!renaming && renameValue !== workspace.name) {
    setRenameValue(workspace.name)
  }

  const isPinned = workspace.pinnedAt !== null

  function handleRenameCommit(): void {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== workspace.name) onFinishRename(trimmed)
    else onCancelRename()
  }

  const menuItems: ContextMenuItem[] = archived
    ? [
        {
          label: 'Unarchive',
          icon: <ArrowUUpLeft size={13} />,
          onClick: () => onUnarchive?.()
        },
        { label: 'Rename', icon: <PencilSimple size={13} />, onClick: onBeginRename }
      ]
    : [
        { label: 'Rename', icon: <PencilSimple size={13} />, onClick: onBeginRename },
        {
          label: isPinned ? 'Unpin' : 'Pin',
          icon: <PushPin size={13} weight={isPinned ? 'fill' : 'regular'} />,
          onClick: onTogglePin
        },
        { divider: true, label: '', onClick: () => {} },
        {
          label: 'Archive',
          icon: <Archive size={13} />,
          onClick: onArchive,
          destructive: true
        }
      ]

  return (
    <div
      onClick={renaming ? undefined : onSelect}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      className={[
        'group relative flex items-start gap-3 px-4 py-3',
        'border-b border-border-default/40 last:border-b-0',
        'transition-colors duration-100',
        renaming
          ? 'cursor-default bg-surface-overlay/30'
          : 'cursor-pointer hover:bg-surface-overlay/40',
        archived ? 'opacity-60 hover:opacity-90' : ''
      ].join(' ')}
    >
      {/* Status dot / activity */}
      <div className="flex items-center h-5 mt-0.5 flex-shrink-0 w-3">
        {archived ? (
          <span
            className="w-1.5 h-1.5 rounded-full bg-text-muted opacity-50"
            aria-label="Archived"
          />
        ) : activity ? (
          <ActivityIndicator detail={activity} />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-text-muted/40" aria-label="Idle" />
        )}
      </div>

      {/* Main content */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 min-w-0">
          {renaming ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameCommit()
                if (e.key === 'Escape') onCancelRename()
              }}
              onBlur={handleRenameCommit}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-sm font-medium bg-surface-overlay border border-accent/40 rounded px-2 py-0.5 outline-none text-text-primary min-w-0 flex-1 max-w-xs"
            />
          ) : (
            <span className="text-sm font-medium text-text-primary truncate">{workspace.name}</span>
          )}
          {isPinned && !archived && !renaming && (
            <PushPin size={11} weight="fill" className="text-accent flex-shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted min-w-0">
          {gitStatus?.branch && (
            <span className="inline-flex items-center gap-1 flex-shrink-0">
              <GitBranch size={10} />
              <span className="font-mono">{gitStatus.branch}</span>
              {gitStatus.hasChanges && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-amber-400/80"
                  title={`+${gitStatus.insertions} −${gitStatus.deletions}`}
                />
              )}
            </span>
          )}
          <span className="inline-flex items-center gap-1 min-w-0 truncate" title={workspace.cwd}>
            <Folder size={10} className="flex-shrink-0" />
            <span className="truncate">{workspace.cwd}</span>
          </span>
        </div>
      </div>

      {/* Right meta */}
      <div className="flex flex-col items-end gap-0.5 flex-shrink-0 text-xs text-text-muted">
        <span>
          {workspace.lastOpenedAt ? relativeTime(workspace.lastOpenedAt) : 'never opened'}
        </span>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

interface WorkspacesTabProps {
  projectId: string
  workspaces: WorkspaceRecord[] | null
  workspaceActivities: Record<string, WorkspaceActivityDetail>
  onAddWorkspace: (projectId: string) => void | Promise<void>
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
  workspaces,
  workspaceActivities,
  onAddWorkspace,
  onSelectWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onUnarchiveWorkspace,
  onToggleWorkspacePin
}: WorkspacesTabProps): React.JSX.Element {
  const loading = workspaces === null
  const all = workspaces ?? []
  const active = all.filter((w) => w.archivedAt === null)
  const archived = all.filter((w) => w.archivedAt !== null)

  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [archivedExpanded, setArchivedExpanded] = useState(false)
  const [gitByWs, setGitByWs] = useState<Record<string, GitStatus | null>>({})

  // Light-touch git status fetch for visible (active) workspaces. We use the
  // existing git:status IPC which itself has a 2s timeout and swallows errors,
  // so the worst case is a row without branch decoration.
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

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <p className="text-xs text-text-muted">
          {loading ? '…' : `${active.length} active`}
          {archived.length > 0 && !loading && ` · ${archived.length} archived`}
        </p>
        <button
          onClick={() => onAddWorkspace(projectId)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 border border-accent/30 text-text-primary hover:bg-accent/25 transition-colors duration-150 cursor-pointer"
        >
          <Plus size={11} weight="bold" />
          New workspace
        </button>
      </div>

      <div className="rounded-lg border border-border-default bg-surface-raised overflow-hidden">
        {loading ? (
          <div className="flex flex-col">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 px-4 py-3 border-b border-border-default/40 last:border-b-0"
                style={{ opacity: 0.4 + i * 0.2 }}
              >
                <div className="w-2 h-2 rounded-full bg-surface-overlay" />
                <div className="flex-1 flex flex-col gap-1">
                  <div className="h-3 bg-surface-overlay rounded w-32" />
                  <div className="h-2.5 bg-surface-overlay rounded w-48" />
                </div>
              </div>
            ))}
          </div>
        ) : active.length === 0 && archived.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10">
            <Terminal size={22} className="text-text-muted opacity-50" />
            <p className="text-sm text-text-muted">No workspaces yet</p>
            <p className="text-xs text-text-muted max-w-xs text-center">
              Create a workspace to start working in this project.
            </p>
          </div>
        ) : active.length === 0 ? (
          <div className="py-8 text-center text-sm text-text-muted">
            All workspaces are archived.
          </div>
        ) : (
          active.map((ws) => (
            <WorkspaceRow
              key={ws.id}
              workspace={ws}
              activity={workspaceActivities[ws.id]}
              gitStatus={gitByWs[ws.id]}
              renaming={renamingId === ws.id}
              onBeginRename={() => setRenamingId(ws.id)}
              onFinishRename={(newName) => {
                onRenameWorkspace(ws.id, projectId, newName)
                setRenamingId(null)
              }}
              onCancelRename={() => setRenamingId(null)}
              onSelect={() => onSelectWorkspace(ws.id)}
              onTogglePin={() => onToggleWorkspacePin(ws.id, projectId)}
              onArchive={() => onArchiveWorkspace(ws.id, projectId)}
            />
          ))
        )}
      </div>

      {archived.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            onClick={() => setArchivedExpanded((v) => !v)}
            className="self-start flex items-center gap-1.5 px-1 py-1 cursor-pointer hover:text-text-primary transition-colors duration-150"
          >
            {archivedExpanded ? (
              <CaretDown size={11} className="text-text-muted" />
            ) : (
              <CaretRight size={11} className="text-text-muted" />
            )}
            <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">
              Archived
            </span>
            <span className="text-xs text-text-muted ml-1">({archived.length})</span>
          </button>
          {archivedExpanded && (
            <div className="rounded-lg border border-border-default bg-surface-raised overflow-hidden">
              {archived.map((ws) => (
                <WorkspaceRow
                  key={ws.id}
                  workspace={ws}
                  archived
                  renaming={renamingId === ws.id}
                  onBeginRename={() => setRenamingId(ws.id)}
                  onFinishRename={(newName) => {
                    onRenameWorkspace(ws.id, projectId, newName)
                    setRenamingId(null)
                  }}
                  onCancelRename={() => setRenamingId(null)}
                  onSelect={() => onSelectWorkspace(ws.id)}
                  onTogglePin={() => onToggleWorkspacePin(ws.id, projectId)}
                  onArchive={() => onArchiveWorkspace(ws.id, projectId)}
                  onUnarchive={() => onUnarchiveWorkspace(ws.id, projectId)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
