/**
 * tui/components/ProjectGroupHeader.tsx — a project group header line (card
 * redesign; replaces ProjectHeaderRow.tsx for the card-based picker).
 *
 * `name --------- N` — the project name on the left, a horizontal rule
 * filling the gap, and the count of workspace rows VISIBLE under this
 * project right now (after the active view filter) right-aligned. Width
 * math for that line lives in projectHeaderLayout.ts's
 * `buildProjectGroupHeaderLine` (a pure function, exercised head-on by
 * scripts/verify-tui-blocks.ts) — this component's only job is placing the
 * three already-sized segments it returns, colouring each, and placing the
 * blank rows around them.
 *
 * TWO DELIBERATE BLANK ROWS, NEITHER THE SAME AS THE OTHER
 * -----------------------------------------------------------------------
 * 1. BELOW the name+rule line, ALWAYS: breathing room before the first card
 *    beneath it, so it isn't flush against the header. When the group is
 *    EMPTY (`isEmpty`, blocks.ts's `Block.isEmpty`), this row carries a
 *    quiet "no workspaces" placeholder instead of staying blank — an empty
 *    group has no card beneath it to breathe before, so the row is repointed
 *    at making the emptiness read as deliberate content rather than a
 *    rendering glitch (see blocks.ts's "EMPTY GROUPS RENDER THEIR HEADER"
 *    note for why this project is visible here at all). Still exactly one
 *    row either way — the height blocks.ts already budgeted doesn't change.
 * 2. ABOVE the name+rule line, ONLY when `blankAbove` is true (every
 *    project group after the first in the whole list): breathing room
 *    separating this group from the PREVIOUS group's last card, so
 *    consecutive projects don't read as one continuous block. The very
 *    first header in the list suppresses this — nothing sits above it to
 *    separate from, and a leading blank at the very top of a phone-width
 *    list is wasted vertical space.
 *
 * NEITHER of these is the dead blank row commit 720e68e7 deliberately
 * removed. That row lived on the first CARD's suppressed separator (space
 * reserved for a rule that was never drawn, left over from before the
 * first-card-height reduction existed) — a different row, a different
 * block, removed because it did nothing. Both rows here are new, deliberate,
 * and owned by the HEADER block (see blocks.ts's `headerHeight`), not by any
 * card — do not fold either back into the first card's height.
 *
 * blocks.ts computes `height` (2 rows for the first header in the list, 3
 * for every one after it) from the exact same `blankAbove` flag this
 * component reads to decide whether to render the leading blank — see
 * blocks.ts's `Block` doc comment and App.tsx's own "derive from the block,
 * never recompute" discipline (mirrors how card `separatorRows` is derived
 * from `block.height`) for why the two can never desync.
 *
 * SELECTABLE ONLY WHEN EMPTY — a project header with workspaces beneath it
 * is still never itself selectable (the cards are); but an EMPTY group has
 * no card to select instead, so App.tsx's selection model lets the caret
 * land on the header itself for exactly that case (see App.tsx's
 * `selectableRows`) — otherwise an empty project could never be highlighted,
 * and `n` (new workspace, which infers its project from the highlighted
 * row) would have no way to target it. `selected` reuses the same rail +
 * background-tint language WorkspaceCard uses for its own selection, so a
 * highlighted empty header reads as "the same kind of selected thing", not
 * a different affordance the user has to learn. Reserves the 1-col gutter
 * slot (CARD_GUTTER_WIDTH + CARD_PAD_GUTTER) unconditionally — same discipline
 * as WorkspaceCard's rail: the slot exists whether or not this particular
 * header is selectable, so selecting it can never shift the header text by a
 * column relative to a sibling header that isn't selected right now.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import type { Palette } from '../theme.js'
import {
  CARD_GUTTER_WIDTH,
  CARD_PAD_GUTTER,
  CARD_PAD_RIGHT,
  NAV_DIVIDER_CHAR,
  cardGutterFor
} from '../theme.js'
import { buildProjectGroupHeaderLine, HEADER_GAP_COLUMNS } from '../projectHeaderLayout.js'

export interface ProjectGroupHeaderProps {
  name: string
  /** Workspace rows visible under this project right now, after the active
   *  view filter — see layout.ts's DisplayRow `visibleCount` field. */
  visibleCount: number
  /** Width available for the name+rule+count line's TEXT content — the
   *  caller's full card area width; the indent below is carved out of it
   *  internally so the composed line still lands flush with the right-hand
   *  inset every card observes. */
  width: number
  /** True for every project group after the first in the whole list — see
   *  this file's header. Comes straight from the block's own `blankAbove`
   *  (blocks.ts), never recomputed here. */
  blankAbove: boolean
  /** True when this project has zero surviving workspace rows — comes
   *  straight from the block's own `isEmpty` (blocks.ts), never recomputed
   *  here. Swaps the blank-below breather for a "no workspaces" placeholder
   *  — see this file's header. */
  isEmpty: boolean
  /** True when App.tsx's selection currently rests on THIS header (only
   *  possible when `isEmpty` — see this file's header's "SELECTABLE ONLY
   *  WHEN EMPTY" note). Drives the same rail + tint WorkspaceCard uses. */
  selected: boolean
  palette: Palette
}

/** Indent shared with WorkspaceCard's text column, so the project name
 *  starts in the same column as the card text beneath it. */
const HEADER_INDENT = CARD_GUTTER_WIDTH + CARD_PAD_GUTTER

function ProjectGroupHeaderImpl({
  name,
  visibleCount,
  width,
  blankAbove,
  isEmpty,
  selected,
  palette
}: ProjectGroupHeaderProps): React.JSX.Element {
  // The name+rule+count line's own budget is the caller's width minus the
  // same left indent and the same right-hand inset (CARD_PAD_RIGHT) every
  // card respects, so the rule's right end — and the count after it — never
  // touches the terminal edge, matching the cards it groups.
  const lineWidth = Math.max(0, width - HEADER_INDENT - CARD_PAD_RIGHT)
  const parts = buildProjectGroupHeaderLine(name, visibleCount, lineWidth, NAV_DIVIDER_CHAR)
  const gap = ' '.repeat(HEADER_GAP_COLUMNS)
  const bg = selected ? palette.selectedBg : undefined
  const gutter = cardGutterFor(selected)

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Blank-above breather — see this file's header. Rendered as its own
          row (not folded into the paddingTop of the row below) so its
          presence/absence is a single boolean toggle, mirroring how
          WorkspaceCard's separator row is a whole extra <Text> line rather
          than a variable top margin. */}
      {blankAbove ? <Text> </Text> : null}
      {/* Rail + name line, row-aligned exactly like WorkspaceCard's own rail:
          a fixed-width gutter Box (never a padded-string glyph — see
          theme.ts's CARD_GUTTER_SELECTED note on why an Ambiguous-width rune
          must live in a clipping Box) followed by the indented name+rule+
          count text. Unselected headers render an empty gutter, so a
          non-empty project's header — which is never itself selectable —
          looks identical to how it always has. */}
      <Box flexDirection="row" flexShrink={0}>
        <Box width={CARD_GUTTER_WIDTH} flexShrink={0}>
          <Text color={palette.accent} backgroundColor={bg}>
            {gutter}
          </Text>
        </Box>
        <Box width={CARD_PAD_GUTTER} flexShrink={0}>
          <Text backgroundColor={bg}> </Text>
        </Box>
        <Text wrap="truncate-end">
          <Text bold color={palette.groupLabel} backgroundColor={bg}>
            {parts.name}
          </Text>
          {parts.rule.length > 0 ? (
            <Text color={palette.border} backgroundColor={bg}>
              {gap}
              {parts.rule}
            </Text>
          ) : null}
          <Text color={palette.secondary} backgroundColor={bg}>
            {parts.countGap ? gap : ''}
            {parts.count}
          </Text>
        </Text>
      </Box>
      {/* Breather below the header, before the first card — owned by this
          block, not by the first card (see this file's header). An empty
          group has no first card, so this row instead carries a quiet
          placeholder confirming the project really does have zero
          workspaces right now (rather than reading as a blank glitch). */}
      <Box paddingLeft={HEADER_INDENT} flexShrink={0}>
        <Text color={palette.secondary} wrap="truncate-end">
          {isEmpty ? 'no workspaces' : ' '}
        </Text>
      </Box>
    </Box>
  )
}

export const ProjectGroupHeader = React.memo(ProjectGroupHeaderImpl)
