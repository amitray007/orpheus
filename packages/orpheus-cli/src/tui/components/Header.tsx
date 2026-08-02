/**
 * tui/components/Header.tsx — title + connection/filter/count status line.
 *
 * Bordered rule reserved for medium/wide (per the "BE DISCIPLINED" border
 * rule — a border's 2 rows would eat ~17% of a 12-row narrow terminal). At
 * narrow, the header stays a plain two-line block; at medium/wide a bottom
 * rule under the title turns it into a real title bar instead of a debug
 * line, without spending a full bordered box.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import type { Breakpoint, Filter, ProjectScope } from '../layout.js'
import type { Palette } from '../theme.js'

export interface HeaderProps {
  scope?: ProjectScope
  connected: boolean
  filter: Filter
  hiddenCount: number
  totalCount: number
  breakpoint: Breakpoint
  palette: Palette
}

/** A horizontal rule sized to the terminal width, drawn with the border palette. */
function Rule({ palette }: { palette: Palette }): React.JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor={palette.border}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
    />
  )
}

export function Header({
  scope,
  connected,
  filter,
  hiddenCount,
  totalCount,
  breakpoint,
  palette
}: HeaderProps): React.JSX.Element {
  const title = scope != null ? `Orpheus — ${scope.name}` : 'Orpheus'
  const connectionGlyph = connected ? '●' : '○'
  const connectionColor = connected ? palette.working : palette.idle
  const connectionLabel = connected ? 'connected' : 'connecting…'

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color={palette.accent}>
          {title}
        </Text>
      </Box>
      <Box>
        <Text color={connectionColor}>{connectionGlyph} </Text>
        <Text color={palette.secondary}>{connectionLabel}</Text>
        <Text color={palette.secondary}> · filter: {filter}</Text>
        {hiddenCount > 0 ? (
          <Text color={palette.secondary}> · {hiddenCount} hidden (f)</Text>
        ) : null}
        {totalCount === 0 ? <Text color={palette.secondary}> · no workspaces</Text> : null}
      </Box>
      {breakpoint !== 'narrow' ? <Rule palette={palette} /> : null}
    </Box>
  )
}
