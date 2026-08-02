/**
 * tui-otui/components/ProjectHeaderRow.tsx — a project group header row.
 *
 * SHARPENED two-tier glyph hierarchy (ghui device #3, docs/
 * TUI_UI_REDESIGN.md): a distinct `◆` glyph now marks every project-group
 * header, in the SAME leading columns workspace rows use for their own
 * selection gutter + index — so grouping is now carried by a glyph shape
 * change (◆ vs !/●/○) as well as indentation, not indentation alone like
 * the previous build. Still accent-colored + bold.
 *
 * PREFIX WIDTH IS gutterWidth + numWidth, NOT gutterWidth ALONE — a
 * workspace row's NAME starts after both the selection gutter (bar/dot
 * column) AND the numbered-index column (WorkspaceRow.tsx's numLabel:
 * `String(index).padStart(...) + ' '`), so aligning the project header's
 * name to just the gutter width left it flush against the `◆` glyph with
 * no separating space, visibly closer to the glyph than workspace names are
 * to their own gutter (caught via tui-mcp screenshot at 44 cols: `◆orpheus-
 * dev-testing` had zero gap). `numWidth` is threaded in via the caller's
 * ColumnPlan (App.tsx already computes one for the narrow tier) so this
 * component doesn't need its own copy of tui/layout.ts's fixed-width table.
 */

import { TextAttributes } from '@opentui/core'
import { gutterWidthFor, PROJECT_GLYPH } from '../theme.js'
import type { Palette } from '../theme.js'
import type { Breakpoint, ColumnPlan } from '../../tui/layout.js'

export interface ProjectHeaderRowProps {
  name: string
  palette: Palette
  breakpoint: Breakpoint
  plan: ColumnPlan
}

export function ProjectHeaderRow(props: ProjectHeaderRowProps): JSX.Element {
  const prefixWidth = gutterWidthFor(props.breakpoint) + props.plan.numWidth
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={props.palette.accent} wrapMode="none" overflow="hidden">
        {`${PROJECT_GLYPH} `.padEnd(prefixWidth)}
      </text>
      <text
        fg={props.palette.accent}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
        overflow="hidden"
      >
        {props.name}
      </text>
    </box>
  )
}
