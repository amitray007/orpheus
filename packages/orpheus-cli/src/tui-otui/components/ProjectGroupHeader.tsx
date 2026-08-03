/**
 * tui-otui/components/ProjectGroupHeader.tsx — a project group header line
 * (card redesign; replaces ProjectHeaderRow.tsx).
 *
 * BARE PROJECT NAME, NO GLYPH — the prior build's `◆ ` prefix (U+25C6 BOX
 * DRAWINGS / geometric shape) is confirmed East_Asian_Width=Ambiguous per
 * Unicode's EastAsianWidth.txt (see theme.ts's file header). Per the card
 * redesign brief, the glyph is dropped entirely, not replaced — cards are
 * already visually chunky (3 lines + a reserved gutter column), so
 * indentation-free bold+accent text on its own line, with a blank line of
 * breathing room above every project after the first, is enough visual
 * separation without a leading glyph.
 *
 * NO GUTTER COLUMN on this row — unlike a WorkspaceCard, a project header
 * is never itself selectable, so it doesn't reserve the 1-col gutter slot
 * workspace cards do. It renders flush left, matching the brief's "bare
 * project name on its own line" wording.
 */

import { TextAttributes } from '@opentui/core'
import type { Palette } from '../theme.js'

export interface ProjectGroupHeaderProps {
  name: string
  palette: Palette
  /** False for the very first project header under the title bar (no
   *  leading blank line needed); true for every subsequent project group. */
  withLeadingBlank: boolean
}

export function ProjectGroupHeader(props: ProjectGroupHeaderProps): JSX.Element {
  return (
    <box flexDirection="column" flexShrink={0}>
      {props.withLeadingBlank ? <box height={1} flexShrink={0} /> : null}
      <text
        fg={props.palette.accent}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
        overflow="hidden"
        height={1}
        flexShrink={0}
      >
        {props.name}
      </text>
    </box>
  )
}
