/**
 * tui/components/Rule.tsx — a full-width horizontal `-` divider.
 *
 * GLYPH: `-` (U+002D HYPHEN-MINUS, confirmed Narrow) — NOT `─` (U+2500 BOX
 * DRAWINGS LIGHT HORIZONTAL, confirmed East_Asian_Width=Ambiguous, see
 * theme.ts's file header).
 *
 * NOT used by TitleBar.tsx (card redesign) — the title bar's own divider was
 * dropped in favor of a blank line (see TitleBar.tsx's file header). Kept
 * alive for other callers (e.g. DetailPane's internal layout).
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { RULE_CHAR } from '../theme.js'
import type { Palette } from '../theme.js'

export interface RuleProps {
  palette: Palette
  color?: string
  /** Rule width in columns — callers know their own available width; there
   *  is no percentage-width primitive to rely on here. */
  width: number
}

export function Rule({ palette, color, width }: RuleProps): React.JSX.Element {
  return (
    <Box height={1} flexShrink={0} width={width} overflow="hidden">
      <Text color={color ?? palette.border} wrap="truncate">
        {RULE_CHAR.repeat(Math.max(0, width))}
      </Text>
    </Box>
  )
}
