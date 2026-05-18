// loadingOverlay — per-workspace state machine for the native loading overlay
// drawn above the ghostty NSView while claude boots.
//
// The native addon owns the visuals (NSVisualEffectView + CALayer card). This
// module owns the lifecycle: when to show, when to hide, the slow-watchdog
// transition, the 250ms min-show debounce that prevents flash on fast mounts.
//
// State graph:
//   idle  ──show()──▶ showing  ──hide()──▶ hidden ──▶ idle
//                       │  (no SessionStart after 3s)
//                       ▼
//                     slow  ──hide() / action click──▶ hidden
//                       │
//                       │ markError()
//                       ▼
//                     error  ──hide() / retry click──▶ hidden

type OverlayState = 'idle' | 'showing' | 'slow' | 'error'

export type LoadingCopy = {
  title: string
  subtitle?: string
  actionLabel?: string
}

type SetOverlayFn = (
  workspaceId: string,
  state: 'showing' | 'slow' | 'error' | 'hidden',
  copy: LoadingCopy
) => void

type Entry = {
  state: OverlayState
  startTime: number
  copy: LoadingCopy
  slowTimer: NodeJS.Timeout | null
  pendingHide: NodeJS.Timeout | null
}

const MIN_SHOW_MS = 250
const SLOW_THRESHOLD_MS = 3000

const entries = new Map<string, Entry>()
let setOverlay: SetOverlayFn | null = null

/** Inject the native bridge once on app startup. */
export function configureLoadingOverlay(fn: SetOverlayFn): void {
  setOverlay = fn
}

function clearTimers(e: Entry): void {
  if (e.slowTimer) {
    clearTimeout(e.slowTimer)
    e.slowTimer = null
  }
  if (e.pendingHide) {
    clearTimeout(e.pendingHide)
    e.pendingHide = null
  }
}

/** Show the overlay for a workspace. Idempotent — updates copy if already showing. */
export function show(workspaceId: string, copy: LoadingCopy): void {
  if (!setOverlay) return
  const existing = entries.get(workspaceId)
  if (existing && existing.state !== 'idle') {
    // Re-show during an active overlay: just update copy, don't reset start time.
    existing.copy = copy
    setOverlay(workspaceId, mapState(existing.state), copy)
    return
  }
  const entry: Entry = {
    state: 'showing',
    startTime: Date.now(),
    copy,
    slowTimer: null,
    pendingHide: null
  }
  entries.set(workspaceId, entry)

  entry.slowTimer = setTimeout(() => {
    const e = entries.get(workspaceId)
    if (!e || e.state !== 'showing') return
    e.state = 'slow'
    const slowCopy: LoadingCopy = {
      title: 'Still starting…',
      subtitle: 'Hooks or auth check taking longer than usual',
      actionLabel: 'Show terminal anyway'
    }
    e.copy = slowCopy
    setOverlay?.(workspaceId, 'slow', slowCopy)
    console.log('[loadingOverlay] watchdog → slow', workspaceId)
  }, SLOW_THRESHOLD_MS)

  setOverlay(workspaceId, 'showing', copy)
  console.log('[loadingOverlay] show', workspaceId, copy)
}

/** Hide the overlay. Respects MIN_SHOW_MS to prevent flash on fast mounts. */
export function hide(workspaceId: string): void {
  if (!setOverlay) return
  const e = entries.get(workspaceId)
  if (!e || e.state === 'idle') return
  if (e.pendingHide) return // already scheduled

  const elapsed = Date.now() - e.startTime
  const remaining = Math.max(0, MIN_SHOW_MS - elapsed)

  const doHide = (): void => {
    const current = entries.get(workspaceId)
    if (!current) return
    clearTimers(current)
    current.state = 'idle'
    // Copy is ignored by the native side when state is 'hidden'.
    setOverlay?.(workspaceId, 'hidden', { title: '' })
    entries.delete(workspaceId)
    console.log('[loadingOverlay] hide', workspaceId, `(after ${Date.now() - e.startTime}ms)`)
  }

  if (remaining <= 0) {
    doHide()
  } else {
    e.pendingHide = setTimeout(doHide, remaining)
  }
}

/** Mark the overlay as failed (claude exited before ready). Stays visible until user dismisses. */
export function markError(workspaceId: string, reason: string): void {
  if (!setOverlay) return
  const e = entries.get(workspaceId)
  if (!e) return
  clearTimers(e)
  e.state = 'error'
  const errorCopy: LoadingCopy = {
    title: "Couldn't start claude",
    subtitle: reason,
    actionLabel: 'Dismiss'
  }
  e.copy = errorCopy
  setOverlay(workspaceId, 'error', errorCopy)
  console.log('[loadingOverlay] error', workspaceId, reason)
}

function mapState(s: OverlayState): 'showing' | 'slow' | 'error' | 'hidden' {
  if (s === 'idle') return 'hidden'
  return s
}
