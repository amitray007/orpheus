/**
 * tui/wizardLayout.ts — pure width-computation helpers for the new-workspace
 * wizard (NewWorkspaceWizard.tsx and its step components under
 * components/wizard/).
 *
 * WHY THIS IS ITS OWN FILE, NOT INLINE IN A COMPONENT
 * -----------------------------------------------------------------------
 * Mirrors layout.ts's own rationale (see that file's header): nothing here
 * imports react/ink, so scripts/verify-tui-wizard.ts can exercise the exact
 * column math a phone-portrait Termius session (~38 columns) will hit
 * without mounting a component or opening a socket. The wizard is the
 * highest-risk surface for an overflow bug in this codebase's whole TUI
 * because it's the ONE piece of UI whose entire reason to exist is working
 * at 38 columns — every other screen degrades gracefully from a wider
 * design, this one's home turf IS the narrow tier.
 *
 * WHAT LIVES HERE VS. WHAT DOESN'T
 * -----------------------------------------------------------------------
 * Only the row-truncation/padding math that the wizard's list rows
 * (provider list, model list, mode list) and confirm-summary lines need.
 * These follow the exact "pad THEN color" discipline WorkspaceCard.tsx's
 * header documents: every function here returns an already-padded string of
 * EXACTLY the requested width, so a caller can safely wrap the result in a
 * <Text backgroundColor=...> without the Ink background-doesn't-reserve-
 * columns trap biting a second time in this file.
 */

import { truncate } from './layout.js'

/** Reserved for the wizard's own selection gutter (rail + spacer), matching
 *  WorkspaceCard's CARD_GUTTER_WIDTH + CARD_PAD_GUTTER exactly — the wizard
 *  reuses that same gutter constant/rendering approach (see
 *  components/wizard/ListStep.tsx), this constant is only the WIDTH the
 *  layout math needs to budget for, not a new rendering primitive. */
export const WIZARD_GUTTER_COLUMNS = 2
/** Mirrors CARD_PAD_RIGHT — one blank trailing column inside a selected
 *  row's tint, so highlighted text never ends flush at the frame edge. */
export const WIZARD_PAD_RIGHT = 1

/**
 * Full row width available for a selectable list row's TEXT content (after
 * the gutter and trailing pad are carved out), given the terminal's content
 * width. Floors at 1 so a pathologically narrow terminal never produces a
 * negative budget that would throw inside `truncate`/`padEnd`.
 */
export function listRowInnerWidth(contentWidth: number): number {
  return Math.max(1, contentWidth - WIZARD_GUTTER_COLUMNS - WIZARD_PAD_RIGHT)
}

/**
 * Build a single selectable-list row's text, truncated and padded to EXACTLY
 * `innerWidth` columns. `suffix` (e.g. " (unavailable)") is appended when it
 * fits alongside at least one character of `label`; dropped entirely rather
 * than squeezed in truncated form when the row is too narrow for both — a
 * half-rendered "(unavail" reads worse than no marker at all, and colour
 * already carries the same signal (see ListStep.tsx).
 */
export function buildListRowText(label: string, innerWidth: number, suffix = ''): string {
  if (suffix.length === 0) return truncate(label, innerWidth).padEnd(innerWidth)
  // Only append the suffix if there's room for it AND at least one column of
  // the label itself — otherwise the row would be ALL suffix, which reads as
  // a garbled row rather than a labeled one.
  const minLabelColumns = 1
  if (innerWidth < suffix.length + minLabelColumns) {
    return truncate(label, innerWidth).padEnd(innerWidth)
  }
  const labelBudget = innerWidth - suffix.length
  const labelText = truncate(label, labelBudget).padEnd(labelBudget)
  return (labelText + suffix).padEnd(innerWidth)
}

/**
 * The confirm screen's summary is a fixed set of "label: value" lines. Each
 * is truncated (never wrapped — Ink wrapping a summary line would silently
 * grow the screen's row count in a way the wizard's fixed-height frame
 * doesn't budget for) to the given content width and left as-is otherwise
 * (no padding needed here — the confirm screen doesn't apply a background
 * tint to these lines, so the WorkspaceCard-style "pad before colour"
 * requirement doesn't apply; see ConfirmStep.tsx).
 */
export function buildSummaryLine(label: string, value: string, contentWidth: number): string {
  const raw = `${label}: ${value}`
  return truncate(raw, Math.max(1, contentWidth))
}
