/**
 * tui-otui/spinner.ts — shared spinner tick, ONE setInterval for the whole
 * app rather than one per animated row.
 *
 * Ink's version (tui/components/Spinner.tsx) gets this "one shared timer"
 * property for free from Ink 7's native `useAnimation` hook. Solid has no
 * equivalent built-in, so this module is the hand-rolled substitute the task
 * brief calls for: a single `createSignal(0)` incremented by a single
 * `setInterval`, exposed as a getter so any row can read the current frame
 * without owning a timer itself.
 *
 * GATED, NOT ALWAYS-ON
 * -----------------------------------------------------------------------
 * The interval only runs while `setActive(true)` — App.tsx calls this based
 * on whether any row in the current frame is `in_progress`. An idle picker
 * (nothing running) does zero timer work and requests zero redraws, matching
 * OpenTUI's own "not a continuous redraw" performance note (only dirty
 * frames get sent) and the Ink Spinner's `isActive` gate.
 */

import { createSignal, onCleanup } from 'solid-js'
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from './theme.js'

const [frame, setFrame] = createSignal(0)

let intervalHandle: ReturnType<typeof setInterval> | null = null
let refCount = 0

function start(): void {
  if (intervalHandle != null) return
  intervalHandle = setInterval(() => {
    setFrame((f) => (f + 1) % SPINNER_FRAMES.length)
  }, SPINNER_INTERVAL_MS)
  intervalHandle.unref?.()
}

function stop(): void {
  if (intervalHandle == null) return
  clearInterval(intervalHandle)
  intervalHandle = null
}

/**
 * Vote the shared spinner timer active/inactive. Multiple callers may vote;
 * the timer runs while at least one active vote is outstanding. App.tsx
 * calls this once, from a top-level effect keyed on "does the current frame
 * have any in_progress row" — not once per row — but the ref-count makes it
 * safe even if a future caller wants a second vote source.
 */
export function useSpinnerVote(active: () => boolean): void {
  let voted = false
  const sync = (): void => {
    const want = active()
    if (want && !voted) {
      voted = true
      refCount++
      if (refCount === 1) start()
    } else if (!want && voted) {
      voted = false
      refCount--
      if (refCount === 0) stop()
    }
  }
  sync()
  onCleanup(() => {
    if (voted) {
      voted = false
      refCount--
      if (refCount === 0) stop()
    }
  })
  // Callers are expected to wrap this in createEffect themselves (App.tsx
  // does) so `active()`'s reactive dependency is tracked properly — this
  // module doesn't call createEffect itself to avoid a double-tracking
  // surprise if a caller already runs it inside one.
  void sync
}

/** Current spinner glyph, 0-indexed into SPINNER_FRAMES. Call inside a reactive scope to track. */
export function spinnerGlyph(): string {
  return SPINNER_FRAMES[frame() % SPINNER_FRAMES.length]!
}
