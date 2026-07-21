// loadingOverlay — per-workspace state machine for the native loading overlay
// drawn above the ghostty NSView while claude boots.
//
// The native addon owns the visuals (NSVisualEffectView + CALayer card). This
// module owns the lifecycle: when to show, when to hide, the slow-watchdog
// transition, the 250ms min-show debounce that prevents flash on fast mounts.
//
// State graph:
//   idle  ──show()──▶ showing  ──hide()──▶ hidden ──▶ idle
//                       │  (no SessionStart after SLOW_THRESHOLD_MS)
//                       ▼
//                     slow  ──hide() / action click──▶ hidden
//                       │
//                       │ markError()
//                       ▼
//                     error  ──hide() / retry click──▶ hidden
//
// Routing awareness: show() accepts an optional `routed` flag (bug-09-polish
// fix). A routed-model mount waits on a proxy round-trip to a third-party
// provider before claude registers its session file — the generic "Hooks or
// auth check taking longer than usual" slow-copy is factually wrong for that
// path (it's neither hooks nor auth), and 3s is too aggressive for a proxy
// hop that legitimately takes longer than a direct Anthropic call. This
// module stays a leaf: it takes the boolean the caller already computed
// (index.ts derives it from isRoutedMount/isRoutedModel) rather than
// importing modelRouting.ts or any electron-touching module itself — nothing
// here changes WHAT dismisses the overlay, only the slow-state copy/timing.

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
  routed: boolean
}

// Exported (not just module-local) so the offline harness
// (scripts/verify-loading-overlay.ts) can assert against the exact values in
// force, rather than duplicating magic numbers that could silently drift.
export const MIN_SHOW_MS = 250
// Claude path: direct api.anthropic.com call, unchanged from the original
// tuning — 3s is long enough that a healthy start rarely trips it.
export const SLOW_THRESHOLD_MS = 3000
// Routed path: the wrapper waits on a proxy round-trip (local proxy process
// -> third-party provider) before claude even starts registering its session
// file. That hop is a normal extra network leg, not a fault — 8s gives it
// room without leaving the user staring at a spinner with zero feedback for
// too long. (Not derived from a measured p99; picked as a defensible
// multiple of the Claude threshold — revisit if proxy latency data shows a
// better number.)
export const SLOW_THRESHOLD_MS_ROUTED = 8000

const entries = new Map<string, Entry>()
let setOverlay: SetOverlayFn | null = null

/** Inject the native bridge once on app startup. */
export function configureLoadingOverlay(fn: SetOverlayFn): void {
  setOverlay = fn
}

// Clock indirection exists ONLY so scripts/verify-loading-overlay.ts can
// drive the slow-watchdog / MIN_SHOW_MS debounce deterministically with a
// fake clock (no real sleeps, per this unit's harness requirement) — it adds
// no electron/DB dependency and defaults to the real timers in production.
type ClockDeps = {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout
  clearTimeout: (t: NodeJS.Timeout) => void
}
const realClock: ClockDeps = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t)
}
let clock: ClockDeps = realClock

/** Test-only hook: swap in a fake clock, or pass undefined to restore the
 *  real one. Never called from production code paths. */
export function __setClockForTest(deps: ClockDeps | undefined): void {
  clock = deps ?? realClock
}

function clearTimers(e: Entry): void {
  if (e.slowTimer) {
    clock.clearTimeout(e.slowTimer)
    e.slowTimer = null
  }
  if (e.pendingHide) {
    clock.clearTimeout(e.pendingHide)
    e.pendingHide = null
  }
}

/** Slow-state copy shown once SLOW_THRESHOLD_MS(_ROUTED) elapses with no
 *  SessionStart. Exported so the offline harness can assert its content
 *  without booting Electron / driving the timer. */
export function slowCopyFor(routed: boolean): LoadingCopy {
  if (routed) {
    return {
      title: 'Still starting…',
      subtitle: 'Waiting for the routing proxy to respond',
      actionLabel: 'Show terminal anyway'
    }
  }
  return {
    title: 'Still starting…',
    subtitle: 'Hooks or auth check taking longer than usual',
    actionLabel: 'Show terminal anyway'
  }
}

/** Show the overlay for a workspace. Idempotent — updates copy if already showing.
 *  `routed` (default false) tells the slow-watchdog which copy/threshold to use —
 *  see the module header comment for why this is a plain boolean, not a module
 *  import. */
export function show(workspaceId: string, copy: LoadingCopy, routed: boolean = false): void {
  if (!setOverlay) return
  const existing = entries.get(workspaceId)
  if (existing && existing.state !== 'idle') {
    // Re-show during an active overlay: just update copy, don't reset start time.
    existing.copy = copy
    existing.routed = routed
    if (existing.pendingHide) {
      clearTimeout(existing.pendingHide)
      existing.pendingHide = null
    }
    setOverlay(workspaceId, mapState(existing.state), copy)
    return
  }
  const entry: Entry = {
    state: 'showing',
    startTime: clock.now(),
    copy,
    slowTimer: null,
    pendingHide: null,
    routed
  }
  entries.set(workspaceId, entry)

  entry.slowTimer = clock.setTimeout(
    () => {
      const e = entries.get(workspaceId)
      if (!e || e.state !== 'showing') return
      e.state = 'slow'
      const slowCopy = slowCopyFor(e.routed)
      e.copy = slowCopy
      setOverlay?.(workspaceId, 'slow', slowCopy)
      console.log('[loadingOverlay] watchdog → slow', workspaceId, { routed: e.routed })
    },
    routed ? SLOW_THRESHOLD_MS_ROUTED : SLOW_THRESHOLD_MS
  )

  setOverlay(workspaceId, 'showing', copy)
  console.log('[loadingOverlay] show', workspaceId, copy)
}

/** Hide the overlay. Respects MIN_SHOW_MS to prevent flash on fast mounts. */
export function hide(workspaceId: string): void {
  if (!setOverlay) return
  const e = entries.get(workspaceId)
  if (!e || e.state === 'idle') return
  if (e.pendingHide) return // already scheduled

  const elapsed = clock.now() - e.startTime
  const remaining = Math.max(0, MIN_SHOW_MS - elapsed)

  const doHide = (): void => {
    const current = entries.get(workspaceId)
    if (!current) return
    clearTimers(current)
    current.state = 'idle'
    // Copy is ignored by the native side when state is 'hidden'.
    setOverlay?.(workspaceId, 'hidden', { title: '' })
    entries.delete(workspaceId)
    console.log('[loadingOverlay] hide', workspaceId, `(after ${clock.now() - e.startTime}ms)`)
  }

  if (remaining <= 0) {
    doHide()
  } else {
    e.pendingHide = clock.setTimeout(doHide, remaining)
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
