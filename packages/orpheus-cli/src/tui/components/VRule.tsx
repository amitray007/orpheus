/**
 * tui/components/VRule.tsx — the single vertical `|` divider between the
 * wide-tier master (card list) and detail (DetailPane) panes.
 *
 * GLYPH: `|` (U+007C VERTICAL LINE, confirmed Narrow) — NOT `│` (U+2502 BOX
 * DRAWINGS LIGHT VERTICAL, confirmed Ambiguous, see theme.ts's file header).
 *
 * THE ONLY VERTICAL RULE IN THE WHOLE LAYOUT, AND IT ONLY EXISTS AT WIDE —
 * App.tsx only mounts this at breakpoint === 'wide'.
 *
 * A vertical rule is a COLUMN of the glyph, one per available row — built as
 * `rows` individual <Text> rows inside a 1-col-wide column Box so it
 * stretches to match whatever height its sibling panes occupy.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { VRULE_CHAR } from '../theme.js'
import type { Palette } from '../theme.js'

export interface VRuleProps {
  palette: Palette
  /** Number of rows to fill — App.tsx knows this from its own
   *  available-rows computation. */
  rows: number
}

export function VRule({ palette, rows }: VRuleProps): React.JSX.Element {
  const count = Math.max(0, rows)
  return (
    <Box width={1} flexShrink={0} flexDirection="column">
      {Array.from({ length: count }, (_, i) => (
        <Text key={i} color={palette.border}>
          {VRULE_CHAR}
        </Text>
      ))}
    </Box>
  )
}
