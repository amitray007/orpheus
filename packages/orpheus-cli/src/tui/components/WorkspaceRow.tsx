/**
 * tui/components/WorkspaceRow.tsx — renders a single workspace row.
 *
 * Thin consumer of tui/layout.ts's pure ColumnPlan/DisplayRow shapes — all
 * width/truncation/indent decisions were already made by layout.ts; this
 * component only adds colour (glyphs stay single-width regardless of colour,
 * per docs/TUI_SPEC.md).
 */

import * as React from 'react'
import { Text } from 'ink'
import { CHILD_INDENT, WORKTREE_GLYPH, statusGlyph, truncate, type ColumnPlan } from '../layout.js'
import type { DisplayRow } from '../layout.js'
import type { WorkspaceStatus } from '../types.js'

const STATUS_COLOR: Record<WorkspaceStatus, string> = {
  attention: 'red',
  in_progress: 'green',
  awaiting_input: 'cyan',
  idle: 'gray'
}

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  attention: 'attention',
  in_progress: 'working',
  awaiting_input: 'awaiting',
  idle: 'idle'
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
}

export function WorkspaceRow({ row, plan, selected }: WorkspaceRowProps): React.JSX.Element {
  const indent = indentFor(row.depth)
  const nameBudget = Math.max(1, plan.nameWidth - indent.length)
  const name = (indent + truncate(row.name, nameBudget)).padEnd(plan.nameWidth)
  const numLabel = String(row.index).padStart(Math.max(1, plan.numWidth - 1)) + ' '
  const color = STATUS_COLOR[row.status]

  const worktreeCell =
    plan.worktreeWidth > 0
      ? (row.worktreeBranch != null ? WORKTREE_GLYPH : ' ').padEnd(plan.worktreeWidth)
      : null
  const statusCell =
    plan.statusWidth > 0 ? (' ' + STATUS_LABEL[row.status]).padEnd(plan.statusWidth) : null

  return (
    <Text inverse={selected} wrap="truncate-end">
      <Text dimColor>{numLabel}</Text>
      <Text color={color}>{statusGlyph(row.status)} </Text>
      <Text bold={row.status === 'attention'}>{name}</Text>
      {worktreeCell != null ? <Text dimColor>{worktreeCell}</Text> : null}
      {statusCell != null ? <Text color={color}>{statusCell}</Text> : null}
    </Text>
  )
}
