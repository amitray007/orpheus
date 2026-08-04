/**
 * tui/components/HelpOverlay.tsx — full keymap reference, shown on `?`.
 *
 * ONLY LISTS IMPLEMENTED KEYS — `r` (rename) is omitted entirely (not
 * listed as "not yet wired"), matching the card redesign's smaller keymap:
 * it requires server actions beyond workspace.host/unhost/create/close/
 * archive that aren't wired in this build. `n` (new workspace) IS wired — see
 * NewWorkspaceWizard.tsx — and is listed here right after `enter`, the row
 * it's most often reached for alongside. `c` (close) and `a` (archive) are
 * ALSO wired — see App.tsx's `handleCloseArchiveKey` and
 * components/CloseArchiveConfirm.tsx — and are listed right after `v`,
 * since both act on the currently-highlighted row exactly like `enter`/`v`
 * do, just further down the destructiveness scale.
 *
 * RENAME: `f` (filter) -> `v` (view) — card redesign.
 *
 * This is the ONE place a border is used regardless of breakpoint — it's a
 * transient overlay replacing the footer, not permanent chrome competing for
 * the narrow layout's scarce rows.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { BORDER_STYLE } from '../theme.js'
import type { Breakpoint } from '../layout.js'
import type { Palette } from '../theme.js'

const ROWS: Array<[string, string]> = [
  ['enter', 'open the highlighted workspace (hosts it in tmux, attaches)'],
  ['n', "new workspace, in the highlighted row's project"],
  ['j/k', 'move the highlighted row'],
  ['v', 'cycle view: active -> all'],
  ['c', 'close the highlighted workspace (reversible)'],
  ['a', 'archive the highlighted workspace (PERMANENT — deletes files/worktree)'],
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
      <Text bold color={palette.keyHint}>
        Keys
      </Text>
      {ROWS.map(([key, desc]) => (
        <Text key={key}>
          <Text bold color={palette.keyHint}>
            {key.padEnd(KEY_COL_WIDTH)}
          </Text>
          <Text color={palette.secondary}>{desc}</Text>
        </Text>
      ))}
      <Text color={palette.secondary}>press any key to close</Text>
    </Box>
  )
}
