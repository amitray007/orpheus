/**
 * tui/components/TitleBar.tsx — dense one-row title bar with right-aligned
 * status, replacing Header.tsx's two-row (title, then a separate status
 * line) shape plus a bordered-box bottom rule.
 *
 * Direct port of tui-otui/components/TitleBar.tsx (OpenTUI/Solid) — see that
 * file's header for the full rationale this preserves:
 *
 * RENAME: filter -> view (card redesign). The underlying VALUE domain
 * ('active' | 'all', still literally `Filter` from ../layout.js) is
 * unchanged; only the user/dev-facing NAME changed. Header text now reads
 * `view: active` / `view: all`, and the hidden-count hint reads
 * `N hidden (v)` (was `(f)`).
 *
 * NO CONNECTION GLYPH — `●`/`○` are both East_Asian_Width=Ambiguous. The
 * connection state is carried by its TEXT LABEL alone
 * ("connected"/"disconnected"/"connecting…") plus its color.
 *
 * FULL-WIDTH RULE BELOW THE BAR — 2 rows at EVERY breakpoint (title row +
 * rule), matching App.tsx's headerReservedFor(). An earlier revision left the
 * second row blank instead; the rule is what makes the top read as a nav bar
 * rather than as the first line of the list.
 *
 * WIDTH BUDGETING IS MANUAL — `width` (App.tsx passes the live CONTENT width,
 * already inset by the root frame's padding) drives an explicit split: the
 * title never truncates below the bare wordmark, and status takes what is
 * left after MIN_TITLE_GAP, disappearing entirely below MIN_STATUS_WIDTH
 * rather than degrading to an uninformative `...`. See those constants for
 * the narrow-terminal collision this arrangement fixes.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { truncate, type ProjectScope } from '../layout.js'
import type { Palette } from '../theme.js'
import { NAV_DIVIDER_CHAR } from '../theme.js'

export interface TitleBarProps {
  scope?: ProjectScope
  connected: boolean
  disconnected: boolean
  hiddenCount: number
  palette: Palette
  /** Live terminal width — drives the manual title/status split. */
  width: number
}

/** Brand mark glyph — U+2726 BLACK FOUR POINTED STAR, East_Asian_Width=N
 *  (single width, verified against EastAsianWidth.txt). Unlike the card's
 *  selection rail — which lives in a fixed-width Box and merely clips if a
 *  terminal renders it double-width — this glyph sits inline in a flowing
 *  text row, so an Ambiguous-width mark WOULD shift the status text right by
 *  a column in a CJK-configured terminal. `N` is safe; `◆ ● ▲ ■ ·` are all
 *  Ambiguous and must not be substituted here without re-checking. */
const BRAND_GLYPH = '\u2726'
const BRAND_NAME = 'Orpheus'

/** Columns the spacer between wordmark and status is never allowed to drop
 *  below — see the status-budget comment in TitleBar for the collision this
 *  prevents. */
const MIN_TITLE_GAP = 2
/** Below this many columns the status is dropped rather than truncated: a
 *  status clipped to `...` spends the row's scarcest columns saying nothing,
 *  and the connection state is still carried by colour. */
const MIN_STATUS_WIDTH = 12

export function TitleBar({
  scope,
  connected,
  disconnected,
  hiddenCount,
  palette,
  width
}: TitleBarProps): React.JSX.Element {
  const scopeSuffix = scope != null ? ` — ${scope.name}` : null
  // Width budget still counts the FULL rendered mark (glyph + space + name +
  // any scope suffix), even though it renders as several <Text> nodes.
  const title = `${BRAND_GLYPH} ${BRAND_NAME}${scopeSuffix ?? ''}`
  const connectionColor = connected
    ? palette.working
    : disconnected
      ? palette.attention
      : palette.idle
  // SHOW ONLY WHAT THE USER CANNOT SEE FOR THEMSELVES.
  //
  // This row used to read `connected - view: all - 4 hidden (v) - no
  // workspaces` — four facts, three of them redundant. `connected` is the
  // normal state and says nothing (its ABNORMAL states still do, and keep
  // their own colour); `no workspaces` restates the empty-state line already
  // rendered in the body directly below. What survives is the view mode, and
  // only when it is hiding something: `4 hidden (v)` tells the user both that
  // rows are missing AND which key reveals them. In the `all` view, nothing
  // is hidden and nothing is shown.
  const statusParts: string[] = []
  if (!connected) statusParts.push(disconnected ? 'disconnected' : 'connecting…')
  if (hiddenCount > 0) statusParts.push(`${hiddenCount} hidden (v)`)
  const statusText = statusParts.join(' - ')

  // Title never shrinks below its own text — the brand is the one thing that
  // must always be legible. Status takes what's left after a REAL gap.
  //
  // The gap used to be 1 column, which is what let the status collide with
  // the wordmark on a narrow terminal: the status is right-aligned by a
  // flexGrow spacer, so once its truncated text filled the remainder the
  // spacer collapsed to nothing and `connected - view: active - ...` began
  // immediately after `Orpheus`. MIN_TITLE_GAP is what the spacer is
  // guaranteed to keep.
  //
  // And below MIN_STATUS_WIDTH the status is dropped ENTIRELY rather than
  // truncated: a status clipped to `co...` or a bare `...` spends the row's
  // scarcest columns saying nothing. The connection state is still carried
  // by the row's colour, and the full text returns as soon as it fits.
  const statusBudget = Math.max(0, width - title.length - MIN_TITLE_GAP)
  const clippedStatus = statusBudget >= MIN_STATUS_WIDTH ? truncate(statusText, statusBudget) : ''

  return (
    <Box flexDirection="column">
      <Box width={width}>
        {/* WORDMARK, not a heading. A leading accent glyph gives the brand a
            fixed visual anchor at the top-left, and the underline treats
            `Orpheus` as a mark rather than as the first line of content —
            without spending a whole row on a rule. `scope` (the --project
            name) stays un-underlined: it is context, not part of the mark. */}
        <Text bold color={palette.accent}>
          {BRAND_GLYPH}{' '}
        </Text>
        <Text bold underline color={palette.brand} wrap="truncate-end">
          {BRAND_NAME}
        </Text>
        {scopeSuffix != null ? (
          <Text color={palette.secondary} wrap="truncate-end">
            {scopeSuffix}
          </Text>
        ) : null}
        {/* minWidth is the GAP, not 0 — with 0 the spacer collapsed and the
            status ran straight into the wordmark on a narrow terminal. Yoga
            now cannot shrink it below the gap, so the separation holds even
            if the budget arithmetic above is ever wrong. */}
        <Box flexGrow={1} minWidth={MIN_TITLE_GAP} justifyContent="flex-end">
          <Text color={connectionColor} wrap="truncate-end">
            {clippedStatus}
          </Text>
        </Box>
      </Box>
      {/* Full-width rule: this is what turns the title row into a nav bar. */}
      <Box width={width}>
        <Text color={palette.border}>{NAV_DIVIDER_CHAR.repeat(Math.max(0, width))}</Text>
      </Box>
    </Box>
  )
}
