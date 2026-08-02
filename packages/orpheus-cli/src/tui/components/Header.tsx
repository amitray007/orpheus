/**
 * tui/components/Header.tsx — title + connection/filter/count status line.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import type { Filter, ProjectScope } from '../layout.js'

export interface HeaderProps {
  scope?: ProjectScope
  connected: boolean
  filter: Filter
  hiddenCount: number
  totalCount: number
}

export function Header({
  scope,
  connected,
  filter,
  hiddenCount,
  totalCount
}: HeaderProps): React.JSX.Element {
  const title = scope != null ? `Orpheus — ${scope.name}` : 'Orpheus'
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>
        {connected ? 'connected' : 'connecting…'} · filter: {filter}
        {hiddenCount > 0 ? ` · ${hiddenCount} hidden (press f)` : ''}
        {totalCount === 0 ? ' · no workspaces' : ''}
      </Text>
    </Box>
  )
}
