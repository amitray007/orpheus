/**
 * tui/components/wizard/ListStep.tsx — a generic selectable-list screen,
 * shared by the wizard's model list (Step 1) and mode list (Step 2) of
 * NewWorkspaceWizard.tsx.
 *
 * ONE COMPONENT, MULTIPLE CALL SITES — rather than one near-identical
 * component per screen. The model list and mode list share the exact
 * same shape: a title, a vertically-scanned list of rows where one is
 * highlighted, `j/k`/arrows move the highlight, `enter` selects. Only the
 * row CONTENT differs (a non-selectable indent-0 provider header, an
 * indent-1 model row with an availability marker, or a bare mode name) —
 * callers pass already-built `ListRow` objects rather than this component
 * knowing anything about providers/models/modes itself, so it stays reusable
 * and (per the lint budget) small. `indent`/`groupHeader` (below) are what
 * let the model list's two-level hierarchy render through this same generic
 * row shape instead of a provider-specific fork — see WizardScreens.tsx's
 * `buildModelListListRows` for how they're populated. This component does
 * NOT itself decide which rows the cursor can land on — `highlightedIndex`
 * only ever arrives already pointing at a selectable row (see
 * wizardStepMachine.ts's `moveModelCursor`); `groupHeader` here is purely
 * about the WINDOWING edge case below, not about intercepting navigation.
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
 * WINDOWING (required now every provider is always expanded — see
 * wizardLayout.ts's `windowListRows`)
 * -----------------------------------------------------------------------
 * This component used to render `rows.map(...)` unconditionally — safe when
 * the tallest possible screen was a drilled-in model list (at most 13 rows,
 * nothing else on screen). It is NOT safe now that Step 1 lists every
 * provider's models, always fully expanded: the live shape is ~49 rows (45
 * models + 4 headers), well past a phone viewport with the keyboard up
 * (~12 rows), which would silently scroll the highlighted row — and the
 * hint line below it — off screen with no indication anything was cut.
 * `availableRows` is REQUIRED (not optional) for exactly that reason: every
 * call site must budget for it, there is no "small list, skip windowing"
 * escape hatch that could regress silently if a future list grows past its
 * caller's assumed bound.
 *
 * STRANDED GROUP HEADER — trimmed, not specially kept visible
 * -----------------------------------------------------------------------
 * `windowListRows` (wizardLayout.ts) is a plain `T[]` windower with no idea
 * a `ListRow` can be a non-selectable header — so a window boundary can land
 * such that a provider's header is the LAST visible row with every one of
 * its models scrolled off below it, which reads as a dead end (the cursor
 * can never land there — headers aren't selectable — so a header alone at
 * the bottom of the screen shows the user nothing they can act on). Rather
 * than teach the generic windower about header semantics, `trimStrandedTail`
 * below does one cheap post-process pass here (the one place that already
 * knows which rows are headers): if the window's last visible row is a
 * `groupHeader` with nothing after it in the window, drop it and fold it
 * into `belowCount` instead. This was picked over "keep the header's models
 * visible too" (would mean growing the window past its budget, defeating
 * the whole point of a fixed row budget) or "always keep the cursor's own
 * group header pinned" (adds a second, stickier windowing mode for a purely
 * cosmetic edge case) — dropping the row is the smallest fix that removes
 * the dead-end read without touching the windowing budget or algorithm.
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
   *  mode row), 1 for a row nested under a provider (a model). Rendered as
   *  leading blank columns inside the row's text budget — see
   *  `buildListRowText`'s caller below. Defaults to 0 so every pre-existing
   *  caller (the mode list) needs no change. */
  indent?: number
  /** True for a provider header row: a structural group label, not a
   *  selectable list item. `highlightedIndex` never points at one of these
   *  (see wizardStepMachine.ts's `moveModelCursor`, which skips them) — this
   *  flag exists purely so `trimStrandedTail` (below) can recognise and drop
   *  one if it ends up stranded as the window's last visible row. */
  groupHeader?: boolean
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
  /** Optional extra line rendered below the hint — the wizard's submit
   *  lifecycle (WizardScreens.tsx's `SubmitStatusLine`: "creating…" / an
   *  inline error), now that there's no dedicated confirm screen to host it.
   *  Reserved in the SAME row budget as the title/hint (see CHROME_ROWS)
   *  when present, so a caller passing this never silently pushes the
   *  window's own row count past `availableRows` — omitted entirely (not
   *  just null) on every screen that has nothing to show here, so the
   *  common case costs zero rows. */
  statusLine?: React.ReactNode
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
 *  columns, then the label, then `suffix` if the row carries one (the
 *  "(unavailable)" marker). Indent eats into `innerWidth` up front (same
 *  "reserve the fixed part, truncate the variable part" discipline as
 *  buildSummaryLine/buildClosePromptLine in wizardLayout.ts) rather than
 *  being prepended after truncation, so a long indented label truncates to
 *  leave room for the indent instead of overflowing past it. */
function buildIndentedRowText(row: ListRow, innerWidth: number): string {
  const indentColumns = Math.min(innerWidth, (row.indent ?? 0) * INDENT_COLUMNS)
  const labelWidth = Math.max(1, innerWidth - indentColumns)
  const labelText = buildListRowText(row.label, labelWidth, row.suffix ?? '')
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
/** Extra row reserved when `statusLine` is passed — see its own doc comment
 *  on ListStepProps for why this is additive rather than folded into
 *  CHROME_ROWS (most screens pass no statusLine and must not pay for a row
 *  they don't render). */
const STATUS_LINE_ROWS = 1

/**
 * Drop a `groupHeader` row if it's stranded as the LAST visible row with
 * nothing of its group shown after it — see this file's own "STRANDED GROUP
 * HEADER" section for why. Only ever trims the tail (a header can't strand
 * itself at the TOP of the window: the window always starts either at row 0
 * or scrolled so the highlighted row is visible, and the highlighted row is
 * never a header itself, so a leading header always has at least the
 * highlighted model somewhere in the same window). Folds the dropped row
 * into `belowCount` so the down-scroll affordance still reports accurately.
 */
function trimStrandedTail<T extends { groupHeader?: boolean }>(
  window: ReturnType<typeof windowListRows<T>>
): ReturnType<typeof windowListRows<T>> {
  const last = window.visible[window.visible.length - 1]
  if (last == null || last.groupHeader !== true) return window
  return {
    ...window,
    visible: window.visible.slice(0, -1),
    belowCount: window.belowCount + 1,
    windowed: true
  }
}

export function ListStep({
  title,
  rows,
  highlightedIndex,
  width,
  palette,
  hint,
  availableRows,
  statusLine
}: ListStepProps): React.JSX.Element {
  const innerWidth = listRowInnerWidth(width)
  const chromeRows = CHROME_ROWS + (statusLine != null ? STATUS_LINE_ROWS : 0)
  const bodyRows = Math.max(0, availableRows - chromeRows)
  const rowWindow = trimStrandedTail(windowListRows(rows, highlightedIndex, bodyRows))
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
      {statusLine}
    </Box>
  )
}
