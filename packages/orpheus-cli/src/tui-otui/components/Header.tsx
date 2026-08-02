/**
 * tui-otui/components/Header.tsx — title + connection/filter/count status line.
 *
 * Ported from tui/components/Header.tsx. A bottom rule is reserved for
 * medium/wide only (a border's row would eat too much of a 12-row narrow
 * terminal) — same "no borders at narrow" discipline as the Ink version.
 *
 * CONNECTION STATES: connecting / connected / disconnected (NEW — see
 * App.tsx's file header for the explicit "disconnected mid-session" state
 * this task calls out as an Ink-version bug). Header only distinguishes
 * connecting vs connected; the disconnected state fully replaces the body
 * (rendered by App.tsx, not folded into this status line) since it needs a
 * keypress acknowledgment and is a blocking, not ambient, condition.
 */

import { TextAttributes } from '@opentui/core'
import type { Breakpoint, Filter, ProjectScope } from '../../tui/layout.js'
import type { Palette } from '../theme.js'

export interface HeaderProps {
  scope?: ProjectScope
  connected: boolean
  /** True once the /subscribe connection has ended unexpectedly — see
   * App.tsx's file header. Distinct from `connected: false` (which also
   * covers the ordinary pre-first-frame "connecting…" state) so the status
   * line doesn't confusingly say "connecting…" right above a "connection
   * lost" body notice. */
  disconnected: boolean
  filter: Filter
  hiddenCount: number
  totalCount: number
  breakpoint: Breakpoint
  palette: Palette
}

export function Header(props: HeaderProps): JSX.Element {
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

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={props.palette.accent} attributes={TextAttributes.BOLD}>
          {title()}
        </text>
      </box>
      <box flexDirection="row">
        <text fg={connectionColor()}>{connectionGlyph()} </text>
        <text fg={props.palette.secondary}>{connectionLabel()}</text>
        <text fg={props.palette.secondary}> · filter: {props.filter}</text>
        {props.hiddenCount > 0 ? (
          <text fg={props.palette.secondary}> · {props.hiddenCount} hidden (f)</text>
        ) : null}
        {props.totalCount === 0 ? <text fg={props.palette.secondary}> · no workspaces</text> : null}
      </box>
      {props.breakpoint !== 'narrow' ? (
        <box
          height={1}
          borderStyle="single"
          borderColor={props.palette.border}
          border={['bottom']}
        />
      ) : null}
    </box>
  )
}
