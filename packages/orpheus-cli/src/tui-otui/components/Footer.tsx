/**
 * tui-otui/components/Footer.tsx — keymap hint line, or a transient notice
 * in its place.
 *
 * KEYMAP IS INTENTIONALLY SMALLER THAN THE INK VERSION'S: only enter/v/?/q
 * plus j/k nav are implemented in this build (n/x/a/r require server
 * actions beyond workspace.host/workspace.unhost — out of scope per the
 * task brief). The footer and HelpOverlay list ONLY these keys — no
 * "not yet wired" placeholders for keys that don't exist in this keymap at
 * all, unlike tui/components/Footer.tsx's ALL_KEYS which still lists them.
 *
 * RENAME: `f` (filter) -> `v` (view) — card redesign, see TitleBar.tsx's
 * file header for the full rationale. NO ARROW GLYPHS: the prior build's
 * `↵`/`↑`/`↓` (U+21B5/U+2191/U+2193) are dropped — `↑`/`↓` are explicitly in
 * the task brief's CONFIRMED AMBIGUOUS list, and rather than spend time
 * verifying `↵` individually this uses the plain-ASCII word `enter` as the
 * KEY label (distinct from the `open` ACTION label it maps to, so the pair
 * doesn't read as a duplicated word) and `j/k` alone for move — avoiding
 * every arrow/return glyph entirely.
 */

import { TextAttributes } from '@opentui/core'
import { For } from 'solid-js'
import type { Breakpoint } from '../../tui/layout.js'
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

export function Footer(props: FooterProps): JSX.Element {
  const keys = (): Array<[string, string]> =>
    props.breakpoint === 'narrow' ? NARROW_KEYS : ALL_KEYS
  return props.notice != null ? (
    <text fg={props.palette.attention} wrapMode="none" overflow="hidden">
      {props.notice}
    </text>
  ) : (
    <text wrapMode="none" overflow="hidden">
      <For each={keys()}>
        {([key, label], i) => (
          <>
            {i() > 0 ? <span fg={props.palette.secondary}>{KEYMAP_SEPARATOR}</span> : null}
            <span fg={props.palette.accent} attributes={TextAttributes.BOLD}>
              {key}
            </span>
            <span fg={props.palette.secondary}> {label}</span>
          </>
        )}
      </For>
    </text>
  )
}
