/**
 * tui/components/HelpOverlay.tsx — full keymap reference, shown on `?`.
 *
 * `n`/`x`/`a`/`r` are explicitly labelled "not yet wired" here (rather than
 * omitted) so pressing them gets an honest inline message instead of a silent
 * no-op — see docs/TUI_SPEC.md D6 / the tui.ts task brief.
 *
 * This is the ONE place a border is used regardless of breakpoint — it's a
 * transient overlay replacing the footer, not permanent chrome competing for
 * the narrow layout's scarce 12 rows, so the "no borders at narrow" rule
 * (see Header.tsx) doesn't apply here.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { BORDER_STYLE } from '../theme.js'
import type { Breakpoint } from '../layout.js'
import type { Palette } from '../theme.js'

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

export interface HelpOverlayProps {
  breakpoint: Breakpoint
  palette: Palette
}

export function HelpOverlay({ breakpoint, palette }: HelpOverlayProps): React.JSX.Element {
  // At narrow width the "↑/↓, j/k" key column plus its description wraps
  // badly inside a bordered box's padding — drop the padX to claw back 2
  // columns rather than let Ink hard-wrap mid-word.
  const paddingX = breakpoint === 'narrow' ? 0 : 1
  return (
    <Box
      flexDirection="column"
      borderStyle={BORDER_STYLE}
      borderColor={palette.border}
      paddingX={paddingX}
    >
      <Text bold color={palette.accent}>
        Keys
      </Text>
      {ROWS.map(([key, desc]) => (
        <Text key={key}>
          <Text bold color={palette.accent}>
            {key.padEnd(KEY_COL_WIDTH)}
          </Text>
          <Text color={palette.secondary}>{desc}</Text>
        </Text>
      ))}
      <Text color={palette.secondary}>press any key to close</Text>
    </Box>
  )
}
