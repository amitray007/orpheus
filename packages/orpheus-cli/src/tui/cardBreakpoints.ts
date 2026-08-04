/**
 * tui/cardBreakpoints.ts — card-UI-LOCAL breakpoint resolution.
 *
 * WHY THIS IS A SEPARATE FUNCTION FROM layout.ts's resolveBreakpoint,
 * NOT A CHANGED ONE
 * -----------------------------------------------------------------------
 * layout.ts's resolveBreakpoint (narrow <52, medium 52-103, wide >=104) is
 * locked in by scripts/verify-tui-layout.ts's exact-boundary assertions
 * (51/52, 103/104) and still backs the old ColumnPlan/WorkspaceRow-shaped
 * code that stays in layout.ts for that harness's sake — changing those
 * thresholds would break that harness. The card UI (App.tsx and its
 * components) needs different thresholds, ported unchanged from the
 * OpenTUI reference build (tui-otui/breakpoints.ts, since deleted along
 * with the rest of that tree — see its own doc comment history for the
 * narrow/medium/wide rationale): narrow <=59 (a stacked single-column body
 * has no room for a 4-column table or the full keymap), medium 60-119
 * (single-column card body, full keymap), wide >=120 (master/detail split
 * — see App.tsx's own WIDE_MIN_COLUMNS, kept in sync with CARD_MEDIUM_MAX
 * below).
 *
 * BUG THIS FIXES: App.tsx previously called layout.ts's resolveBreakpoint
 * directly for its OWN `breakpoint` prop (which Footer/HelpOverlay/TitleBar
 * use to decide narrow-vs-full keymap/copy), while separately hardcoding
 * `WIDE_MIN_COLUMNS = 120` just for the master/detail split. That left a
 * 52-59 column gap where resolveBreakpoint already reports 'medium' (its
 * own narrow ceiling is 51) but the card design's own narrow tier — which
 * targets phone-landscape widths — hasn't ended yet: Footer rendered its
 * full 5-key line instead of the narrow 4-key subset, a real overflow risk
 * at exactly the width band this whole redesign targets. Card-based
 * components must always resolve their breakpoint through
 * resolveCardBreakpoint(), never layout.ts's resolveBreakpoint.
 */

import type { Breakpoint } from './layout.js'

export const CARD_NARROW_MAX = 59
export const CARD_MEDIUM_MAX = 119

export function resolveCardBreakpoint(columns: number): Breakpoint {
  if (columns <= CARD_NARROW_MAX) return 'narrow'
  if (columns <= CARD_MEDIUM_MAX) return 'medium'
  return 'wide'
}
