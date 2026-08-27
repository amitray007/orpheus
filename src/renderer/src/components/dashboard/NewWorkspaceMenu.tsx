import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { WorkspaceRecord, NewWorkspaceMenuIsolation, HarnessSummary } from '@shared/types'
import {
  showNewWorkspaceMenu,
  updateNewWorkspaceMenu,
  hideNewWorkspaceMenu,
  newWorkspaceMenuId,
  onNewWorkspaceMenuEvent
} from '@/lib/overlayClient'
import { playSound } from '@/lib/sound'
import { decideHarnessCreateAction } from '@/lib/newWorkspaceMenuLogic'

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

// ---------------------------------------------------------------------------
// Harnesses cache (support-multi-harness) — module-level, shared across all
// instances, same shape as modesCache above. harness:list is static
// per-build data (no push channel — see HarnessPicker.tsx's own header for
// why the settings picker doesn't need one either), so a single fetch on
// first open per app session is enough; every instance of this popover
// reuses it instead of refetching on every open.
// ---------------------------------------------------------------------------

let harnessesCache: HarnessSummary[] | null = null

// ---------------------------------------------------------------------------
// NewWorkspaceMenu
//
// Rendered in the native overlay layer so the popover paints OVER the
// terminal instead of being clipped inside the sidebar — see
// src/renderer/src/overlay/kinds/NewWorkspaceMenu.tsx (the dumb render+emit
// half) and src/renderer/src/lib/overlayClient.ts's
// showNewWorkspaceMenu/onNewWorkspaceMenuEvent (the props-down/events-up
// wiring). This component keeps ALL data hooks and every window.api.* call
// (offeredModes, harness:list, worktrees.branchExists,
// workspaces.createWorktree) — the overlay kind never touches IPC directly,
// mirroring WorkspaceSettingsPopover.tsx's contract.
//
// CLICK-ONLY TRIGGER: the "+" trigger has no hover-open at all — a plain
// toggle (click opens, click again closes). Once open, it stays open until:
// outside click (the pointerdown effect below), Escape (the overlay kind's
// own handler, which emits 'cancel'), a successful create, or clicking the
// trigger again.
//
// HARNESS-SELECTOR REBUILD (support-multi-harness — replaces the old
// provider/model creation flow entirely): this popover used to be a
// two-level provider -> model picker with its own flyout submenu, a
// committed "selected model" top line, and a SEPARATE click/Enter on that
// top line to actually create. All of that — useSelectableModels,
// groupModelsForCreation/creationProviderMenu.ts's grouping, the
// session-scoped creationLastUsedStore, workspace-creation-time
// workspaces.setModel, and decideCreateAction's model-aware create
// decision — is gone from this component. Per the approved redesign, the
// popover now shows every registered HARNESS as a chip
// (window.api.harness.list); clicking one BOTH selects it AND creates the
// workspace immediately, using whatever isolation mode + branch text is
// currently set (see decideHarnessCreateAction in newWorkspaceMenuLogic.ts —
// the pure, assertable half of this decision). The workspace's actual model
// is then whatever that harness's own settings resolve to at launch
// (composeClaudeLaunch layering global -> project -> workspace) — this
// popover doesn't pick a model at creation time at all anymore.
//
// Local/Worktree is UNCHANGED: a two-way isolation TOGGLE (never creates by
// itself); selecting Worktree reveals the branch input inline, and clicking
// a harness while Worktree is selected creates the worktree workspace using
// whatever branch text is currently in that field.
//
// Props:
//   projectId     — the project this workspace will belong to
//   defaultName   — auto-generated workspace name (used to seed the branch slug)
//   onCreateLocal — callback to perform the plain-create (Local) path.
//                   `harnessId` is the harness chosen (undefined means "use
//                   the sole/default harness").
//   onCreated     — callback fired after a worktree workspace is created
//   children      — the trigger element (the "+" button or similar)
//   className     — forwarded to the wrapper div
// ---------------------------------------------------------------------------

export interface NewWorkspaceMenuProps {
  projectId: string
  /** Auto-generated workspace name for the current project (e.g. "Workspace 2"). */
  defaultName: string
  /** Called to create a local workspace via the existing plain-create path.
   *  `modelId` stays for the caller's existing signature (see Sidebar.tsx/
   *  ProjectHeader.tsx call sites) but this popover no longer picks a model —
   *  always undefined ("use the global/project default" for whichever
   *  harness launches). `harnessId` is the harness chosen — undefined means
   *  "use the sole/default harness," same convention as before. */
  onCreateLocal: (modelId?: string, harnessId?: string) => void
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

type MenuView = 'closed' | 'open'

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
  const [isolation, setIsolation] = useState<NewWorkspaceMenuIsolation>('local')
  // support-multi-harness — see harnessesCache's own header comment.
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>(() => harnessesCache ?? [])

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

  // support-multi-harness — cache-first (harnessesCache), unlike fetchModes:
  // harness:list is static per-build data, not per-project, so there's
  // nothing to invalidate on open the way modesCache is invalidated above
  // (project git-worktree support can change; the registered harness set
  // cannot, within one running app). Falls back to a fresh window.api call
  // only on first-ever open.
  const fetchHarnesses = useCallback((): void => {
    if (harnessesCache) {
      setHarnesses(harnessesCache)
      return
    }
    window.api.harness
      .list()
      .then((list) => {
        harnessesCache = list
        setHarnesses(list)
      })
      .catch(() => {
        // Leave harnesses empty on failure — the overlay kind's HarnessRow
        // renders zero chips, so a failed fetch degrades to "no create
        // control shown" rather than blocking on a stale/garbage list.
      })
  }, [])

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
    fetchHarnesses()

    setIsolation('local')
    setBranch(defaultBranch)
    setBranchExists(null)
    setBranchCreating(false)
    setBranchError(null)
    setView('open')

    showNewWorkspaceMenu(menuId, wrapperRef.current, {
      loading: true,
      isolation: 'local',
      branchValue: defaultBranch,
      branchExists: null,
      branchCreating: false,
      harnesses: harnessesCache ?? []
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- defaultBranch/fetchModes/fetchHarnesses/menuId are all stable-per-projectId (or per-render-but-content-stable).
  }, [projectId, fetchModes, fetchHarnesses, menuId])

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

  async function handleCreate(harnessId: string): Promise<void> {
    // decideHarnessCreateAction is the pure, assertable half of this
    // decision (see scripts/verify-new-workspace-menu.ts) — this handler is
    // just its side-effecting continuation (call the right window.api.*
    // path). One click both selects the harness AND creates — see this
    // file's header comment.
    const decision = decideHarnessCreateAction(isolation, harnessId, branch)
    if (decision.kind === 'disabled' || branchCreating) return

    if (decision.kind === 'local') {
      handleClose()
      onCreateLocal(undefined, harnessId)
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
        branch: trimmed,
        harnessId
      })
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
      onPickIsolation: (nextIsolation) => {
        setIsolation(nextIsolation)
      },
      // support-multi-harness — a harness chip click IS the create action
      // now (no separate confirm/create step); see this file's header
      // comment for why.
      onPickHarness: (harnessId) => void handleCreate(harnessId),
      onChangeBranch: (value) => {
        setBranch(value)
        setBranchError(null)
        setBranchExists(null)
        checkBranch(value)
      },
      onCancel: handleClose
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, menuId, isolation, branch])

  // Keep the open popover's props in sync as state changes (mirrors
  // WorkspaceSettingsPopover's isDirty->updateWorkspaceSettingsCard effect).
  useEffect(() => {
    if (view === 'closed') return
    updateNewWorkspaceMenu(menuId, {
      loading: modes === null,
      isolation,
      modes: modes ?? undefined,
      branchValue: branch,
      branchExists,
      branchCreating,
      branchError: branchError ?? undefined,
      harnesses
    })
  }, [view, menuId, modes, isolation, branch, branchExists, branchCreating, branchError, harnesses])

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
