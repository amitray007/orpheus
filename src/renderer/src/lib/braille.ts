import { useEffect, useState } from 'react'

/** Braille spinner frames — shared across ActivityIndicator and StatusChip. */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

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
