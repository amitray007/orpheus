import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import { GitBranch, Plus, SpinnerGap } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'
import { Overlay } from '../ui/Overlay'
import { useFocusOnMount } from '@/lib/useFocusOnMount'
import { playSound } from '@/lib/sound'
import { useSidebarBounds } from './SidebarBoundsContext'

// ---------------------------------------------------------------------------
// Renderer-side slug helper (mirrors main/worktrees.ts worktreeSlug without
// Node's crypto module).
// ---------------------------------------------------------------------------

function worktreeSlugRenderer(name: string): string {
  const normalized = name.normalize('NFKD').replace(/[̀-ͯ]/g, '')
  const slugged = normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const trimmed = slugged.replace(/^-+|-+$/g, '')
  const capped = trimmed.slice(0, 40)
  if (capped.length === 0) {
    return `wt-${Math.random().toString(36).slice(2, 8)}`
  }
  return capped
}

// ---------------------------------------------------------------------------
// Branch-field sub-view (shown when Worktree mode is active)
// ---------------------------------------------------------------------------

interface BranchFieldProps {
  projectId: string
  defaultBranch: string
  onCreated: (record: WorkspaceRecord) => void
  onCancel: () => void
}

function BranchInput({
  value,
  onChange,
  onKeyDown,
  className,
  disabled
}: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  className: string
  disabled?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  useFocusOnMount(ref)
  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      disabled={disabled}
      className={className}
      placeholder="branch-name"
      aria-label="Branch name for worktree workspace"
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
    />
  )
}

function BranchField({
  projectId,
  defaultBranch,
  onCreated,
  onCancel
}: BranchFieldProps): React.JSX.Element {
  const [branch, setBranch] = useState(defaultBranch)
  const [exists, setExists] = useState<boolean | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activeCheckRef = useRef(0)

  // Clear any pending debounce timer on unmount to prevent a stale IPC call
  // firing after Escape/close, which could collide with a fresh remount's token.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const checkBranch = useCallback(
    (value: string): void => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (!value.trim()) {
        setExists(null)
        return
      }
      const token = ++activeCheckRef.current
      debounceRef.current = setTimeout(() => {
        window.api.worktrees
          .branchExists(projectId, value.trim())
          .then((result) => {
            if (token === activeCheckRef.current) setExists(result)
          })
          .catch(() => {
            if (token === activeCheckRef.current) setExists(null)
          })
      }, 300)
    },
    [projectId]
  )

  function handleChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const v = e.target.value
    setBranch(v)
    setError(null)
    setExists(null)
    checkBranch(v)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleCreate()
    }
  }

  async function handleCreate(): Promise<void> {
    const trimmed = branch.trim()
    if (!trimmed || creating) return
    setCreating(true)
    setError(null)
    try {
      // Derive a workspace name from the branch (strip worktree- prefix, capitalise).
      const name =
        trimmed
          .replace(/^worktree-/, '')
          .replace(/-+/g, ' ')
          .trim()
          .replace(/\b\w/g, (c) => c.toUpperCase()) || trimmed
      const record = await window.api.workspaces.createWorktree(projectId, {
        name,
        branch: trimmed
      })
      playSound('pop')
      onCreated(record)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCreating(false)
    }
  }

  const trimmed = branch.trim()
  const hint =
    exists === true ? 'branch exists — will check it out' : exists === false ? 'new branch' : null

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <div className="flex items-center gap-1.5">
        <GitBranch size={12} className="text-text-muted flex-shrink-0" />
        <span className="text-xs text-text-muted">Branch</span>
      </div>
      <div className="relative flex items-center">
        <BranchInput
          value={branch}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={creating}
          className={[
            'w-full text-xs px-2 py-1.5 rounded-md border outline-none',
            'bg-surface-default text-text-primary placeholder:text-text-muted',
            creating
              ? 'border-border-default opacity-60 cursor-not-allowed'
              : 'border-border-default focus:border-accent/60',
            error ? 'border-red-500/60' : ''
          ]
            .filter(Boolean)
            .join(' ')}
        />
        {creating && (
          <span className="absolute right-2 text-text-muted animate-spin">
            <SpinnerGap size={12} />
          </span>
        )}
      </div>

      {hint && !error && <p className="text-xs text-text-muted leading-tight">{hint}</p>}
      {error && <p className="text-xs text-red-400 leading-tight break-words">{error}</p>}

      <div className="flex items-center gap-1.5 mt-0.5">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={!trimmed || creating}
          className={[
            'flex-1 text-xs px-2 py-1 rounded-md border font-medium',
            'transition-colors duration-100',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            !trimmed || creating
              ? 'opacity-40 cursor-not-allowed border-border-default text-text-muted'
              : 'bg-accent/15 border-accent/30 text-text-primary hover:bg-accent/25 cursor-pointer'
          ].join(' ')}
        >
          {creating ? 'Creating…' : 'Create'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={creating}
          className="text-xs px-2 py-1 rounded-md border border-border-default text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 cursor-pointer"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Offered modes cache — module-level, shared across all instances.
// ---------------------------------------------------------------------------

const modesCache = new Map<string, { local: boolean; worktree: boolean }>()

// ---------------------------------------------------------------------------
// NewWorkspaceMenu
//
// Props:
//   projectId     — the project this workspace will belong to
//   defaultName   — auto-generated workspace name (used to seed the branch slug)
//   onCreateLocal — callback to perform the plain-create (Local) path
//   onCreated     — callback fired after a worktree workspace is created
//   children      — the trigger element (the "+" button or similar)
//   className     — forwarded to the wrapper div
// ---------------------------------------------------------------------------

export interface NewWorkspaceMenuProps {
  projectId: string
  /** Auto-generated workspace name for the current project (e.g. "Workspace 2"). */
  defaultName: string
  /** Called to create a local workspace via the existing plain-create path. */
  onCreateLocal: () => void
  /** Called after a worktree workspace has been created. */
  onCreated: (record: WorkspaceRecord) => void
  /** The trigger element — the "+" button or text link. */
  children: React.ReactNode
  /** Extra class names applied to the wrapper div. */
  className?: string
}

type MenuView = 'closed' | 'picker' | 'branch'

// Anchor position captured on click so the overlay can use `position: fixed`
// without reading `ref.current` during render.
type AnchorPos = { top: number; left: number }

// Clamped popover position, computed after the rendered content is measured.
type ClampedPos = { top: number; left: number }

export function NewWorkspaceMenu({
  projectId,
  defaultName,
  onCreateLocal,
  onCreated,
  children,
  className
}: NewWorkspaceMenuProps): React.JSX.Element {
  const [view, setView] = useState<MenuView>('closed')
  const [modes, setModes] = useState<{ local: boolean; worktree: boolean } | null>(
    () => modesCache.get(projectId) ?? null
  )
  const [anchorPos, setAnchorPos] = useState<AnchorPos | null>(null)
  const [clampedPos, setClampedPos] = useState<ClampedPos | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const sidebarBoundsRef = useSidebarBounds()

  // Fetch offered modes (async IPC call), populating the cache.
  // Single-fire auto-create: if only one mode is available, collapse immediately
  // in the .then() resolve handler — never in a reactive effect — so the local-only
  // path runs exactly once per fetch regardless of onCreateLocal identity changes.
  const fetchModes = useCallback((): void => {
    window.api.app
      .offeredModes(projectId)
      .then((m) => {
        modesCache.set(projectId, m)
        setModes(m)
        // Collapse immediately in the resolve handler (single-fire, no re-run risk).
        // Only collapse when the picker is open (view check via functional update pattern
        // is not available here, but the menu is guaranteed open since fetchModes is only
        // called from handleTriggerClick when transitioning to 'picker').
        if (!m.local && !m.worktree) return // both unavailable — leave picker visible
        if (m.local && m.worktree) return // both offered — keep picker open
        if (m.worktree) {
          setView('branch')
        } else {
          // local-only: auto-create once, right here in the resolve handler.
          setView('closed')
          onCreateLocal()
        }
      })
      .catch(() => {
        const fallback = { local: true, worktree: false }
        modesCache.set(projectId, fallback)
        setModes(fallback)
        // On error, fallback is local-only — auto-create once.
        setView('closed')
        onCreateLocal()
      })
  }, [projectId, onCreateLocal])

  // When modes load while the picker is shown, collapse to the appropriate action.
  // Note: auto-create (local-only path) is handled directly in fetchModes above.
  // This effect only handles the worktree-only collapse (no double-create risk).
  useEffect(() => {
    if (view !== 'picker' || modes === null) return
    // Both offered → keep picker open; otherwise collapse.
    if (modes.local && modes.worktree) return
    if (modes.worktree) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- triggered by async offeredModes resolve, not a cascading sync call
      setView('branch')
    }
    // local-only case is handled in fetchModes .then() — do NOT call onCreateLocal here.
  }, [modes, view])

  // Clamp the popover inside the sidebar bounds (falling back to the viewport),
  // mirroring ContextMenu's clamping math. Re-runs whenever the anchor changes,
  // the view switches (picker -> branch resizes the card), or modes finish
  // loading (loading -> loaded picker can change size).
  useLayoutEffect(() => {
    if (view === 'closed' || !anchorPos) return
    const el = contentRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let top = anchorPos.top
    let left = anchorPos.left
    const bounds = sidebarBoundsRef?.current?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight
    }
    if (left + rect.width > bounds.right) left = bounds.right - rect.width - 4
    if (top + rect.height > bounds.bottom) top = bounds.bottom - rect.height - 4
    if (left < bounds.left) left = bounds.left + 4
    if (top < bounds.top) top = bounds.top + 4
    setClampedPos({ top, left })
  }, [anchorPos, view, modes, sidebarBoundsRef])

  // Reposition on window resize while open (mirrors TopBar's StatusPopover).
  useEffect(() => {
    if (view === 'closed') return
    function reposition(): void {
      if (!wrapperRef.current) return
      const rect = wrapperRef.current.getBoundingClientRect()
      setAnchorPos({ top: rect.bottom + 4, left: rect.left })
    }
    window.addEventListener('resize', reposition)
    return () => window.removeEventListener('resize', reposition)
  }, [view])

  function captureAnchor(): AnchorPos | null {
    if (!wrapperRef.current) return null
    const rect = wrapperRef.current.getBoundingClientRect()
    return { top: rect.bottom + 4, left: rect.left }
  }

  function handleTriggerClick(e: React.MouseEvent): void {
    e.stopPropagation()

    if (view !== 'closed') {
      setView('closed')
      return
    }

    // Capture anchor position immediately while the element is still in layout.
    const pos = captureAnchor()
    setAnchorPos(pos)
    // Reset the clamped position so the popover doesn't briefly render at a
    // stale clamped location from a prior open before the layout effect reruns.
    setClampedPos(pos)

    // Always re-fetch on open to pick up config changes (clears the cache entry).
    modesCache.delete(projectId)
    // Kick off async fetch; state update arrives via setModes in fetchModes.
    fetchModes()

    // Open immediately and stay open through the async fetch — the picker
    // renders a stable loading state (see showLoading below) instead of
    // vanishing while modes === null, so there's no flicker.
    setView('picker')
  }

  // Genuine-dismiss only: outside-click, Escape (both handled by Overlay), or an
  // explicit selection (Local/Worktree picked, or branch created/cancelled).
  // The trigger's onMouseDown stopPropagation (above) prevents the same click
  // that opens the menu from being seen as an "outside" click by Overlay.
  function handleClose(): void {
    setView('closed')
    setAnchorPos(null)
    setClampedPos(null)
  }

  function handlePickLocal(e: React.MouseEvent): void {
    e.stopPropagation()
    setView('closed')
    onCreateLocal()
  }

  function handlePickWorktree(e: React.MouseEvent): void {
    e.stopPropagation()
    setView('branch')
  }

  function handleCreated(record: WorkspaceRecord): void {
    setView('closed')
    onCreated(record)
  }

  const defaultBranch = `worktree-${worktreeSlugRenderer(defaultName)}`

  // The picker stays mounted for the entire 'picker' view — including while
  // fetchModes() is in flight — so the menu never visually vanishes-then-
  // reappears. While modes === null we render a stable disabled/loading state
  // instead of nothing; once modes resolve to "both offered" we render the
  // real Local/Worktree items (single-mode cases collapse away via the effect
  // above / fetchModes' resolve handler, never rendered here).
  const showPicker = view === 'picker'
  const showBranch = view === 'branch'
  const pickerLoading = modes === null

  const overlayStyle: React.CSSProperties | undefined = clampedPos ?? anchorPos ?? undefined

  return (
    <div ref={wrapperRef} className={['relative flex', className].filter(Boolean).join(' ')}>
      {/* Trigger wrapper — intercepts clicks before they reach the inner button.
          onMouseDown stops propagation so the SAME click that opens the menu
          isn't also seen by Overlay's document-level outside-mousedown listener
          (which would otherwise fire onDismiss for the trigger's own mousedown,
          since the trigger sits outside the portaled Overlay's ref). flex-1 so
          the trigger (and the button inside it) can stretch to fill a
          full-width wrapper — inline-flex would shrink both to content size. */}
      <div
        onClick={handleTriggerClick}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex flex-1"
      >
        {children}
      </div>

      {/* Picker dropdown: Local | Worktree. Stays mounted (view='picker') through
          the async fetchModes() load — shows a disabled/loading state rather
          than unmounting, so the menu never flickers or vanishes mid-load. */}
      <Overlay
        open={showPicker}
        interactive
        onDismiss={handleClose}
        portal
        className="fixed z-50 min-w-[140px] rounded-md border border-border-default bg-surface-overlay shadow-lg py-1"
        style={overlayStyle}
      >
        <div ref={contentRef} role="menu">
          {pickerLoading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted">
              <SpinnerGap size={12} className="animate-spin flex-shrink-0" />
              Loading…
            </div>
          ) : modes && modes.local && modes.worktree ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={handlePickLocal}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-text-primary transition-colors duration-100 hover:bg-surface-raised focus-visible:outline-none focus-visible:bg-surface-raised cursor-pointer"
              >
                <Plus size={12} weight="bold" className="text-text-muted flex-shrink-0" />
                Local
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={handlePickWorktree}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-text-primary transition-colors duration-100 hover:bg-surface-raised focus-visible:outline-none focus-visible:bg-surface-raised cursor-pointer"
              >
                <GitBranch size={12} className="text-text-muted flex-shrink-0" />
                Worktree
              </button>
            </>
          ) : (
            // Both modes unavailable (rare/error edge case) — nothing sensible
            // to offer; render an empty measured node so clamping still works
            // and the menu doesn't look broken open with no content semantics.
            <div className="px-3 py-2 text-sm text-text-muted">No workspace types available</div>
          )}
        </div>
      </Overlay>

      {/* Branch field panel */}
      <Overlay
        open={showBranch}
        interactive
        onDismiss={handleClose}
        portal
        className="fixed z-50 w-64 rounded-md border border-border-default bg-surface-overlay shadow-lg"
        style={overlayStyle}
      >
        <div ref={contentRef}>
          <BranchField
            projectId={projectId}
            defaultBranch={defaultBranch}
            onCreated={handleCreated}
            onCancel={handleClose}
          />
        </div>
      </Overlay>
    </div>
  )
}
