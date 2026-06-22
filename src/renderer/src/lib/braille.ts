import { useEffect, useState } from 'react'

/** Braille spinner frames — shared across ActivityIndicator and StatusChip. */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Braille walk frames — a single dot traveling around the cell perimeter (tool state). */
export const BRAILLE_WALK_FRAMES = ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'] as const

/** Braille fill frames — dots filling bottom-up then emptying (compacting state). */
export const BRAILLE_FILL_FRAMES = ['⠁', '⠃', '⠇', '⠧', '⠷', '⠿', '⠷', '⠧', '⠇', '⠃'] as const

/**
 * Animate through a set of frames at a fixed interval.
 * Returns the current frame string. Only ticks when `active` is true.
 */
export function useAnimatedFrame(
  frames: readonly string[],
  intervalMs: number,
  active: boolean
): string {
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setIndex((i) => (i + 1) % frames.length), intervalMs)
    return () => clearInterval(id)
  }, [frames, intervalMs, active])
  return frames[index] ?? frames[0] ?? ''
}
