/**
 * tui-otui/components/HelpOverlay.tsx — full keymap reference, shown on `?`.
 *
 * ONLY LISTS IMPLEMENTED KEYS — n/x/a/r are omitted entirely (not listed as
 * "not yet wired" the way tui/components/HelpOverlay.tsx does), per the task
 * brief: those require server actions beyond workspace.host/unhost that
 * aren't wired in this build, and the brief is explicit that unimplemented
 * keys should not appear in footer/help at all.
 *
 * The one border used regardless of breakpoint — transient overlay
 * replacing the body, not permanent chrome competing for the narrow
 * layout's scarce rows (matches the Ink version's rationale).
 */

import { TextAttributes } from '@opentui/core'
import { For } from 'solid-js'
import type { Breakpoint } from '../../tui/layout.js'
import type { Palette } from '../theme.js'

const ROWS: Array<[string, string]> = [
  ['↵', 'open the highlighted workspace (hosts it in tmux, attaches)'],
  ['↑/↓, j/k', 'move the highlighted row'],
  ['f', 'cycle filter: active -> all'],
  ['?', 'toggle this help'],
  ['q', 'quit']
]

const KEY_COL_WIDTH = 11

export interface HelpOverlayProps {
  breakpoint: Breakpoint
  palette: Palette
}

export function HelpOverlay(props: HelpOverlayProps): JSX.Element {
  const paddingX = (): number => (props.breakpoint === 'narrow' ? 0 : 1)
  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={props.palette.border}
      paddingLeft={paddingX()}
      paddingRight={paddingX()}
    >
      <text fg={props.palette.accent} attributes={TextAttributes.BOLD}>
        Keys
      </text>
      <For each={ROWS}>
        {([key, desc]) => (
          <text wrapMode="none">
            <span fg={props.palette.accent} attributes={TextAttributes.BOLD}>
              {key.padEnd(KEY_COL_WIDTH)}
            </span>
            <span fg={props.palette.secondary}>{desc}</span>
          </text>
        )}
      </For>
      <text fg={props.palette.secondary}>press any key to close</text>
    </box>
  )
}
