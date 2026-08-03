/**
 * tui-otui/components/WorkspaceTable.tsx — the medium/wide-tier workspace
 * list, built on `@opentui/core`'s `TextTableRenderable` (docs/
 * TUI_UI_REDESIGN.md: "TextTable is the direct answer to 'the tabular
 * display is good, just needs a better look' — it replaces hand-computed
 * padEnd arithmetic with a real column engine").
 *
 * THREE THINGS VERIFIED HANDS-ON BEFORE WRITING THIS FILE (via tui-mcp spike
 * sessions against a real pty — see the final report for exact before/after
 * byte captures) THAT SHAPE EVERY DECISION BELOW:
 *
 * 1. `<text-table>` HAS NO SOLID JSX TAG — `@opentui/solid`'s component
 *    catalogue (src/elements/catalogue.ts's `baseComponents`) does not
 *    register TextTableRenderable at all, unlike select/tab-select/scrollbox
 *    etc. Registered here via `extend({ 'text-table': TextTableRenderable })`
 *    at module load (Solid's own documented mechanism) so the tag becomes
 *    usable declaratively.
 *
 * 2. THE `content` PROP CANNOT BE PASSED DECLARATIVELY — @opentui/solid's
 *    reconciler (index.js's `setProperty`) has a hardcoded generic case for
 *    prop name `"content"` (shared with <text>/<code>/<markdown>, which all
 *    take a plain STRING content prop): `Array.isArray(value) ?
 *    value.join("") : ...`. A TextTableContent 2D array gets silently
 *    stringified into garbage via `.join("")` before ever reaching
 *    TextTableRenderable's own `content` setter, which then throws
 *    (`this._content.reduce is not a function`) because it received a
 *    string, not an array. FIX: grab the instance via `ref` and set
 *    `.content = ...` IMPERATIVELY inside an effect, bypassing the
 *    reconciler's prop-diffing for this one property entirely. Every other
 *    TextTable prop (columnWidthMode, columnFitter, wrapMode, border, ...)
 *    passes through the JSX props normally without issue — only `content`
 *    needed this workaround.
 *
 * 3. PER-CELL `bg` DOES NOT PRODUCE A CONTINUOUS ROW-WIDE TINT ON ITS OWN —
 *    with `columnWidthMode: "fill"` and/or nonzero `cellPaddingX`/
 *    `columnGap`, the padding/gap/fill-remainder space around and between
 *    cells is painted with the table's own DEFAULT background, not the
 *    adjacent cell's `bg`, leaving visible unstyled seams through a
 *    "selected row" tint (confirmed via raw ANSI byte capture: cell writes
 *    like `[2;2H...!` and `[2;6H...name` with the tint color, separated by a
 *    `\x1b[49m` — default-bg — write for the padding chars in between). FIX:
 *    `columnWidthMode: "content"` (NOT "fill"), `cellPaddingX: 0`,
 *    `columnGap: 0`, and every cell's TEXT is pre-`padEnd`'d to its exact
 *    allocated column width in THIS component (mirroring the pre-TextTable
 *    hand-rolled padEnd discipline in tui/layout.ts, just moved from
 *    per-glyph JSX spans into pre-built chunk strings) — so a cell's styled
 *    chunk already fills 100% of its column's width and there is no
 *    unstyled remainder left for the table to paint separately. Verified via
 *    tui-mcp: with this combination, a "selected row"'s bg writes are one
 *    single contiguous ANSI run covering the full row width, zero seams.
 *    Column width DISTRIBUTION is instead computed BY THIS COMPONENT (same
 *    arithmetic shape as tui/layout.ts's columnPlanFor: fixed status/branch/
 *    age widths, name column absorbs the remainder) so the table still
 *    visually fills the available terminal width, matching the brief's
 *    "fill available width" intent without ever handing TextTable an
 *    unstyled remainder to paint itself.
 *
 * SELECTION IS STILL A THREE-SIGNAL TREATMENT — bg tint (point 3 above) +
 * a leading gutter-column glyph (bar/dot, mirroring WorkspaceRow.tsx's
 * existing narrow-tier device) + bold text. The gutter column is baked in
 * as the table's own first column (not a separate synchronized element
 * outside the table) — this is what the task brief asked to be verified: a
 * real leading gutter column IS achievable inside TextTable itself, so no
 * external wrapper/second component was needed to preserve the third
 * signal.
 */

import { RGBA, TextAttributes, TextTableRenderable, type TextTableContent } from '@opentui/core'
import { extend } from '@opentui/solid'
import { createEffect, createMemo, onMount, type Accessor } from 'solid-js'
import { truncate, displayTitleFor, type Breakpoint, type DisplayRow } from '../../tui/layout.js'
import type { Palette } from '../theme.js'
import { PROJECT_GLYPH, OPEN_GLYPH, WORKTREE_GLYPH, CHILD_INDENT, SELECTION_DOT } from '../theme.js'
import { spinnerGlyph } from '../spinner.js'
import { formatAge } from '../format.js'
import type { WorkspaceStatus } from '../types.js'

extend({ 'text-table': TextTableRenderable })

const STATUS_LABEL: Record<WorkspaceStatus, string> = {
  attention: 'attention',
  in_progress: 'working',
  awaiting_input: 'awaiting',
  idle: 'idle'
}

function statusColorKey(
  status: WorkspaceStatus
): keyof Pick<Palette, 'attention' | 'working' | 'awaiting' | 'idle'> {
  if (status === 'attention') return 'attention'
  if (status === 'in_progress') return 'working'
  if (status === 'awaiting_input') return 'awaiting'
  return 'idle'
}

function statusGlyph(status: WorkspaceStatus): string {
  if (status === 'attention') return '!'
  if (status === 'in_progress') return spinnerGlyph()
  return '○'
}

/** Column widths for the medium/wide TextTable — same fixed+flexible shape
 * as tui/layout.ts's columnPlanFor, computed locally since this table's
 * column SET (gutter/status/name/branch/age) differs from the Ink/narrow
 * plan's (num/glyph/name/worktree/status). */
export interface TableColumnPlan {
  gutterWidth: number
  statusWidth: number
  nameWidth: number
  branchWidth: number
  ageWidth: number
}

const GUTTER_COL = 2 // selection bar/dot + one separating space
const STATUS_COL = 3 // "! " / spinner glyph + one space
const STATUS_COL_WIDE = 11 // "attention  " — spelled-out status word at wide
const BRANCH_COL_MEDIUM = 14
const BRANCH_COL_WIDE = 20
const AGE_COL = 5
const MIN_NAME_COL = 8

export function tableColumnPlanFor(breakpoint: Breakpoint, columns: number): TableColumnPlan {
  const statusWidth = breakpoint === 'wide' ? STATUS_COL_WIDE : STATUS_COL
  const branchWidth = breakpoint === 'wide' ? BRANCH_COL_WIDE : BRANCH_COL_MEDIUM
  const ageWidth = AGE_COL
  const fixed = GUTTER_COL + statusWidth + branchWidth + ageWidth
  const nameWidth = Math.max(MIN_NAME_COL, columns - fixed)
  return { gutterWidth: GUTTER_COL, statusWidth, nameWidth, branchWidth, ageWidth }
}

function padded(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length >= width ? text.slice(0, width) : text.padEnd(width)
}

function rightAligned(text: string, width: number): string {
  if (width <= 0) return ''
  return text.length >= width ? text.slice(text.length - width) : text.padStart(width)
}

function hex(color: string): RGBA {
  return RGBA.fromHex(color)
}

type Chunk = TextTableContent[number][number]

function cell(text: string, fg: string, bg: string | undefined, bold: boolean): Chunk {
  return [
    {
      __isChunk: true,
      text,
      fg: hex(fg),
      bg: bg != null ? hex(bg) : undefined,
      attributes: bold ? TextAttributes.BOLD : TextAttributes.NONE
    }
  ]
}

export interface WorkspaceTableProps {
  /** Windowed, already-scroll-sliced rows (project headers + workspace rows
   * interleaved), same shape App.tsx already threads through to
   * WorkspaceRow/ProjectHeaderRow for the narrow tier. */
  rows: Accessor<DisplayRow[]>
  selectedWorkspaceId: Accessor<string | null>
  plan: Accessor<TableColumnPlan>
  palette: Palette
}

export function WorkspaceTable(props: WorkspaceTableProps): JSX.Element {
  let tableRef: TextTableRenderable | undefined

  const content = createMemo<TextTableContent>(() => {
    const plan = props.plan()
    const selectedId = props.selectedWorkspaceId()
    const pal = props.palette
    const now = Date.now()

    return props.rows().map((row): TextTableContent[number] => {
      if (row.kind === 'project-header') {
        const label = truncate(`${PROJECT_GLYPH} ${row.projectName}`, plan.nameWidth)
        return [
          cell(padded('', plan.gutterWidth), pal.accent, undefined, false),
          cell(padded('', plan.statusWidth), pal.accent, undefined, false),
          cell(padded(label, plan.nameWidth), pal.accent, undefined, true),
          cell(padded('', plan.branchWidth), pal.accent, undefined, false),
          cell(padded('', plan.ageWidth), pal.accent, undefined, false)
        ]
      }

      const selected = row.workspaceId === selectedId
      const bg = selected ? pal.selectedBg : row.tmuxHosted ? pal.openBg : undefined
      const statusColor = pal[statusColorKey(row.status)]
      const textColor = selected ? pal.accent : pal.text
      const bold = selected || row.status === 'attention'

      const gutterText = padded(selected ? SELECTION_DOT : '', plan.gutterWidth)

      const indent = row.depth > 0 ? '  '.repeat(row.depth - 1) + CHILD_INDENT : ''
      const openMark = row.tmuxHosted
        ? `${OPEN_GLYPH} `
        : row.worktreeBranch != null
          ? `${WORKTREE_GLYPH} `
          : ''
      const nameText = padded(
        truncate(indent + openMark + displayTitleFor(row), plan.nameWidth),
        plan.nameWidth
      )

      const statusText =
        plan.statusWidth >= STATUS_COL_WIDE
          ? padded(` ${STATUS_LABEL[row.status]}`, plan.statusWidth)
          : padded(` ${statusGlyph(row.status)}`, plan.statusWidth)

      const branchText = padded(
        row.worktreeBranch != null ? ` ${truncate(row.worktreeBranch, plan.branchWidth - 1)}` : '',
        plan.branchWidth
      )
      const ageText = rightAligned(`${formatAge(row.lastActivityAt, now)} `, plan.ageWidth)

      return [
        cell(gutterText, pal.accent, bg, false),
        cell(statusText, statusColor, bg, bold),
        cell(nameText, textColor, bg, bold),
        cell(branchText, pal.secondary, bg, false),
        cell(ageText, pal.secondary, bg, false)
      ]
    })
  })

  onMount(() => {
    createEffect(() => {
      if (tableRef == null) return
      tableRef.content = content()
    })
  })

  return (
    <text-table
      ref={(el: TextTableRenderable) => {
        tableRef = el
      }}
      columnWidthMode="content"
      columnFitter="balanced"
      wrapMode="none"
      cellPaddingX={0}
      cellPaddingY={0}
      columnGap={0}
      border={false}
      outerBorder={false}
      selectable={false}
    />
  )
}
