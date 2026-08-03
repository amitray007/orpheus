/**
 * tui/components/Footer.tsx — keymap hint line, or a transient notice in its
 * place.
 *
 * KEYMAP IS INTENTIONALLY SMALL: only enter/j-k/v/?/q are implemented —
 * n/x/a/r require server actions beyond workspace.host/unhost, out of scope
 * (see docs behind the card redesign). No "not yet wired" placeholders for
 * keys that don't exist in this keymap at all.
 *
 * RENAME: `f` (filter) -> `v` (view) — card redesign. NO ARROW GLYPHS: `↵`/
 * `↑`/`↓` are dropped in favor of the plain-ASCII word `enter` and `j/k`
 * alone for move, avoiding every East_Asian_Width=Ambiguous glyph risk
 * entirely (see theme.ts's file header).
 */

import * as React from 'react'
import { Text } from 'ink'
import type { Breakpoint } from '../layout.js'
import { KEYMAP_SEPARATOR } from '../theme.js'
import type { Palette } from '../theme.js'

const ALL_KEYS: Array<[string, string]> = [
  ['enter', 'open'],
  ['j/k', 'move'],
  ['v', 'view'],
  ['?', 'keys'],
  ['q', 'quit']
]

/** Highest-value subset that still fits comfortably inside 44 columns. */
const NARROW_KEYS: Array<[string, string]> = [
  ['enter', 'open'],
  ['v', 'view'],
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
