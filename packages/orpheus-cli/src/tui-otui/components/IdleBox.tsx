/**
 * tui-otui/components/IdleBox.tsx — the idle-collapse box (view: all only).
 *
 * When `view === 'all'`, idle workspaces do NOT render as full 3-line
 * cards — ALL idle workspaces in a project collapse into ONE small box at
 * the end of that project's card group. Under `view: active` (default),
 * idle workspaces don't appear at all (existing isActiveStatus/filter
 * behavior in tui/layout.ts already does this).
 *
 * GLYPH SAFETY — VERIFIED ASCII BOX, NOT THE ROUNDED UNICODE SET
 * -----------------------------------------------------------------------
 * Per the task brief, box-drawing characters in the U+25xx/U+23xx ranges
 * are frequently East_Asian_Width=Ambiguous and the rounded Unicode box set
 * (╭╮╰╯) is explicitly NOT assumed safe without justification. This box
 * uses only plain ASCII punctuation, independently verified against
 * EastAsianWidth.txt for this pass (see theme.ts's IDLE_BOX_* constants for
 * each character's confirmed category) — `,` `-` `.` `` ` `` `'` `|`, all
 * Na. Each row inside the box: title (truncated) left, age right-aligned,
 * within the box's inner width.
 *
 * RIGHT-EDGE WIDTH BUG (found + fixed during live tui-mcp verification)
 * -----------------------------------------------------------------------
 * The first version encoded the top/bottom-left corners as 2-character
 * strings (`,-`/`` `- ``) but computed `innerWidth` as if the border were
 * 1 character per side — silently overflowing the box's total width by 1
 * column every render, which `overflow="hidden"` then clipped from the
 * RIGHT edge (the closing `.`/`'` corner), leaving the top/bottom rules
 * dangling in a bare `-` with no visible close. Fixed by making every
 * corner glyph exactly 1 character (theme.ts) and computing the box's
 * total width, inner width, and every row's content ONCE from a single
 * shared `outerWidth`/`innerWidth` pair below — the top rule, bottom rule,
 * and every content row all derive from the SAME two numbers, so they
 * cannot drift out of sync again. Verified via tui-mcp: top/bottom rows now
 * close with `.`/`'` at the exact same column the vertical bars sit on in
 * every content row.
 */

import { For } from 'solid-js'
import {
  IDLE_BOX_BOTTOM_LEFT,
  IDLE_BOX_BOTTOM_RIGHT,
  IDLE_BOX_HRULE,
  IDLE_BOX_TOP_LEFT,
  IDLE_BOX_TOP_RIGHT,
  IDLE_BOX_VRULE
} from '../theme.js'
import type { Palette } from '../theme.js'
import { displayTitleFor, truncate, type DisplayRow } from '../../tui/layout.js'
import { formatAge } from '../format.js'

export interface IdleBoxProps {
  rows: Array<Extract<DisplayRow, { kind: 'workspace' }>>
  /** Full width available (matches the card width at this breakpoint). */
  width: number
  palette: Palette
}

const LABEL = ' idle '

export function IdleBox(props: IdleBoxProps): JSX.Element {
  // Outer box occupies the same `width` a card would (minus the 1-col
  // gutter, matching WorkspaceCard's own convention so idle rows align
  // with the workspace cards above them). `outerWidth` is the box's total
  // rendered width INCLUDING its 1-char left+right border columns;
  // `innerWidth` is what's left for content between them. Every line below
  // is built from these same two numbers — see file header's bug note.
  const outerWidth = (): number => Math.max(3, props.width - 1)
  const innerWidth = (): number => Math.max(1, outerWidth() - 2)

  const topLine = (): string => {
    const dashes = Math.max(0, innerWidth() - LABEL.length)
    const middle = (LABEL + IDLE_BOX_HRULE.repeat(dashes)).slice(0, innerWidth())
    return (' ' + IDLE_BOX_TOP_LEFT + middle + IDLE_BOX_TOP_RIGHT).padEnd(props.width)
  }
  const bottomLine = (): string =>
    (
      ' ' +
      IDLE_BOX_BOTTOM_LEFT +
      IDLE_BOX_HRULE.repeat(innerWidth()) +
      IDLE_BOX_BOTTOM_RIGHT
    ).padEnd(props.width)

  function rowLine(row: Extract<DisplayRow, { kind: 'workspace' }>): string {
    const age = formatAge(row.lastActivityAt)
    const titleBudget = Math.max(1, innerWidth() - age.length - 1)
    const title = truncate(displayTitleFor(row), titleBudget).padEnd(titleBudget)
    const inner = `${title} ${age}`.padEnd(innerWidth())
    return (' ' + IDLE_BOX_VRULE + inner + IDLE_BOX_VRULE).padEnd(props.width)
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      <text
        fg={props.palette.secondary}
        wrapMode="none"
        overflow="hidden"
        height={1}
        flexShrink={0}
      >
        {topLine()}
      </text>
      <For each={props.rows}>
        {(row) => (
          <text
            fg={props.palette.secondary}
            wrapMode="none"
            overflow="hidden"
            height={1}
            flexShrink={0}
          >
            {rowLine(row)}
          </text>
        )}
      </For>
      <text
        fg={props.palette.secondary}
        wrapMode="none"
        overflow="hidden"
        height={1}
        flexShrink={0}
      >
        {bottomLine()}
      </text>
    </box>
  )
}
