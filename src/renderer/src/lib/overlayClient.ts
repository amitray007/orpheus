// ---------------------------------------------------------------------------
// overlayClient.ts — renderer-side helpers for the React overlay layer's
// 'hoverCard' / 'detailsCard' kinds (U8). Mirrors nativePopover.ts's
// promise/dismissal/exclusivity semantics on top of window.api.overlay
// instead of window.api.terminal.showPopover/updatePopover/hidePopover.
//
// USE_REACT_OVERLAYS is the kill-switch (plan U8/U9 requirement): flip to
// false to fall back to the chassis path at every call site in one place.
// Call sites (Sidebar.tsx, WorkspaceTitleBar.tsx) branch on this flag and
// call EITHER this module OR nativePopover.ts, never both for the same
// logical show — see the per-callsite comments there.
// ---------------------------------------------------------------------------

import type {
  GitStatus,
  GhPullRequest,
  WorkspaceActivityDetail,
  OverlayDescriptor,
  OverlayEvent,
  OverlayCardGit,
  OverlayCardPr,
  HoverCardProps,
  DetailsCardProps,
  ProjectCardProps,
  ConfirmModalProps,
  ConfirmModalResult,
  NoticeBannerProps
} from '@shared/types'

export const USE_REACT_OVERLAYS = true

export type {
  HoverCardProps,
  DetailsCardProps,
  ProjectCardProps,
  ConfirmModalProps,
  ConfirmModalResult
}

// ── Activity state mapping (same vocabulary as nativePopover.ts) ───────────

const ACTIVITY_LABEL: Partial<Record<WorkspaceActivityDetail, string>> = {
  working: 'Working…',
  ready: 'ready',
  idle: 'idle',
  attention: 'needs attention'
}

export function activityToState(
  activity: WorkspaceActivityDetail | undefined
): HoverCardProps['activityState'] {
  if (!activity || activity === 'archived') return 'idle'
  return activity
}

export function activityToLabel(activity: WorkspaceActivityDetail | undefined): string {
  if (!activity || activity === 'archived') return 'idle'
  return ACTIVITY_LABEL[activity] ?? activity
}

// ── GitStatus / GhPullRequest → card prop shapes ────────────────────────────

export function gitStatusToCard(gitStatus: GitStatus | null): OverlayCardGit | undefined {
  if (!gitStatus) return undefined
  const parts: string[] = []
  if (gitStatus.newFiles > 0) parts.push(`${gitStatus.newFiles} new`)
  if (gitStatus.modifiedFiles > 0) parts.push(`${gitStatus.modifiedFiles} modified`)
  if (gitStatus.deletedFiles > 0) parts.push(`${gitStatus.deletedFiles} deleted`)
  return {
    branch: gitStatus.branch ?? '',
    detached: gitStatus.branch === null,
    summary: parts.join(' · ') || 'No changes',
    insertions: gitStatus.insertions ?? 0,
    deletions: gitStatus.deletions ?? 0
  }
}

export function prToCard(pr: GhPullRequest | null | undefined): OverlayCardPr | undefined {
  if (!pr) return undefined
  const checkMap: Record<string, OverlayCardPr['check']> = {
    success: 'ok',
    failure: 'fail',
    pending: 'pending'
  }
  return {
    number: pr.number,
    state: pr.state,
    check: pr.checks ? (checkMap[pr.checks] ?? 'none') : 'none',
    url: pr.url
  }
}

// ── Rect helper ──────────────────────────────────────────────────────────────

function anchorRectFromEl(el: Element): { x: number; y: number; w: number; h: number } {
  const rect = el.getBoundingClientRect()
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height }
}

// ── Per-id event routing ─────────────────────────────────────────────────────
// Each shown card registers pointer (hover-bridge) + custom handlers here,
// keyed by the overlay id. A single module-level onEvent listener (init-once)
// fans events out to the right handler and cleans up on 'exited'.

interface CardHandlers {
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}

const handlersById = new Map<string, CardHandlers>()

// Per-id confirm-modal event handlers, separate from `handlersById` above
// since confirm modals don't use pointer enter/leave. Routed by the same
// `ensureRouter` listener (module-level, init-once) below.
interface ConfirmHandlers {
  onButton: (buttonId: string, checkboxChecked: boolean) => void
  onCheckbox: (checked: boolean) => void
  onCancel: () => void
}

const confirmSettlers = new Map<string, ConfirmHandlers>()

let routerInitialized = false

function ensureRouter(): void {
  if (routerInitialized) return
  routerInitialized = true
  window.api.overlay.onEvent((e: OverlayEvent) => {
    // Confirm-modal events are routed separately from the hover-bridge
    // handlers below — a given overlay id is never in both maps.
    const confirmHandlers = confirmSettlers.get(e.overlayId)
    if (confirmHandlers) {
      switch (e.type) {
        case 'button': {
          const payload = e.payload as { buttonId: string; checkboxChecked: boolean } | undefined
          if (payload) confirmHandlers.onButton(payload.buttonId, payload.checkboxChecked)
          break
        }
        case 'checkbox': {
          const payload = e.payload as { id: string; checked: boolean } | undefined
          if (payload) confirmHandlers.onCheckbox(payload.checked)
          break
        }
        case 'cancel':
          confirmHandlers.onCancel()
          break
        default:
          break
      }
      return
    }

    const handlers = handlersById.get(e.overlayId)
    if (!handlers) return
    switch (e.type) {
      case 'mouseenter':
        handlers.onPointerEnter?.()
        break
      case 'mouseleave':
        handlers.onPointerLeave?.()
        break
      case 'exited':
        handlersById.delete(e.overlayId)
        break
      default:
        break
    }
  })
}

/**
 * Registers a mouseenter/mouseleave bridge for the card with the given id —
 * lets the call site cancel/re-arm its own close timer when the pointer
 * crosses from the trigger row into the card (same "hover bridge" contract
 * onNativePopoverClosed served for the chassis, generalized to both edges).
 * Returns an unregister function.
 */
export function onCardPointer(
  id: string,
  handlers: { onEnter?: () => void; onLeave?: () => void }
): () => void {
  ensureRouter()
  const existing = handlersById.get(id) ?? {}
  existing.onPointerEnter = handlers.onEnter
  existing.onPointerLeave = handlers.onLeave
  handlersById.set(id, existing)
  return () => {
    const current = handlersById.get(id)
    if (!current) return
    if (current.onPointerEnter === handlers.onEnter) current.onPointerEnter = undefined
    if (current.onPointerLeave === handlers.onLeave) current.onPointerLeave = undefined
  }
}

// PR-chip clicks: the card kind opens the URL itself (embeds it in props),
// via the same window.open(...) → shell.openExternal path PrChip.tsx and
// nativePopover.ts already use — no extra IPC plumbing needed since the URL
// is already sitting in HoverCardProps.pr / DetailsCardProps.pr and the card
// component can call this directly on click.
export function openPrUrl(url: string): void {
  try {
    window.open(url, '_blank', 'noopener,noreferrer')
  } catch {
    // no-op
  }
}

// ── Show / update / hide ─────────────────────────────────────────────────────

export function showHoverCard(
  workspaceId: string,
  anchorEl: Element,
  props: HoverCardProps
): string {
  ensureRouter()
  const id = `hover:${workspaceId}`
  const descriptor: OverlayDescriptor = {
    id,
    kind: 'hoverCard',
    placement: { mode: 'anchored', anchorRect: anchorRectFromEl(anchorEl), preferredSide: 'right' },
    props: props as unknown as Record<string, unknown>,
    acceptsClicks: true,
    takesFocus: false,
    ownerWorkspaceId: workspaceId
  }
  void window.api.overlay.show(descriptor).catch(() => {})
  return id
}

export function showDetailsCard(
  workspaceId: string,
  anchorEl: Element,
  props: DetailsCardProps
): string {
  ensureRouter()
  const id = `details:${workspaceId}`
  const descriptor: OverlayDescriptor = {
    id,
    kind: 'detailsCard',
    placement: {
      mode: 'anchored',
      anchorRect: anchorRectFromEl(anchorEl),
      preferredSide: 'bottom'
    },
    props: props as unknown as Record<string, unknown>,
    acceptsClicks: true,
    takesFocus: false,
    ownerWorkspaceId: workspaceId
  }
  void window.api.overlay.show(descriptor).catch(() => {})
  return id
}

export function updateDetailsCard(id: string, patch: Partial<DetailsCardProps>): void {
  void window.api.overlay.update(id, patch as unknown as Record<string, unknown>).catch(() => {})
}

export function hideOverlayCard(id: string): void {
  void window.api.overlay.hide(id).catch(() => {})
}

// Convenience id builders so call sites don't hand-construct the `hover:` /
// `details:` prefixes in more than one place.
export function hoverCardId(workspaceId: string): string {
  return `hover:${workspaceId}`
}

export function detailsCardId(workspaceId: string): string {
  return `details:${workspaceId}`
}

export function showProjectCard(
  projectId: string,
  anchorEl: Element,
  props: ProjectCardProps
): string {
  ensureRouter()
  const id = `project:${projectId}`
  const descriptor: OverlayDescriptor = {
    id,
    kind: 'projectCard',
    // Sidebar tiles sit at the far left edge — 'right' matches the native
    // popover's positioning (buildProjectCard is shown off the collapsed
    // rail, which only has room to open rightward).
    placement: { mode: 'anchored', anchorRect: anchorRectFromEl(anchorEl), preferredSide: 'right' },
    props: props as unknown as Record<string, unknown>,
    acceptsClicks: true,
    takesFocus: false
  }
  void window.api.overlay.show(descriptor).catch(() => {})
  return id
}

export function projectCardId(projectId: string): string {
  return `project:${projectId}`
}

// ── Confirm modal ────────────────────────────────────────────────────────────
//
// showConfirmModalReact mirrors nativePopover.ts's showConfirmModal contract
// exactly: same ConfirmModalResult shape, NEVER rejects (every failure path —
// overlay:show rejection/timeout, a stale/unmatched event, the overlay layer
// being unavailable — settles as { buttonId: 'cancel', checkboxChecked }).
// Checkbox state is tracked here (not just inside the ConfirmModal component)
// so the result carries the latest value even if the user never touches the
// checkbox (defaults to its initial `checked`) and so a rapid toggle-then-
// confirm always reads the last emitted value rather than a stale render.
//
// Each call gets a synthetic id ("confirm:<uuid>") exactly like the chassis's
// "modal:<uuid>" workspaceId — so concurrent modals (calls overlapping in
// time, e.g. a fast double-trigger) never collide with each other or with any
// live hover/details/project overlay id.
//
// activeConfirmOverlayId mirrors nativePopover.ts's activeModalWorkspaceId:
// the id of the most recently opened confirm modal that hasn't settled yet
// (null if none). getActiveConfirmOverlayId()/hideConfirmOverlay() let a
// caller (e.g. WorkspaceView's worktree-error effect) capture and actively
// dismiss the specific modal IT opened on cleanup — same "capture id right
// after showing, hide on unmount" pattern getActiveModalWorkspaceId() +
// hideNativePopover() serve for the chassis.
let activeConfirmOverlayId: string | null = null

export function getActiveConfirmOverlayId(): string | null {
  return activeConfirmOverlayId
}

export function hideConfirmOverlay(id: string): void {
  void window.api.overlay.hide(id).catch(() => {})
}

export function showConfirmModalReact(data: ConfirmModalProps): Promise<ConfirmModalResult> {
  ensureRouter()
  const id = `confirm:${crypto.randomUUID()}`
  activeConfirmOverlayId = id
  let checkboxChecked = data.checkbox?.checked ?? false

  return new Promise<ConfirmModalResult>((resolve) => {
    let settled = false
    const settle = (buttonId: string): void => {
      if (settled) return
      settled = true
      handlersById.delete(id)
      confirmSettlers.delete(id)
      if (activeConfirmOverlayId === id) activeConfirmOverlayId = null
      void window.api.overlay.hide(id).catch(() => {})
      resolve({ buttonId, checkboxChecked })
    }

    confirmSettlers.set(id, {
      onButton: (buttonId, checked) => {
        checkboxChecked = checked
        settle(buttonId)
      },
      onCheckbox: (checked) => {
        checkboxChecked = checked
      },
      onCancel: () => settle('cancel')
    })

    const descriptor: OverlayDescriptor = {
      id,
      kind: 'confirmModal',
      placement: { mode: 'centered' },
      props: data as unknown as Record<string, unknown>,
      acceptsClicks: true,
      takesFocus: true
    }

    void window.api.overlay.show(descriptor).catch(() => {
      // overlay:show rejected (timeout / layer unavailable / crash) — absorb
      // into resolve-as-cancel so the caller's await can never hang, mirroring
      // nativePopover.ts's showConfirmModal catch(() => settle('cancel')).
      settle('cancel')
    })
  })
}

// ── Notice banner ────────────────────────────────────────────────────────────

export function showNoticeBanner(
  workspaceId: string,
  anchorEl: Element,
  props: NoticeBannerProps
): string {
  ensureRouter()
  const id = `notice:${workspaceId}`

  // The chassis-free markup this replaces sat INSET at the bottom of the
  // terminal container (`absolute bottom-4 left-1/2 -translate-x-1/2`), not
  // outside it — computeAnchoredPlacement (main/overlayLayer.ts) places a
  // card OUTSIDE its anchor rect on the preferred side (x = anchor.x, no
  // centering term), which is built for edge-flush popovers, not a
  // horizontally-centered inset banner. To reproduce the same on-screen spot
  // without touching main-process placement code: anchor to a zero-height,
  // zero-width POINT at the container's horizontal center, 16px above its
  // bottom edge, with preferredSide 'top' — the card is placed with its LEFT
  // edge at that point, i.e. `x = anchor.x`. NoticeBanner.tsx renders at a
  // FIXED width (384px, w-96) instead of max-content specifically so this
  // point can be offset by exactly half that width, landing the fixed-width
  // card dead-centered on the container from the very first paint (no
  // reportSize-driven re-placement pass, no visible horizontal jump).
  const containerRect = anchorRectFromEl(anchorEl)
  const BANNER_WIDTH = 384 // must match NoticeBanner.tsx's `w-96`
  const anchorStrip = {
    x: containerRect.x + containerRect.w / 2 - BANNER_WIDTH / 2,
    y: containerRect.y + containerRect.h - 16,
    w: 0,
    h: 0
  }

  const descriptor: OverlayDescriptor = {
    id,
    kind: 'noticeBanner',
    placement: { mode: 'anchored', anchorRect: anchorStrip, preferredSide: 'top' },
    props: props as unknown as Record<string, unknown>,
    acceptsClicks: false,
    takesFocus: false,
    ownerWorkspaceId: workspaceId
  }
  void window.api.overlay.show(descriptor).catch(() => {})
  return id
}

export function noticeBannerId(workspaceId: string): string {
  return `notice:${workspaceId}`
}
