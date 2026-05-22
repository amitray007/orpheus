import { useEffect, useState } from 'react'
import type React from 'react'
import type {
  AppUiState,
  FooterActionDescriptor,
  FooterActionScope,
  ProjectRecord
} from '@shared/types'
import { SettingRow, Toggle } from './primitives'
import { SettingsSectionSkeleton } from '../../Skeleton'
import { ConfirmModal } from '../../ConfirmModal'
import { IconByName } from '../footer/iconMap'
import { playSound } from '../../../lib/sound'
import { FooterActionEditor } from './footer/FooterActionEditor'

// ---------------------------------------------------------------------------
// OrpheusFooterSection — Workspace Footer settings (phase 4)
// Full editor: scope picker, action list with drag-reorder, split-pane form
// ---------------------------------------------------------------------------

// Scope chip label
function scopeChip(scope: FooterActionScope): string {
  if (scope === 'global') return 'GLB'
  if (scope === 'project') return 'PRJ'
  return 'WS'
}

// ---------------------------------------------------------------------------
// DragHandle icon (three horizontal lines)
// ---------------------------------------------------------------------------
function DragHandle(): React.JSX.Element {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="currentColor"
      aria-hidden="true"
      className="text-text-muted/50"
    >
      <rect y="1.5" width="10" height="1.2" rx="0.6" />
      <rect y="4.4" width="10" height="1.2" rx="0.6" />
      <rect y="7.3" width="10" height="1.2" rx="0.6" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Scope radio button
// ---------------------------------------------------------------------------
interface ScopeRadioProps {
  value: FooterActionScope
  current: FooterActionScope
  label: string
  disabled?: boolean
  onChange: (v: FooterActionScope) => void
}
function ScopeRadio({
  value,
  current,
  label,
  disabled,
  onChange
}: ScopeRadioProps): React.JSX.Element {
  return (
    <label
      className={[
        'flex items-center gap-1.5 text-xs cursor-pointer select-none',
        disabled ? 'opacity-40 cursor-not-allowed' : ''
      ].join(' ')}
    >
      <input
        type="radio"
        name="footer-scope"
        value={value}
        checked={current === value}
        disabled={disabled}
        onChange={() => {
          if (!disabled) onChange(value)
        }}
        className="accent-accent cursor-pointer"
      />
      <span className={current === value && !disabled ? 'text-text-primary' : 'text-text-muted'}>
        {label}
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Action list row
// ---------------------------------------------------------------------------
interface ActionRowProps {
  action: FooterActionDescriptor
  selected: boolean
  isDragging: boolean
  isDropTarget: boolean
  dropPos: 'before' | 'after'
  onSelect: () => void
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onDelete: () => void
}

function ActionRow({
  action,
  selected,
  isDragging,
  isDropTarget,
  dropPos,
  onSelect,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onDelete
}: ActionRowProps): React.JSX.Element {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={onSelect}
      className={[
        'relative flex items-center gap-2 px-2.5 py-2 rounded cursor-pointer transition-colors duration-100',
        'group',
        selected
          ? 'bg-accent/12 text-text-primary'
          : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary',
        isDragging ? 'opacity-40' : '',
        isDropTarget && dropPos === 'before'
          ? 'border-t-2 border-accent'
          : isDropTarget && dropPos === 'after'
            ? 'border-b-2 border-accent'
            : ''
      ].join(' ')}
    >
      {/* Drag handle */}
      <span className="flex-shrink-0 cursor-grab active:cursor-grabbing">
        <DragHandle />
      </span>

      {/* Icon */}
      <span className="flex-shrink-0 w-3 h-3 flex items-center justify-center text-text-muted">
        {action.icon ? <IconByName name={action.icon} size={12} /> : null}
      </span>

      {/* Label */}
      <span className="flex-1 min-w-0 text-xs truncate">{action.label}</span>

      {/* Scope chip */}
      <span className="flex-shrink-0 text-[9px] font-mono text-text-muted/60 bg-surface-overlay px-1 py-0.5 rounded">
        {scopeChip(action.scope)}
      </span>

      {/* Delete button (hover only) */}
      <button
        type="button"
        title="Delete action"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
        className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 text-text-muted hover:text-red-400 transition-all duration-150 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
          <path
            d="M1.5 1.5L6.5 6.5M6.5 1.5L1.5 6.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function OrpheusFooterSection(): React.JSX.Element {
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Scope picker — only Global and Project (workspace scope deliberately dropped
  // as too micro). The full projects list is loaded so the user can pick which
  // project to author against directly from Settings (not tied to whatever
  // they last opened in the nav).
  const [scope, setScope] = useState<FooterActionScope>('global')
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)

  // Actions list for the current scope
  const [actions, setActions] = useState<FooterActionDescriptor[]>([])
  const [actionsLoading, setActionsLoading] = useState(false)

  // Selected action + editor mode
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  // Drag-reorder state
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [dropPos, setDropPos] = useState<'before' | 'after'>('before')

  // Delete confirm
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Reset confirm
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [resetting, setResetting] = useState(false)

  // Bootstrap: load uiState + the full projects list so the user can pick
  // which project to author against. Default-select the last-opened project
  // if it still exists; otherwise fall back to the first project (if any).
  useEffect(() => {
    let cancelled = false

    async function boot(): Promise<void> {
      try {
        const [s, projectsList] = await Promise.all([
          window.api.uiState.get(),
          window.api.projects.list()
        ])
        if (cancelled) return
        setUiState(s)
        setProjects(projectsList)

        const lastPid = s.lastProjectId
        const defaultProj =
          (lastPid && projectsList.find((p) => p.id === lastPid)) ?? projectsList[0] ?? null
        if (defaultProj) setProjectId(defaultProj.id)

        setLoading(false)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      }
    }

    void boot()
    return () => {
      cancelled = true
    }
  }, [])

  // Load actions whenever scope changes
  useEffect(() => {
    if (loading) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: scope change triggers async fetch; clear UI immediately.
    setActionsLoading(true)
    setSelectedId(null)
    setIsCreating(false)

    const sid = scope === 'global' ? undefined : (projectId ?? undefined)

    window.api.footerActions
      .listAtScope(scope, sid)
      .then((rows) => {
        if (!cancelled) {
          setActions(rows)
          setActionsLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) setActionsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [scope, projectId, loading])

  function refetchActions(): void {
    const sid = scope === 'global' ? undefined : (projectId ?? undefined)
    setActionsLoading(true)
    window.api.footerActions
      .listAtScope(scope, sid)
      .then((rows) => {
        setActions(rows)
        setActionsLoading(false)
      })
      .catch(() => setActionsLoading(false))
  }

  function toggleFooter(v: boolean): void {
    if (!uiState) return
    setUiState({ ...uiState, showWorkspaceFooter: v })
    window.api.uiState.update({ showWorkspaceFooter: v }).catch((err) => {
      console.error('[settings] showWorkspaceFooter update failed', err)
      window.api.uiState.get().then(setUiState).catch(console.error)
    })
  }

  async function handleResetDefaults(): Promise<void> {
    setResetting(true)
    try {
      await window.api.footerActions.resetDefaults()
      refetchActions()
    } catch (err) {
      console.error('[settings] resetDefaults failed', err)
    } finally {
      setResetting(false)
      setShowResetConfirm(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Drag-reorder (mirrors Sidebar.tsx pattern)
  // ---------------------------------------------------------------------------

  function onDragStart(e: React.DragEvent<HTMLDivElement>, id: string): void {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', id)
    setDragId(id)
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>, id: string): void {
    if (!dragId || dragId === id) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const isAbove = e.clientY < rect.top + rect.height / 2
    setDropTargetId(id)
    setDropPos(isAbove ? 'before' : 'after')
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>, targetId: string): void {
    e.preventDefault()
    if (!dragId || dragId === targetId) {
      setDragId(null)
      setDropTargetId(null)
      return
    }
    const ids = actions.map((a) => a.id)
    const fromIdx = ids.indexOf(dragId)
    if (fromIdx === -1) {
      setDragId(null)
      setDropTargetId(null)
      return
    }
    ids.splice(fromIdx, 1)
    let toIdx = ids.indexOf(targetId)
    if (toIdx === -1) toIdx = ids.length
    if (dropPos === 'after') toIdx += 1
    ids.splice(toIdx, 0, dragId)

    // Optimistic update
    const reordered = ids
      .map((id) => actions.find((a) => a.id === id))
      .filter(Boolean) as FooterActionDescriptor[]
    setActions(reordered)

    const sid = scope === 'global' ? null : (projectId ?? null)
    window.api.footerActions.reorder(scope, sid, ids).catch((err) => {
      console.error('[settings] reorder failed', err)
      refetchActions()
    })

    setDragId(null)
    setDropTargetId(null)
  }

  function onDragEnd(): void {
    setDragId(null)
    setDropTargetId(null)
  }

  // ---------------------------------------------------------------------------
  // Delete (from row hover-button — quick delete without editor)
  // ---------------------------------------------------------------------------

  async function handleRowDelete(id: string): Promise<void> {
    playSound('pop')
    try {
      await window.api.footerActions.remove(id)
      setActions((prev) => prev.filter((a) => a.id !== id))
      if (selectedId === id) {
        setSelectedId(null)
        setIsCreating(false)
      }
    } catch (err) {
      console.error('[settings] delete failed', err)
    } finally {
      setDeletingId(null)
    }
  }

  // ---------------------------------------------------------------------------
  // Editor callbacks
  // ---------------------------------------------------------------------------

  function handleEditorSave(): void {
    setSelectedId(null)
    setIsCreating(false)
    refetchActions()
  }

  function handleEditorCancel(): void {
    playSound('click')
    setSelectedId(null)
    setIsCreating(false)
  }

  function handleEditorDelete(id: string): void {
    setActions((prev) => prev.filter((a) => a.id !== id))
    setSelectedId(null)
    setIsCreating(false)
  }

  // ---------------------------------------------------------------------------
  // Render guards
  // ---------------------------------------------------------------------------

  if (error) {
    return (
      <div className="rounded-lg border border-border-default bg-surface-raised p-4 text-sm text-red-400">
        Failed to load: {error}
      </div>
    )
  }

  if (!uiState || loading) {
    return <SettingsSectionSkeleton />
  }

  const scopeId = scope === 'global' ? null : projectId

  const selectedAction = selectedId ? (actions.find((a) => a.id === selectedId) ?? null) : null
  const showEditor = isCreating || selectedId !== null

  return (
    <>
      {showResetConfirm && (
        <ConfirmModal
          title="Reset footer actions?"
          body={
            <p className="text-sm text-text-secondary">
              This will delete all global footer actions and restore the default actions.
              Project-scoped actions are not affected.
            </p>
          }
          confirmLabel={resetting ? 'Resetting…' : 'Reset to defaults'}
          destructive
          onConfirm={handleResetDefaults}
          onCancel={() => setShowResetConfirm(false)}
        />
      )}

      {deletingId && (
        <ConfirmModal
          title="Delete action?"
          body={
            <p className="text-sm text-text-secondary">
              This will permanently remove{' '}
              <strong>{actions.find((a) => a.id === deletingId)?.label ?? 'this action'}</strong>.
            </p>
          }
          confirmLabel="Delete"
          destructive
          onConfirm={() => handleRowDelete(deletingId)}
          onCancel={() => setDeletingId(null)}
        />
      )}

      <div className="flex flex-col gap-6">
        {/* Toggle row */}
        <div className="space-y-0">
          <SettingRow
            label="Show workspace footer"
            description="Display a single-line action strip at the bottom of each workspace terminal."
          >
            <Toggle
              value={uiState.showWorkspaceFooter}
              onChange={toggleFooter}
              ariaLabel="Show workspace footer"
            />
          </SettingRow>
        </div>

        {/* Scope picker — Global + Project (workspace scope deliberately omitted). */}
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
            Scope
          </h3>
          <div className="flex items-center gap-4 flex-wrap">
            <ScopeRadio value="global" current={scope} label="Global" onChange={setScope} />
            <ScopeRadio
              value="project"
              current={scope}
              label="Project"
              disabled={projects.length === 0}
              onChange={setScope}
            />
            {scope === 'project' && projects.length > 0 && (
              <select
                value={projectId ?? ''}
                onChange={(e) => setProjectId(e.target.value)}
                className="text-xs bg-surface-overlay border border-border-default/60 rounded px-2 py-1 text-text-primary outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                aria-label="Project for scoped actions"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {projects.length === 0 && (
            <p className="text-[11px] text-text-muted">
              Add a project to author project-scoped actions.
            </p>
          )}
        </div>

        {/* Split pane */}
        <div className="flex flex-col lg:flex-row gap-4 min-h-[320px]">
          {/* Left: action list */}
          <div className="flex flex-col gap-2 lg:w-[45%] flex-shrink-0">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase tracking-wider text-text-secondary">
                Actions at this scope
              </h3>
            </div>

            <div className="bg-surface-raised border border-border-default rounded-lg flex flex-col flex-1 min-h-[200px]">
              {actionsLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="text-xs text-text-muted">Loading…</span>
                </div>
              ) : actions.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-1 px-4 py-6 text-center">
                  <p className="text-xs text-text-muted">No actions at this scope.</p>
                  <p className="text-[11px] text-text-muted/60">
                    Global actions apply everywhere; project and workspace actions are additive.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-0 p-1.5">
                  {actions.map((action) => (
                    <ActionRow
                      key={action.id}
                      action={action}
                      selected={selectedId === action.id}
                      isDragging={dragId === action.id}
                      isDropTarget={dropTargetId === action.id}
                      dropPos={dropPos}
                      onSelect={() => {
                        setSelectedId(action.id)
                        setIsCreating(false)
                      }}
                      onDragStart={(e) => onDragStart(e, action.id)}
                      onDragOver={(e) => onDragOver(e, action.id)}
                      onDrop={(e) => onDrop(e, action.id)}
                      onDragEnd={onDragEnd}
                      onDelete={() => setDeletingId(action.id)}
                    />
                  ))}
                </div>
              )}

              {/* Add action */}
              <div className="border-t border-border-default/40 mt-auto px-2.5 py-2">
                <button
                  type="button"
                  onClick={() => {
                    playSound('click')
                    setIsCreating(true)
                    setSelectedId(null)
                  }}
                  className="w-full flex items-center gap-1.5 text-xs text-text-muted hover:text-text-primary transition-colors duration-150 px-1 py-1 rounded hover:bg-surface-overlay"
                >
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 11 11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                  >
                    <line x1="5.5" y1="1" x2="5.5" y2="10" />
                    <line x1="1" y1="5.5" x2="10" y2="5.5" />
                  </svg>
                  Add action
                </button>
              </div>
            </div>
          </div>

          {/* Right: editor */}
          <div className="flex flex-col flex-1 min-w-0">
            <div className="bg-surface-raised border border-border-default rounded-lg flex flex-col flex-1 p-4 min-h-[200px]">
              {showEditor ? (
                <FooterActionEditor
                  scope={scope}
                  scopeId={scopeId}
                  action={isCreating ? null : selectedAction}
                  onSave={handleEditorSave}
                  onCancel={handleEditorCancel}
                  onDelete={handleEditorDelete}
                />
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-1.5 text-center px-4">
                  <p className="text-xs text-text-muted">
                    Select an action to edit, or click{' '}
                    <span className="font-medium text-text-secondary">+ Add action</span>.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Reset */}
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => {
              playSound('click')
              setShowResetConfirm(true)
            }}
            className="text-xs text-text-muted hover:text-text-primary transition-colors duration-150 px-2 py-1 rounded hover:bg-surface-overlay"
          >
            Reset all to defaults
          </button>
        </div>
      </div>
    </>
  )
}
