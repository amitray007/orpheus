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
  DetailsCardProps
} from '@shared/types'

export const USE_REACT_OVERLAYS = true

export type { HoverCardProps, DetailsCardProps }

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

let routerInitialized = false

function ensureRouter(): void {
  if (routerInitialized) return
  routerInitialized = true
  window.api.overlay.onEvent((e: OverlayEvent) => {
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
