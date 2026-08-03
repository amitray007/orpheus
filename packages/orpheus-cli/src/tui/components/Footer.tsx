/**
 * tui/components/Footer.tsx — keymap hint line, or a transient notice in its
 * place.
 *
 * KEYMAP: enter/j-k/v/n/?/q are implemented — `n` (new workspace) is wired
 * to NewWorkspaceWizard.tsx (see App.tsx's `wizardProject` state); `x/a/r`
 * still require server actions beyond workspace.host/unhost/create and
 * remain out of scope (see docs behind the card redesign). No "not yet
 * wired" placeholders for keys that don't exist in this keymap at all.
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
  ['n', 'new'],
  ['v', 'view'],
  ['?', 'keys'],
  ['q', 'quit']
]

/**
 * Highest-value subset that still fits comfortably inside ~44 columns.
 *
 * CHARACTER-BUDGET MATH (KEYMAP_SEPARATOR is 3 chars, each entry renders as
 * `key + ' ' + label`): the pre-existing 4-key set (`enter open`, `v view`,
 * `? keys`, `q quit`) was 10+6+6+6 = 28 chars of content + 3 separators * 3
 * chars = 9, total 37 — already close to the 44 budget. Adding `n new` (5
 * chars) plus one more separator (3) would push the total to 45, over
 * budget. Rather than overflow, `v` (view) is DROPPED here: of the four
 * pre-existing keys, `v`/view-cycling is the one you can live without
 * seeing in the footer at a glance — it toggles a filter, not something
 * destructive or hard to discover, and it stays fully documented in the
 * `?` help overlay. `enter`/`q` are the two keys no picker screen should
 * ever be caught without (open the thing you're looking at; get out), and
 * `?` is the one key whose ENTIRE job is "reveal the keys this footer
 * doesn't have room for" — dropping it would be self-defeating exactly
 * when the footer is incomplete. New-workspace creation is significant
 * enough (a first-class action, not a toggle) to earn footer space over a
 * view-filter cycle. Resulting set: `enter open`, `n new`, `? keys`,
 * `q quit` = 10+5+6+6 = 27 + 3*3 = 9, total 36 chars — comfortably under
 * the 44-column budget with headroom to spare.
 */
const NARROW_KEYS: Array<[string, string]> = [
  ['enter', 'open'],
  ['n', 'new'],
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
          <Text bold color={palette.keyHint}>
            {key}
          </Text>
          <Text color={palette.secondary}> {label}</Text>
        </React.Fragment>
      ))}
    </Text>
  )
}
