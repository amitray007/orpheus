/**
 * tui-otui/components/Rule.tsx — a full-width horizontal `-` divider.
 *
 * GLYPH: was `─` (U+2500 BOX DRAWINGS LIGHT HORIZONTAL), confirmed
 * East_Asian_Width=Ambiguous per Unicode's EastAsianWidth.txt (see theme.ts's
 * file header). Now `-` (U+002D HYPHEN-MINUS, confirmed Narrow) via
 * theme.ts's RULE_CHAR.
 *
 * NO LONGER USED BY TitleBar.tsx (card redesign) — the title bar's own
 * divider was dropped entirely in favor of a blank line (owner call: a
 * `-`-repeated line across 44+ columns read as visual noise/a "dotted seam"
 * once rendered, given the header already carries structure via
 * `title` + `view: active  N` on one row). This component is KEPT ALIVE for
 * other callers (e.g. HelpOverlay's internal layout, if it grows one) —
 * only its glyph changed and its TitleBar call site was removed.
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
