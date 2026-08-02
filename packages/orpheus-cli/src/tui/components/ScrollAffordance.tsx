/**
 * tui/components/ScrollAffordance.tsx — the "▲ 3 more" / "▼ 3 more" line
 * shown above/below the visible window (see layout.ts's scrollWindowFor).
 *
 * ALWAYS MOUNTED, CONDITIONALLY COLORED — never conditionally mounted.
 * Once `scrollWindowFor` reports `windowed: true`, BOTH affordance rows are
 * rendered for the whole scrolling session; whether a given direction
 * currently has anything scrolled off is expressed as bright-vs-dim color
 * (and the count text), not as the row appearing/disappearing. Mounting
 * conditionally would mean the reserved affordance budget — and therefore
 * the content window's own height — changes the instant the user scrolls
 * past the top/bottom edge, visibly reflowing every row on screen. App.tsx
 * only renders this component at all when `scrollWindow.windowed` is true;
 * within a windowed session both rows stay mounted throughout.
 */

import * as React from 'react'
import { Text } from 'ink'
import { SCROLL_DOWN_GLYPH, SCROLL_UP_GLYPH } from '../theme.js'
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
  const glyph = direction === 'up' ? SCROLL_UP_GLYPH : SCROLL_DOWN_GLYPH
  const hasMore = count > 0
  // Bright accent when there's real content that direction, dim secondary
  // at the edge — color is the ONLY thing that changes as you scroll, the
  // row itself never unmounts (see the file header).
  const color = hasMore ? palette.accent : palette.secondary
  return (
    <Text color={color}>
      {glyph} {hasMore ? `${count} more` : ''}
    </Text>
  )
}

export const ScrollAffordance = React.memo(ScrollAffordanceImpl)
