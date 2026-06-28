import type React from 'react'
import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { useFocusOnMount } from '@/lib/useFocusOnMount'
import {
  Circle,
  Kanban,
  Plus,
  CaretDown,
  CaretRight,
  Stack,
  Archive,
  Gear,
  GitFork,
  PushPin
} from '@phosphor-icons/react'
import type { PinnedItem, ProjectRecord, SessionRecord, WorkspaceRecord } from '@shared/types'
import { ProjectListSkeleton } from '../Skeleton'
import { Identicon } from '../Identicon'
import { ContextMenu } from '../ContextMenu'
import type { ContextMenuItem } from '../ContextMenu'
import { ActivityIndicator } from './ActivityIndicator'
import { resolveWorkspaceName } from './resolveWorkspaceName'
import { SidebarBoundsContext, useSidebarBounds } from './SidebarBoundsContext'
import { useWorkspaceActivity } from '@/lib/activityStore'
import { useWorkspaceActivityTime } from '@/lib/activityTimeStore'
import { useWorkspaceTitle } from '@/lib/titleStore'
import { useGitStatus } from '@/lib/gitStore'
import { usePr } from '@/lib/prStore'
import { showHoverPopover, hideNativePopover, onNativePopoverClosed } from '@/lib/nativePopover'
import { formatRelativeTime, EMPTY_TITLE_MAP, EMPTY_MTIME_MAP } from './sidebar.helpers'
import { NavItem, SectionHeader } from './SidebarNavItems'
import { CollapsedProjectList } from './CollapsedProjectList'

// ---------------------------------------------------------------------------
// Workspace sub-row (nested inside expanded project row)
// ---------------------------------------------------------------------------

interface WorkspaceRowProps {
  workspace: WorkspaceRecord
  project: ProjectRecord
  active: boolean
  /** Map from claudeSessionId → first-user-prompt title (fetched once per project). */
  sessionTitleBySessionId: Map<string, string>
  /** Map from claudeSessionId → last user message preview (fetched once per project). */
  sessionUserPreviewBySessionId: Map<string, string>
  /** Map from claudeSessionId → jsonlMtime (epoch ms) for all sessions in this project. */
  sessionMtimeBySessionId: Map<string, number>
  /** Stale threshold in minutes (from AppUiState). */
  staleAfterMinutes: number
  /** Current time in epoch ms, updated once per minute at sidebar root. */
  nowMs: number
  onSelect: () => void
  renaming: boolean
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onArchive: () => void
  onClose: () => void
  onTogglePin: () => void
}

// Small component so useFocusOnMount fires when the rename input mounts
function WorkspaceRenameInput({
  value,
  onChange,
  onKeyDown,
  onBlur,
  onClick,
  onMouseDown,
  className,
  ariaLabel
}: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onBlur: () => void
  onClick: (e: React.MouseEvent<HTMLInputElement>) => void
  onMouseDown: (e: React.MouseEvent<HTMLInputElement>) => void
  className: string
  ariaLabel: string
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  useFocusOnMount(ref)
  return (
    <input
      ref={ref}
      aria-label={ariaLabel}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onClick={onClick}
      onMouseDown={onMouseDown}
      className={className}
    />
  )
}

const WorkspaceSubRow = memo(function WorkspaceSubRow({
  workspace,
  active,
  sessionTitleBySessionId,
  sessionMtimeBySessionId,
  nowMs,
  onSelect,
  renaming,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onArchive,
  onClose,
  onTogglePin
}: WorkspaceRowProps): React.JSX.Element {
  // Subscribe to this workspace's key only — no re-render on other workspaces
  const activity = useWorkspaceActivity(workspace.id)
  const isBusy = activity === 'working'
  const isClosed = workspace.closedAt !== null
  const liveActivityAt = useWorkspaceActivityTime(workspace.id)
  const terminalTitle = useWorkspaceTitle(workspace.id)
  const gitStatus = useGitStatus(workspace.id)
  const pr = usePr(workspace.id)
  const [hovered, setHovered] = useState(false)
  const [renameValue, setRenameValue] = useState(workspace.name)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const sidebarBoundsRef = useSidebarBounds()

  const sessionTitle = workspace.claudeSessionId
    ? (sessionTitleBySessionId.get(workspace.claudeSessionId) ?? null)
    : null

  const dn = resolveWorkspaceName({ workspace, terminalTitle, sessionTitle })
  const displayName = dn.text

  // Seed the rename input with whatever the user currently sees, so renaming
  // from a Claude title doesn't snap back to "New workspace".
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- conditional sync: only updates when renaming mode activates
    if (renaming) setRenameValue(displayName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming])

  function handleContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const rect = sidebarBoundsRef?.current?.getBoundingClientRect()
    if (!rect || rect.width < 200) {
      const isPinned = workspace.pinnedAt !== null
      void window.api.contextMenu
        .show([
          { label: isPinned ? 'Unpin' : 'Pin', action: 'togglePin' },
          { label: 'Rename', action: 'rename' },
          { divider: true },
          ...(!isClosed && !isBusy ? [{ label: 'Close', action: 'close' }] : []),
          { label: 'Archive', action: 'archive' }
        ])
        .then((action) => {
          if (!action) return
          if (action === 'togglePin') onTogglePin()
          else if (action === 'rename') onBeginRename()
          else if (action === 'close') onClose()
          else if (action === 'archive') onArchive()
        })
      return
    }
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const isPinned = workspace.pinnedAt !== null
  const wsMenuItems: ContextMenuItem[] = [
    { label: isPinned ? 'Unpin' : 'Pin', onClick: onTogglePin },
    { label: 'Rename', onClick: onBeginRename },
    { label: '', divider: true, onClick: () => {} },
    ...(!isClosed && !isBusy ? [{ label: 'Close', onClick: onClose }] : []),
    { label: 'Archive', onClick: onArchive }
  ]

  function handleRenameCommit(): void {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== workspace.name) {
      onFinishRename(trimmed)
    } else {
      onCancelRename()
    }
    setRenameValue(workspace.name) // reset so a future rename starts clean
  }

  // Freshness display — live activity time wins; jsonl mtime is the fallback for
  // workspaces with no activity since launch. Take the max so a freshly loaded
  // mtime never overrides a more-recent live bump.
  const mtimeActivityAt = workspace.claudeSessionId
    ? (sessionMtimeBySessionId.get(workspace.claudeSessionId) ?? null)
    : null
  const lastActivityAt =
    liveActivityAt !== null && mtimeActivityAt !== null
      ? Math.max(liveActivityAt, mtimeActivityAt)
      : (liveActivityAt ?? mtimeActivityAt)
  const relativeTime = formatRelativeTime(lastActivityAt, nowMs)
  const ageMs = lastActivityAt !== null ? nowMs - lastActivityAt : null
  const isVeryOld = ageMs !== null && ageMs >= 24 * 60 * 60_000

  const hasDetail = gitStatus !== null || pr != null

  // Native popover: only allowed when inactive, not renaming, and has data.
  const cardAllowed = hasDetail && !renaming && !active

  // Ref to the row element used as anchor for the native popover.
  const rowRef = useRef<HTMLDivElement>(null)

  // Hover timing mirrors the old floating-ui delays: 120ms open, 80ms close.
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function clearHoverTimer(): void {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }

  function handleRowMouseEnter(): void {
    if (!cardAllowed) return
    clearHoverTimer()
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      if (!rowRef.current || !cardAllowed) return
      showHoverPopover(
        workspace.id,
        rowRef.current,
        gitStatus,
        pr,
        dn.text,
        activity,
        relativeTime,
        workspace.cwd
      )
    }, 120)
  }

  function handleRowMouseLeave(): void {
    clearHoverTimer()
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      hideNativePopover(workspace.id)
    }, 80)
  }

  // If the card is allowed but the row becomes active / renaming / loses detail,
  // close it immediately so it never sits over a live terminal.
  useEffect(() => {
    if (!cardAllowed) {
      clearHoverTimer()
      hideNativePopover(workspace.id)
    }
  }, [cardAllowed, workspace.id])

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      clearHoverTimer()
      hideNativePopover(workspace.id)
    }
  }, [workspace.id])

  // Hover-bridge: when the native card closes itself via NSTrackingArea
  // mouseExited (pointer left the card without returning to the trigger),
  // reset our open-state by cancelling any pending timers. This ensures a
  // subsequent hover on this row re-opens the card cleanly.
  useEffect(() => {
    const unregister = onNativePopoverClosed(workspace.id, () => {
      clearHoverTimer()
    })
    return unregister
  }, [workspace.id])

  return (
    <>
      <div
        ref={rowRef}
        className={[
          'relative flex rounded-r-md transition-colors duration-150 group',
          isVeryOld && !isClosed ? 'opacity-60' : '',
          isClosed ? 'opacity-50' : '',
          // 2px left bar on active rows for unambiguous selection.
          // Workspaces use white (text-primary); projects use the yellow accent.
          active
            ? 'bg-text-primary/10 text-text-primary border-l-2 border-text-primary'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
        ].join(' ')}
        onMouseEnter={() => {
          setHovered(true)
          handleRowMouseEnter()
        }}
        onMouseLeave={() => {
          setHovered(false)
          handleRowMouseLeave()
        }}
        onContextMenu={handleContextMenu}
      >
        <button
          type="button"
          onClick={onSelect}
          className={[
            'flex flex-col pl-8 pr-9 flex-1 text-left min-w-0',
            'h-8 justify-center',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-r-md'
          ].join(' ')}
          aria-label={workspace.name}
        >
          {/* Line 1: status icon · title · fork badge · time/archive */}
          <span className="flex items-center gap-1.5 min-w-0">
            {/* Status icon slot */}
            <span
              className="flex items-center justify-center w-3 h-3 flex-shrink-0"
              title={isClosed ? 'Closed — click to reopen' : undefined}
            >
              {isClosed ? (
                <Circle size={11} weight="regular" className="text-text-muted opacity-60" />
              ) : activity && activity !== 'archived' ? (
                <ActivityIndicator detail={activity} />
              ) : (
                <Stack
                  size={12}
                  weight={active ? 'fill' : 'regular'}
                  className={[
                    'transition-colors duration-150',
                    active ? 'text-text-primary' : 'text-text-muted group-hover:text-text-secondary'
                  ].join(' ')}
                />
              )}
            </span>

            {/* Title area */}
            <span className="flex items-center gap-1 min-w-0 flex-1">
              {renaming ? (
                <WorkspaceRenameInput
                  ariaLabel="Rename workspace"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameCommit()
                    if (e.key === 'Escape') onCancelRename()
                  }}
                  onBlur={handleRenameCommit}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="bg-surface-overlay border border-accent/40 rounded px-1.5 py-0 outline-none text-xs text-text-primary min-w-0 flex-1"
                />
              ) : (
                <span
                  className={[
                    'text-xs truncate min-w-0 flex-1 leading-none',
                    dn.muted ? 'text-text-muted italic' : ''
                  ].join(' ')}
                >
                  {dn.text}
                </span>
              )}
              {/* Fork badge — after title */}
              {!renaming && workspace.forkedFromSessionId && (
                <GitFork
                  size={10}
                  weight="duotone"
                  className="text-text-muted flex-shrink-0"
                  aria-label="forked workspace"
                />
              )}
            </span>
          </span>
        </button>

        {/* Trailing slot: time and archive share the same absolute position at the right edge */}
        {!renaming && relativeTime && !hovered && (
          <span className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center h-8 pr-1 pointer-events-none">
            <span className="text-[11px] text-text-muted tabular-nums">{relativeTime}</span>
          </span>
        )}
        {!renaming && hovered && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onArchive()
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            aria-label="Archive workspace"
          >
            <Archive size={13} />
          </button>
        )}
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={wsMenuItems}
            onClose={() => setMenu(null)}
            boundsRef={sidebarBoundsRef ?? undefined}
          />
        )}
      </div>
    </>
  )
})

// ---------------------------------------------------------------------------
// Pinned workspace row (appears in the Pinned section above Projects)
// ---------------------------------------------------------------------------

interface PinnedRowProps {
  item: PinnedItem
  active: boolean
  onSelect: () => void
  onUnpin: () => void
}

const PinnedRow = memo(function PinnedRow({
  item,
  active,
  onSelect,
  onUnpin
}: PinnedRowProps): React.JSX.Element {
  const { workspace, project } = item
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const sidebarBoundsRef = useSidebarBounds()

  // Subscribe to this workspace's data from per-key stores — re-renders only
  // when THIS pinned row's key changes, not when any other workspace changes.
  const activity = useWorkspaceActivity(workspace.id)
  const terminalTitle = useWorkspaceTitle(workspace.id)

  // Session title is per-project; we don't pull it for cross-project pinned
  // rows. Terminal title (live OSC + persisted last_title from getTitle)
  // covers the common case — falls through to the workspace's stored name
  // (or "New workspace") otherwise.
  const dn = resolveWorkspaceName({ workspace, terminalTitle, sessionTitle: null })

  function handleContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const rect = sidebarBoundsRef?.current?.getBoundingClientRect()
    if (!rect || rect.width < 200) {
      void window.api.contextMenu.show([{ label: 'Unpin', action: 'unpin' }]).then((action) => {
        if (action === 'unpin') onUnpin()
      })
      return
    }
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const pinnedMenuItems: ContextMenuItem[] = [{ label: 'Unpin', onClick: onUnpin }]

  return (
    <div
      className={[
        'relative flex items-center rounded-r-md transition-colors duration-150 group',
        active
          ? 'bg-text-primary/10 text-text-primary border-l-2 border-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
      ].join(' ')}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex items-center gap-2.5 pl-4 pr-2 py-2 flex-1 text-left min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-r-md"
        title={workspace.cwd}
        aria-label={workspace.name}
      >
        <span className="flex-shrink-0">
          {activity && activity !== 'archived' ? (
            <ActivityIndicator detail={activity} />
          ) : (
            <Stack
              size={12}
              weight={active ? 'fill' : 'regular'}
              className={[
                'transition-colors duration-150',
                active ? 'text-text-primary' : 'text-text-muted group-hover:text-text-secondary'
              ].join(' ')}
            />
          )}
        </span>
        <span className="flex flex-col gap-0.5 min-w-0 flex-1">
          <span
            className={[
              'text-xs truncate leading-tight',
              dn.muted ? 'text-text-muted italic' : ''
            ].join(' ')}
            title={dn.text}
          >
            {dn.text}
          </span>
          <span className="text-[11px] text-text-muted truncate leading-tight">{project.name}</span>
        </span>
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={pinnedMenuItems}
          onClose={() => setMenu(null)}
          boundsRef={sidebarBoundsRef ?? undefined}
        />
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Project row (with identicon, expand chevron, workspace count)
// ---------------------------------------------------------------------------

interface ProjectRowProps {
  project: ProjectRecord
  active: boolean
  expanded: boolean
  workspaces: WorkspaceRecord[]
  workspaceCount: number
  workspaceCountInline: boolean
  fetchGithubAvatars: boolean
  selectedWorkspaceId?: string | null
  /** Map from claudeSessionId → session title for all sessions in this project. */
  sessionTitleBySessionId: Map<string, string>
  /** Map from claudeSessionId → last user message preview for all sessions in this project. */
  sessionUserPreviewBySessionId: Map<string, string>
  /** Map from claudeSessionId → jsonlMtime (epoch ms) for all sessions in this project. */
  sessionMtimeBySessionId: Map<string, number>
  /** Stale threshold in minutes (from AppUiState). */
  staleAfterMinutes: number
  /** Current time in epoch ms, updated once per minute at sidebar root. */
  nowMs: number
  onSelect: () => void
  onToggleExpand: () => void
  onSelectWorkspace: (workspaceId: string) => void
  currentViewKind: string
  currentWorkspaceId?: string | null
  renaming: boolean
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onRequestRemove: () => void
  onAddWorkspace: () => void
  renamingWorkspaceId: string | null
  onBeginRenameWorkspace: (workspaceId: string) => void
  onFinishRenameWorkspace: (workspaceId: string, newName: string) => void
  onCancelRenameWorkspace: () => void
  onArchiveWorkspace: (workspaceId: string) => void
  onCloseWorkspace: (workspaceId: string) => void
  onTogglePinWorkspace: (workspaceId: string) => void
  onTogglePinProject: () => void
  wsDragId: string | null
  wsDropTargetId: string | null
  wsDropPos: 'before' | 'after'
  onWorkspaceDragStart: (
    e: React.DragEvent<HTMLDivElement>,
    wsId: string,
    projectId: string
  ) => void
  onWorkspaceDragOver: (e: React.DragEvent<HTMLDivElement>, wsId: string, projectId: string) => void
  onWorkspaceDrop: (
    e: React.DragEvent<HTMLDivElement>,
    targetId: string,
    projectId: string,
    workspaces: WorkspaceRecord[]
  ) => void
  onWorkspaceDragEnd: () => void
}

// Small component so useFocusOnMount fires when the project rename input mounts
function ProjectRenameInput({
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
      aria-label="Rename project"
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onClick={onClick}
      className={className}
    />
  )
}

const ProjectRow = memo(function ProjectRow({
  project,
  active,
  expanded,
  workspaces,
  workspaceCount,
  workspaceCountInline,
  fetchGithubAvatars,
  selectedWorkspaceId,
  sessionTitleBySessionId,
  sessionUserPreviewBySessionId,
  sessionMtimeBySessionId,
  staleAfterMinutes,
  nowMs,
  onSelect,
  onToggleExpand,
  onSelectWorkspace,
  currentViewKind,
  currentWorkspaceId,
  renaming,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onRequestRemove,
  onAddWorkspace,
  renamingWorkspaceId,
  onBeginRenameWorkspace,
  onFinishRenameWorkspace,
  onCancelRenameWorkspace,
  onArchiveWorkspace,
  onCloseWorkspace,
  onTogglePinWorkspace,
  onTogglePinProject,
  wsDragId,
  wsDropTargetId,
  wsDropPos,
  onWorkspaceDragStart,
  onWorkspaceDragOver,
  onWorkspaceDrop,
  onWorkspaceDragEnd
}: ProjectRowProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const [renameValue, setRenameValue] = useState(project.name)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const sidebarBoundsRef = useSidebarBounds()

  // Sync rename input when project name changes externally (useEffect avoids render-time setState)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- conditional sync: only updates when not actively renaming
    if (!renaming) setRenameValue(project.name)
  }, [project.name, renaming])

  function handleContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    const isPinned = project.pinnedAt !== null
    const rect = sidebarBoundsRef?.current?.getBoundingClientRect()
    if (!rect || rect.width < 200) {
      void window.api.contextMenu
        .show([
          { label: isPinned ? 'Unpin' : 'Pin', action: 'togglePin' },
          { label: 'Rename', action: 'rename' },
          { divider: true },
          { label: 'Remove', action: 'remove' }
        ])
        .then((action) => {
          if (!action) return
          if (action === 'togglePin') onTogglePinProject()
          else if (action === 'rename') onBeginRename()
          else if (action === 'remove') onRequestRemove()
        })
      return
    }
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const isPinned = project.pinnedAt !== null
  const projectMenuItems: ContextMenuItem[] = [
    { label: isPinned ? 'Unpin' : 'Pin', onClick: onTogglePinProject },
    { label: 'Rename', onClick: onBeginRename },
    { label: '', divider: true, onClick: () => {} },
    { label: 'Remove', onClick: onRequestRemove }
  ]

  function handleRenameCommit(): void {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== project.name) {
      onFinishRename(trimmed)
    } else {
      onCancelRename()
    }
  }

  return (
    <div className="flex flex-col">
      <div
        className={[
          'relative flex items-center rounded-r-md transition-colors duration-150 group',
          active
            ? 'bg-accent/15 text-text-primary border-l-2 border-accent'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
        ].join(' ')}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={handleContextMenu}
      >
        {/* Main clickable row — navigate to project view. py-2 → ~40px hit target */}
        <button
          type="button"
          onClick={onSelect}
          className="flex items-center gap-2 px-2 py-2 flex-1 text-left min-w-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-r-md"
          title={project.path}
          aria-label={project.name}
        >
          <span className="relative inline-flex items-center flex-shrink-0">
            <Identicon
              seed={project.path}
              size={20}
              avatarUrl={fetchGithubAvatars ? project.githubAvatarUrl : null}
            />
            {project.pinnedAt !== null && (
              <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-surface-raised border border-border-default flex items-center justify-center pointer-events-none">
                <PushPin size={6} weight="fill" className="text-accent" />
              </span>
            )}
          </span>
          {renaming ? (
            <ProjectRenameInput
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameCommit()
                if (e.key === 'Escape') onCancelRename()
              }}
              onBlur={handleRenameCommit}
              onClick={(e) => e.stopPropagation()}
              className="bg-surface-overlay border border-accent/40 rounded px-2 py-0.5 outline-none text-sm font-medium text-text-primary min-w-0 flex-1"
            />
          ) : (
            <span className="text-sm truncate min-w-0 flex-1 flex items-center gap-1.5">
              <span className="truncate">{project.name}</span>
              {workspaceCountInline && workspaceCount > 0 && (
                <span className="text-xs text-text-muted flex-shrink-0">· {workspaceCount}</span>
              )}
            </span>
          )}
        </button>

        {/* Right controls: add workspace + chevron. Each button is 32x32. */}
        {!renaming && (
          <div className="flex items-center gap-0.5 pr-1 flex-shrink-0">
            {/* Add workspace — visible on hover */}
            {hovered && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onAddWorkspace()
                }}
                className="w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                title="New workspace"
                aria-label="New workspace"
              >
                <Plus size={14} weight="bold" />
              </button>
            )}

            {/* Expand/collapse chevron */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggleExpand()
              }}
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
              title={expanded ? 'Collapse' : 'Expand workspaces'}
              aria-label={expanded ? 'Collapse workspaces' : 'Expand workspaces'}
            >
              {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
            </button>
          </div>
        )}
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={projectMenuItems}
            onClose={() => setMenu(null)}
            boundsRef={sidebarBoundsRef ?? undefined}
          />
        )}
      </div>

      {/* Nested workspace rows */}
      {expanded && workspaces.length === 0 && (
        <button
          type="button"
          onClick={onAddWorkspace}
          className="w-full h-8 flex items-center justify-start gap-2 pl-8 pr-2 mt-0.5 text-left text-xs text-text-muted border-l-2 border-transparent hover:text-text-primary hover:bg-surface-overlay rounded-r-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Add workspace"
        >
          <Plus size={12} />
          <span>Add workspace</span>
        </button>
      )}
      {expanded && workspaces.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {workspaces.map((ws) => {
            const showLineAbove = wsDropTargetId === ws.id && wsDropPos === 'before'
            const showLineBelow = wsDropTargetId === ws.id && wsDropPos === 'after'
            const isDragging = wsDragId === ws.id
            return (
              <div
                key={ws.id}
                draggable={renamingWorkspaceId !== ws.id}
                onDragStart={(e) => onWorkspaceDragStart(e, ws.id, project.id)}
                onDragOver={(e) => onWorkspaceDragOver(e, ws.id, project.id)}
                onDrop={(e) => onWorkspaceDrop(e, ws.id, project.id, workspaces)}
                onDragEnd={onWorkspaceDragEnd}
                className={`relative ${isDragging ? 'opacity-40' : ''}`}
              >
                {showLineAbove && <DropIndicator position="top" />}
                <WorkspaceSubRow
                  workspace={ws}
                  project={project}
                  active={
                    currentViewKind === 'workspace' &&
                    (currentWorkspaceId === ws.id || selectedWorkspaceId === ws.id)
                  }
                  sessionTitleBySessionId={sessionTitleBySessionId}
                  sessionUserPreviewBySessionId={sessionUserPreviewBySessionId}
                  sessionMtimeBySessionId={sessionMtimeBySessionId}
                  staleAfterMinutes={staleAfterMinutes}
                  nowMs={nowMs}
                  onSelect={() => onSelectWorkspace(ws.id)}
                  renaming={renamingWorkspaceId === ws.id}
                  onBeginRename={() => onBeginRenameWorkspace(ws.id)}
                  onFinishRename={(name) => onFinishRenameWorkspace(ws.id, name)}
                  onCancelRename={onCancelRenameWorkspace}
                  onArchive={() => onArchiveWorkspace(ws.id)}
                  onClose={() => onCloseWorkspace(ws.id)}
                  onTogglePin={() => onTogglePinWorkspace(ws.id)}
                />
                {showLineBelow && <DropIndicator position="bottom" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Drop indicator
// ---------------------------------------------------------------------------

function DropIndicator({ position }: { position: 'top' | 'bottom' }): React.JSX.Element {
  return (
    <div
      className="absolute left-0 right-0 h-0.5 bg-accent rounded-full pointer-events-none z-10"
      style={position === 'top' ? { top: -1 } : { bottom: -1 }}
    />
  )
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export type SidebarActiveView = 'sessions' | 'project' | 'workspace' | 'settings'

interface SidebarProps {
  collapsed: boolean
  projects: ProjectRecord[]
  projectsLoading: boolean
  selectedProjectId: string | null
  selectedWorkspaceId: string | null
  activeView: SidebarActiveView
  currentViewKind: string
  expandedProjectIds: Set<string>
  workspacesByProject: Record<string, WorkspaceRecord[]>
  // Sidebar behavior preferences (v12)
  workspaceCountInline: boolean
  sidebarWidth: number // px, expanded state only
  // Privacy (v37)
  fetchGithubAvatars: boolean
  pinnedItems: PinnedItem[]
  onSelectProject: (id: string) => void
  onSelectNav: (view: 'sessions') => void
  onSelectSettings: () => void
  onAddProject: () => void
  addingProject?: boolean
  onToggleProjectExpand: (id: string) => void
  onSelectWorkspace: (workspaceId: string, projectId: string) => void
  onRenameProject: (id: string, newName: string) => void | Promise<void>
  onRequestRemoveProject: (project: ProjectRecord) => void
  onAddWorkspace: (projectId: string) => void | Promise<void>
  onRenameWorkspace: (
    workspaceId: string,
    projectId: string,
    newName: string
  ) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onCloseWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onTogglePinWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onTogglePinProject: (projectId: string) => void | Promise<void>
  onReorderProjects: (orderedIds: string[]) => void
  onReorderWorkspaces: (projectId: string, orderedIds: string[]) => void
  onRefreshPins: () => void
}

export function Sidebar({
  collapsed,
  projects,
  projectsLoading,
  selectedProjectId,
  selectedWorkspaceId,
  activeView,
  currentViewKind,
  expandedProjectIds,
  workspacesByProject,
  workspaceCountInline,
  sidebarWidth,
  fetchGithubAvatars,
  onSelectProject,
  onSelectNav,
  onSelectSettings,
  onAddProject,
  addingProject = false,
  onToggleProjectExpand,
  onSelectWorkspace,
  onRenameProject,
  onRequestRemoveProject,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onCloseWorkspace,
  onTogglePinWorkspace,
  onTogglePinProject,
  onReorderProjects,
  onReorderWorkspaces,
  pinnedItems,
  onRefreshPins
}: SidebarProps): React.JSX.Element {
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renamingWorkspaceId, setRenamingWorkspaceId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropPos, setDropPos] = useState<'before' | 'after'>('before')
  const [wsDragId, setWsDragId] = useState<string | null>(null)
  const wsDragProjectIdRef = useRef<string | null>(null)
  const [wsDropTargetId, setWsDropTargetId] = useState<string | null>(null)
  const [wsDropPos, setWsDropPos] = useState<'before' | 'after'>('before')
  // Map from projectId → (Map from claudeSessionId → session title).
  // Fetched once per project when its workspaces first become visible.
  const [sessionTitlesByProject, setSessionTitlesByProject] = useState<
    Map<string, Map<string, string>>
  >(new Map())
  // Map from projectId → (Map from claudeSessionId → last user message preview).
  const [sessionUserPreviewsByProject, setSessionUserPreviewsByProject] = useState<
    Map<string, Map<string, string>>
  >(new Map())
  // Map from projectId → (Map from claudeSessionId → jsonlMtime epoch ms).
  const [sessionMtimesByProject, setSessionMtimesByProject] = useState<
    Map<string, Map<string, number>>
  >(new Map())
  // Stale threshold from AppUiState (default matches original hardcoded 60 min)
  const [staleAfterMinutes, setStaleAfterMinutes] = useState(60)
  // Coarse clock — tick once per minute so all rows refresh together
  const [nowMs, setNowMs] = useState(() => Date.now())
  const fetchedProjectSessions = useRef<Set<string> | null>(null)
  if (fetchedProjectSessions.current === null) fetchedProjectSessions.current = new Set<string>()
  const sidebarRef = useRef<HTMLElement>(null)

  // Fetch sessions for any visible project that hasn't been loaded yet.
  useEffect(() => {
    const projectIds = projects.map((p) => p.id)
    for (const projectId of projectIds) {
      if (fetchedProjectSessions.current!.has(projectId)) continue
      fetchedProjectSessions.current!.add(projectId)
      window.api.sessions
        .listForProject(projectId, { includeArchived: true })
        .then((sessions: SessionRecord[]) => {
          const titleMap = new Map<string, string>()
          const userPreviewMap = new Map<string, string>()
          const mtimeMap = new Map<string, number>()
          for (const s of sessions) {
            if (s.title) titleMap.set(s.id, s.title)
            if (s.lastUserMessagePreview) userPreviewMap.set(s.id, s.lastUserMessagePreview)
            if (s.jsonlMtime != null) mtimeMap.set(s.id, s.jsonlMtime)
          }
          setSessionTitlesByProject((prev) => {
            const next = new Map(prev)
            next.set(projectId, titleMap)
            return next
          })
          setSessionUserPreviewsByProject((prev) => {
            const next = new Map(prev)
            next.set(projectId, userPreviewMap)
            return next
          })
          setSessionMtimesByProject((prev) => {
            const next = new Map(prev)
            next.set(projectId, mtimeMap)
            return next
          })
        })
        .catch((err) => console.error('[sidebar] sessions load failed for', projectId, err))
    }
  }, [projects])

  // Subscribe to staleAfterMinutes from AppUiState
  useEffect(() => {
    void window.api.uiState.get().then((s) => setStaleAfterMinutes(s.staleAfterMinutes))
    const unsub = window.api.uiState.onChanged((s) => setStaleAfterMinutes(s.staleAfterMinutes))
    return unsub
  }, [])

  // Tick nowMs once per minute so freshness labels refresh without per-row timers
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  function handleBeginRename(id: string): void {
    setRenamingProjectId(id)
  }

  function handleFinishRename(id: string, newName: string): void {
    onRenameProject(id, newName)
    setRenamingProjectId(null)
  }

  const handleCancelRename = useCallback((): void => {
    setRenamingProjectId(null)
  }, [])

  const handleBeginRenameWorkspace = useCallback((id: string): void => {
    setRenamingWorkspaceId(id)
  }, [])

  function handleFinishRenameWorkspace(
    workspaceId: string,
    projectId: string,
    newName: string
  ): void {
    onRenameWorkspace(workspaceId, projectId, newName)
    setRenamingWorkspaceId(null)
  }

  const handleCancelRenameWorkspace = useCallback((): void => {
    setRenamingWorkspaceId(null)
  }, [])

  // Returns 0 for pinned projects, 1 for unpinned — used to enforce same-tier drag.
  function projectPinTier(projectId: string): 0 | 1 {
    const p = projects.find((x) => x.id === projectId)
    return p?.pinnedAt != null ? 0 : 1
  }

  function onProjectDragStart(e: React.DragEvent<HTMLDivElement>, id: string): void {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  function onProjectDragOver(e: React.DragEvent<HTMLDivElement>, id: string): void {
    if (!dragId || dragId === id) return
    // Cross-tier drag: no indicator shown
    if (projectPinTier(dragId) !== projectPinTier(id)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const isAbove = e.clientY < rect.top + rect.height / 2
    setDropTargetId(id)
    setDropPos(isAbove ? 'before' : 'after')
  }

  function onProjectDrop(e: React.DragEvent<HTMLDivElement>, targetId: string): void {
    e.preventDefault()
    if (!dragId || dragId === targetId) {
      setDragId(null)
      setDropTargetId(null)
      return
    }
    // Cross-tier drop: no-op
    if (projectPinTier(dragId) !== projectPinTier(targetId)) {
      setDragId(null)
      setDropTargetId(null)
      return
    }
    const ids = projects.map((p) => p.id)
    const fromIdx = ids.indexOf(dragId)
    if (fromIdx === -1) return
    ids.splice(fromIdx, 1)
    let toIdx = ids.indexOf(targetId)
    if (toIdx === -1) toIdx = ids.length
    if (dropPos === 'after') toIdx += 1
    ids.splice(toIdx, 0, dragId)
    onReorderProjects(ids)
    setDragId(null)
    setDropTargetId(null)
  }

  function onProjectDragEnd(): void {
    setDragId(null)
    setDropTargetId(null)
  }

  const onWorkspaceDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, wsId: string, projectId: string): void => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', wsId)
      setWsDragId(wsId)
      wsDragProjectIdRef.current = projectId
    },
    []
  )

  const onWorkspaceDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, wsId: string, projectId: string): void => {
      if (!wsDragId || wsDragId === wsId) return
      // Cross-project drag: no-op
      if (wsDragProjectIdRef.current !== projectId) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect()
      const isAbove = e.clientY < rect.top + rect.height / 2
      setWsDropTargetId(wsId)
      setWsDropPos(isAbove ? 'before' : 'after')
    },
    [wsDragId]
  )

  const onWorkspaceDrop = useCallback(
    (
      e: React.DragEvent<HTMLDivElement>,
      targetId: string,
      projectId: string,
      workspaces: WorkspaceRecord[]
    ): void => {
      e.preventDefault()
      if (!wsDragId || wsDragId === targetId || wsDragProjectIdRef.current !== projectId) {
        setWsDragId(null)
        wsDragProjectIdRef.current = null
        setWsDropTargetId(null)
        return
      }
      const ids = workspaces.map((w) => w.id)
      const fromIdx = ids.indexOf(wsDragId)
      if (fromIdx === -1) {
        setWsDragId(null)
        wsDragProjectIdRef.current = null
        setWsDropTargetId(null)
        return
      }
      ids.splice(fromIdx, 1)
      let toIdx = ids.indexOf(targetId)
      if (toIdx === -1) toIdx = ids.length
      if (wsDropPos === 'after') toIdx += 1
      ids.splice(toIdx, 0, wsDragId)
      onReorderWorkspaces(projectId, ids)
      setWsDragId(null)
      wsDragProjectIdRef.current = null
      setWsDropTargetId(null)
    },
    [wsDragId, wsDropPos, onReorderWorkspaces]
  )

  const onWorkspaceDragEnd = useCallback((): void => {
    setWsDragId(null)
    wsDragProjectIdRef.current = null
    setWsDropTargetId(null)
  }, [])

  // Used by CollapsedProjectList to highlight the currently-active project.
  const isProjectActive = useCallback(
    (projectId: string): boolean =>
      (activeView === 'project' || activeView === 'workspace') && selectedProjectId === projectId,
    [activeView, selectedProjectId]
  )

  const addProjectButton = (
    <button
      type="button"
      aria-label="Add project"
      disabled={addingProject}
      className={[
        'p-1 rounded transition-colors duration-150',
        addingProject
          ? 'text-text-muted opacity-50 cursor-wait'
          : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
      ].join(' ')}
      onClick={onAddProject}
    >
      <Plus size={14} weight="bold" />
    </button>
  )

  return (
    <SidebarBoundsContext.Provider value={sidebarRef}>
      <aside
        ref={sidebarRef}
        className={[
          collapsed ? 'w-14' : '',
          'transition-[width] duration-150 ease-out',
          'bg-surface-raised border-r border-border-default',
          'flex flex-col gap-1 overflow-hidden shrink-0 h-full'
        ].join(' ')}
        style={collapsed ? undefined : { width: sidebarWidth + 'px' }}
      >
        {/* Top nav */}
        {/* Route key 'sessions' is preserved for back-compat with uiState serialisation; visible label is Workspaces */}
        <NavItem
          Icon={Kanban}
          label="Workspaces"
          active={activeView === 'sessions'}
          collapsed={collapsed}
          flushTop
          onClick={() => onSelectNav('sessions')}
        />

        {/* Pinned section — only rendered when at least one workspace is pinned */}
        {!collapsed && pinnedItems.length > 0 && (
          <div className="mt-4 flex flex-col gap-0.5">
            <SectionHeader label="Pinned" />
            {pinnedItems.map((item) => (
              <PinnedRow
                key={item.workspace.id}
                item={item}
                active={selectedWorkspaceId === item.workspace.id}
                onSelect={() => onSelectWorkspace(item.workspace.id, item.workspace.projectId)}
                onUnpin={async () => {
                  await window.api.workspaces.setPinned(item.workspace.id, false)
                  onRefreshPins()
                }}
              />
            ))}
          </div>
        )}

        {/* Projects section */}
        <div className="mt-4 flex flex-col gap-0.5 flex-1 min-h-0">
          {!collapsed ? (
            <>
              <SectionHeader label="Projects" action={addProjectButton} />
              {projectsLoading ? (
                <ProjectListSkeleton />
              ) : projects.length === 0 ? (
                <p className="text-xs text-text-muted px-3 mt-1">No projects yet</p>
              ) : (
                <div className="flex flex-col gap-0.5 overflow-y-auto flex-1 min-h-0 no-scrollbar">
                  {projects.map((p) => {
                    const expanded = expandedProjectIds.has(p.id)
                    const workspaces = (workspacesByProject[p.id] ?? []).filter(
                      (w) => w.archivedAt === null
                    )
                    const showLineAbove = dropTargetId === p.id && dropPos === 'before'
                    const showLineBelow = dropTargetId === p.id && dropPos === 'after'
                    const isDragging = dragId === p.id
                    return (
                      <div
                        key={p.id}
                        draggable={renamingProjectId !== p.id}
                        onDragStart={(e) => onProjectDragStart(e, p.id)}
                        onDragOver={(e) => onProjectDragOver(e, p.id)}
                        onDrop={(e) => onProjectDrop(e, p.id)}
                        onDragEnd={onProjectDragEnd}
                        className={['relative', isDragging ? 'opacity-40' : ''].join(' ')}
                      >
                        {showLineAbove && <DropIndicator position="top" />}
                        <ProjectRow
                          project={p}
                          active={activeView === 'project' && selectedProjectId === p.id}
                          expanded={expanded}
                          workspaces={workspaces}
                          workspaceCount={workspaces.length}
                          workspaceCountInline={workspaceCountInline}
                          fetchGithubAvatars={fetchGithubAvatars}
                          selectedWorkspaceId={selectedWorkspaceId}
                          sessionTitleBySessionId={
                            sessionTitlesByProject.get(p.id) ?? EMPTY_TITLE_MAP
                          }
                          sessionUserPreviewBySessionId={
                            sessionUserPreviewsByProject.get(p.id) ?? EMPTY_TITLE_MAP
                          }
                          sessionMtimeBySessionId={
                            sessionMtimesByProject.get(p.id) ?? EMPTY_MTIME_MAP
                          }
                          staleAfterMinutes={staleAfterMinutes}
                          nowMs={nowMs}
                          onSelect={() => onSelectProject(p.id)}
                          onToggleExpand={() => onToggleProjectExpand(p.id)}
                          onSelectWorkspace={(wsId) => onSelectWorkspace(wsId, p.id)}
                          currentViewKind={currentViewKind}
                          currentWorkspaceId={selectedWorkspaceId}
                          renaming={renamingProjectId === p.id}
                          onBeginRename={() => handleBeginRename(p.id)}
                          onFinishRename={(name) => handleFinishRename(p.id, name)}
                          onCancelRename={handleCancelRename}
                          onRequestRemove={() => onRequestRemoveProject(p)}
                          onAddWorkspace={() => onAddWorkspace(p.id)}
                          renamingWorkspaceId={renamingWorkspaceId}
                          onBeginRenameWorkspace={handleBeginRenameWorkspace}
                          onFinishRenameWorkspace={(wsId, name) =>
                            handleFinishRenameWorkspace(wsId, p.id, name)
                          }
                          onCancelRenameWorkspace={handleCancelRenameWorkspace}
                          onArchiveWorkspace={(wsId) => onArchiveWorkspace(wsId, p.id)}
                          onCloseWorkspace={(wsId) => onCloseWorkspace(wsId, p.id)}
                          onTogglePinWorkspace={(wsId) => onTogglePinWorkspace(wsId, p.id)}
                          onTogglePinProject={() => onTogglePinProject(p.id)}
                          wsDragId={wsDragId}
                          wsDropTargetId={wsDropTargetId}
                          wsDropPos={wsDropPos}
                          onWorkspaceDragStart={onWorkspaceDragStart}
                          onWorkspaceDragOver={onWorkspaceDragOver}
                          onWorkspaceDrop={onWorkspaceDrop}
                          onWorkspaceDragEnd={onWorkspaceDragEnd}
                        />
                        {showLineBelow && <DropIndicator position="bottom" />}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <CollapsedProjectList
              projects={projects}
              projectsLoading={projectsLoading}
              fetchGithubAvatars={fetchGithubAvatars}
              isProjectActive={isProjectActive}
              addingProject={addingProject}
              onSelectProject={onSelectProject}
              onAddProject={onAddProject}
              workspacesByProject={workspacesByProject}
            />
          )}
        </div>

        {/* Bottom: Settings */}
        <NavItem
          Icon={Gear}
          label="Settings"
          active={activeView === 'settings'}
          collapsed={collapsed}
          onClick={onSelectSettings}
        />
      </aside>
    </SidebarBoundsContext.Provider>
  )
}
