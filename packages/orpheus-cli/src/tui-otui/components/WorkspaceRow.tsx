/**
 * tui-otui/components/WorkspaceRow.tsx — renders a single workspace row.
 *
 * Thin consumer of ../../tui/layout.js's pure ColumnPlan/DisplayRow shapes,
 * ported from tui/components/WorkspaceRow.tsx. See that file's header for
 * the full "three layered selection signals, all three at every breakpoint"
 * rationale (the Termius colour-quantization lesson) — this component keeps
 * the same three signals:
 *   1. `bg` (OpenTUI's <text> background-color prop — NOT `backgroundColor`,
 *      which is the <box> equivalent) tint across the row — primary signal.
 *   2. Gutter glyph (bar/dot) in a reserved fixed-width column.
 *   3. Text recolor to accent.
 *
 * FOUR-WAY ROW STATE (extends the Ink version's three-way state)
 * -----------------------------------------------------------------------
 * The task brief calls for THREE visual states: focused (keyboard cursor),
 * currently-open (tmuxHosted proxy, NEW vs the Ink version), and neutral.
 * `focused` and `open` are independent booleans (a row can be both), so in
 * practice there are four combinations. Precedence when both are true:
 * focused wins for the background tint (selectedBg is brighter/more salient
 * than openBg — the keyboard cursor must never be visually swallowed by the
 * "this one's live" indicator), but the OPEN_GLYPH still renders in the
 * worktree/trailing slot regardless of focus so "this is the live session"
 * is never lost just because you arrowed onto it.
 */

import { TextAttributes } from '@opentui/core'
import {
  CHILD_INDENT,
  WORKTREE_GLYPH,
  OPEN_GLYPH,
  gutterContentFor,
  gutterWidthFor
} from '../theme.js'
import type { Palette } from '../theme.js'
import { truncate, type Breakpoint, type ColumnPlan, type DisplayRow } from '../../tui/layout.js'
import type { WorkspaceStatus } from '../types.js'
import { spinnerGlyph } from '../spinner.js'

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

function statusGlyph(status: WorkspaceStatus): string {
  if (status === 'attention') return '!'
  if (status === 'in_progress') return spinnerGlyph()
  // awaiting_input and idle intentionally share a glyph (both "nothing to
  // do right now") — told apart by colour, per layout.ts's own statusGlyph.
  return '○'
}

/** Depth 0 = no indent; depth N = (N-1) continuation levels then the "└ " marker.
 * Simpler scheme than the design spec's full ├─/│ continuation-line ASCII
 * tree — see App.tsx's file header for why (nesting is shallow in practice,
 * matching the Ink version's own documented deviation). */
function indentFor(depth: number): string {
  if (depth <= 0) return ''
  return '  '.repeat(depth - 1) + CHILD_INDENT
}

export interface WorkspaceRowProps {
  row: Extract<DisplayRow, { kind: 'workspace' }>
  plan: ColumnPlan
  selected: boolean
  open: boolean
  palette: Palette
  breakpoint: Breakpoint
}

export function WorkspaceRow(props: WorkspaceRowProps): JSX.Element {
  const indent = (): string => indentFor(props.row.depth)
  const nameBudget = (): number => Math.max(1, props.plan.nameWidth - indent().length)
  const name = (): string =>
    (indent() + truncate(props.row.name, nameBudget())).padEnd(props.plan.nameWidth)
  const gutterWidth = (): number => gutterWidthFor(props.breakpoint)
  const numLabel = (): string =>
    String(props.row.index).padStart(Math.max(1, props.plan.numWidth - gutterWidth() - 1)) + ' '
  const color = (): string => statusColor(props.row.status, props.palette)

  // Selection background wins over open-state background — see the file
  // header's precedence note. Neither applies simultaneously to the same
  // pixel; the row's whole background is one solid tint.
  const rowBackground = (): string | undefined => {
    if (props.selected) return props.palette.selectedBg
    if (props.open) return props.palette.openBg
    return undefined
  }
  const textColor = (): string => (props.selected ? props.palette.accent : props.palette.secondary)

  const worktreeCell = (): string | null => {
    if (props.plan.worktreeWidth <= 0) return null
    // Open-session glyph takes priority in this slot when both would apply
    // (a hosted worktree workspace) — worktree-ness is discoverable from the
    // name/branch elsewhere, but "this is the live session" is the more
    // actionable signal at a glance.
    const glyph = props.open ? OPEN_GLYPH : props.row.worktreeBranch != null ? WORKTREE_GLYPH : ' '
    return glyph.padEnd(props.plan.worktreeWidth)
  }
  const statusCell = (): string | null =>
    props.plan.statusWidth > 0
      ? (' ' + STATUS_LABEL[props.row.status]).padEnd(props.plan.statusWidth)
      : null

  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={props.palette.accent}>{gutterContentFor(props.breakpoint, props.selected)}</text>
      <text bg={rowBackground()} fg={textColor()}>
        {numLabel()}
      </text>
      <text bg={rowBackground()} fg={color()}>
        {statusGlyph(props.row.status)}{' '}
      </text>
      <text
        bg={rowBackground()}
        fg={textColor()}
        attributes={
          props.selected || props.row.status === 'attention' ? TextAttributes.BOLD : undefined
        }
        wrapMode="none"
        overflow="hidden"
      >
        {name()}
      </text>
      {props.plan.worktreeWidth > 0 ? (
        <text bg={rowBackground()} fg={props.open ? props.palette.accent : props.palette.secondary}>
          {worktreeCell()}
        </text>
      ) : null}
      {props.plan.statusWidth > 0 ? (
        <text bg={rowBackground()} fg={color()}>
          {statusCell()}
        </text>
      ) : null}
    </box>
  )
}
