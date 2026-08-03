/**
 * tui-otui/components/ScrollAffordance.tsx — the "more above (N)" /
 * "more below (N)" line.
 *
 * GLYPH-SAFETY: no leading glyph at all. The prior build used `▲`/`▼`
 * (U+25B2/U+25BC), both confirmed East_Asian_Width=Ambiguous per the
 * Unicode Consortium's EastAsianWidth.txt (see theme.ts's file header for
 * the verification method). Rather than hunt for a verified-safe
 * replacement glyph, this uses plain text with no glyph at all — the
 * task brief's own "simplest and zero-risk" recommendation — since the
 * direction (above/below) is already unambiguous from the word itself and
 * the line's position (top vs bottom of the scrolling body).
 *
 * ALWAYS MOUNTED (when scrollWindow.windowed), CONDITIONALLY COLORED — see
 * ../../tui/layout.ts's ScrollWindow.windowed doc comment for why: mounting
 * conditionally reflows every row on screen the instant the user scrolls
 * past an edge, because the reserved affordance budget would change. App.tsx
 * only renders this component at all once `windowed` is true; within a
 * windowed session both directions stay mounted, recoloring only.
 */

import type { Palette } from '../theme.js'

export interface ScrollAffordanceProps {
  count: number
  direction: 'up' | 'down'
  palette: Palette
}

export function ScrollAffordance(props: ScrollAffordanceProps): JSX.Element {
  const hasMore = (): boolean => props.count > 0
  const color = (): string => (hasMore() ? props.palette.accent : props.palette.secondary)
  const label = (): string =>
    hasMore() ? `more ${props.direction === 'up' ? 'above' : 'below'} (${props.count})` : ''
  return <text fg={color()}>{label()}</text>
}
