/**
 * tui-otui/components/TitleBar.tsx — dense one-row title bar with
 * right-aligned status, replacing Header.tsx's two-row (title, then a
 * separate status line) shape plus a bordered-box bottom rule.
 *
 * RENAME: filter -> view (card redesign) — the underlying VALUE domain
 * ('active' | 'all', still literally `Filter` from tui/layout.ts — that
 * type is shared with the Ink build and out of scope to rename there) is
 * unchanged; only the user/dev-facing NAME changed. Header text now reads
 * `view: active` / `view: all`, and the hidden-count hint reads
 * `N hidden (v)` (was `(f)`).
 *
 * NO CONNECTION GLYPH — was `●`/`○` (U+25CF/U+25CB), both confirmed
 * East_Asian_Width=Ambiguous per Unicode's EastAsianWidth.txt (see
 * theme.ts's file header). Rather than hunt for a replacement glyph, the
 * connection state is carried by its TEXT LABEL alone
 * ("connected"/"disconnected"/"connecting…") plus its color — satisfying
 * docs/TUI_OPENTUI_DESIGN.md's non-negotiable #3 (state never carried by
 * colour alone) via the word itself, the same pattern the card design uses
 * for status words (see WorkspaceCard.tsx).
 *
 * NO RULE BELOW THE BAR (card redesign amendment) — the prior build
 * reserved a second row for a `Rule` component (a full-width `─`/`-` line)
 * at medium/wide breakpoints. Owner call: with the title bar already dense
 * (title + connection/view/count on one row), a repeated-dash line read as
 * visual noise/a "dotted seam" once rendered — dropped in favor of a blank
 * line so the header still occupies 2 rows at medium/wide (preserving
 * App.tsx's headerReserved calculation) without drawing anything on the
 * second one. narrow still reserves only 1 row (no blank line) — matching
 * the prior build's "no rule at narrow" discipline, just extended to "no
 * blank line either" since there's nothing to separate at that tier's
 * scarce row budget.
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
 * CONNECTION STATES: unchanged contract from the old Header.tsx — see that
 * file's original doc comment (now superseded) for why `disconnected` is a
 * distinct boolean from `connected: false`.
 */

import { TextAttributes } from '@opentui/core'
import {
  truncate,
  type Breakpoint,
  type Filter as View,
  type ProjectScope
} from '../../tui/layout.js'
import type { Palette } from '../theme.js'

export interface TitleBarProps {
  scope?: ProjectScope
  connected: boolean
  disconnected: boolean
  /** Local name is `view` (see file header's RENAME note) — the TYPE is
   *  still literally `Filter` from tui/layout.ts (out of scope to rename
   *  there), imported here under the local alias `View` so every reference
   *  in tui-otui/ reads "view" consistently instead of mixing `Filter`
   *  (type) with `view` (value). */
  view: View
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
  const connectionColor = (): string =>
    props.connected
      ? props.palette.working
      : props.disconnected
        ? props.palette.attention
        : props.palette.idle
  const connectionLabel = (): string =>
    props.connected ? 'connected' : props.disconnected ? 'disconnected' : 'connecting…'

  const statusText = (): string => {
    const parts = [connectionLabel(), `view: ${props.view}`]
    if (props.hiddenCount > 0) parts.push(`${props.hiddenCount} hidden (v)`)
    if (props.totalCount === 0) parts.push('no workspaces')
    return parts.join(' - ')
  }

  // Title never shrinks below its own text — the brand is the one thing
  // that must always be legible. Status gets whatever's left after the
  // title + a one-space gap.
  const titleText = (): string => title()
  const statusBudget = (): number => Math.max(0, props.width - titleText().length - 1)
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
          <text fg={connectionColor()} wrapMode="none" overflow="hidden">
            {clippedStatus()}
          </text>
        </box>
      </box>
      {props.breakpoint !== 'narrow' ? <box height={1} flexShrink={0} /> : null}
    </box>
  )
}
