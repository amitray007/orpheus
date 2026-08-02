/**
 * tui-otui/breakpoints.ts — tui-otui-LOCAL breakpoint resolution.
 *
 * WHY THIS IS A SEPARATE FUNCTION FROM tui/layout.ts's resolveBreakpoint,
 * NOT A CHANGED ONE
 * -----------------------------------------------------------------------
 * tui/layout.ts's resolveBreakpoint (narrow <52, medium 52-103, wide >=104)
 * is shared with the Ink build (tui/App.tsx) and is locked in by
 * scripts/verify-tui-layout.ts's exact-boundary assertions (51/52, 103/104)
 * — changing those thresholds would break that harness AND reshape the Ink
 * picker, which is explicitly out of scope for this redesign (see the task
 * brief: "tui/ is explicitly out of scope... prefer additive changes").
 *
 * The redesign brief calls for roughly 60/120 as the three-tier thresholds
 * ("Breakpoints don't have to be exactly 60/120 if OpenTUI/Yoga flex math
 * makes a slightly different threshold cleaner — use judgement, but keep the
 * three-tier intent"). This module is that judgement call, kept entirely
 * local to tui-otui/ so it can diverge from the Ink thresholds without
 * touching shared code. `Breakpoint` itself (the type) IS still imported
 * from tui/layout.ts — only the WIDTH THRESHOLDS that map a column count to
 * one of its three values are redefined here.
 *
 * THRESHOLD RATIONALE
 * -----------------------------------------------------------------------
 * - narrow < 60: below this, a TextTable with 4 real columns (status, name,
 *   branch, age) has no room to be legible — single-column stacked rows
 *   (today's WorkspaceRow-style layout) stay the better fit through the
 *   44-col reference width.
 * - medium 60-119: single-column body, but the list becomes a real
 *   TextTable — verified via tui-mcp that 4 columns with sane minimum
 *   widths (status~4, name~flexible, branch~16, age~6) fit comfortably at
 *   60 cols without every column collapsing to unreadable widths.
 * - wide >= 120: master/detail. 120 was chosen (matching the brief's own
 *   suggestion) because a ~70-col list pane + ~48-col detail pane + a 1-col
 *   vertical rule is the narrowest split where the detail pane can show a
 *   full workspace name + branch + session id without truncation for
 *   typical values — verified via tui-mcp at exactly 120x30.
 */

import type { Breakpoint } from '../tui/layout.js'

export const OTUI_NARROW_MAX = 59
export const OTUI_MEDIUM_MAX = 119

export function resolveOtuiBreakpoint(columns: number): Breakpoint {
  if (columns <= OTUI_NARROW_MAX) return 'narrow'
  if (columns <= OTUI_MEDIUM_MAX) return 'medium'
  return 'wide'
}
