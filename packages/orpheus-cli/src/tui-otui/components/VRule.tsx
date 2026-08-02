/**
 * tui-otui/components/VRule.tsx — the single vertical `│` divider between
 * the wide-tier master (WorkspaceTable) and detail (DetailPane) panes.
 *
 * THE ONLY VERTICAL RULE IN THE WHOLE LAYOUT, AND IT ONLY EXISTS AT WIDE
 * (ghui device #2, docs/TUI_UI_REDESIGN.md: "the only vertical rule is the
 * master/detail split, and it disappears at narrow"). App.tsx only mounts
 * this at breakpoint()==='wide'.
 *
 * A vertical rule is a COLUMN of the glyph, one per available row — NOT one
 * row of repeated glyphs (that would be a horizontal rule rotated in name
 * only). Built as `height` individual <text> rows inside a 1-col-wide
 * flexGrow box so it stretches to match whatever height its sibling panes
 * occupy, without needing an explicit row count passed down from App.tsx.
 */

import { For } from 'solid-js'
import { VRULE_CHAR } from '../theme.js'
import type { Palette } from '../theme.js'

export interface VRuleProps {
  palette: Palette
  /** Number of rows to fill — App.tsx knows this from its own available-rows
   * computation; passing it explicitly avoids needing this component to
   * read terminal dimensions itself. */
  rows: number
}

export function VRule(props: VRuleProps): JSX.Element {
  return (
    <box width={1} flexShrink={0} flexDirection="column">
      <For each={Array.from({ length: Math.max(0, props.rows) })}>
        {() => (
          <text fg={props.palette.border} wrapMode="none">
            {VRULE_CHAR}
          </text>
        )}
      </For>
    </box>
  )
}
