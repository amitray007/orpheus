/**
 * tui/components/wizard/ListStep.tsx — a generic selectable-list screen,
 * shared by the wizard's model accordion (Step 1) and mode list (Step 3) of
 * NewWorkspaceWizard.tsx.
 *
 * ONE COMPONENT, MULTIPLE CALL SITES — rather than one near-identical
 * component per screen. The model accordion and mode list share the exact
 * same shape: a title, a vertically-scanned list of rows where one is
 * highlighted, `j/k`/arrows move the highlight, `enter` selects. Only the
 * row CONTENT differs (a provider header with an indent-0 trailing
 * count+marker, an indent-1 model row with an availability marker, or a bare
 * mode name) — callers pass already-built `ListRow` objects rather than this
 * component knowing anything about providers/models/modes itself, so it
 * stays reusable and (per the lint budget) small. `indent`/`trailingMarker`
 * (below) are what let the model accordion's two-level hierarchy render
 * through this same generic row shape instead of a provider-specific fork —
 * see WizardScreens.tsx's `buildModelAccordionListRows` for how they're
 * populated.
 *
 * SELECTION RENDERING — REUSES WorkspaceCard's OWN GUTTER APPROACH
 * -----------------------------------------------------------------------
 * Per the task brief: no new selection glyph. `cardGutterFor()` (theme.ts)
 * returns the SAME rail character WorkspaceCard.tsx uses for the picker's own
 * selected row, rendered inside a fixed-width Box for the same
 * East_Asian_Width safety reason documented there (an Ambiguous-width glyph
 * clips at the box edge in a CJK terminal instead of shoving text right).
 *
 * PAD BEFORE COLOUR (the Ink backgroundColor trap, see WorkspaceCard.tsx's
 * header) — every row's text is built via wizardLayout.ts's
 * `buildListRowText`, which returns an ALREADY padEnd()'d string of exactly
 * `innerWidth` columns; only THEN is it wrapped in a <Text backgroundColor=
 * ...>. Never apply backgroundColor to an unpadded string here.
 *
 * WINDOWING (accordion-required, see wizardLayout.ts's `windowListRows`)
 * -----------------------------------------------------------------------
 * This component used to render `rows.map(...)` unconditionally — safe when
 * the tallest possible screen was a drilled-in model list (at most 13 rows,
 * nothing else on screen). It is NOT safe now that Step 1 is a single
 * accordion screen: expanding the biggest provider group can push the row
 * count well past a phone viewport with the keyboard up (~12 rows), which
 * would silently scroll the highlighted row — and the hint line below it —
 * off screen with no indication anything was cut. `availableRows` is
 * REQUIRED (not optional) for exactly that reason: every call site must
 * budget for it, there is no "small list, skip windowing" escape hatch that
 * could regress silently if a future list grows past its caller's assumed
 * bound.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { cardGutterFor, CARD_GUTTER_WIDTH, CARD_PAD_GUTTER, CARD_PAD_RIGHT } from '../../theme.js'
import type { Palette } from '../../theme.js'
import { listRowInnerWidth, buildListRowText, windowListRows } from '../../wizardLayout.js'
import { ScrollAffordance } from '../ScrollAffordance.js'

export interface ListRow {
  key: string
  label: string
  /** Row text colour when NOT dimmed — e.g. a provider's agentColors hue.
   *  Falls back to palette.text when omitted. */
  color?: string
  /** True for a row that must render visually distinct and be unselectable
   *  (an unavailable model) — see the task brief's Step 1 requirement. */
  disabled?: boolean
  /** Appended after the label when there's room (see buildListRowText) —
   *  used for the "(unavailable)" marker. */
  suffix?: string
  /** Nesting level: 0 for a top-level row (a provider header, or a plain
   *  mode row), 1 for a row nested under an expanded provider (a model).
   *  Rendered as leading blank columns inside the row's text budget — see
   *  `buildListRowText`'s caller below. Defaults to 0 so every pre-existing
   *  caller (the mode list) needs no change. */
  indent?: number
  /** Rendered flush-right on the row, after the label/suffix — the
   *  accordion's per-provider model count + expand/collapse marker (`>` /
   *  `v`, see WizardScreens.tsx). Absent for model/mode rows. */
  trailingMarker?: string
}

export interface ListStepProps {
  title: string
  rows: ListRow[]
  highlightedIndex: number
  width: number
  palette: Palette
  /** Footer hint line — callers pass their own step-specific copy (esc
   *  behaviour differs between the provider list and the model list, see
   *  NewWorkspaceWizard.tsx). */
  hint: string
  /** Row budget for the SCROLLING BODY ONLY — title and hint are rendered
   *  outside this budget (they're each their own fixed row, always visible;
   *  see the render body below), so callers pass the terminal's full
   *  available-rows figure and this component reserves the title/hint rows
   *  itself. Required, not optional — see this file's WINDOWING note. */
  availableRows: number
}

/** Columns spent per indent level — one blank column per level, enough to
 *  visually nest a model row under its provider without eating meaningfully
 *  into the already-tight 38-column phone budget. */
const INDENT_COLUMNS = 2

function rowColorFor(row: ListRow, selected: boolean, palette: Palette): string {
  if (row.disabled) return palette.secondary
  if (selected) return palette.accent
  return row.color ?? palette.text
}

/** Build the row's actual text budget: `indent` levels of leading blank
 *  columns, then the label, then whichever of `suffix`/`trailingMarker` this
 *  row carries — a provider row and a model row never populate both, so
 *  there's no ordering question between them, just "use whichever is set".
 *  Indent eats into `innerWidth` up front (same "reserve the fixed part,
 *  truncate the variable part" discipline as buildSummaryLine/
 *  buildClosePromptLine in wizardLayout.ts) rather than being prepended
 *  after truncation, so a long indented label truncates to leave room for
 *  the indent instead of overflowing past it. */
function buildIndentedRowText(row: ListRow, innerWidth: number): string {
  const indentColumns = Math.min(innerWidth, (row.indent ?? 0) * INDENT_COLUMNS)
  const labelWidth = Math.max(1, innerWidth - indentColumns)
  const marker = row.trailingMarker ?? row.suffix ?? ''
  const labelText = buildListRowText(row.label, labelWidth, marker)
  return ' '.repeat(indentColumns) + labelText
}

function ListRowView({
  row,
  selected,
  innerWidth,
  palette
}: {
  row: ListRow
  selected: boolean
  innerWidth: number
  palette: Palette
}): React.JSX.Element {
  const gutter = cardGutterFor(selected)
  const bg = selected ? palette.selectedBg : undefined
  const text = buildIndentedRowText(row, innerWidth)
  return (
    <Box flexDirection="row" height={1} flexShrink={0}>
      <Box width={CARD_GUTTER_WIDTH} flexShrink={0}>
        <Text color={palette.accent} backgroundColor={bg}>
          {gutter}
        </Text>
      </Box>
      <Box width={CARD_PAD_GUTTER} flexShrink={0}>
        <Text backgroundColor={bg}> </Text>
      </Box>
      <Text
        backgroundColor={bg}
        color={rowColorFor(row, selected, palette)}
        dimColor={row.disabled}
        bold={selected && !row.disabled}
        wrap="truncate"
      >
        {text}
      </Text>
      <Box width={CARD_PAD_RIGHT} flexShrink={0}>
        <Text backgroundColor={bg}> </Text>
      </Box>
    </Box>
  )
}

/** Rows reserved OUTSIDE the scrolling body's own budget: the title line and
 *  the hint line, each always rendered regardless of scroll position — see
 *  ListStepProps.availableRows's doc comment. */
const CHROME_ROWS = 2

export function ListStep({
  title,
  rows,
  highlightedIndex,
  width,
  palette,
  hint,
  availableRows
}: ListStepProps): React.JSX.Element {
  const innerWidth = listRowInnerWidth(width)
  const bodyRows = Math.max(0, availableRows - CHROME_ROWS)
  const rowWindow = windowListRows(rows, highlightedIndex, bodyRows)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER}>
        <Text bold color={palette.groupLabel} wrap="truncate-end">
          {title}
        </Text>
      </Box>
      {rowWindow.windowed ? (
        <ScrollAffordance count={rowWindow.aboveCount} direction="up" palette={palette} />
      ) : null}
      <Box flexDirection="column" flexGrow={1}>
        {rowWindow.visible.map((row, i) => (
          <ListRowView
            key={row.key}
            row={row}
            selected={i === rowWindow.visibleHighlightedIndex}
            innerWidth={innerWidth}
            palette={palette}
          />
        ))}
      </Box>
      {rowWindow.windowed ? (
        <ScrollAffordance count={rowWindow.belowCount} direction="down" palette={palette} />
      ) : null}
      <Text color={palette.secondary} wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  )
}
