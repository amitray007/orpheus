import type React from 'react'
import { useState } from 'react'
import { Folder, Terminal, Archive, PencilSimple } from '@phosphor-icons/react'
import type { ProjectRecord, WorkspaceRecord } from '@shared/types'

// ---------------------------------------------------------------------------
// Relative time helper
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
// WorkspaceView
// ---------------------------------------------------------------------------

interface WorkspaceViewProps {
  workspace: WorkspaceRecord
  project: ProjectRecord
  onArchive: () => void
}

export function WorkspaceView({
  workspace,
  project,
  onArchive
}: WorkspaceViewProps): React.JSX.Element {
  const [archiving, setArchiving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(workspace.name)

  async function handleArchive(): Promise<void> {
    if (archiving) return
    setArchiving(true)
    try {
      await window.api.workspaces.archive(workspace.id)
      onArchive()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[workspace-view] archive failed:', msg)
      alert(msg.includes('last active') ? msg : 'Archive failed. Check console for details.')
      setArchiving(false)
    }
  }

  async function handleRename(): Promise<void> {
    if (!renameValue.trim() || renameValue.trim() === workspace.name) {
      setRenaming(false)
      return
    }
    try {
      await window.api.workspaces.rename(workspace.id, renameValue.trim())
      setRenaming(false)
    } catch (err) {
      console.error('[workspace-view] rename failed', err)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {/* Breadcrumb: project name */}
          <p className="text-xs text-text-muted font-medium mb-0.5 truncate">{project.name}</p>

          {/* Workspace name */}
          {renaming ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRename()
                if (e.key === 'Escape') {
                  setRenameValue(workspace.name)
                  setRenaming(false)
                }
              }}
              className="text-xl font-semibold text-text-primary bg-surface-overlay border border-accent/40 rounded px-2 py-0.5 outline-none w-full max-w-sm"
            />
          ) : (
            <h1
              className="text-xl font-semibold text-text-primary truncate cursor-text"
              onClick={() => setRenaming(true)}
              title="Click to rename"
            >
              {workspace.name}
            </h1>
          )}

          {/* cwd path */}
          <p
            className="text-xs text-text-muted mt-1 flex items-center gap-1 truncate"
            title={workspace.cwd}
          >
            <Folder size={11} className="flex-shrink-0" />
            {workspace.cwd}
          </p>

          {workspace.lastOpenedAt && (
            <p className="text-xs text-text-muted mt-0.5">
              Last opened {relativeTime(workspace.lastOpenedAt)}
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setRenaming(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border-default transition-colors duration-150 text-text-secondary hover:text-text-primary hover:bg-surface-overlay"
          >
            <PencilSimple size={13} />
            Rename
          </button>
          <button
            onClick={handleArchive}
            disabled={archiving}
            className={[
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
              'border border-border-default transition-colors duration-150 flex-shrink-0',
              archiving
                ? 'opacity-40 cursor-wait text-text-muted'
                : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
            ].join(' ')}
          >
            <Archive size={13} weight="regular" />
            {archiving ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      </div>

      {/* Terminal placeholder */}
      <div className="bg-surface-raised border border-border-default rounded-lg p-10 flex flex-col items-center gap-3">
        <Terminal size={40} className="text-text-muted opacity-40" />
        <div className="text-center">
          <p className="text-sm font-medium text-text-secondary">Terminal — coming soon</p>
          <p className="text-xs text-text-muted mt-1.5 max-w-xs">
            This workspace&apos;s terminal will run{' '}
            <code className="text-accent/80 bg-surface-overlay px-1 py-0.5 rounded text-[11px]">
              claude
            </code>{' '}
            here when libghostty integration lands.
          </p>
        </div>
      </div>
    </div>
  )
}
