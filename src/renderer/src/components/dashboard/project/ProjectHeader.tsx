import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  Archive,
  Check,
  Code,
  Copy,
  DotsThree,
  FolderOpen,
  GearSix,
  GitMerge,
  Plus,
  Terminal
} from '@phosphor-icons/react'
import type { AppUiState, DetectedApp, GitStatus, ProjectRecord } from '@shared/types'
import { ContextMenu, type ContextMenuItem } from '../../ContextMenu'
import { Identicon } from '../../Identicon'
import { SplitButton } from '../../SplitButton'
import { Skeleton } from '../../Skeleton'

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

function shortAppLabel(app: DetectedApp): string {
  return app.label ?? app.name
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface ProjectHeaderProps {
  project: ProjectRecord
  /** null = still loading (ProjectHeader renders a skeleton chip in that case). */
  /** `null` while the workspace list is still loading. */
  workspaceCount: number | null | null
  lastActivityAt: number | null
  /** `null` while project settings are still loading. */
  overrideCount: number | null
  onNewWorkspace: () => void
  onOpenSettings: () => void
  onRequestRemove: () => void
  /** Privacy toggle — suppresses avatar even when URL is cached in the project record. */
  fetchGithubAvatars?: boolean
}

export function ProjectHeader({
  project,
  workspaceCount,
  lastActivityAt,
  overrideCount,
  onNewWorkspace,
  onOpenSettings,
  onRequestRemove,
  fetchGithubAvatars
}: ProjectHeaderProps): React.JSX.Element {
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [pathCopied, setPathCopied] = useState(false)
  const [editors, setEditors] = useState<DetectedApp[]>([])
  const [terminals, setTerminals] = useState<DetectedApp[]>([])
  const [uiState, setUiState] = useState<AppUiState | null>(null)
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

  useEffect(() => {
    let cancelled = false
    Promise.all([
      window.api.shell.listEditorApps(),
      window.api.shell.listTerminalApps(),
      window.api.uiState.get()
    ])
      .then(([eds, tms, ui]) => {
        if (cancelled) return
        setEditors(eds)
        setTerminals(tms)
        setUiState(ui)
      })
      .catch((err) => console.error('[project-header] failed to load app prefs', err))
    return () => {
      cancelled = true
    }
  }, [])

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

  async function pickEditor(name: string): Promise<void> {
    setUiState((prev) => (prev ? { ...prev, preferredEditorApp: name } : prev))
    try {
      await window.api.uiState.update({ preferredEditorApp: name })
    } catch (err) {
      console.error('[project-header] persist editor pref failed', err)
    }
  }

  async function pickTerminal(name: string): Promise<void> {
    setUiState((prev) => (prev ? { ...prev, preferredTerminalApp: name } : prev))
    try {
      await window.api.uiState.update({ preferredTerminalApp: name })
    } catch (err) {
      console.error('[project-header] persist terminal pref failed', err)
    }
  }

  const preferredEditor = uiState?.preferredEditorApp ?? null
  const preferredTerminal = uiState?.preferredTerminalApp ?? null

  const activeEditor = editors.find((e) => e.name === preferredEditor) ?? editors[0] ?? null
  const activeTerminal = terminals.find((t) => t.name === preferredTerminal) ?? terminals[0] ?? null

  const overflowMenu: ContextMenuItem[] = [
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

  const workspacesLabel =
    workspaceCount === null
      ? null
      : `${workspaceCount} workspace${workspaceCount === 1 ? '' : 's'}`
  const activityLabel = lastActivityAt
    ? `active ${relativeTime(lastActivityAt)}`
    : 'no activity yet'

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex-shrink-0">
          <Identicon
            seed={project.path}
            size={28}
            avatarUrl={
              (fetchGithubAvatars ?? uiState?.fetchGithubAvatars ?? true)
                ? project.githubAvatarUrl
                : null
            }
          />
        </div>

        <div className="flex-1 min-w-0 flex flex-col gap-1">
          <div className="flex items-baseline gap-2 min-w-0 flex-wrap">
            <h1 className="text-xl font-semibold text-text-primary truncate">{project.name}</h1>
            {/* Path + copy as a single unit so they never wrap apart. */}
            <span className="inline-flex items-center gap-1 min-w-0 flex-1">
              <p
                className="text-xs text-text-muted font-mono truncate min-w-0"
                title={project.path}
              >
                {project.path}
              </p>
              <button
                type="button"
                onClick={copyPath}
                aria-label={pathCopied ? 'Path copied' : 'Copy path to clipboard'}
                title={pathCopied ? 'Copied' : 'Copy path'}
                className={[
                  'flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md',
                  'transition-colors duration-150 cursor-pointer',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  pathCopied
                    ? 'text-emerald-400'
                    : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
                ].join(' ')}
              >
                {pathCopied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
              </button>
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs text-text-muted flex-wrap">
            {gitStatus?.branch && (
              <>
                <span
                  className="inline-flex items-center gap-1"
                  title={`Current git branch: ${gitStatus.branch}`}
                >
                  <GitMerge size={11} />
                  <span className="font-mono">{gitStatus.branch}</span>
                </span>
                <span aria-hidden>·</span>
              </>
            )}
            {workspacesLabel ? (
              <span>{workspacesLabel}</span>
            ) : (
              <Skeleton className="inline-block h-3 w-24 align-middle opacity-60" />
            )}
            <span aria-hidden>·</span>
            <span>{activityLabel}</span>
            {overrideCount === null ? (
              <>
                <span aria-hidden>·</span>
                <Skeleton className="inline-block h-3 w-20 align-middle opacity-60" />
              </>
            ) : overrideCount > 0 ? (
              <>
                <span aria-hidden>·</span>
                <button
                  onClick={onOpenSettings}
                  className="text-accent hover:underline cursor-pointer"
                >
                  {overrideCount} override{overrideCount === 1 ? '' : 's'}
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          {/* Show in Finder — no picker, single OS app */}
          <button
            type="button"
            onClick={() => window.api.shell.revealInFinder(project.path).catch(console.error)}
            aria-label="Show project in Finder"
            title="Show in Finder"
            className={[
              'inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-xs',
              'text-text-secondary border border-border-default',
              'transition-colors duration-150 cursor-pointer',
              'hover:text-text-primary hover:bg-surface-overlay',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
            ].join(' ')}
          >
            <FolderOpen size={12} weight="regular" />
            Finder
          </button>

          {/* Open in editor — picker */}
          <SplitButton<string>
            options={editors.map((e) => ({
              value: e.name,
              label: shortAppLabel(e)
            }))}
            value={activeEditor?.name ?? null}
            onChange={pickEditor}
            onClick={() => window.api.shell.openInEditor(project.path).catch(console.error)}
            popoverHeader="Open in"
            primaryDisabled={editors.length === 0}
          >
            <Code size={12} weight="regular" />
            <span>{activeEditor ? shortAppLabel(activeEditor) : 'Editor'}</span>
          </SplitButton>

          {/* Open in terminal — picker */}
          <SplitButton<string>
            options={terminals.map((t) => ({
              value: t.name,
              label: shortAppLabel(t)
            }))}
            value={activeTerminal?.name ?? null}
            onChange={pickTerminal}
            onClick={() => window.api.shell.openTerminal(project.path).catch(console.error)}
            popoverHeader="Open in"
            primaryDisabled={terminals.length === 0}
          >
            <Terminal size={12} weight="regular" />
            <span>{activeTerminal ? shortAppLabel(activeTerminal) : 'Terminal'}</span>
          </SplitButton>

          <span className="w-px h-5 bg-border-default mx-1" aria-hidden />

          <button
            type="button"
            onClick={onNewWorkspace}
            aria-label="Create new workspace"
            className={[
              'inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-xs font-medium',
              'bg-accent/15 border border-accent/30 text-text-primary',
              'transition-colors duration-150 cursor-pointer',
              'hover:bg-accent/25',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
            ].join(' ')}
          >
            <Plus size={12} weight="bold" />
            New workspace
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Project settings"
            title="Project settings"
            className={[
              'inline-flex items-center justify-center w-8 h-8 rounded-md',
              'border border-border-default text-text-secondary',
              'transition-colors duration-150 cursor-pointer',
              'hover:text-text-primary hover:bg-surface-overlay',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
            ].join(' ')}
          >
            <GearSix size={14} />
          </button>
          <button
            type="button"
            onClick={openMenu}
            aria-label="More actions"
            aria-haspopup="menu"
            title="More actions"
            className={[
              'inline-flex items-center justify-center w-8 h-8 rounded-md',
              'border border-border-default text-text-secondary',
              'transition-colors duration-150 cursor-pointer',
              'hover:text-text-primary hover:bg-surface-overlay',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
            ].join(' ')}
          >
            <DotsThree size={16} weight="bold" />
          </button>
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={overflowMenu} />
      )}
    </header>
  )
}
