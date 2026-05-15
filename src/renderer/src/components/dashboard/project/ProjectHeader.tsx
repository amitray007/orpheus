import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  Archive,
  Code,
  Copy,
  DotsThree,
  Folder,
  FolderOpen,
  GearSix,
  GitBranch,
  Plus,
  Terminal,
  Check
} from '@phosphor-icons/react'
import type { GitStatus, ProjectRecord } from '@shared/types'
import { ContextMenu, type ContextMenuItem } from '../../ContextMenu'

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
// Header
// ---------------------------------------------------------------------------

interface ProjectHeaderProps {
  project: ProjectRecord
  /** Active workspace count (excludes archived). */
  workspaceCount: number
  /** Total local sessions count, from the sessions paged IPC. -1 means unknown. */
  sessionCount: number
  /** Max(lastOpenedAt) across all workspaces in the project; null if none. */
  lastActivityAt: number | null
  /** Number of overrides applied at project scope. 0 hides the override chip. */
  overrideCount: number
  onNewWorkspace: () => void
  onOpenSettings: () => void
  onRequestRemove: () => void
}

export function ProjectHeader({
  project,
  workspaceCount,
  sessionCount,
  lastActivityAt,
  overrideCount,
  onNewWorkspace,
  onOpenSettings,
  onRequestRemove
}: ProjectHeaderProps): React.JSX.Element {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [pathCopied, setPathCopied] = useState(false)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.git
      .status(project.path)
      .then((s) => {
        if (!cancelled) setGitStatus(s)
      })
      .catch(() => {
        if (!cancelled) setGitStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [project.path])

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    },
    []
  )

  async function copyPath(): Promise<void> {
    try {
      await window.api.shell.copyToClipboard(project.path)
      setPathCopied(true)
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
      copyResetTimer.current = setTimeout(() => setPathCopied(false), 1500)
    } catch (err) {
      console.error('[project-header] copy failed', err)
    }
  }

  const overflowMenu: ContextMenuItem[] = [
    {
      label: 'Show in Finder',
      icon: <FolderOpen size={13} />,
      onClick: () => {
        window.api.shell.revealInFinder(project.path).catch(console.error)
      }
    },
    {
      label: 'Open in editor',
      icon: <Code size={13} />,
      onClick: () => {
        window.api.shell.openInEditor(project.path).catch(console.error)
      }
    },
    {
      label: 'Open in terminal',
      icon: <Terminal size={13} />,
      onClick: () => {
        window.api.shell.openTerminal(project.path).catch(console.error)
      }
    },
    {
      label: 'Copy path',
      icon: <Copy size={13} />,
      onClick: () => {
        copyPath()
      }
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: 'Remove from Orpheus',
      icon: <Archive size={13} />,
      onClick: onRequestRemove,
      destructive: true
    }
  ]

  function openMenu(e: React.MouseEvent): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: rect.right - 200, y: rect.bottom + 4 })
  }

  const sessionsLabel =
    sessionCount < 0 ? '— sessions' : `${sessionCount} session${sessionCount === 1 ? '' : 's'}`
  const workspacesLabel = `${workspaceCount} workspace${workspaceCount === 1 ? '' : 's'}`
  const activityLabel = lastActivityAt
    ? `active ${relativeTime(lastActivityAt)}`
    : 'no activity yet'

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 p-2.5 rounded-lg bg-surface-raised border border-border-default flex-shrink-0">
          <Folder size={20} weight="fill" className="text-accent" />
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold text-text-primary truncate">{project.name}</h1>

          <div className="flex items-center gap-1.5 min-w-0">
            <p className="text-xs text-text-muted font-mono truncate min-w-0" title={project.path}>
              {project.path}
            </p>
            <button
              onClick={copyPath}
              aria-label={pathCopied ? 'Copied' : 'Copy path'}
              title={pathCopied ? 'Copied' : 'Copy path'}
              className={[
                'flex-shrink-0 p-0.5 rounded transition-colors duration-150 cursor-pointer',
                pathCopied
                  ? 'text-emerald-400'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
              ].join(' ')}
            >
              {pathCopied ? <Check size={11} weight="bold" /> : <Copy size={11} />}
            </button>
          </div>

          <div className="flex items-center gap-3 text-xs text-text-muted flex-wrap">
            {gitStatus?.branch && (
              <span className="inline-flex items-center gap-1">
                <GitBranch size={11} />
                <span className="font-mono">{gitStatus.branch}</span>
                {gitStatus.hasChanges && (
                  <span
                    className="text-amber-400/80"
                    title={`+${gitStatus.insertions} −${gitStatus.deletions}`}
                  >
                    ●
                  </span>
                )}
              </span>
            )}
            <span>{workspacesLabel}</span>
            <span aria-hidden>·</span>
            <span>{sessionsLabel}</span>
            <span aria-hidden>·</span>
            <span>{activityLabel}</span>
            {overrideCount > 0 && (
              <>
                <span aria-hidden>·</span>
                <button
                  onClick={onOpenSettings}
                  className="text-accent hover:underline cursor-pointer"
                >
                  {overrideCount} override{overrideCount === 1 ? '' : 's'}
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={onNewWorkspace}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 border border-accent/30 text-text-primary hover:bg-accent/25 transition-colors cursor-pointer"
          >
            <Plus size={11} weight="bold" />
            New workspace
          </button>
          <button
            onClick={onOpenSettings}
            aria-label="Project settings"
            title="Project settings"
            className="p-1.5 rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors cursor-pointer"
          >
            <GearSix size={13} />
          </button>
          <button
            onClick={openMenu}
            aria-label="More actions"
            title="More actions"
            className="p-1.5 rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:bg-surface-overlay transition-colors cursor-pointer"
          >
            <DotsThree size={14} weight="bold" />
          </button>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={overflowMenu} />
      )}
    </header>
  )
}
