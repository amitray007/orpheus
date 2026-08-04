/**
 * tui/components/Footer.tsx — keymap hint line, or a transient notice in its
 * place.
 *
 * KEYMAP: enter/j-k/v/n/c/a/?/q are implemented — `n` (new workspace) is
 * wired to NewWorkspaceWizard.tsx (see App.tsx's `wizardProject` state);
 * `c` (close, reversible) and `a` (archive, PERMANENT DELETE) are wired to
 * workspace.close/workspace.archive via App.tsx's `handleCloseArchiveKey`
 * and components/CloseArchiveConfirm.tsx. Both are UNSHIFTED and are not a
 * shifted pair of one letter — this UI's primary client is a phone, where
 * shift is a mode switch, and a missed shift must never turn the reversible
 * action into the permanent one (see App.tsx's useInput comment). `r`
 * (rename) still requires a server action not yet exposed and remains out
 * of scope. No "not yet wired" placeholders for keys that don't exist in
 * this keymap at all.
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

/**
 * ALL_KEYS (medium/wide) — no tight budget (see this file's own comment on
 * NARROW_KEYS for the numbers that DO matter). `c`/`a` (close/archive) are
 * added here: `c close` (7 chars) + separator (3) + `a archive`
 * (9 chars) = 19 more content+separator chars on top of the pre-existing
 * 56-char/6-entry set (56 + 19 = 75, plus one more inter-entry separator for
 * the 8th entry = 78 total) — comfortably inside a medium (>=52 col) or wide
 * (>=104 col) terminal, which is exactly why this set doesn't need the same
 * character-budget discipline NARROW_KEYS below does.
 */
const ALL_KEYS: Array<[string, string]> = [
  ['enter', 'open'],
  ['j/k', 'move'],
  ['n', 'new'],
  ['v', 'view'],
  ['c', 'close'],
  ['a', 'archive'],
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
 *
 * c/a (close/archive) EVALUATED AND DELIBERATELY KEPT OUT — CHARACTER MATH
 * -----------------------------------------------------------------------
 * Adding `c close` (1+1+5 = 7 chars) as a 5th entry costs that 7 plus one
 * more KEYMAP_SEPARATOR (3): 36 + 7 + 3 = 46 — 2 over the ~44 budget this
 * set already targets. `a archive` would cost even more (1+1+7 = 9, +3 =
 * 12, landing at 48) and both together would be 58 — nearly 15 over.
 * Shortening the label doesn't rescue it either (`c shut` still lands at
 * 45). So: NEITHER key is added to NARROW_KEYS, following the exact
 * discipline that already dropped `v` from this set — `c`/close is common
 * and reversible but still a destructive-ADJACENT action, and `a`/archive
 * is rare and genuinely destructive; neither is in the same "no picker
 * should ever be caught without this" tier as enter/q, and both stay fully
 * documented in the `?` help overlay (HelpOverlay.tsx) exactly like `v`
 * does today. A narrow/phone-width user can still reach both keys directly
 * (they're not gated behind ALL_KEYS in any functional sense, only hidden
 * from this hint line) — `?` is one keypress away and is itself always in
 * this set for exactly that reason.
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
