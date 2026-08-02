/**
 * tui-otui/components/TitleBar.tsx — dense one-row title bar with
 * right-aligned status, replacing Header.tsx's two-row (title, then a
 * separate status line) shape plus a bordered-box bottom rule.
 *
 * ghui devices adopted (docs/TUI_UI_REDESIGN.md):
 *   #6 "A real title bar": `GHUI  amitray007  authored … updated Mon, 8/3
 *      3:14 am` — brand, context, and freshness on ONE row, timestamp
 *      right-aligned. Here: `Orpheus [— scope]` on the left, connection
 *      state + filter + counts right-aligned.
 *   #2 "Horizontal rules, not boxes": the divider below the bar is a Rule
 *      component (full-width `─`), not a bordered box — see Rule.tsx.
 *
 * WIDTH BUDGETING IS MANUAL, NOT `justifyContent: "space-between"` —
 * verified via tui-mcp that space-between does NOT auto-shrink text nodes:
 * two <text> children whose combined natural width exceeds the row's width
 * simply overflow (each gets clipped independently by its own
 * `overflow="hidden"`, with no coordination between them — "Orpheus"
 * itself got clipped to "Orpheu" at 44 cols in the first pass, which is
 * exactly backwards: the STATUS side should give way, never the brand).
 * Fix: `props.width` (App.tsx passes the live terminal width) drives an
 * explicit split — title gets a fixed-priority budget (never truncated
 * below the bare "Orpheus" label), status gets whatever's left and is
 * itself truncated via tui/layout.ts's shared `truncate()` helper, right
 * aligned by left-padding.
 *
 * ONE ROW ALWAYS (narrow included) — a deliberate compression from the old
 * Header.tsx's two body rows (title row + status row) into one, freeing a
 * second row of vertical budget on a 12-row narrow terminal, which is
 * exactly where every row counts most. The rule row is still reserved at
 * medium/wide only (a rule's own row would cost 8%+ of a 12-row narrow
 * screen for a purely decorative device) — same "no borders at narrow"
 * discipline the old Header.tsx used, just applied to the new Rule instead
 * of a box border.
 *
 * CONNECTION STATES: unchanged contract from the old Header.tsx — see that
 * file's original doc comment (now superseded) for why `disconnected` is a
 * distinct boolean from `connected: false`.
 */

import { TextAttributes } from '@opentui/core'
import { truncate, type Breakpoint, type Filter, type ProjectScope } from '../../tui/layout.js'
import type { Palette } from '../theme.js'
import { Rule } from './Rule.js'

export interface TitleBarProps {
  scope?: ProjectScope
  connected: boolean
  disconnected: boolean
  filter: Filter
  hiddenCount: number
  totalCount: number
  breakpoint: Breakpoint
  palette: Palette
  /** Live terminal width — drives the manual title/status split (see the
   * file header's "WIDTH BUDGETING IS MANUAL" note). */
  width: number
}

export function TitleBar(props: TitleBarProps): JSX.Element {
  const title = (): string => (props.scope != null ? `Orpheus — ${props.scope.name}` : 'Orpheus')
  const connectionGlyph = (): string => (props.connected ? '●' : '○')
  const connectionColor = (): string =>
    props.connected
      ? props.palette.working
      : props.disconnected
        ? props.palette.attention
        : props.palette.idle
  const connectionLabel = (): string =>
    props.connected ? 'connected' : props.disconnected ? 'disconnected' : 'connecting…'

  const statusText = (): string => {
    const parts = [connectionLabel(), `filter: ${props.filter}`]
    if (props.hiddenCount > 0) parts.push(`${props.hiddenCount} hidden (f)`)
    if (props.totalCount === 0) parts.push('no workspaces')
    return parts.join(' · ')
  }

  // Title never shrinks below its own text — the brand is the one thing
  // that must always be legible. Status gets whatever's left after the
  // title + a one-space gap + the connection glyph's own 2-col budget,
  // floored at 0 (an absurdly narrow terminal just shows the title alone).
  const titleText = (): string => title()
  const statusBudget = (): number => Math.max(0, props.width - titleText().length - 1 - 2)
  const clippedStatus = (): string => truncate(statusText(), statusBudget())

  return (
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row" height={1} width={props.width}>
        <text
          fg={props.palette.accent}
          attributes={TextAttributes.BOLD}
          wrapMode="none"
          overflow="hidden"
        >
          {titleText()}
        </text>
        <box flexGrow={1} minWidth={0} justifyContent="flex-end" flexDirection="row">
          <text wrapMode="none" overflow="hidden">
            <span fg={connectionColor()}>{connectionGlyph()} </span>
            <span fg={props.palette.secondary}>{clippedStatus()}</span>
          </text>
        </box>
      </box>
      {props.breakpoint !== 'narrow' ? <Rule palette={props.palette} /> : null}
    </box>
  )
}
