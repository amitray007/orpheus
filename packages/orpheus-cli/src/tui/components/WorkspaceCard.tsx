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
 * AGENT/PROVIDER ATTRIBUTION — COLOUR ONLY, NO NEW TOKEN
 * -----------------------------------------------------------------------
 * Line 1's TEXT is unchanged from before providers were plumbed through:
 * still exactly `model effort` on the left, `status elapsed` on the right,
 * same `formatModelEffort`/`line1Parts` calls, same width budget. Which
 * provider owns the resolved model (`row`'s workspace's `providerId`) is
 * surfaced ONLY as the colour of that existing model/effort token — orange
 * for claude, white for codex, grey for xai/grok, green for antigravity
 * (palette.agentColors, keyed by the raw providerId) — falling back to the
 * neutral `palette.modelText` when the provider is unknown/absent. No
 * separate word/prefix is rendered and no truncation-budget change was
 * needed, since nothing was added to the string.
 */

import React from 'react'
import { Box, Text } from 'ink'
import {
  WORKTREE_GLYPH,
  cardGutterFor,
  CARD_GUTTER_WIDTH,
  CARD_PAD_GUTTER,
  CARD_PAD_RIGHT,
  CARD_DIVIDER_CHAR
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
  /** The effective model's owning provider id, looked up by App from the raw
   *  TreeFrame — see src/shared/types.ts's TreeWorkspaceFrame.providerId.
   *  Drives line 1's model/effort token COLOUR only (palette.agentColors) —
   *  see this file's own "AGENT/PROVIDER ATTRIBUTION" header for why there's
   *  no separate text token. */
  providerId?: string | null
  /** Current git branch of the workspace cwd. Line 3 renders
   *  `row.worktreeBranch ?? gitBranch` — see src/shared/types.ts's
   *  `gitBranch` field for the full precedence rationale. */
  gitBranch: string | null
  selected: boolean
  /** Rows to reserve ABOVE the card's 3 content lines for a leading rule —
   *  `CARD_SEPARATOR_ROWS` for every card except the first in a project
   *  group, which gets 0: that card has no previous CARD to rule off (the
   *  project header sits directly above it, drawn as a bare name with no
   *  rule of its own — see ProjectGroupHeader.tsx), so it reserves no row at
   *  all rather than reserving one and leaving it blank. Driven by the
   *  caller from the same `Block.height` that fed blocks.ts's windowing sum
   *  (see App.tsx's PickerBody), so the rendered row count here always
   *  matches what windowing already counted for this card. */
  separatorRows: number
  /** Whether to draw the dotted rule INSIDE the separator row(s) reserved by
   *  `separatorRows` above. Only meaningful when `separatorRows > 0` — see
   *  App.tsx's PickerBody for the visible-window edge cases (top of the
   *  scrolled window, predecessor is a header) that can suppress the rule
   *  even when a row is reserved for it. */
  showDivider: boolean
  /** Full width available INCLUDING the 1-col gutter. */
  width: number
  palette: Palette
}

export function WorkspaceCard({
  row,
  model,
  effort,
  providerId,
  gitBranch,
  selected,
  separatorRows,
  showDivider,
  width,
  palette
}: WorkspaceCardProps): React.JSX.Element {
  const gutter = cardGutterFor(selected)
  // The rail column PLUS the blank column separating it from the text, so
  // neither the rail nor the tint sits flush against the card's own copy.
  const innerWidth = Math.max(1, width - CARD_GUTTER_WIDTH - CARD_PAD_GUTTER - CARD_PAD_RIGHT)
  const bg = selected ? palette.selectedBg : undefined

  // ---- Line 1: model/effort (left) + status/elapsed (right) ----
  // NO agent/provider WORD is rendered — the provider is carried by the model
  // token's COLOUR alone (orange claude / white codex / grey grok / green
  // antigravity), so line 1's text and width are identical to what they were
  // before providers were plumbed through. An earlier revision prepended a
  // `codex `/`grok ` token here; that was dropped deliberately, so don't
  // reintroduce it without checking — `formatAgentName` no longer has a
  // caller.
  const { left, right } = line1Parts(
    formatModelEffort(model, effort),
    `${STATUS_LABEL[row.status]} ${formatAge(row.lastActivityAt)}`,
    innerWidth,
    truncate
  )
  // Provider colour for the model token, falling back to the neutral
  // modelText when the provider is unknown or absent — never a placeholder.
  const modelColor = palette.agentColors[providerId ?? ''] ?? palette.modelText
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
      {/* Dotted rule ABOVE the card, not below — a trailing rule under the
          LAST card in a group has nothing beneath it and reads as an
          unfinished edge. Drawn for every card except the first in its group,
          which reserves NO row here at all (separatorRows === 0) rather than
          reserving one it would only ever leave blank — that reserved-but-
          blank row was the dead gap under every project name this component
          used to render. UNTINTED even when the card below is selected, so
          the highlight starts with the card's own content. `separatorRows`
          comes from the same Block.height blocks.ts already windows this
          card by, so this Box's rendered height can never drift from what
          the windowing sum counted for it — see this file's `separatorRows`
          prop doc comment. */}
      <Box height={separatorRows} flexShrink={0} paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER}>
        {showDivider ? (
          <Text color={palette.border}>{CARD_DIVIDER_CHAR.repeat(Math.max(0, innerWidth))}</Text>
        ) : null}
      </Box>
      <Box flexDirection="row" height={1} flexShrink={0}>
        {rail}
        <Text backgroundColor={bg} color={modelColor} wrap="truncate">
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
    </Box>
  )
}
