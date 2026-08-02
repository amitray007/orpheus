/**
 * tui/components/HelpOverlay.tsx — full keymap reference, shown on `?`.
 *
 * `n`/`x`/`a`/`r` are explicitly labelled "not yet wired" here (rather than
 * omitted) so pressing them gets an honest inline message instead of a silent
 * no-op — see docs/TUI_SPEC.md D6 / the tui.ts task brief.
 */

import * as React from 'react'
import { Box, Text } from 'ink'

const ROWS: Array<[string, string]> = [
  ['↵', 'open the highlighted workspace (hosts it in tmux, attaches)'],
  ['↑/↓, j/k', 'move the highlighted row'],
  ['n', 'new workspace — not yet wired in this build'],
  ['x', 'kill the tmux session, keep workspace resumable — not yet wired'],
  ['a', 'archive + kill the tmux session — not yet wired'],
  ['r', 'rename the workspace — not yet wired'],
  ['f', 'cycle filter: active -> all'],
  ['?', 'toggle this help'],
  ['q', 'quit']
]

const KEY_COL_WIDTH = 11

export function HelpOverlay(): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keys</Text>
      {ROWS.map(([key, desc]) => (
        <Text key={key}>
          <Text bold>{key.padEnd(KEY_COL_WIDTH)}</Text>
          {desc}
        </Text>
      ))}
      <Text dimColor>press any key to close</Text>
    </Box>
  )
}
