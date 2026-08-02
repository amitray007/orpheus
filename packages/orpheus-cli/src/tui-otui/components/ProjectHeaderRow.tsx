/**
 * tui-otui/components/ProjectHeaderRow.tsx — a project group header row.
 *
 * Ported from tui/components/ProjectHeaderRow.tsx: accent-colored, bold, and
 * left-padded to match WorkspaceRow's selection-gutter width so project
 * names visually align with the workspace names beneath them.
 */

import { TextAttributes } from '@opentui/core'
import { gutterWidthFor, SELECTION_GUTTER_EMPTY } from '../theme.js'
import type { Palette } from '../theme.js'
import type { Breakpoint } from '../../tui/layout.js'

export interface ProjectHeaderRowProps {
  name: string
  palette: Palette
  breakpoint: Breakpoint
}

export function ProjectHeaderRow(props: ProjectHeaderRowProps): JSX.Element {
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={props.palette.secondary}>
        {SELECTION_GUTTER_EMPTY.repeat(gutterWidthFor(props.breakpoint))}
      </text>
      <text fg={props.palette.accent} attributes={TextAttributes.BOLD}>
        {props.name}
      </text>
    </box>
  )
}
