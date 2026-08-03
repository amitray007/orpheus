/**
 * tui/components/WorkspaceCard.tsx — the Ink render of the 3-line workspace
 * card. Direct port of tui-otui/components/WorkspaceCard.tsx (OpenTUI/Solid);
 * the DESIGN is frozen and identical, only the renderer differs.
 *
 * CARD SHAPE (exactly 3 lines, always — never collapses to 2)
 * -----------------------------------------------------------------------
 * 1. `model effort` left, `status elapsed` right — same line.
 * 2. Workspace title (displayTitleFor()).
 * 3. `⎇ branch` — `row.worktreeBranch ?? gitBranch`, rendered BLANK (not
 *    omitted) when neither exists, so every card is exactly 3 lines tall
 *    regardless of content. Fixed height is what lets blocks.ts's windowing
 *    math stay simple and makes "no vertical shift on selection" checkable.
 *
 * WHY EVERY LINE IS PADDED BEFORE IT IS COLORED (the Ink-specific trap)
 * -----------------------------------------------------------------------
 * Ink's `backgroundColor` on a <Text> colors the EXISTING CHARACTERS of that
 * node — it reserves zero extra columns (see WorkspaceRow.tsx's own comment
 * on the same point). So a selection tint applied to unpadded content stops
 * at the last glyph and reads as "highlighted text"; padded to the full card
 * width first, it reads as a selected OBJECT. Every line here is therefore
 * assembled as ONE string, padded to `innerWidth()`, and only then handed to
 * a single <Text backgroundColor=...>. This is the same discipline the
 * OpenTUI version used, and the same bug class gh-dash hit with
 * `.Width(w).Background(...)`.
 *
 * SELECTION — RESERVE THE GUTTER SLOT, SWAP THE RUNE
 * -----------------------------------------------------------------------
 * Every card has a 1-column leading gutter on ALL THREE lines — ' ' normal,
 * '|' selected. Same column, same width, always present, so selecting cannot
 * shift layout by even one cell. Three INDEPENDENT signals on the selected
 * card, each surviving the loss of the others:
 *   1. Gutter rune: ' ' -> '|'
 *   2. Background tint across the full card width, all 3 lines
 *   3. Bold on the title line only — SELECTION-CONDITIONAL. Unconditional
 *      bold would leave that line distinguished by colour alone, which is
 *      exactly what degrades first on a client that quantizes truecolour.
 *
 * AGENT NAME SEAM (intentionally not plumbed)
 * -----------------------------------------------------------------------
 * No per-workspace agent-identity field exists on the wire yet (this app only
 * launches the `claude` CLI today). The seam is marked below at the exact
 * spot an agent token would be prepended to line 1.
 */

import React from 'react'
import { Box, Text } from 'ink'
import {
  WORKTREE_GLYPH,
  cardGutterFor,
  CARD_GUTTER_WIDTH,
  CARD_PAD_GUTTER,
  CARD_PAD_RIGHT,
  CARD_SEPARATOR_ROWS
} from '../theme.js'
import type { Palette } from '../theme.js'
import { displayTitleFor, truncate, type DisplayRow } from '../layout.js'
import { formatAge, formatModelEffort, line1Parts } from '../format.js'
import type { WorkspaceStatus } from '../types.js'

/** Exactly four status words, one each. Note "in progress" has a space
 *  (display word), unlike the wire enum's underscore. */
const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  attention: 'attention',
  in_progress: 'in progress',
  awaiting_input: 'awaiting',
  idle: 'idle'
}

function statusColor(status: WorkspaceStatus, palette: Palette): string {
  if (status === 'attention') return palette.attention
  if (status === 'in_progress') return palette.working
  if (status === 'awaiting_input') return palette.awaiting
  return palette.idle
}

export interface WorkspaceCardProps {
  row: Extract<DisplayRow, { kind: 'workspace' }>
  /** Effective model/effort, looked up by App from the raw TreeFrame. */
  model: string | null
  effort: string | null
  /** Current git branch of the workspace cwd. Line 3 renders
   *  `row.worktreeBranch ?? gitBranch` — see src/shared/types.ts's
   *  `gitBranch` field for the full precedence rationale. */
  gitBranch: string | null
  selected: boolean
  /** Full width available INCLUDING the 1-col gutter. */
  width: number
  palette: Palette
}

export function WorkspaceCard({
  row,
  model,
  effort,
  gitBranch,
  selected,
  width,
  palette
}: WorkspaceCardProps): React.JSX.Element {
  const gutter = cardGutterFor(selected)
  // The rail column PLUS the blank column separating it from the text, so
  // neither the rail nor the tint sits flush against the card's own copy.
  const innerWidth = Math.max(1, width - CARD_GUTTER_WIDTH - CARD_PAD_GUTTER - CARD_PAD_RIGHT)
  const bg = selected ? palette.selectedBg : undefined

  // ---- Line 1: model/effort (left) + status/elapsed (right) ----
  // AGENT NAME SEAM: prepend the agent token here when the field exists.
  const { left, right } = line1Parts(
    formatModelEffort(model, effort),
    `${STATUS_LABEL[row.status]} ${formatAge(row.lastActivityAt)}`,
    innerWidth,
    truncate
  )
  // Attention stays bold regardless of selection — it is a standing alert,
  // not a selection cue.
  const statusBold = row.status === 'attention'

  // ---- Line 2: title ----
  const titleText = truncate(displayTitleFor(row), innerWidth).padEnd(innerWidth)

  // ---- Line 3: branch (blank when none — card stays exactly 3 lines) ----
  const branch = row.worktreeBranch ?? gitBranch
  const branchText =
    branch == null
      ? ''.padEnd(innerWidth)
      : truncate(`${WORKTREE_GLYPH} ${branch}`, innerWidth).padEnd(innerWidth)

  /** Rail + the blank column after it. The rail sits in a FIXED-WIDTH Box so
   *  an Ambiguous-width glyph (see theme.ts's CARD_GUTTER_SELECTED) clips at
   *  the box edge in a CJK terminal instead of shoving the card's text right;
   *  the spacer keeps the text and the tint off the rail itself. */
  const rail = (
    <>
      <Box width={CARD_GUTTER_WIDTH} flexShrink={0}>
        <Text color={palette.accent} backgroundColor={bg}>
          {gutter}
        </Text>
      </Box>
      <Box width={CARD_PAD_GUTTER} flexShrink={0}>
        <Text backgroundColor={bg}> </Text>
      </Box>
    </>
  )

  /** Trailing inset, CARRYING THE TINT — it has to be part of the highlighted
   *  block, not a gap after it, or the selection would visibly stop one column
   *  short of where the card ends. Same width as the rail's gap on the left,
   *  so the tinted block is inset equally on both sides. */
  const tailPad = (
    <Box width={CARD_PAD_RIGHT} flexShrink={0}>
      <Text backgroundColor={bg}> </Text>
    </Box>
  )

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box flexDirection="row" height={1} flexShrink={0}>
        {rail}
        <Text backgroundColor={bg} color={palette.modelText} wrap="truncate">
          {left}
        </Text>
        <Text backgroundColor={bg} color={statusColor(row.status, palette)} bold={statusBold}>
          {right}
        </Text>
        {tailPad}
      </Box>
      <Box flexDirection="row" height={1} flexShrink={0}>
        {rail}
        <Text
          backgroundColor={bg}
          color={selected ? palette.accent : palette.text}
          bold={selected}
          wrap="truncate"
        >
          {titleText}
        </Text>
        {tailPad}
      </Box>
      <Box flexDirection="row" height={1} flexShrink={0}>
        {rail}
        <Text backgroundColor={bg} color={palette.secondary} wrap="truncate">
          {branchText}
        </Text>
        {tailPad}
      </Box>
      {/* Separator row — UNTINTED even when selected, so the highlight ends
          with the card's own content and the gap reads as space BETWEEN
          cards rather than as a trailing empty line inside the selected one.
          Counted in App.tsx's CARD_HEIGHT, so blocks.ts windows it with the
          card it belongs to. */}
      <Box height={CARD_SEPARATOR_ROWS} flexShrink={0} />
    </Box>
  )
}
