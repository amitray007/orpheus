/**
 * tui/components/WorkspaceRow.tsx — renders a single workspace row.
 *
 * Thin consumer of tui/layout.ts's pure ColumnPlan/DisplayRow shapes — all
 * width/truncation/indent decisions were already made by layout.ts; this
 * component only adds colour + chrome (glyphs stay single-width regardless
 * of colour, per docs/TUI_SPEC.md).
 *
 * SELECTION TREATMENT (replaces the old `inverse` flip) — THREE LAYERED SIGNALS,
 * ALL THREE AT EVERY BREAKPOINT (see `rowBackground` below for why)
 * -----------------------------------------------------------------------
 * 1. A `backgroundColor` tint across the whole row (`rowBackground`) — the
 *    PRIMARY, structural signal. Applies at every breakpoint including
 *    narrow: a `backgroundColor` colors EXISTING characters, it doesn't
 *    consume extra columns, so there was never a real space constraint
 *    against using it at 44 cols too (an earlier revision incorrectly
 *    gated this to medium/wide only — see `rowBackground`'s comment for
 *    the bug that caused).
 * 2. An indicator glyph in a reserved fixed-width gutter — `▌` (bar) at
 *    narrow, `●` (dot) at medium/wide, accent-colored. Unselected rows
 *    render a space in the SAME gutter width, so nothing reflows when
 *    selection moves.
 * 3. Text recolors to the accent — both the row number AND the name flip
 *    to `palette.accent` (unselected: `palette.secondary`) when selected.
 *    `palette.accent` is a hue distinct from every status color (see
 *    theme.ts's DARK palette) so this never gets confused with a status
 *    recolor.
 * `inverse` is gone entirely — it inverts against ANSI defaults, breaks
 * under custom terminal palettes, and reads as "error", not "focused".
 *
 * MEMOIZATION: `React.memo` with a manual comparator. The default shallow-
 * prop-compare would already work for `row`/`selected` (primitives/stable
 * refs from layout.ts), but `plan` and `palette` are freshly-computed
 * objects each App.tsx render (useMemo'd, but recreated on breakpoint/level
 * change) — a manual comparator on plan's actual fields avoids relying on
 * object identity surviving through App.tsx's memo chain.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import {
  CHILD_INDENT,
  WORKTREE_GLYPH,
  statusGlyph,
  truncate,
  displayTitleFor,
  type Breakpoint,
  type ColumnPlan
} from '../layout.js'
import type { DisplayRow } from '../layout.js'
import type { WorkspaceStatus } from '../types.js'
import { gutterContentFor, gutterWidthFor, type Palette } from '../theme.js'
import { Spinner } from './Spinner.js'

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  attention: 'attention',
  in_progress: 'working',
  awaiting_input: 'awaiting',
  idle: 'idle'
}

function statusColor(status: WorkspaceStatus, palette: Palette): string {
  if (status === 'attention') return palette.attention
  if (status === 'in_progress') return palette.working
  if (status === 'awaiting_input') return palette.awaiting
  return palette.idle
}

/** Depth 0 = no indent; depth N = (N-1) continuation levels then the "└ " marker. */
function indentFor(depth: number): string {
  if (depth <= 0) return ''
  return '  '.repeat(depth - 1) + CHILD_INDENT
}

export interface WorkspaceRowProps {
  row: Extract<DisplayRow, { kind: 'workspace' }>
  plan: ColumnPlan
  selected: boolean
  palette: Palette
  breakpoint: Breakpoint
}

function WorkspaceRowImpl({
  row,
  plan,
  selected,
  palette,
  breakpoint
}: WorkspaceRowProps): React.JSX.Element {
  const indent = indentFor(row.depth)
  const nameBudget = Math.max(1, plan.nameWidth - indent.length)
  const name = (indent + truncate(displayTitleFor(row), nameBudget)).padEnd(plan.nameWidth)
  // The gutter (accent bar/dot or matching blank space) is carved OUT of
  // plan.numWidth's existing budget rather than added on top — so a row's
  // total rendered width still equals plan.total exactly and the 44-col
  // narrow layout never overflows/wraps. gutterWidthFor() varies by
  // breakpoint (1 at narrow, 2 at medium/wide for the dot variant).
  const gutterWidth = gutterWidthFor(breakpoint)
  const numLabel = String(row.index).padStart(Math.max(1, plan.numWidth - gutterWidth - 1)) + ' '
  const color = statusColor(row.status, palette)
  // Selection background tint — ALL breakpoints, including narrow. A
  // `backgroundColor` on a <Text> node colors EXISTING characters; it
  // reserves zero extra columns, so there was never actually a space
  // constraint here (an earlier revision incorrectly gated this to
  // medium/wide only, treating it like the worktree/status columns which
  // DO cost real width — those are unrelated). This was a real bug: at
  // narrow, an `attention`-status row is ALREADY bold (see the `name`
  // Text's `bold` prop below), so selecting/deselecting an attention row
  // changed NOTHING but a 1-character gutter glyph and a text hue — easy
  // to miss at a glance, which is exactly what the user reported ("up/down
  // doesn't visibly highlight the row"). The tint is the primary, always-
  // present signal now; the gutter glyph and text recolor are additional,
  // not load-bearing alone.
  const rowBackground = selected ? palette.selectedBg : undefined
  const textColor = selected ? palette.accent : palette.secondary

  const worktreeCell =
    plan.worktreeWidth > 0
      ? (row.worktreeBranch != null ? WORKTREE_GLYPH : ' ').padEnd(plan.worktreeWidth)
      : null
  const statusCell =
    plan.statusWidth > 0 ? (' ' + STATUS_LABEL[row.status]).padEnd(plan.statusWidth) : null

  return (
    <Box>
      <Text color={palette.accent}>{gutterContentFor(breakpoint, selected)}</Text>
      <Text backgroundColor={rowBackground} color={textColor}>
        {numLabel}
      </Text>
      <Text backgroundColor={rowBackground} color={color}>
        {row.status === 'in_progress' ? <Spinner color={color} /> : statusGlyph(row.status)}{' '}
      </Text>
      <Text
        backgroundColor={rowBackground}
        color={textColor}
        bold={selected || row.status === 'attention'}
        wrap="truncate-end"
      >
        {name}
      </Text>
      {worktreeCell != null ? (
        <Text backgroundColor={rowBackground} color={palette.secondary}>
          {worktreeCell}
        </Text>
      ) : null}
      {statusCell != null ? (
        <Text backgroundColor={rowBackground} color={color}>
          {statusCell}
        </Text>
      ) : null}
    </Box>
  )
}

function propsAreEqual(prev: WorkspaceRowProps, next: WorkspaceRowProps): boolean {
  return (
    prev.selected === next.selected &&
    prev.breakpoint === next.breakpoint &&
    prev.row.workspaceId === next.row.workspaceId &&
    prev.row.name === next.row.name &&
    prev.row.lastTitle === next.row.lastTitle &&
    prev.row.status === next.row.status &&
    prev.row.index === next.row.index &&
    prev.row.depth === next.row.depth &&
    prev.row.worktreeBranch === next.row.worktreeBranch &&
    prev.plan.nameWidth === next.plan.nameWidth &&
    prev.plan.numWidth === next.plan.numWidth &&
    prev.plan.worktreeWidth === next.plan.worktreeWidth &&
    prev.plan.statusWidth === next.plan.statusWidth &&
    prev.palette === next.palette
  )
}

export const WorkspaceRow = React.memo(WorkspaceRowImpl, propsAreEqual)
