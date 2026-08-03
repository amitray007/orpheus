/**
 * tui/components/ProjectGroupHeader.tsx — a project group header line (card
 * redesign; replaces ProjectHeaderRow.tsx for the card-based picker).
 *
 * BARE PROJECT NAME, NO GLYPH — no leading glyph prefix. Cards are already
 * visually chunky (3 lines + a reserved gutter column), so indentation-free
 * bold+accent text on its own line, with a blank line of breathing room
 * above every project after the first, is enough visual separation.
 *
 * NO GUTTER COLUMN on this row — unlike a WorkspaceCard, a project header is
 * never itself selectable, so it doesn't reserve the 1-col gutter slot
 * workspace cards do. It renders flush left.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import type { Palette } from '../theme.js'
import { CARD_GUTTER_WIDTH, CARD_PAD_GUTTER, CARD_PAD_RIGHT, GROUP_DIVIDER_CHAR } from '../theme.js'

export interface ProjectGroupHeaderProps {
  name: string
  palette: Palette
  /** False for the very first project header under the title bar (no
   *  leading blank line needed); true for every subsequent project group. */
  withLeadingBlank: boolean
  /** Full card-area width, so the underline spans the same columns the cards
   *  below it occupy. */
  width: number
}

function ProjectGroupHeaderImpl({
  name,
  palette,
  withLeadingBlank,
  width
}: ProjectGroupHeaderProps): React.JSX.Element {
  const ruleWidth = Math.max(0, width - CARD_GUTTER_WIDTH - CARD_PAD_GUTTER - CARD_PAD_RIGHT)
  return (
    <Box flexDirection="column" flexShrink={0}>
      {withLeadingBlank ? <Box height={1} flexShrink={0} /> : null}
      {/* Indented by the card's rail + spacer so the project name starts in
          the same column as the card text beneath it, rather than hanging one
          rail-width to the left of every workspace it groups. */}
      <Box paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER} flexShrink={0}>
        <Text bold color={palette.groupLabel} wrap="truncate-end">
          {name}
        </Text>
      </Box>
      {/* Rule directly under the project name, spanning the card content
          columns — separates the group label from the cards it heads without
          spending a blank row on the gap. */}
      <Box paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER} flexShrink={0}>
        <Text color={palette.border}>{GROUP_DIVIDER_CHAR.repeat(ruleWidth)}</Text>
      </Box>
    </Box>
  )
}

export const ProjectGroupHeader = React.memo(ProjectGroupHeaderImpl)
