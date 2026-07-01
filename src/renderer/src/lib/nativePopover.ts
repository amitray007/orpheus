// ---------------------------------------------------------------------------
// nativePopover.ts — renderer-side helpers for the native popover chassis.
//
// Wraps window.api.terminal.showPopover / updatePopover / hidePopover so
// callers don't need to know about anchorRect construction or fontDir. Also
// registers the one-time onPopoverAction listener that opens PR URLs when a
// PR chip inside a native card is clicked.
// ---------------------------------------------------------------------------

import type { GitStatus, GhPullRequest, WorkspaceActivityDetail } from '@shared/types'

// ── Data shapes expected by the native card ─────────────────────────────────

export type HoverPopoverData = {
  title: string
  activityLabel: string
  activityState: 'working' | 'ready' | 'idle' | 'attention' | 'archived'
  relativeTime: string
  git?: {
    branch: string
    detached: boolean
    summary: string
    insertions: number
    deletions: number
  }
  pr?: { number: number; state: 'open' | 'merged' | 'closed' | 'draft'; check: string }
  prUrl?: string
  cwd?: string
}

export type ProjectPopoverData = {
  name: string
  pinned: boolean
  repo?: string // "owner/repo" when GitHub, else omitted
  path: string
  workspaceCount: number
  workspaces: Array<{
    name: string
    state: 'working' | 'ready' | 'idle' | 'attention' | 'archived'
  }>
}

export type ConfirmModalButton = {
  id: string
  label: string
  style?: 'default' | 'primary' | 'danger'
}

export type ConfirmModalData = {
  title: string
  body: string
  buttons: ConfirmModalButton[]
  checkbox?: { id: string; label: string; checked: boolean }
}

export type ConfirmModalResult = { buttonId: string; checkboxChecked: boolean }

export type DetailsPopoverData = {
  pr?: { number: number; state: 'open' | 'merged' | 'closed' | 'draft'; check: string }
  prUrl?: string
  model?: string
  contextText?: string
  contextLoading?: boolean
  cost?: string
  costLoading?: boolean
  git?: {
    branch: string
    detached: boolean
    summary: string
    insertions: number
    deletions: number
  }
  cwd?: string
}

// ── Activity state mapping ───────────────────────────────────────────────────

const ACTIVITY_LABEL: Partial<Record<WorkspaceActivityDetail, string>> = {
  working: 'Working…',
  ready: 'ready',
  idle: 'idle',
  attention: 'needs attention'
}

export function activityToState(
  activity: WorkspaceActivityDetail | undefined
): HoverPopoverData['activityState'] {
  if (!activity || activity === 'archived') return 'idle'
  return activity as HoverPopoverData['activityState']
}

export function activityToLabel(activity: WorkspaceActivityDetail | undefined): string {
  if (!activity || activity === 'archived') return 'idle'
  return ACTIVITY_LABEL[activity] ?? activity
}

// ── Git status → native git object ──────────────────────────────────────────

function gitStatusToNative(gitStatus: GitStatus | null): HoverPopoverData['git'] | undefined {
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

// ── PR → native pr object ────────────────────────────────────────────────────

function prToNative(pr: GhPullRequest | null | undefined): HoverPopoverData['pr'] | undefined {
  if (!pr) return undefined
  const checkMap: Record<string, string> = {
    success: 'ok',
    failure: 'fail',
    pending: 'pending'
  }
  return {
    number: pr.number,
    state: pr.state as 'open' | 'merged' | 'closed' | 'draft',
    check: pr.checks ? (checkMap[pr.checks] ?? 'none') : 'none'
  }
}

// ── PR URL registry — kept in module scope so onPopoverAction can look up ───
// Maps workspaceId → pr.url for the currently shown popover.
const prUrlByWorkspace = new Map<string, string>()

// ── Native-closed callback registry ─────────────────────────────────────────
// When the native card's NSTrackingArea fires mouseExited, the native side
// sends "<workspaceId>::closed" through the popover action TSFN. Callers
// (Sidebar WorkspaceSubRow, WorkspaceTitleBar) register a per-workspace
// handler here so they can reset their own open-state and cancel any timers,
// ensuring a subsequent hover re-opens the card cleanly.
//
// Only one handler per workspaceId is retained at a time (latest registration
// wins). Handlers are keyed by workspaceId and called once on the "::closed"
// signal, then left registered (they are cheap no-ops if the card is already
// closed — idempotency is the caller's responsibility).
const nativeCloseHandlers = new Map<string, () => void>()

export function onNativePopoverClosed(workspaceId: string, handler: () => void): () => void {
  nativeCloseHandlers.set(workspaceId, handler)
  // Returns a cleanup function to remove the registration.
  return () => {
    if (nativeCloseHandlers.get(workspaceId) === handler) {
      nativeCloseHandlers.delete(workspaceId)
    }
  }
}

// ── Confirm-modal action routing ─────────────────────────────────────────────
// Each open modal registers a handler here, keyed by its synthetic
// workspaceId ("modal:<id>"). The router below dispatches elementId strings
// to the matching handler; the handler removes itself once the modal resolves.
const modalHandlers = new Map<string, (elementId: string) => void>()

function isModalWorkspaceId(workspaceId: string): boolean {
  return workspaceId.startsWith('modal:')
}

// ── One-time action listener registration ───────────────────────────────────

let actionListenerRegistered = false

function ensurePopoverActionListener(): void {
  if (actionListenerRegistered) return
  actionListenerRegistered = true
  window.api.terminal.onPopoverAction((e) => {
    // identifier format: "workspaceId::pr", "workspaceId::closed",
    // "workspaceId::cancel", "workspaceId::<buttonId>", or
    // "workspaceId::checkbox:<id>::<0|1>" (the LAST case has TWO "::"
    // separators — split on the FIRST one for workspaceId; the remainder,
    // including any further "::", is the elementId).
    const sep = e.identifier.indexOf('::')
    if (sep === -1) return
    const workspaceId = e.identifier.slice(0, sep)
    const elementId = e.identifier.slice(sep + 2)

    if (isModalWorkspaceId(workspaceId)) {
      const handler = modalHandlers.get(workspaceId)
      if (handler) handler(elementId)
      return
    }

    if (elementId === 'pr') {
      const url = prUrlByWorkspace.get(workspaceId)
      if (url) {
        try {
          window.open(url, '_blank', 'noopener,noreferrer')
        } catch {
          // no-op
        }
      }
    } else if (elementId === 'closed') {
      // Native card closed via mouseExited — reset renderer open-state.
      // Clear the PR URL entry so it doesn't linger.
      prUrlByWorkspace.delete(workspaceId)
      // Invoke the registered close handler if any.
      const handler = nativeCloseHandlers.get(workspaceId)
      if (handler) {
        handler()
      }
    }
  })
}

// ── Public helpers ───────────────────────────────────────────────────────────

export function showHoverPopover(
  workspaceId: string,
  anchorEl: Element,
  gitStatus: GitStatus | null,
  pr: GhPullRequest | null,
  title: string,
  activity: WorkspaceActivityDetail | undefined,
  relativeTime: string,
  cwd: string
): void {
  ensurePopoverActionListener()

  if (pr?.url) {
    prUrlByWorkspace.set(workspaceId, pr.url)
  } else {
    prUrlByWorkspace.delete(workspaceId)
  }

  const rect = anchorEl.getBoundingClientRect()
  const anchorRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }

  const data: HoverPopoverData = {
    title,
    activityLabel: activityToLabel(activity),
    activityState: activityToState(activity),
    relativeTime,
    git: gitStatusToNative(gitStatus),
    pr: prToNative(pr),
    prUrl: pr?.url ?? undefined,
    cwd
  }

  void window.api.terminal
    .showPopover(workspaceId, 'hover', anchorRect, data as unknown as Record<string, unknown>)
    .catch(() => {})
}

export function showDetailsPopover(
  workspaceId: string,
  anchorEl: Element,
  data: DetailsPopoverData,
  pr: GhPullRequest | null | undefined
): void {
  ensurePopoverActionListener()

  if (pr?.url) {
    prUrlByWorkspace.set(workspaceId, pr.url)
  } else {
    prUrlByWorkspace.delete(workspaceId)
  }

  const rect = anchorEl.getBoundingClientRect()
  const anchorRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }

  const nativeData = {
    ...data,
    pr: prToNative(pr ?? null),
    prUrl: pr?.url ?? undefined
  }

  void window.api.terminal
    .showPopover(
      workspaceId,
      'details',
      anchorRect,
      nativeData as unknown as Record<string, unknown>
    )
    .catch(() => {})
}

export function showProjectPopover(
  projectId: string,
  anchorEl: Element,
  data: ProjectPopoverData
): void {
  ensurePopoverActionListener()

  const rect = anchorEl.getBoundingClientRect()
  const anchorRect = { x: rect.left, y: rect.top, w: rect.width, h: rect.height }

  void window.api.terminal
    .showPopover(
      `proj:${projectId}`,
      'project',
      anchorRect,
      data as unknown as Record<string, unknown>
    )
    .catch(() => {})
}

export function updateDetailsPopover(
  workspaceId: string,
  patch: Partial<DetailsPopoverData>
): void {
  void window.api.terminal
    .updatePopover(workspaceId, patch as unknown as Record<string, unknown>)
    .catch(() => {})
}

export function hideNativePopover(workspaceId: string): void {
  prUrlByWorkspace.delete(workspaceId)
  void window.api.terminal.hidePopover(workspaceId).catch(() => {})
}

// ── Native confirm modal ─────────────────────────────────────────────────────
//
// Renders a centered, dimmed, native modal ABOVE the terminal surface (React
// modals get occluded by the live libghostty NSView; this chassis doesn't).
// Each call gets its own synthetic workspaceId ("modal:<uuid>") so concurrent
// modals (unlikely, but not disallowed) never collide with each other or with
// real workspace popover actions.
export function showConfirmModal(data: ConfirmModalData): Promise<ConfirmModalResult> {
  ensurePopoverActionListener()

  const workspaceId = `modal:${crypto.randomUUID()}`
  let checkboxChecked = data.checkbox?.checked ?? false

  return new Promise<ConfirmModalResult>((resolve) => {
    let settled = false
    const settle = (buttonId: string): void => {
      if (settled) return
      settled = true
      modalHandlers.delete(workspaceId)
      hideNativePopover(workspaceId)
      resolve({ buttonId, checkboxChecked })
    }

    modalHandlers.set(workspaceId, (elementId) => {
      if (elementId.startsWith('checkbox:')) {
        // "checkbox:<id>::<0|1>" — split on the LAST "::" for the 0/1 flag.
        const sep = elementId.lastIndexOf('::')
        if (sep === -1) return
        checkboxChecked = elementId.slice(sep + 2) === '1'
        return
      }
      if (elementId === 'cancel') {
        settle('cancel')
        return
      }
      // Any other elementId is a terminal button click.
      settle(elementId)
    })

    // Anchor rect is ignored for kind 'confirm' (native side centers it).
    const anchorRect = { x: 0, y: 0, w: 0, h: 0 }
    void window.api.terminal
      .showPopover(workspaceId, 'confirm', anchorRect, data as unknown as Record<string, unknown>)
      .catch(() => {
        // If showPopover itself fails (e.g. no host contentView yet), resolve
        // as cancel rather than leaving the caller's await hanging forever.
        settle('cancel')
      })
  })
}

// Re-export the git+pr converters for use by consumers that already have raw objects
export { gitStatusToNative, prToNative }
