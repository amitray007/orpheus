import { memo, useCallback, useEffect, useRef, useState } from 'react'
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
import type {
  AppUiState,
  DetectedApp,
  GitStatus,
  ProjectRecord,
  WorkspaceRecord
} from '@shared/types'
import { ContextMenu, type ContextMenuItem } from '../../ContextMenu'
import { Identicon } from '../../Identicon'
import { SplitButton } from '../../SplitButton'
import { Skeleton } from '../../Skeleton'
import { playSound } from '../../../lib/sound'
import { NewWorkspaceMenu } from '../NewWorkspaceMenu'

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
// Subcomponents (private — not reusable outside this file)
// ---------------------------------------------------------------------------

// Shared CSS for the two icon-only square buttons (Settings, More-actions).
const ICON_BTN_CLS = [
  'inline-flex items-center justify-center w-8 h-8 rounded-md',
  'border border-border-default text-text-secondary',
  'transition-colors duration-150 cursor-pointer',
  'hover:text-text-primary hover:bg-surface-overlay',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50'
].join(' ')

interface HeaderIconButtonProps {
  onClick: (e: React.MouseEvent) => void
  ariaLabel: string
  title?: string
  ariaHasPopup?: React.AriaAttributes['aria-haspopup']
  children: React.ReactNode
}

const HeaderIconButton = memo(function HeaderIconButton({
  onClick,
  ariaLabel,
  title,
  ariaHasPopup,
  children
}: HeaderIconButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-haspopup={ariaHasPopup}
      title={title}
      className={ICON_BTN_CLS}
    >
      {children}
    </button>
  )
})

// Path display + copy-to-clipboard button — a single inline unit so they never wrap apart.
interface PathWithCopyProps {
  path: string
  onCopy: () => void
  copied: boolean
}

const PathWithCopy = memo(function PathWithCopy({
  path,
  onCopy,
  copied
}: PathWithCopyProps): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 min-w-0 flex-1">
      <p className="text-xs text-text-muted font-mono truncate min-w-0" title={path}>
        {path}
      </p>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? 'Path copied' : 'Copy path to clipboard'}
        title={copied ? 'Copied' : 'Copy path'}
        className={[
          'flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md',
          'transition-colors duration-150 cursor-pointer',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          copied
            ? 'text-emerald-400'
            : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
        ].join(' ')}
      >
        {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
      </button>
    </span>
  )
})

// Metadata strip: git branch, workspace count, last-activity, and override count.
interface ProjectMetaProps {
  gitBranch: string | null | undefined
  workspacesLabel: string | null
  activityLabel: string
  overrideCount: number | null
  onOpenSettings: () => void
}

const ProjectMeta = memo(function ProjectMeta({
  gitBranch,
  workspacesLabel,
  activityLabel,
  overrideCount,
  onOpenSettings
}: ProjectMetaProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 text-xs text-text-muted flex-wrap">
      {gitBranch && (
        <>
          <span
            className="inline-flex items-center gap-1"
            title={`Current git branch: ${gitBranch}`}
          >
            <GitMerge size={11} />
            <span className="font-mono">{gitBranch}</span>
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
            type="button"
            onClick={onOpenSettings}
            className="text-accent hover:underline cursor-pointer"
          >
            {overrideCount} override{overrideCount === 1 ? '' : 's'}
          </button>
        </>
      ) : null}
    </div>
  )
})

// Right-side action bar: Finder, Editor split-button, Terminal split-button,
// New-workspace, Settings, and More-actions.
interface ProjectActionsProps {
  projectId: string
  projectPath: string
  workspaceDefaultName: string
  editors: DetectedApp[]
  terminals: DetectedApp[]
  activeEditor: DetectedApp | null
  activeTerminal: DetectedApp | null
  onPickEditor: (name: string) => void
  onPickTerminal: (name: string) => void
  onNewWorkspace: () => void
  onWorktreeCreated: (workspace: WorkspaceRecord) => void
  onOpenSettings: () => void
  onOpenMenu: (e: React.MouseEvent) => void
}

const ProjectActions = memo(function ProjectActions({
  projectId,
  projectPath,
  workspaceDefaultName,
  editors,
  terminals,
  activeEditor,
  activeTerminal,
  onPickEditor,
  onPickTerminal,
  onNewWorkspace,
  onWorktreeCreated,
  onOpenSettings,
  onOpenMenu
}: ProjectActionsProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {/* Show in Finder — no picker, single OS app */}
      <button
        type="button"
        onClick={() => window.api.shell.revealInFinder(projectPath).catch(console.error)}
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
        onChange={onPickEditor}
        onClick={() => window.api.shell.openInEditor(projectPath).catch(console.error)}
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
        onChange={onPickTerminal}
        onClick={() => window.api.shell.openTerminal(projectPath).catch(console.error)}
        popoverHeader="Open in"
        primaryDisabled={terminals.length === 0}
      >
        <Terminal size={12} weight="regular" />
        <span>{activeTerminal ? shortAppLabel(activeTerminal) : 'Terminal'}</span>
      </SplitButton>

      <span className="w-px h-5 bg-border-default mx-1" aria-hidden />

      <NewWorkspaceMenu
        projectId={projectId}
        defaultName={workspaceDefaultName}
        onCreateLocal={onNewWorkspace}
        onCreated={onWorktreeCreated}
      >
        <button
          type="button"
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
      </NewWorkspaceMenu>

      <HeaderIconButton
        onClick={onOpenSettings}
        ariaLabel="Project settings"
        title="Project settings"
      >
        <GearSix size={14} />
      </HeaderIconButton>

      <HeaderIconButton
        onClick={onOpenMenu}
        ariaLabel="More actions"
        ariaHasPopup="menu"
        title="More actions"
      >
        <DotsThree size={16} weight="bold" />
      </HeaderIconButton>
    </div>
  )
})

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
  /** Auto-generated next workspace name (e.g. "Workspace 2"), used to seed the worktree branch slug. */
  workspaceDefaultName: string
  onNewWorkspace: () => void
  /** Called after a worktree workspace has been created — navigate to it. */
  onWorktreeCreated: (workspace: WorkspaceRecord) => void
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
  workspaceDefaultName,
  onNewWorkspace,
  onWorktreeCreated,
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

  const copyPath = useCallback(async (): Promise<void> => {
    try {
      await window.api.shell.copyToClipboard(project.path)
      playSound('copy')
      setPathCopied(true)
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
      copyResetTimer.current = setTimeout(() => setPathCopied(false), 1500)
    } catch (err) {
      console.error('[project-header] copy failed', err)
    }
  }, [project.path])

  const pickEditor = useCallback(async (name: string): Promise<void> => {
    setUiState((prev) => (prev ? { ...prev, preferredEditorApp: name } : prev))
    try {
      await window.api.uiState.update({ preferredEditorApp: name })
    } catch (err) {
      console.error('[project-header] persist editor pref failed', err)
    }
  }, [])

  const pickTerminal = useCallback(async (name: string): Promise<void> => {
    setUiState((prev) => (prev ? { ...prev, preferredTerminalApp: name } : prev))
    try {
      await window.api.uiState.update({ preferredTerminalApp: name })
    } catch (err) {
      console.error('[project-header] persist terminal pref failed', err)
    }
  }, [])

  const openMenu = useCallback((e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setMenu({ x: rect.right - 200, y: rect.bottom + 4 })
  }, [])

  const preferredEditor = uiState?.preferredEditorApp ?? null
  const preferredTerminal = uiState?.preferredTerminalApp ?? null

  const activeEditor = editors.find((e) => e.name === preferredEditor) ?? editors[0] ?? null
  const activeTerminal = terminals.find((t) => t.name === preferredTerminal) ?? terminals[0] ?? null

  const overflowMenu: ContextMenuItem[] = [
    {
      label: 'Remove',
      icon: <Archive size={13} />,
      onClick: onRequestRemove,
      destructive: true
    }
  ]

  const workspacesLabel =
    workspaceCount === null ? null : `${workspaceCount} workspace${workspaceCount === 1 ? '' : 's'}`
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
            <h1 className="text-lg font-semibold text-text-primary truncate">{project.name}</h1>
            {/* Path + copy as a single unit so they never wrap apart. */}
            <PathWithCopy path={project.path} onCopy={copyPath} copied={pathCopied} />
          </div>

          <ProjectMeta
            gitBranch={gitStatus?.branch}
            workspacesLabel={workspacesLabel}
            activityLabel={activityLabel}
            overrideCount={overrideCount}
            onOpenSettings={onOpenSettings}
          />
        </div>

        <ProjectActions
          projectId={project.id}
          projectPath={project.path}
          workspaceDefaultName={workspaceDefaultName}
          editors={editors}
          terminals={terminals}
          activeEditor={activeEditor}
          activeTerminal={activeTerminal}
          onPickEditor={pickEditor}
          onPickTerminal={pickTerminal}
          onNewWorkspace={onNewWorkspace}
          onWorktreeCreated={onWorktreeCreated}
          onOpenSettings={onOpenSettings}
          onOpenMenu={openMenu}
        />
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={overflowMenu} />
      )}
    </header>
  )
}
