/**
 * tui/components/Footer.tsx — keymap hint line, or a transient notice
 * (e.g. "'n' is not yet wired in this build") in its place.
 *
 * Lipgloss-style key hints: a dim key glyph followed by its label, joined
 * with a middle-dot separator — replaces the previous single flat dimColor
 * line where key and label had no visual distinction from each other.
 *
 * NARROW WIDTH: the full 8-key hint line (~78 chars) never fit in 44 cols —
 * even the ORIGINAL flat-string footer silently overflowed to a second
 * line there, which is exactly the "footer costs more than 1 row" bug the
 * windowing math must not repeat. At narrow, show only the highest-value
 * keys (open/filter/help/quit) so the whole line fits in one row; at
 * medium/wide there's room for the full keymap.
 */

import * as React from 'react'
import { Text } from 'ink'
import type { Breakpoint } from '../layout.js'
import { KEYMAP_SEPARATOR } from '../theme.js'
import type { Palette } from '../theme.js'

const ALL_KEYS: Array<[string, string]> = [
  ['↵', 'open'],
  ['n', 'new'],
  ['x', 'kill'],
  ['a', 'archive'],
  ['r', 'rename'],
  ['f', 'filter'],
  ['?', 'keys'],
  ['q', 'quit']
]

/** Highest-value subset that still fits comfortably inside 44 columns. */
const NARROW_KEYS: Array<[string, string]> = [
  ['↵', 'open'],
  ['f', 'filter'],
  ['?', 'keys'],
  ['q', 'quit']
]

export interface FooterProps {
  notice: string | null
  palette: Palette
  breakpoint: Breakpoint
}

export function Footer({ notice, palette, breakpoint }: FooterProps): React.JSX.Element {
  if (notice != null) {
    return (
      <Text color={palette.attention} wrap="truncate-end">
        {notice}
      </Text>
    )
  }
  const keys = breakpoint === 'narrow' ? NARROW_KEYS : ALL_KEYS
  return (
    <Text wrap="truncate-end">
      {keys.map(([key, label], i) => (
        <React.Fragment key={key}>
          {i > 0 ? <Text color={palette.secondary}>{KEYMAP_SEPARATOR}</Text> : null}
          <Text bold color={palette.accent}>
            {key}
          </Text>
          <Text color={palette.secondary}> {label}</Text>
        </React.Fragment>
      ))}
    </Text>
  )
}
