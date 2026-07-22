import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { WorkspaceRecord, NewWorkspaceMenuIsolation } from '@shared/types'
import {
  showNewWorkspaceMenu,
  updateNewWorkspaceMenu,
  hideNewWorkspaceMenu,
  newWorkspaceMenuId,
  onNewWorkspaceMenuEvent
} from '@/lib/overlayClient'
import { useOverlayHoverCard } from '@/lib/useOverlayHoverCard'
import { playSound } from '@/lib/sound'
import { useSelectableModels } from '@/lib/useSelectableModels'
import { useRoutingProxyEnabled } from '@/lib/routingProxyEnabledStore'
import {
  groupModelsForCreation,
  initialCreationProviderId,
  lastUsedModelForProvider
} from '@/lib/creationProviderMenu'
import { recordCreationLastUsed, useCreationLastUsedState } from '@/lib/creationLastUsedStore'
import { setWorkspaceModel } from '@/lib/workspaceModelStore'
import { decideCreateAction } from '@/lib/newWorkspaceMenuLogic'

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
// Offered modes cache — module-level, shared across all instances.
// ---------------------------------------------------------------------------

const modesCache = new Map<string, { local: boolean; worktree: boolean }>()

// Submenu hover-intent timing (the "+" TRIGGER itself is click-only — no
// open delay there at all, see handleTriggerClick below; this timing is now
// scoped ENTIRELY to the provider -> model flyout submenu's own
// diagonal-traversal problem). 120ms open matches every other hover-driven
// overlay in this app (Sidebar's HoverCard, WorkspaceTitleBar's DetailsCard);
// 200ms close (toward the top of the requested 150-250ms range) gives room
// to cross the row-to-submenu gap before the flyout vanishes.
const SUBMENU_OPEN_DELAY_MS = 120
const SUBMENU_CLOSE_DELAY_MS = 200

// ---------------------------------------------------------------------------
// NewWorkspaceMenu
//
// Ported to the native overlay layer (model-routing unit 10-creation) so the
// popover paints OVER the terminal instead of being clipped inside the
// sidebar — see src/renderer/src/overlay/kinds/NewWorkspaceMenu.tsx (the
// dumb render+emit half) and src/renderer/src/lib/overlayClient.ts's
// showNewWorkspaceMenu/onNewWorkspaceMenuEvent (the props-down/events-up
// wiring). This component keeps ALL data hooks and every window.api.* call
// (offeredModes, worktrees.branchExists, workspaces.createWorktree/setModel)
// — the overlay kind never computes model facts or touches IPC directly,
// mirroring WorkspaceSettingsPopover.tsx's contract exactly.
//
// CLICK-ONLY TRIGGER (this unit's fix — "it shouldn't open on hover for the
// + icon... only on click, and it should be open until I stay in popover"):
// the "+" trigger has NO hover-open at all anymore — handleTriggerClick is
// the ONLY way the popover opens (a plain toggle: click opens, click again
// closes). Once open, it stays open regardless of pointer position — it
// closes ONLY on: outside click (the pointerdown effect below), Escape (the
// overlay kind's own handler, which emits 'cancel'), a successful create, or
// clicking the trigger again. The `hoverCard` timer machinery below is now
// scoped ENTIRELY to the provider -> model FLYOUT SUBMENU's own
// diagonal-traversal problem (see PROVIDER -> MODEL FLYOUT SUBMENU below) —
// it has nothing to do with the top-level trigger/popover open state
// anymore.
//
// PROVIDER -> MODEL FLYOUT SUBMENU (this unit's redesign — was an in-place
// swap that hid the provider list and lost the user's place): the overlay
// kind (src/renderer/src/overlay/kinds/NewWorkspaceMenu.tsx) now renders the
// provider list AND the active provider's model list as two SIDE-BY-SIDE
// panels in the SAME overlay surface (an in-flow flex layout, not a second
// overlay window — see that file's header comment for the full reasoning on
// why one surface is simpler and is what the existing overlay
// infrastructure supports naturally). This component still owns every
// window.api.* call and the `activeProviderId`/`selectedProviderId`/
// `selectedModelId` state the kind renders from; `onEnterSubmenu`/
// `onLeaveSubmenu` below are the new events that solve the diagonal-
// traversal problem for that submenu specifically (entering EITHER the
// provider row list or the submenu itself cancels any pending close;
// leaving either re-arms it) — the same shape as the trigger-hover fix this
// unit REMOVES from the top level, just moved one level down to where a
// hover-driven affordance still legitimately exists.
//
// CREATE-ACTION INVERSION, HOVER VS. PICK (this unit's bug fixes — see
// onHoverProvider/onPickProvider/onPickModel below): the top line (provider
// icon + model name + an Enter-key affordance) is the ONLY create action, so
// every OTHER interaction in this popover must be purely a SELECTION step,
// never itself destructive of a prior selection:
//   - onHoverProvider (mouse hover) is PURELY NAVIGATIONAL — it opens/
//     switches the flyout submenu so the user can browse a provider's models,
//     but must NOT write to selectedProviderId/selectedModelId (the top
//     line/create payload). Hovering around must never change what Enter/the
//     top line would create.
//   - onPickProvider (explicit click, or ArrowRight/Enter navigating INTO a
//     provider row) IS deliberate user intent, unlike a hover — this DOES
//     commit that provider's last-used model to the top line.
//   - onPickModel (clicking a specific model row) commits that model to the
//     top line AND leaves the submenu OPEN — picking a model is a STEP, not
//     the create action; the user still needs to reach the top line and
//     click it (or press Enter) to actually create. Only outside-click, Esc,
//     a successful create, or clicking the "+" trigger again close things.
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
  /** Disambiguates the overlay id when more than one NewWorkspaceMenu trigger
   *  can be mounted for the SAME projectId at once — e.g. ProjectRow renders
   *  both the always-mounted "+" trigger AND (only while expanded with zero
   *  workspaces) the empty-state "Add workspace" row. Both derive their
   *  overlay id from `projectId` alone by default, so without a suffix they'd
   *  collide: the empty-state instance unmounts the instant the FIRST
   *  workspace is created (workspaces.length flips to 1), and its cleanup
   *  effect calls hideNewWorkspaceMenu(menuId) — which, with a shared id,
   *  force-closes the OTHER instance's popover if it happened to be the one
   *  currently open. Give every extra trigger for the same project a unique
   *  suffix so their overlay ids never alias. */
  idSuffix?: string
}

type MenuView = 'closed' | 'providers' | 'models'

export function NewWorkspaceMenu({
  projectId,
  defaultName,
  onCreateLocal,
  onCreated,
  children,
  className,
  idSuffix
}: NewWorkspaceMenuProps): React.JSX.Element {
  const [view, setView] = useState<MenuView>('closed')
  const [modes, setModes] = useState<{ local: boolean; worktree: boolean } | null>(
    () => modesCache.get(projectId) ?? null
  )
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [isolation, setIsolation] = useState<NewWorkspaceMenuIsolation>('local')

  // Branch-panel state (was BranchField's local state — now lives here since
  // the panel renders inside the SAME popover instance, not a swapped-in
  // second Overlay).
  const [branch, setBranch] = useState('')
  const [branchExists, setBranchExists] = useState<boolean | null>(null)
  const [branchCreating, setBranchCreating] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const branchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const branchCheckTokenRef = useRef(0)

  const wrapperRef = useRef<HTMLDivElement>(null)
  const menuId = idSuffix
    ? `${newWorkspaceMenuId(projectId)}:${idSuffix}`
    : newWorkspaceMenuId(projectId)
  const openRef = useRef(false)
  // Scoped to the provider -> model flyout submenu ONLY (see this file's own
  // header comment) — the top-level trigger/popover no longer uses any
  // hover timer at all, it's click-toggle only.
  const submenuHoverCard = useOverlayHoverCard({
    openDelay: SUBMENU_OPEN_DELAY_MS,
    closeDelay: SUBMENU_CLOSE_DELAY_MS
  })

  // The full selectable-model list (Claude always present; routed groups
  // gated on proxy/provider health — see selectable.ts). Shared/cached with
  // every other picker in the app (footer chip, drawers) — this popover
  // computes NO model facts of its own, only groups/orders what main sent.
  const { models: selectableModels } = useSelectableModels(undefined, view !== 'closed')
  const groups = groupModelsForCreation(selectableModels)
  const lastUsed = useCreationLastUsedState()
  // Gates the pinned "Refresh models" row (model-routing unit 12) — see
  // overlay/kinds/NewWorkspaceMenu.tsx's own doc comment on that row.
  const routingProxyEnabled = useRoutingProxyEnabled()

  const hasPickedRef = useRef(false)

  // Seeding is NOT done at click/hover-open time — at that moment
  // useSelectableModels is still disabled (view is about to flip from
  // 'closed'), so `groups` could still be the Claude-only fallback even when
  // the real last-used was a routed provider. Instead, re-seed via effect
  // whenever the popover is on the provider view AND the user hasn't made an
  // explicit pick yet this session.
  useEffect(() => {
    if (view !== 'providers' || hasPickedRef.current) return
    const initialProviderId = initialCreationProviderId(lastUsed, groups)
    const initialGroup = groups.find((g) => g.providerId === initialProviderId)
    const initialModels = initialGroup?.models ?? []
    const modelId = lastUsedModelForProvider(lastUsed, initialProviderId, initialModels)
    setSelectedProviderId(initialProviderId)
    setSelectedModelId(modelId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- groups is recomputed fresh every render from selectableModels; re-running this seed effect on identity churn (not content) would fight hasPickedRef's "only seed until a real pick" contract.
  }, [view, lastUsed])

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

  const defaultBranch = `worktree-${worktreeSlugRenderer(defaultName)}`

  const checkBranch = useCallback(
    (value: string): void => {
      if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current)
      if (!value.trim()) {
        setBranchExists(null)
        return
      }
      const token = ++branchCheckTokenRef.current
      branchDebounceRef.current = setTimeout(() => {
        window.api.worktrees
          .branchExists(projectId, value.trim())
          .then((result) => {
            if (token === branchCheckTokenRef.current) setBranchExists(result)
          })
          .catch(() => {
            if (token === branchCheckTokenRef.current) setBranchExists(null)
          })
      }, 300)
    },
    [projectId]
  )

  function handleClose(): void {
    openRef.current = false
    setView('closed')
    setActiveProviderId(null)
    setIsolation('local')
    setBranch('')
    setBranchExists(null)
    setBranchCreating(false)
    setBranchError(null)
    if (branchDebounceRef.current) clearTimeout(branchDebounceRef.current)
    hideNewWorkspaceMenu(menuId)
  }

  const openMenu = useCallback((): void => {
    if (openRef.current || !wrapperRef.current) return
    openRef.current = true

    modesCache.delete(projectId)
    fetchModes()

    setActiveProviderId(null)
    setSelectedProviderId(null)
    setSelectedModelId(null)
    setIsolation('local')
    setBranch(defaultBranch)
    setBranchExists(null)
    setBranchCreating(false)
    setBranchError(null)
    hasPickedRef.current = false
    setView('providers')

    showNewWorkspaceMenu(menuId, wrapperRef.current, {
      loading: true,
      groups: [],
      view: 'providers',
      isolation: 'local',
      lastUsedModelIdByProvider: {},
      branchValue: defaultBranch,
      branchExists: null,
      branchCreating: false,
      routingProxyEnabled
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaultBranch/fetchModes/menuId are all stable-per-projectId (or per-render-but-content-stable) — re-running openMenu's identity on their churn would defeat the hover-intent timer's callback stability.
  }, [projectId, fetchModes, menuId])

  // CLICK-ONLY: the sole way this popover opens. No hover-open, no
  // hover-close — once open it stays open until outside-click/Escape/create/
  // clicking the trigger again (see this file's header comment).
  function handleTriggerClick(e: React.MouseEvent): void {
    e.stopPropagation()
    if (openRef.current) {
      handleClose()
      return
    }
    openMenu()
  }

  // Submenu hover-bridge (the provider -> model FLYOUT SUBMENU's own
  // diagonal-traversal fix, NOT the top-level trigger/popover — that one is
  // click-only now, see handleTriggerClick above). The overlay lives in a
  // separate child BrowserWindow, so entering/leaving the provider row list
  // or the submenu panel doesn't reach this component as a native DOM event
  // — the overlay kind emits 'enterSubmenu'/'leaveSubmenu' (routed through
  // onNewWorkspaceMenuEvent below) whenever the pointer crosses into or out
  // of EITHER panel. Entering either cancels any pending close; leaving
  // either re-arms the SAME close timer, so leaving via the submenu behaves
  // identically to leaving via the row list.
  function handleEnterSubmenu(): void {
    submenuHoverCard.clearTimer()
  }

  function handleLeaveSubmenu(): void {
    submenuHoverCard.armClose(() => {
      setActiveProviderId(null)
      setView('providers')
    })
  }

  // Per-provider last-used marker map — passed down as-is so the overlay
  // kind can render the `●` on the right model row without needing to know
  // about CreationLastUsedState's Map-based shape itself.
  const lastUsedModelIdByProvider: Record<string, string> = {}
  for (const [providerId, modelId] of lastUsed.byProvider) {
    lastUsedModelIdByProvider[providerId] = modelId
  }

  async function handleCreate(): Promise<void> {
    // decideCreateAction is the pure, assertable half of this decision (see
    // scripts/verify-new-workspace-menu.ts) — this handler is just its
    // side-effecting continuation (persist last-used, call the right
    // window.api.* path).
    const decision = decideCreateAction(isolation, selectedModelId, branch)
    if (decision.kind === 'disabled' || branchCreating) return

    const modelId = decision.modelId
    if (modelId && selectedProviderId) recordCreationLastUsed(selectedProviderId, modelId)

    if (decision.kind === 'local') {
      handleClose()
      onCreateLocal(modelId)
      return
    }

    // Worktree — create using whatever branch text is currently in the
    // inline branch field.
    const trimmed = decision.branch
    setBranchCreating(true)
    setBranchError(null)
    updateNewWorkspaceMenu(menuId, { branchCreating: true })
    try {
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
      if (modelId) {
        try {
          await window.api.workspaces.setModel(record.id, modelId)
          setWorkspaceModel(record.id, modelId)
        } catch (err) {
          console.error('[NewWorkspaceMenu] failed to set creation-time model', err)
        }
      }
      playSound('pop')
      handleClose()
      onCreated(record)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setBranchError(message)
      setBranchCreating(false)
      updateNewWorkspaceMenu(menuId, { branchCreating: false, branchError: message })
    }
  }

  // Route the popover's emitted events back into this component's state,
  // then push the resulting state back down via updateNewWorkspaceMenu — the
  // same "emit -> handler -> update() push" loop WorkspaceSettingsPopover
  // uses for its editors.
  useEffect(() => {
    if (view === 'closed') return undefined
    return onNewWorkspaceMenuEvent(menuId, {
      onHoverProvider: (providerId) => {
        // PURELY NAVIGATIONAL (bug fix — hovering must never mutate the
        // committed top-line selection): opens/switches the FLYOUT SUBMENU to
        // this provider's model list so the user can see its models, but does
        // NOT touch selectedProviderId/selectedModelId (the top line, which
        // is also the create action) and does NOT set hasPickedRef — a mere
        // hover is not a pick. The submenu still previews that provider's
        // last-used model (via lastUsedModelIdByProvider, already threaded
        // down) without committing it. `view` moves to 'models' so arrow
        // keys act on the now-open submenu.
        setActiveProviderId(providerId)
        setView('models')
      },
      onPickProvider: (providerId) => {
        // EXPLICIT pick (click, or ArrowRight/Enter navigating into a
        // provider row): deliberate, not incidental like a hover — this DOES
        // commit that provider's last-used model to the top line, same as
        // picking a model directly. See this file's header comment for the
        // reasoning (hover must stay non-destructive; an explicit action on
        // the row is a reasonable proxy for "I want this provider").
        hasPickedRef.current = true
        setActiveProviderId(providerId)
        const group = groups.find((g) => g.providerId === providerId)
        const modelId = lastUsedModelForProvider(lastUsed, providerId, group?.models ?? [])
        setSelectedProviderId(providerId)
        setSelectedModelId(modelId)
        setView('models')
      },
      onBackToProviders: () => {
        setActiveProviderId(null)
        setView('providers')
      },
      onPickModel: (providerId, modelId) => {
        // Selecting a model updates the top line but leaves the submenu OPEN
        // (bug fix — picking a model is only a STEP now, not the create
        // action itself: the user still needs to reach the top line and
        // click it/press Enter to actually create). The submenu stays
        // anchored on this provider (activeProviderId untouched) with the
        // picked model shown checked; only outside-click/Esc/create/
        // clicking the trigger again close the popover.
        hasPickedRef.current = true
        setSelectedProviderId(providerId)
        setSelectedModelId(modelId)
      },
      onPickIsolation: (nextIsolation) => {
        setIsolation(nextIsolation)
        if (nextIsolation === 'worktree' && selectedModelId && selectedProviderId) {
          recordCreationLastUsed(selectedProviderId, selectedModelId)
        }
      },
      onChangeBranch: (value) => {
        setBranch(value)
        setBranchError(null)
        setBranchExists(null)
        checkBranch(value)
      },
      onCreate: () => void handleCreate(),
      onCancel: handleClose,
      onEnterSubmenu: handleEnterSubmenu,
      onLeaveSubmenu: handleLeaveSubmenu
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, menuId, groups, lastUsed, selectedModelId, selectedProviderId])

  // Keep the open popover's props in sync as state changes (mirrors
  // WorkspaceSettingsPopover's isDirty->updateWorkspaceSettingsCard effect).
  useEffect(() => {
    if (view === 'closed') return
    const topLineProviderId = selectedProviderId ?? 'claude'
    updateNewWorkspaceMenu(menuId, {
      loading: modes === null,
      groups,
      view: view === 'models' ? 'models' : 'providers',
      activeProviderId: activeProviderId ?? undefined,
      selectedProviderId: topLineProviderId,
      selectedModelId: selectedModelId ?? undefined,
      isolation,
      modes: modes ?? undefined,
      lastUsedModelIdByProvider,
      branchValue: branch,
      branchExists,
      branchCreating,
      branchError: branchError ?? undefined,
      routingProxyEnabled
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    view,
    menuId,
    groups,
    modes,
    activeProviderId,
    selectedProviderId,
    selectedModelId,
    isolation,
    branch,
    branchExists,
    branchCreating,
    branchError,
    routingProxyEnabled
  ])

  // Outside-click dismissal: the popover lives in a separate child
  // BrowserWindow, so the main renderer's document-level listener never sees
  // clicks landing INSIDE it — only clicks in the main window (including the
  // terminal) reach here, which is exactly the "outside" set (mirrors
  // WorkspaceSettingsPopover's identical effect).
  useEffect(() => {
    if (view === 'closed') return undefined
    const onPointerDown = (e: PointerEvent): void => {
      if (wrapperRef.current && wrapperRef.current.contains(e.target as Node)) return
      handleClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  // Hide on unmount so a stale popover never outlives its owning trigger.
  useEffect(() => {
    return () => hideNewWorkspaceMenu(menuId)
  }, [menuId])

  return (
    <div ref={wrapperRef} className={['relative flex', className].filter(Boolean).join(' ')}>
      {/* Trigger wrapper — CLICK ONLY (no onMouseEnter/onMouseLeave at all;
          see this file's header comment). Intercepts clicks before they
          reach the inner button. onMouseDown stops propagation so the SAME
          click that opens the menu isn't also seen as an outside-click by
          the popover's own dismissal listener. flex-1 so the trigger (and
          the button inside it) can stretch to fill a full-width wrapper. */}
      <div
        onClick={handleTriggerClick}
        onMouseDown={(e) => e.stopPropagation()}
        className="flex flex-1"
      >
        {children}
      </div>
    </div>
  )
}
