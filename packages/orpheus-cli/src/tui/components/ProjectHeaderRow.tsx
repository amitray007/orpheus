/**
 * tui/components/ProjectHeaderRow.tsx — a project group header row.
 *
 * Colored with the accent (the same hue as the selection bar/dot) so
 * project headers read as structural chrome, distinct from the
 * bold-but-neutral workspace names beneath them — this is most of "visual
 * hierarchy": previously every row (headers included) was uniform white
 * bold text.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import type { Breakpoint } from '../layout.js'
import { gutterWidthFor, SELECTION_GUTTER_EMPTY } from '../theme.js'
import type { Palette } from '../theme.js'

export interface ProjectHeaderRowProps {
  name: string
  palette: Palette
  breakpoint: Breakpoint
}

function ProjectHeaderRowImpl({
  name,
  palette,
  breakpoint
}: ProjectHeaderRowProps): React.JSX.Element {
  return (
    <Box>
      {/* Leading blank matches WorkspaceRow's selection-gutter width for the
          current breakpoint (1 col narrow, 2 col medium/wide) so project
          names visually align with the workspace names beneath them. */}
      <Text>{SELECTION_GUTTER_EMPTY.repeat(gutterWidthFor(breakpoint))}</Text>
      <Text bold color={palette.accent}>
        {name}
      </Text>
    </Box>
  )
}

export const ProjectHeaderRow = React.memo(ProjectHeaderRowImpl)
