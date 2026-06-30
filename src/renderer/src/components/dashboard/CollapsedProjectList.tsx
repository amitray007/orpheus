import type React from 'react'
import { memo, useRef } from 'react'
import { Plus, PushPin } from '@phosphor-icons/react'
import type { ProjectRecord, WorkspaceRecord } from '@shared/types'
import { Identicon } from '../Identicon'
import { showProjectPopover, hideNativePopover, onNativePopoverClosed } from '@/lib/nativePopover'
import { getActivitySnapshot } from '@/lib/activityStore'
import { getTitleSnapshot } from '@/lib/titleStore'
import { resolveWorkspaceName } from './resolveWorkspaceName'
import type { WorkspaceActivityDetail } from '@shared/types'

// ---------------------------------------------------------------------------
// Collapsed sidebar — identicon strip shown when the sidebar is narrow
// ---------------------------------------------------------------------------

interface CollapsedProjectListProps {
  projects: ProjectRecord[]
  projectsLoading: boolean
  fetchGithubAvatars: boolean
  /** Returns true when the given project should appear active (highlighted). */
  isProjectActive: (projectId: string) => boolean
  addingProject: boolean
  onSelectProject: (id: string) => void
  onAddProject: () => void
  /** Non-archived workspaces grouped by projectId — used to build the project popover. */
  workspacesByProject: Record<string, WorkspaceRecord[]>
}

// Maps WorkspaceActivityDetail to the state union used by the project popover.
function toPopoverState(
  detail: WorkspaceActivityDetail | undefined
): 'working' | 'ready' | 'idle' | 'attention' | 'archived' {
  if (!detail || detail === 'archived') return 'idle'
  return detail
}

// ---------------------------------------------------------------------------
// ProjectTile — one icon button with native popover hover behavior
// ---------------------------------------------------------------------------

interface ProjectTileProps {
  p: ProjectRecord
  isActive: boolean
  fetchGithubAvatars: boolean
  workspaces: WorkspaceRecord[]
  onSelectProject: (id: string) => void
  tileClass: string
}

const ProjectTile = memo(function ProjectTile({
  p,
  isActive,
  fetchGithubAvatars,
  workspaces,
  onSelectProject,
  tileClass
}: ProjectTileProps): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const popoverId = `proj:${p.id}`

  function clearHoverTimer(): void {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }

  function handleMouseEnter(): void {
    clearHoverTimer()
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      if (!buttonRef.current) return

      // Snapshot activity and title store at show-time (no hooks in a loop).
      const activityMap = getActivitySnapshot()
      const titles = getTitleSnapshot()
      const activeWorkspaces = workspaces.filter((w) => w.archivedAt === null)
      const capped = activeWorkspaces.slice(0, 8)

      showProjectPopover(p.id, buttonRef.current, {
        name: p.name,
        pinned: p.pinnedAt != null,
        repo: p.githubOwner && p.githubRepo ? `${p.githubOwner}/${p.githubRepo}` : undefined,
        path: p.path,
        workspaceCount: activeWorkspaces.length,
        workspaces: capped.map((w) => {
          const displayName = resolveWorkspaceName({
            workspace: w,
            terminalTitle: titles.get(w.id) ?? null,
            sessionTitle: null
          }).text
          // Append branch annotation for worktree workspaces so the project
          // popover workspace list distinguishes them from plain workspaces.
          const name =
            w.worktreeParentCwd && w.worktreeBranch
              ? `${displayName} · ${w.worktreeBranch}`
              : displayName
          return {
            name,
            state: toPopoverState(activityMap.get(w.id))
          }
        })
      })

      // Register native-closed handler: reset timer state when card closes itself.
      onNativePopoverClosed(popoverId, () => {
        clearHoverTimer()
      })
    }, 150)
  }

  function handleMouseLeave(): void {
    clearHoverTimer()
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null
      hideNativePopover(popoverId)
    }, 80)
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={() => onSelectProject(p.id)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      title={p.name}
      aria-label={p.name}
      className={[tileClass, isActive ? 'bg-accent/15' : 'hover:bg-surface-overlay'].join(' ')}
    >
      <span className="relative inline-flex items-center flex-shrink-0">
        <Identicon
          seed={p.path}
          size={22}
          avatarUrl={fetchGithubAvatars ? p.githubAvatarUrl : null}
        />
        {p.pinnedAt !== null && (
          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-surface-raised border border-border-default flex items-center justify-center pointer-events-none">
            <PushPin size={6} weight="fill" className="text-accent" />
          </span>
        )}
      </span>
    </button>
  )
})

// ---------------------------------------------------------------------------
// CollapsedProjectList
// ---------------------------------------------------------------------------

export const CollapsedProjectList = memo(function CollapsedProjectList({
  projects,
  projectsLoading,
  fetchGithubAvatars,
  isProjectActive,
  addingProject,
  onSelectProject,
  onAddProject,
  workspacesByProject
}: CollapsedProjectListProps): React.JSX.Element {
  // Every entry in the collapsed rail renders inside an identical fixed-size
  // tile (TILE square, centered content, shrink-0) so heterogeneous content —
  // identicon SVG, GitHub avatar, the + glyph — always lays out predictably and
  // can never be squished by the overflowing flex column.
  const TILE =
    'flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'

  return (
    <div className="flex flex-col items-center gap-1 overflow-y-auto flex-1 min-h-0 no-scrollbar">
      <button
        type="button"
        aria-label="Add project"
        disabled={addingProject}
        className={[
          TILE,
          'mb-1',
          addingProject
            ? 'text-text-muted opacity-50 cursor-wait'
            : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
        onClick={onAddProject}
      >
        <Plus size={14} weight="bold" />
      </button>
      {!projectsLoading &&
        projects.map((p) => (
          <ProjectTile
            key={p.id}
            p={p}
            isActive={isProjectActive(p.id)}
            fetchGithubAvatars={fetchGithubAvatars}
            workspaces={workspacesByProject[p.id] ?? []}
            onSelectProject={onSelectProject}
            tileClass={TILE}
          />
        ))}
    </div>
  )
})
