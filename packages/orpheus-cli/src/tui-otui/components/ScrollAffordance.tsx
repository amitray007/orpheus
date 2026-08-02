/**
 * tui-otui/components/ScrollAffordance.tsx — the "▲ 3 more" / "▼ 3 more" line.
 *
 * ALWAYS MOUNTED (when scrollWindow.windowed), CONDITIONALLY COLORED — see
 * ../../tui/layout.ts's ScrollWindow.windowed doc comment for why: mounting
 * conditionally reflows every row on screen the instant the user scrolls
 * past an edge, because the reserved affordance budget would change. App.tsx
 * only renders this component at all once `windowed` is true; within a
 * windowed session both directions stay mounted, recoloring only.
 */

import { SCROLL_DOWN_GLYPH, SCROLL_UP_GLYPH } from '../theme.js'
import type { Palette } from '../theme.js'

export interface ScrollAffordanceProps {
  count: number
  direction: 'up' | 'down'
  palette: Palette
}

export function ScrollAffordance(props: ScrollAffordanceProps): JSX.Element {
  const glyph = props.direction === 'up' ? SCROLL_UP_GLYPH : SCROLL_DOWN_GLYPH
  const hasMore = (): boolean => props.count > 0
  const color = (): string => (hasMore() ? props.palette.accent : props.palette.secondary)
  return (
    <text fg={color()}>
      {glyph} {hasMore() ? `${props.count} more` : ''}
    </text>
  )
}
