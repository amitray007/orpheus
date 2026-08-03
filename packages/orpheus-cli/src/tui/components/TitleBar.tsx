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
 * NO RULE BELOW THE BAR (card redesign amendment) — the prior Header.tsx
 * reserved a second row for a bordered rule at medium/wide. Dropped in favor
 * of a blank line: the title bar is already dense (title + connection/view/
 * count on one row), and a repeated-dash line read as visual noise. Still
 * occupies 2 rows at medium/wide (matching App.tsx's headerReserved calc)
 * without drawing anything on the second one; narrow stays 1 row.
 *
 * WIDTH BUDGETING IS MANUAL — `width` (App.tsx passes the live terminal
 * width) drives an explicit split: title gets a fixed-priority budget (never
 * truncated below the bare "Orpheus" label), status gets whatever's left and
 * is itself truncated via ../layout.js's shared `truncate()`, right-aligned
 * by left-padding via a flexGrow spacer Box.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { truncate, type Breakpoint, type Filter as View, type ProjectScope } from '../layout.js'
import type { Palette } from '../theme.js'

export interface TitleBarProps {
  scope?: ProjectScope
  connected: boolean
  disconnected: boolean
  view: View
  hiddenCount: number
  totalCount: number
  breakpoint: Breakpoint
  palette: Palette
  /** Live terminal width — drives the manual title/status split. */
  width: number
}

export function TitleBar({
  scope,
  connected,
  disconnected,
  view,
  hiddenCount,
  totalCount,
  breakpoint,
  palette,
  width
}: TitleBarProps): React.JSX.Element {
  const title = scope != null ? `Orpheus — ${scope.name}` : 'Orpheus'
  const connectionColor = connected
    ? palette.working
    : disconnected
      ? palette.attention
      : palette.idle
  const connectionLabel = connected ? 'connected' : disconnected ? 'disconnected' : 'connecting…'

  const statusParts = [connectionLabel, `view: ${view}`]
  if (hiddenCount > 0) statusParts.push(`${hiddenCount} hidden (v)`)
  if (totalCount === 0) statusParts.push('no workspaces')
  const statusText = statusParts.join(' - ')

  // Title never shrinks below its own text — the brand is the one thing
  // that must always be legible. Status gets whatever's left after the
  // title + a one-space gap.
  const statusBudget = Math.max(0, width - title.length - 1)
  const clippedStatus = truncate(statusText, statusBudget)

  return (
    <Box flexDirection="column">
      <Box width={width}>
        <Text bold color={palette.accent} wrap="truncate-end">
          {title}
        </Text>
        <Box flexGrow={1} minWidth={0} justifyContent="flex-end">
          <Text color={connectionColor} wrap="truncate-end">
            {clippedStatus}
          </Text>
        </Box>
      </Box>
      {breakpoint !== 'narrow' ? <Box height={1} /> : null}
    </Box>
  )
}
