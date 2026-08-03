/**
 * tui/components/wizard/ListStep.tsx — a generic selectable-list screen,
 * shared by the wizard's provider list, model list, and mode list (Steps 1
 * and 3 of NewWorkspaceWizard.tsx).
 *
 * ONE COMPONENT, THREE CALL SITES — rather than three near-identical
 * components. The provider list, model list, and mode list all share the
 * exact same shape: a title, a vertically-scanned list of rows where one is
 * highlighted, `j/k`/arrows move the highlight, `enter` selects. Only the
 * row CONTENT differs (provider label + colour, model label + availability
 * marker, or a bare mode name) — callers pass already-built `ListRow`
 * objects rather than this component knowing anything about providers/
 * models/modes itself, so it stays reusable and (per the lint budget) small.
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
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { cardGutterFor, CARD_GUTTER_WIDTH, CARD_PAD_GUTTER, CARD_PAD_RIGHT } from '../../theme.js'
import type { Palette } from '../../theme.js'
import { listRowInnerWidth, buildListRowText } from '../../wizardLayout.js'

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
}

function rowColorFor(row: ListRow, selected: boolean, palette: Palette): string {
  if (row.disabled) return palette.secondary
  if (selected) return palette.accent
  return row.color ?? palette.text
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
  const text = buildListRowText(row.label, innerWidth, row.suffix ?? '')
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

export function ListStep({
  title,
  rows,
  highlightedIndex,
  width,
  palette,
  hint
}: ListStepProps): React.JSX.Element {
  const innerWidth = listRowInnerWidth(width)
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER}>
        <Text bold color={palette.groupLabel} wrap="truncate-end">
          {title}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {rows.map((row, i) => (
          <ListRowView
            key={row.key}
            row={row}
            selected={i === highlightedIndex}
            innerWidth={innerWidth}
            palette={palette}
          />
        ))}
      </Box>
      <Text color={palette.secondary} wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  )
}
