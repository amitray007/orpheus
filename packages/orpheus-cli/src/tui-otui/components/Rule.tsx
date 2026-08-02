/**
 * tui-otui/components/Rule.tsx — a full-width horizontal `─` divider.
 *
 * ghui device #2 (docs/TUI_UI_REDESIGN.md): "Horizontal rules as section
 * dividers, not boxes. Full-width `─` runs separate regions. No nested
 * bordered panels eating 2 cols + 2 rows each for no informational gain."
 *
 * Replaces Header.tsx's old `<box border={['bottom']}>` device (a bordered
 * box just to get one rule line, which is a heavier construct than needed)
 * and HelpOverlay's box-border framing is intentionally left alone — see
 * that file's own header for why the overlay keeps its border (transient,
 * not permanent chrome).
 *
 * WIDTH: `width="100%"` relies on the parent having an explicit size
 * (App.tsx's root box always does — see its own file header on the root
 * layout contract), matching the "Percentage Dimensions Need Parent Size"
 * gotcha from the OpenTUI containers reference.
 */

import { RULE_CHAR } from '../theme.js'
import type { Palette } from '../theme.js'

export interface RuleProps {
  palette: Palette
  /** Rules are flexShrink={0} by default (fixed one row) — callers inside a
   * flexGrow body never want a rule to compete for growth space. */
  color?: string
}

export function Rule(props: RuleProps): JSX.Element {
  return (
    <box height={1} flexShrink={0} width="100%" overflow="hidden">
      <text fg={props.color ?? props.palette.border} wrapMode="none" overflow="hidden">
        {RULE_CHAR.repeat(500)}
      </text>
    </box>
  )
}
