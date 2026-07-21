import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { CaretRight, GitBranch, House, SpinnerGap } from '@phosphor-icons/react'
import type { WorkspaceRecord } from '@shared/types'
import { Overlay } from '../ui/Overlay'
import { ProviderIcon } from '../ProviderIcon'
import { useFocusOnMount } from '@/lib/useFocusOnMount'
import { playSound } from '@/lib/sound'
import { useSidebarBounds } from './SidebarBoundsContext'
import { useSelectableModels } from '@/lib/useSelectableModels'
import { labelFor } from '@/lib/modelPickerOptions'
import {
  groupModelsForCreation,
  initialCreationProviderId,
  lastUsedModelForProvider,
  type CreationProviderGroup
} from '@/lib/creationProviderMenu'
import { recordCreationLastUsed, useCreationLastUsedState } from '@/lib/creationLastUsedStore'
import { setWorkspaceModel } from '@/lib/workspaceModelStore'

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
  /** The model chosen in the provider/model view before switching to
   *  Worktree — undefined means "use the global/project default" (unchanged
   *  pre-existing behavior). Persisted to the SAME storage the footer Model
   *  chip writes (workspace:setModel) before onCreated fires, so the very
   *  first terminal:mount for this worktree workspace launches routed with
   *  no restart. */
  selectedModelId: string | undefined
  selectedProviderId: string | undefined
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
  selectedModelId,
  selectedProviderId,
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
      // Creation-time model routing (unit 10) — same persistence path the
      // Local button uses (see handleAddWorkspace in Dashboard.tsx): write
      // to workspace:setModel (the SAME storage the footer chip writes)
      // BEFORE onCreated fires navigation, so the first terminal:mount for
      // this worktree workspace composes routed with no restart needed.
      if (selectedModelId) {
        try {
          await window.api.workspaces.setModel(record.id, selectedModelId)
          setWorkspaceModel(record.id, selectedModelId)
        } catch (err) {
          console.error('[NewWorkspaceMenu] failed to set creation-time model', err)
        }
      }
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

  // Read-only echo of the model chosen in the provider/model view — the
  // creation popover's top line stays visible in spirit even after swapping
  // to the branch panel, so the user isn't left wondering what Worktree will
  // actually create with. enabled=true reuses the SAME shared cache the
  // provider/model view already populated (no extra fetch in the common case).
  const { models: modelsForLabel } = useSelectableModels(selectedModelId, true)
  const selectedModelLabel = selectedModelId
    ? (modelsForLabel.find((m) => m.id === selectedModelId)?.label ?? selectedModelId)
    : null

  return (
    <div className="flex flex-col gap-1.5 p-2">
      {selectedModelId && selectedProviderId && (
        <div className="flex items-center gap-1.5 pb-1 border-b border-border-default/60">
          <ProviderIcon providerId={selectedProviderId} size={12} />
          <span className="text-xs text-text-secondary truncate">{selectedModelLabel}</span>
        </div>
      )}
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
// Provider row — top-level "providers" view. Selecting NEVER creates (rule 1
// of the approved design) — it swaps to that provider's model list.
// ---------------------------------------------------------------------------

function ProviderRow({
  group,
  onPick
}: {
  group: CreationProviderGroup
  onPick: (providerId: string) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation()
        onPick(group.providerId)
      }}
      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-text-primary transition-colors duration-100 hover:bg-surface-raised focus-visible:outline-none focus-visible:bg-surface-raised cursor-pointer"
    >
      <ProviderIcon providerId={group.providerId} size={13} />
      <span className="flex-1 truncate">{group.label}</span>
      <span className="text-xs text-text-muted flex-shrink-0">{group.models.length}</span>
      <CaretRight size={11} className="text-text-muted flex-shrink-0" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// NewWorkspaceMenu
//
// Props:
//   projectId     — the project this workspace will belong to
//   defaultName   — auto-generated workspace name (used to seed the branch slug)
//   onCreateLocal — callback to perform the plain-create (Local) path; now
//                   receives the model id chosen in this popover (undefined
//                   = use the global/project default, unchanged pre-existing
//                   behavior)
//   onCreated     — callback fired after a worktree workspace is created
//   children      — the trigger element (the "+" button or similar)
//   className     — forwarded to the wrapper div
// ---------------------------------------------------------------------------

export interface NewWorkspaceMenuProps {
  projectId: string
  /** Auto-generated workspace name for the current project (e.g. "Workspace 2"). */
  defaultName: string
  /** Called to create a local workspace via the existing plain-create path.
   *  `modelId` is the model chosen in this popover (undefined = default). */
  onCreateLocal: (modelId?: string) => void
  /** Called after a worktree workspace has been created. */
  onCreated: (record: WorkspaceRecord) => void
  /** The trigger element — the "+" button or text link. */
  children: React.ReactNode
  /** Extra class names applied to the wrapper div. */
  className?: string
}

// Two-level, in-place swap (rule of the approved design): 'providers' (top
// level) and 'models' (a specific provider's models) render in the SAME
// Overlay instance, swapping content in place on selection — never a nested
// popover triggered off a new anchor. 'branch' is its own Overlay, exactly
// mirroring the pre-existing picker->branch swap this design generalizes.
type MenuView = 'closed' | 'providers' | 'models' | 'branch'

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
  // The provider whose model list is showing in the 'models' view — null
  // while on the 'providers' view.
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null)
  // The currently-selected model — updates live as the user picks a
  // provider (pre-selects that provider's own last-used) or a specific
  // model row. This is what Local/Worktree create with, and what the
  // display-only top line shows.
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [anchorPos, setAnchorPos] = useState<AnchorPos | null>(null)
  const [clampedPos, setClampedPos] = useState<ClampedPos | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const sidebarBoundsRef = useSidebarBounds()

  // The full selectable-model list (Claude always present; routed groups
  // gated on proxy/provider health — see selectable.ts). Shared/cached with
  // every other picker in the app (footer chip, drawers) — this popover
  // computes NO model facts of its own, only groups/orders what main sent.
  const { models: selectableModels } = useSelectableModels(undefined, view !== 'closed')
  const groups = useMemo(() => groupModelsForCreation(selectableModels), [selectableModels])
  const lastUsed = useCreationLastUsedState()

  // Seeding is NOT done at click time — at the moment handleTriggerClick
  // runs, useSelectableModels is still disabled (view is about to flip from
  // 'closed', not yet 'providers'), so `groups` could still be the
  // Claude-only fallback even when the real last-used was a routed provider.
  // Instead, re-seed via effect whenever the popover is on the provider view
  // AND the user hasn't made an explicit pick yet this session — this
  // self-corrects once the real (possibly routed) group list arrives,
  // without ever clobbering a selection the user already made.
  const hasPickedRef = useRef(false)
  useEffect(() => {
    if (view !== 'providers' || hasPickedRef.current) return
    const initialProviderId = initialCreationProviderId(lastUsed, groups)
    const initialGroup = groups.find((g) => g.providerId === initialProviderId)
    const initialModels = initialGroup?.models ?? []
    const modelId = lastUsedModelForProvider(lastUsed, initialProviderId, initialModels)
    setSelectedProviderId(initialProviderId)
    setSelectedModelId(modelId)
  }, [view, groups, lastUsed])

  // Fetch offered modes (async IPC call), populating the cache. No longer
  // auto-collapses/auto-creates on a single-mode project (unlike the old
  // 2-item Local/Worktree picker) — the provider/model view is always the
  // useful first stop now, so a local-only or worktree-only project simply
  // disables the other button (see the render below) rather than skipping
  // the popover entirely.
  const fetchModes = useCallback((): void => {
    window.api.app
      .offeredModes(projectId)
      .then((m) => {
        modesCache.set(projectId, m)
        setModes(m)
      })
      .catch(() => {
        const fallback = { local: true, worktree: false }
        modesCache.set(projectId, fallback)
        setModes(fallback)
      })
  }, [projectId])

  // Clamp the popover inside the sidebar bounds (falling back to the viewport),
  // mirroring ContextMenu's clamping math. Re-runs whenever the anchor changes,
  // the view switches (providers <-> models <-> branch resizes the card), or
  // modes/groups finish loading (loading -> loaded can change size).
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
  }, [anchorPos, view, modes, groups, sidebarBoundsRef])

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
    fetchModes()

    setActiveProviderId(null)
    setSelectedProviderId(null)
    setSelectedModelId(null)
    // Allow the seeding effect above to (re-)run for this fresh open — it
    // self-corrects as `groups` arrives/changes until the user makes an
    // explicit pick.
    hasPickedRef.current = false
    setView('providers')
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

  // Rule 1 of the approved design: clicking a provider row SELECTS, it never
  // creates — swaps the SAME overlay's content to that provider's model
  // list, pre-selecting the provider's own last-used model (marked `●`).
  function handlePickProvider(providerId: string): void {
    hasPickedRef.current = true
    setActiveProviderId(providerId)
    const group = groups.find((g) => g.providerId === providerId)
    const modelId = lastUsedModelForProvider(lastUsed, providerId, group?.models ?? [])
    setSelectedProviderId(providerId)
    setSelectedModelId(modelId)
    setView('models')
  }

  // Back arrow in the models view — returns to the provider list, keeping
  // the current selection (top line stays whatever was last picked).
  function handleBackToProviders(): void {
    setActiveProviderId(null)
    setView('providers')
  }

  // Rule 1 again: picking a model row SELECTS (updates the live top line +
  // pre-select for next time), never creates.
  function handlePickModel(providerId: string, modelId: string): void {
    hasPickedRef.current = true
    setSelectedProviderId(providerId)
    setSelectedModelId(modelId)
  }

  // Rule 3: Local creates immediately with the currently-selected model.
  // Claude's default entry (nothing explicitly picked yet, or Claude with no
  // sub-selection) passes undefined so the existing global/project-default
  // resolution path is unchanged byte-for-byte.
  function handleCreateLocal(e: React.MouseEvent): void {
    e.stopPropagation()
    const modelId = selectedModelId ?? undefined
    if (modelId && selectedProviderId) recordCreationLastUsed(selectedProviderId, modelId)
    setView('closed')
    onCreateLocal(modelId)
  }

  // Rule 3: Worktree swaps to the existing branch panel, which creates with
  // the currently-selected model (see BranchField's selectedModelId prop).
  function handlePickWorktree(e: React.MouseEvent): void {
    e.stopPropagation()
    if (selectedModelId && selectedProviderId) {
      recordCreationLastUsed(selectedProviderId, selectedModelId)
    }
    setView('branch')
  }

  function handleCreated(record: WorkspaceRecord): void {
    setView('closed')
    onCreated(record)
  }

  const defaultBranch = `worktree-${worktreeSlugRenderer(defaultName)}`

  const showProviders = view === 'providers'
  const showModels = view === 'models'
  const showPicker = showProviders || showModels
  const showBranch = view === 'branch'
  // Only offeredModes (Local/Worktree availability) is a genuine loading gate
  // — selectableModels never needs one: useSelectableModels' synchronous
  // Claude-only fallback (see selectableModelsStore.ts) means `groups` always
  // has at least the Claude entry immediately, even before models:
  // listSelectable resolves, so the provider list itself never needs to wait.
  const pickerLoading = modes === null

  const activeGroup = groups.find((g) => g.providerId === activeProviderId) ?? null
  const activeGroupLastUsedId = activeProviderId
    ? lastUsedModelForProvider(lastUsed, activeProviderId, activeGroup?.models ?? [])
    : null

  const topLineProviderId = selectedProviderId ?? 'claude'
  const topLineGroup = groups.find((g) => g.providerId === topLineProviderId)
  const topLineModel = topLineGroup?.models.find((m) => m.id === selectedModelId)
  const topLineLabel = topLineModel ? labelFor(topLineModel) : (selectedModelId ?? '')

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

      {/* Provider/model picker — ONE Overlay instance whose content swaps
          in place between the provider list and a specific provider's model
          list (rule: two-level in-place swap, never a nested popover). */}
      <Overlay
        open={showPicker}
        interactive
        onDismiss={handleClose}
        portal
        className="fixed z-50 w-64 rounded-md border border-border-default bg-surface-overlay shadow-lg py-1"
        style={overlayStyle}
      >
        <div ref={contentRef}>
          {pickerLoading ? (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-text-muted">
              <SpinnerGap size={12} className="animate-spin flex-shrink-0" />
              Loading…
            </div>
          ) : (
            <>
              {/* Top line — DISPLAY ONLY, not clickable. Shows the currently
                  selected Provider · Model, updates live as the user picks. */}
              <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border-default/60">
                <ProviderIcon providerId={topLineProviderId} size={12} />
                <span className="text-xs text-text-secondary truncate">
                  {topLineGroup?.label ?? 'Claude'}
                  {topLineLabel ? ` · ${topLineLabel}` : ''}
                </span>
              </div>

              {showProviders && (
                <div role="menu">
                  {groups.map((group) => (
                    <ProviderRow key={group.providerId} group={group} onPick={handlePickProvider} />
                  ))}
                </div>
              )}

              {showModels && activeGroup && (
                <div role="menu">
                  <button
                    type="button"
                    onClick={handleBackToProviders}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-text-secondary transition-colors duration-100 hover:bg-surface-raised focus-visible:outline-none focus-visible:bg-surface-raised cursor-pointer"
                  >
                    <ProviderIcon providerId={activeGroup.providerId} size={12} />
                    <span className="flex-1 truncate">{activeGroup.label}</span>
                  </button>
                  {activeGroup.models.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation()
                        handlePickModel(activeGroup.providerId, m.id)
                      }}
                      className="w-full flex items-center gap-2 pl-8 pr-3 py-1.5 text-sm text-left text-text-primary transition-colors duration-100 hover:bg-surface-raised focus-visible:outline-none focus-visible:bg-surface-raised cursor-pointer"
                    >
                      <span className="w-3 flex-shrink-0 text-accent">
                        {m.id === (selectedModelId ?? activeGroupLastUsedId) ? '●' : ''}
                      </span>
                      <span className="flex-1 truncate">{labelFor(m)}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Local / Worktree — the ONLY create actions. Visible in BOTH
                  views. Models/providers above SELECT; only these two CREATE. */}
              <div className="flex items-center gap-1.5 px-2 pt-1.5 mt-1 border-t border-border-default/60">
                <button
                  type="button"
                  onClick={handleCreateLocal}
                  disabled={modes ? !modes.local : false}
                  className={[
                    'flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded-md border font-medium',
                    'transition-colors duration-100',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                    modes && !modes.local
                      ? 'opacity-40 cursor-not-allowed border-border-default text-text-muted'
                      : 'bg-accent/15 border-accent/30 text-text-primary hover:bg-accent/25 cursor-pointer'
                  ].join(' ')}
                >
                  <House size={12} weight="bold" />
                  Local
                </button>
                <button
                  type="button"
                  onClick={handlePickWorktree}
                  disabled={modes ? !modes.worktree : false}
                  className={[
                    'flex-1 flex items-center justify-center gap-1.5 text-xs px-2 py-1.5 rounded-md border font-medium',
                    'transition-colors duration-100',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                    modes && !modes.worktree
                      ? 'opacity-40 cursor-not-allowed border-border-default text-text-muted'
                      : 'border-border-default text-text-primary hover:bg-surface-raised cursor-pointer'
                  ].join(' ')}
                >
                  <GitBranch size={12} />
                  Worktree
                </button>
              </div>
            </>
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
            selectedModelId={selectedModelId ?? undefined}
            selectedProviderId={selectedProviderId ?? undefined}
            onCreated={handleCreated}
            onCancel={handleClose}
          />
        </div>
      </Overlay>
    </div>
  )
}
