// ---------------------------------------------------------------------------
// overlayClient.ts — renderer-side helpers for the React overlay layer: the
// hoverCard / detailsCard / projectCard / confirmModal / noticeBanner /
// chipTooltip / chipPrompt kinds. Wraps window.api.overlay.show/update/hide
// with per-kind promise/dismissal/exclusivity semantics so call sites don't
// need to know about descriptor construction or generation/id bookkeeping.
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
  NoticeBannerProps,
  ChipTooltipProps,
  ChipPromptProps,
  ChipPromptResult,
  ChipDropdownProps,
  ChipDropdownItem,
  ChipDropdownResult,
  WorkspaceSettingsCardProps,
  WorkspaceSettingsCardPatch
} from '@shared/types'

export type {
  HoverCardProps,
  DetailsCardProps,
  ProjectCardProps,
  ConfirmModalProps,
  ConfirmModalResult,
  ChipTooltipProps,
  ChipPromptProps,
  ChipPromptResult,
  ChipDropdownProps,
  ChipDropdownItem,
  ChipDropdownResult,
  WorkspaceSettingsCardProps,
  WorkspaceSettingsCardPatch
}

// ── Activity state mapping ───────────────────────────────────────────────

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
  /** detailsCard-only: "Restart to apply" clicked in the dirty-state row (U3). */
  onRestart?: () => void
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

// Per-id chipPrompt event handlers (submit/cancel only — no button/checkbox
// vocabulary), routed by the same `ensureRouter` listener below. A given
// overlay id is never in more than one of handlersById/confirmSettlers/
// chipPromptSettlers.
interface ChipPromptHandlers {
  onSubmit: (values: Record<string, string>) => void
  onCancel: () => void
}

const chipPromptSettlers = new Map<string, ChipPromptHandlers>()

// Per-id chipDropdown event handlers (select/cancel only), routed by the same
// `ensureRouter` listener below. A given overlay id is never in more than one
// of handlersById/confirmSettlers/chipPromptSettlers/chipDropdownSettlers.
interface ChipDropdownHandlers {
  onSelect: (value: string) => void
  onCancel: () => void
}

const chipDropdownSettlers = new Map<string, ChipDropdownHandlers>()

// Per-id workspaceSettingsCard event handlers — LONG-LIVED (like
// handlersById), not promise-settled (like the confirm/chipPrompt/
// chipDropdown settlers above): the card stays open across many edits, so
// each emitted event is routed to the call site's current handler for as
// long as the card is shown, not just once. A given overlay id is never in
// more than one of these five maps.
export interface WorkspaceSettingsCardHandlers {
  onToggleLoco: (value: boolean) => void
  onChangeFlags: (flags: string[]) => void
  onChangeEnvVars: (envVars: Record<string, string>) => void
  onRestart: () => void
  /** Escape while the card is shown — OverlayRoot emits 'cancel' globally for
   *  any takesFocus descriptor (see overlay/OverlayRoot.tsx). The call site
   *  closes the popover the same way outside-click does. */
  onCancel: () => void
}

const workspaceSettingsCardHandlers = new Map<string, WorkspaceSettingsCardHandlers>()

let routerInitialized = false

// Extracted from ensureRouter's onEvent callback for the same reason as
// dispatchWorkspaceSettingsCardEvent below: each per-map dispatch block adds
// to that callback's cognitive complexity, and adding a fourth pushed it over
// the ceiling. Returns true if `e` was handled.
function dispatchChipDropdownEvent(e: OverlayEvent): boolean {
  const handlers = chipDropdownSettlers.get(e.overlayId)
  if (!handlers) return false
  switch (e.type) {
    case 'select': {
      const payload = e.payload as { value: string } | undefined
      if (payload) handlers.onSelect(payload.value)
      break
    }
    case 'cancel':
      handlers.onCancel()
      break
    default:
      break
  }
  return true
}

// Extracted from ensureRouter's onEvent callback to keep that function's own
// cognitive complexity under the repo's ceiling — this is a self-contained
// dispatch for the workspaceSettingsCard event vocabulary only. Returns true
// if `e` was handled (i.e. an id in workspaceSettingsCardHandlers matched),
// so the caller knows not to fall through to the hover-bridge handlers below.
function dispatchWorkspaceSettingsCardEvent(e: OverlayEvent): boolean {
  const settingsCardHandlers = workspaceSettingsCardHandlers.get(e.overlayId)
  if (!settingsCardHandlers) return false

  switch (e.type) {
    case 'toggleLoco': {
      const payload = e.payload as { value: boolean } | undefined
      if (payload) settingsCardHandlers.onToggleLoco(payload.value)
      break
    }
    case 'changeFlags': {
      const payload = e.payload as { flags: string[] } | undefined
      if (payload) settingsCardHandlers.onChangeFlags(payload.flags)
      break
    }
    case 'changeEnvVars': {
      const payload = e.payload as { envVars: Record<string, string> } | undefined
      if (payload) settingsCardHandlers.onChangeEnvVars(payload.envVars)
      break
    }
    case 'restart':
      settingsCardHandlers.onRestart()
      break
    case 'cancel':
      settingsCardHandlers.onCancel()
      break
    case 'exited':
      workspaceSettingsCardHandlers.delete(e.overlayId)
      break
    default:
      break
  }
  return true
}

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

    const chipPromptHandlers = chipPromptSettlers.get(e.overlayId)
    if (chipPromptHandlers) {
      switch (e.type) {
        case 'submit': {
          const payload = e.payload as { values: Record<string, string> } | undefined
          chipPromptHandlers.onSubmit(payload?.values ?? {})
          break
        }
        case 'cancel':
          chipPromptHandlers.onCancel()
          break
        default:
          break
      }
      return
    }

    if (dispatchChipDropdownEvent(e)) return

    if (dispatchWorkspaceSettingsCardEvent(e)) return

    const handlers = handlersById.get(e.overlayId)
    if (!handlers) return
    switch (e.type) {
      case 'mouseenter':
        handlers.onPointerEnter?.()
        break
      case 'mouseleave':
        handlers.onPointerLeave?.()
        break
      case 'restart':
        handlers.onRestart?.()
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
  handlers: { onEnter?: () => void; onLeave?: () => void; onRestart?: () => void }
): () => void {
  ensureRouter()
  const existing = handlersById.get(id) ?? {}
  existing.onPointerEnter = handlers.onEnter
  existing.onPointerLeave = handlers.onLeave
  existing.onRestart = handlers.onRestart
  handlersById.set(id, existing)
  return () => {
    const current = handlersById.get(id)
    if (!current) return
    if (current.onPointerEnter === handlers.onEnter) current.onPointerEnter = undefined
    if (current.onPointerLeave === handlers.onLeave) current.onPointerLeave = undefined
    if (current.onRestart === handlers.onRestart) current.onRestart = undefined
  }
}

// PR-chip clicks: the card kind opens the URL itself (embeds it in props),
// via the same window.open(...) → shell.openExternal path PrChip.tsx uses —
// no extra IPC plumbing needed since the URL is already sitting in
// HoverCardProps.pr / DetailsCardProps.pr and the card component can call
// this directly on click.
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
// showConfirmModalReact NEVER rejects: every failure path (overlay:show
// rejection/timeout, a stale/unmatched event, the overlay layer being
// unavailable) settles as { buttonId: 'cancel', checkboxChecked }. Checkbox
// state is tracked here (not just inside the ConfirmModal component) so the
// result carries the latest value even if the user never touches the
// checkbox (defaults to its initial `checked`) and so a rapid toggle-then-
// confirm always reads the last emitted value rather than a stale render.
//
// Each call gets a synthetic id ("confirm:<uuid>") so concurrent modals
// (calls overlapping in time, e.g. a fast double-trigger) never collide with
// each other or with any live hover/details/project overlay id.
//
// activeConfirmOverlayId is the id of the most recently opened confirm modal
// that hasn't settled yet (null if none). getActiveConfirmOverlayId()/
// hideConfirmOverlay() let a caller (e.g. WorkspaceView's worktree-error
// effect) capture and actively dismiss the specific modal IT opened on
// cleanup — "capture id right after showing, hide on unmount".
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
      // into resolve-as-cancel so the caller's await can never hang.
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

// ── Chip tooltip / prompt (footer ActionChip, U9) ───────────────────────────
//
// The footer ActionChip's two overlay usages both opened bottom-full
// (upward into the terminal rect) via the in-page `Overlay` component and
// were occluded by the live terminal (docs/learnings/overlay-child-window-
// macos.md — same-window DOM can never paint above the terminal NSView).
// Both migrate here as anchored, preferredSide 'top' descriptors (same
// upward-opening direction as the chassis-free markup they replace).

export function chipTooltipId(actionId: string): string {
  return `chipTooltip:${actionId}`
}

/**
 * Shows (or replaces) the transient hover-label above an ActionChip.
 * Non-interactive — never emits events; the call site hides it directly
 * (hideOverlayCard) on its own timer/mouseleave, same as the chassis-free
 * `ChipTooltip` component's setTimeout-driven hide.
 *
 * `preferredSide` defaults to 'top' (the footer ActionChip/DropdownChip
 * origin usage, opening upward off a bottom-anchored chip). Callers anchored
 * elsewhere — e.g. the far-left ActivityRail, which only has room to open
 * rightward like showProjectCard/showHoverCard above — can override it.
 */
export function showChipTooltip(
  id: string,
  anchorRect: { x: number; y: number; w: number; h: number },
  props: ChipTooltipProps,
  ownerWorkspaceId?: string,
  preferredSide: 'top' | 'bottom' | 'left' | 'right' = 'top'
): void {
  ensureRouter()
  const descriptor: OverlayDescriptor = {
    id,
    kind: 'chipTooltip',
    placement: { mode: 'anchored', anchorRect, preferredSide },
    props: props as unknown as Record<string, unknown>,
    acceptsClicks: false,
    takesFocus: false,
    ownerWorkspaceId
  }
  void window.api.overlay.show(descriptor).catch(() => {})
}

export function chipPromptId(actionId: string): string {
  return `chipPrompt:${actionId}`
}

// Force-cancel hooks for still-pending chip prompts, keyed by overlay id —
// lets hideChipPrompt (outside-click / blur at the call site) settle the
// promise as null instead of just hiding the window and leaving the await
// hanging forever (unlike hideConfirmOverlay, which is only ever called from
// an unmount cleanup that no longer cares about the result).
const chipPromptForceCancel = new Map<string, () => void>()

/**
 * Shows the interactive prompt popover above an ActionChip and resolves once
 * the user submits or cancels. Mirrors showConfirmModalReact's settle
 * contract exactly: NEVER rejects — Cancel click, Escape (global takesFocus
 * handler in OverlayRoot, plus the kind's own input keydown), outside-click/
 * blur (via hideChipPrompt), or an overlay:show IPC failure all resolve
 * `null`. Apply/Enter resolves `{ values }` with the latest in-popover edits.
 */
export function showChipPrompt(
  id: string,
  anchorRect: { x: number; y: number; w: number; h: number },
  props: ChipPromptProps,
  ownerWorkspaceId?: string
): Promise<ChipPromptResult> {
  ensureRouter()

  return new Promise<ChipPromptResult>((resolve) => {
    let settled = false
    const settle = (result: ChipPromptResult): void => {
      if (settled) return
      settled = true
      chipPromptSettlers.delete(id)
      chipPromptForceCancel.delete(id)
      void window.api.overlay.hide(id).catch(() => {})
      resolve(result)
    }

    chipPromptSettlers.set(id, {
      onSubmit: (values) => settle({ values }),
      onCancel: () => settle(null)
    })
    chipPromptForceCancel.set(id, () => settle(null))

    const descriptor: OverlayDescriptor = {
      id,
      kind: 'chipPrompt',
      placement: { mode: 'anchored', anchorRect, preferredSide: 'top' },
      props: props as unknown as Record<string, unknown>,
      acceptsClicks: true,
      takesFocus: true,
      ownerWorkspaceId
    }

    void window.api.overlay.show(descriptor).catch(() => {
      settle(null)
    })
  })
}

/**
 * Actively dismiss a still-pending chip prompt (outside-click / blur at the
 * call site) and settle its promise as `null`. No-op if already settled.
 */
export function hideChipPrompt(id: string): void {
  const forceCancel = chipPromptForceCancel.get(id)
  if (forceCancel) {
    forceCancel()
  } else {
    void window.api.overlay.hide(id).catch(() => {})
  }
}

export function chipDropdownId(x: string): string {
  return `chipDropdown:${x}`
}

// Force-cancel hooks for still-pending chip dropdowns, keyed by overlay id —
// lets hideChipDropdown (outside-click / blur at the call site) settle the
// promise as null instead of just hiding the window and leaving the await
// hanging forever (mirrors chipPromptForceCancel).
const chipDropdownForceCancel = new Map<string, () => void>()

/**
 * Shows the interactive dropdown popover above a chip and resolves once the
 * user picks a row or cancels. Mirrors showChipPrompt's settle contract
 * exactly: NEVER rejects — Cancel/Escape (global takesFocus handler in
 * OverlayRoot, plus the kind's own Escape keydown), outside-click/blur (via
 * hideChipDropdown), or an overlay:show IPC failure all resolve `null`.
 * Row click/Enter resolves `{ kind: 'select', value }`.
 */
export function showChipDropdown(
  id: string,
  anchorRect: { x: number; y: number; w: number; h: number },
  props: ChipDropdownProps,
  ownerWorkspaceId?: string,
  preferredSide: 'top' | 'bottom' | 'left' | 'right' = 'top'
): Promise<ChipDropdownResult> {
  ensureRouter()

  return new Promise<ChipDropdownResult>((resolve) => {
    let settled = false
    const settle = (result: ChipDropdownResult): void => {
      if (settled) return
      settled = true
      chipDropdownSettlers.delete(id)
      chipDropdownForceCancel.delete(id)
      void window.api.overlay.hide(id).catch(() => {})
      resolve(result)
    }

    chipDropdownSettlers.set(id, {
      onSelect: (value) => settle({ kind: 'select', value }),
      onCancel: () => settle(null)
    })
    chipDropdownForceCancel.set(id, () => settle(null))

    const descriptor: OverlayDescriptor = {
      id,
      kind: 'chipDropdown',
      placement: { mode: 'anchored', anchorRect, preferredSide },
      props: props as unknown as Record<string, unknown>,
      acceptsClicks: true,
      takesFocus: true,
      ownerWorkspaceId
    }

    void window.api.overlay.show(descriptor).catch(() => {
      settle(null)
    })
  })
}

/**
 * Actively dismiss a still-pending chip dropdown (outside-click / blur at the
 * call site) and settle its promise as `null`. No-op if already settled.
 */
export function hideChipDropdown(id: string): void {
  const forceCancel = chipDropdownForceCancel.get(id)
  if (forceCancel) {
    forceCancel()
  } else {
    void window.api.overlay.hide(id).catch(() => {})
  }
}

// ── Workspace settings card (title bar Settings gear, U-overlay-migration) ─
//
// Long-lived + focusable + continuously-mutating — combines detailsCard's
// update-loop (settings/dirty-flag changes keep pushing new props while it's
// open) with chipPrompt's focus/input handling (CliFlagsEditor/
// CustomEnvVarsEditor are real text inputs). Props down, events up: the call
// site (WorkspaceSettingsPopover.tsx) owns every window.api.
// claudeWorkspaceSettings.* call; this module only shows/updates the card and
// routes its emitted events to whatever handlers the call site registered via
// onWorkspaceSettingsCard.

export function workspaceSettingsCardId(workspaceId: string): string {
  return `workspaceSettings:${workspaceId}`
}

/**
 * Registers the long-lived event handlers for an open workspaceSettingsCard —
 * mirrors onCardPointer's register/unregister contract. Call once when the
 * card is shown; unregister on hide/unmount. Handlers can be swapped in place
 * (e.g. when the call site's callback identities change across renders) since
 * this just replaces the map entry.
 */
export function onWorkspaceSettingsCardEvent(
  id: string,
  handlers: WorkspaceSettingsCardHandlers
): () => void {
  ensureRouter()
  workspaceSettingsCardHandlers.set(id, handlers)
  return () => {
    const current = workspaceSettingsCardHandlers.get(id)
    if (current === handlers) workspaceSettingsCardHandlers.delete(id)
  }
}

export function showWorkspaceSettingsCard(
  workspaceId: string,
  anchorEl: Element,
  props: WorkspaceSettingsCardProps
): string {
  ensureRouter()
  const id = workspaceSettingsCardId(workspaceId)
  const descriptor: OverlayDescriptor = {
    id,
    kind: 'workspaceSettingsCard',
    // Gear button sits in the title bar and opens downward, same direction
    // the retired in-page Overlay used (rect.bottom + 4) — preserved here so
    // the popover still opens toward the terminal/workbench area below the
    // bar rather than off-screen upward.
    placement: {
      mode: 'anchored',
      anchorRect: anchorRectFromEl(anchorEl),
      preferredSide: 'bottom'
    },
    props: props as unknown as Record<string, unknown>,
    acceptsClicks: true,
    takesFocus: true,
    ownerWorkspaceId: workspaceId
  }
  void window.api.overlay.show(descriptor).catch(() => {})
  return id
}

export function updateWorkspaceSettingsCard(id: string, patch: WorkspaceSettingsCardPatch): void {
  void window.api.overlay.update(id, patch as unknown as Record<string, unknown>).catch(() => {})
}

export function hideWorkspaceSettingsCard(id: string): void {
  void window.api.overlay.hide(id).catch(() => {})
}
