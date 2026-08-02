/**
 * tui/components/Spinner.tsx — animated affordance for `in_progress` rows.
 *
 * Backed by Ink 7's NATIVE `useAnimation` hook rather than a hand-rolled
 * shared `setInterval` — Ink's own docs note "all animations share a single
 * timer internally, so multiple animated components consolidate into one
 * render cycle," which is exactly the "one shared interval, not one per
 * row" requirement this component needs, without a bespoke store to
 * maintain. Interval is 250ms (theme.SPINNER_INTERVAL_MS) — deliberately
 * slower than a typical 80-100ms spinner cadence, since this can render
 * over a phone SSH link (docs/TUI_SPEC.md) and a faster tick risks
 * re-render pressure on a slow connection for a purely decorative
 * affordance.
 *
 * ACCESSIBILITY: `useIsScreenReaderEnabled()` (also native to Ink 7) gates
 * the animation off entirely — a screen reader gets a single static glyph
 * instead of a value that changes every 250ms, and `useAnimation`'s
 * `isActive: false` stops the shared timer's work for this consumer rather
 * than just hiding its visual effect.
 */

import * as React from 'react'
import { Text, useAnimation, useIsScreenReaderEnabled } from 'ink'
import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '../theme.js'

export interface SpinnerProps {
  color: string
}

function SpinnerImpl({ color }: SpinnerProps): React.JSX.Element {
  const screenReaderEnabled = useIsScreenReaderEnabled()
  const { frame } = useAnimation({ interval: SPINNER_INTERVAL_MS, isActive: !screenReaderEnabled })
  const glyph = screenReaderEnabled
    ? SPINNER_FRAMES[0]!
    : SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!
  return <Text color={color}>{glyph}</Text>
}

export const Spinner = React.memo(SpinnerImpl)
