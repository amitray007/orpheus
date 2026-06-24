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
  activityState:
    | 'ready'
    | 'idle'
    | 'attention'
    | 'thinking'
    | 'tool'
    | 'compacting'
    | 'asking'
    | 'archived'
  relativeTime: string
  git?: {
    branch: string
    detached: boolean
    summary: string
    insertions: number
    deletions: number
  }
  pr?: { number: number; state: 'open' | 'merged' | 'closed' | 'draft'; check: string }
  cwd?: string
}

export type DetailsPopoverData = {
  pr?: { number: number; state: 'open' | 'merged' | 'closed' | 'draft'; check: string }
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
  thinking: 'thinking',
  tool: 'running tool',
  compacting: 'compacting',
  asking: 'awaiting input',
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

// ── One-time action listener registration ───────────────────────────────────

let actionListenerRegistered = false

function ensurePopoverActionListener(): void {
  if (actionListenerRegistered) return
  actionListenerRegistered = true
  window.api.terminal.onPopoverAction((e) => {
    // identifier format: "workspaceId::pr"
    const sep = e.identifier.lastIndexOf('::')
    if (sep === -1) return
    const workspaceId = e.identifier.slice(0, sep)
    const elementId = e.identifier.slice(sep + 2)
    if (elementId === 'pr') {
      const url = prUrlByWorkspace.get(workspaceId)
      if (url) {
        window.open(url, '_blank', 'noopener,noreferrer')
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

  const nativeData: DetailsPopoverData = {
    ...data,
    pr: prToNative(pr ?? null)
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

// Re-export the git+pr converters for use by consumers that already have raw objects
export { gitStatusToNative, prToNative }
