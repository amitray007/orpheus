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

export interface ProjectGroupHeaderProps {
  name: string
  palette: Palette
  /** False for the very first project header under the title bar (no
   *  leading blank line needed); true for every subsequent project group. */
  withLeadingBlank: boolean
}

function ProjectGroupHeaderImpl({
  name,
  palette,
  withLeadingBlank
}: ProjectGroupHeaderProps): React.JSX.Element {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {withLeadingBlank ? <Box height={1} flexShrink={0} /> : null}
      <Text bold color={palette.accent} wrap="truncate-end">
        {name}
      </Text>
    </Box>
  )
}

export const ProjectGroupHeader = React.memo(ProjectGroupHeaderImpl)
