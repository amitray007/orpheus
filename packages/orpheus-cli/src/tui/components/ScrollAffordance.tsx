/**
 * tui/components/ScrollAffordance.tsx — the "more above (N)" / "more below
 * (N)" line shown above/below the visible window (see blocks.ts's
 * windowBlocks).
 *
 * NO LEADING GLYPH (card redesign) — was `▲`/`▼` (U+25B2/U+25BC), both
 * East_Asian_Width=Ambiguous (render two columns wide in CJK-configured
 * terminals — see theme.ts's file header). Plain text instead: the
 * direction is already unambiguous from the word itself and the line's
 * position (top vs bottom of the scrolling body).
 *
 * ALWAYS MOUNTED, CONDITIONALLY COLORED — never conditionally mounted. Once
 * windowing engages, BOTH affordance rows are rendered for the whole
 * scrolling session; whether a given direction currently has anything
 * scrolled off is expressed as bright-vs-dim color (and the count text), not
 * as the row appearing/disappearing. Mounting conditionally would mean the
 * reserved affordance budget — and therefore the content window's own
 * height — changes the instant the user scrolls past the top/bottom edge,
 * visibly reflowing every row on screen.
 */

import * as React from 'react'
import { Text } from 'ink'
import type { Palette } from '../theme.js'

export interface ScrollAffordanceProps {
  count: number
  direction: 'up' | 'down'
  palette: Palette
}

function ScrollAffordanceImpl({
  count,
  direction,
  palette
}: ScrollAffordanceProps): React.JSX.Element {
  const hasMore = count > 0
  // Bright accent when there's real content that direction, dim secondary
  // at the edge — color is the ONLY thing that changes as you scroll, the
  // row itself never unmounts (see the file header).
  const color = hasMore ? palette.accent : palette.secondary
  const label = hasMore ? `more ${direction === 'up' ? 'above' : 'below'} (${count})` : ''
  return <Text color={color}>{label}</Text>
}

export const ScrollAffordance = React.memo(ScrollAffordanceImpl)
