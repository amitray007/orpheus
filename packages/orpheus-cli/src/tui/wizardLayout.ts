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

/** Literal characters `buildClosePromptLine` wraps the (possibly-truncated)
 *  workspace name in: `close "` (7) + `"?` (2) = 9. Named/exported so the
 *  harness can assert the exact budget rather than re-deriving 9 by hand. */
export const CLOSE_PROMPT_LITERAL_COLUMNS = 9

/**
 * Build the close-confirm overlay's one-line prompt (`close "name"?`),
 * reserving `CLOSE_PROMPT_LITERAL_COLUMNS` for the surrounding literal text
 * and truncating the workspace name into whatever's left — same
 * "budget the literal text, truncate the variable part" discipline as
 * `buildSummaryLine` above, used by tui/components/CloseArchiveConfirm.tsx.
 * Floors the name budget at 1 so a pathologically narrow terminal never
 * calls `truncate` with a non-positive width.
 */
export function buildClosePromptLine(workspaceName: string, contentWidth: number): string {
  const nameWidth = Math.max(1, contentWidth - CLOSE_PROMPT_LITERAL_COLUMNS)
  return `close "${truncate(workspaceName, nameWidth)}"?`
}

// ---------------------------------------------------------------------------
// Flat-row windowing — Step 1's accordion list has no fixed row count once a
// provider expands (see wizardStepMachine.ts's `buildModelAccordionRows`):
// with live data at time of writing, 4 providers collapsed is 4 rows, but
// expanding the biggest one (13 models) makes it 3 collapsed providers + 1
// header + 13 models = 17 rows, plus this screen's own title/hint lines —
// comfortably more than a phone viewport with the on-screen keyboard up
// (~12 rows). ListStep.tsx renders `rows.map(...)` with NO windowing of its
// own, which was safe for the old two-screen split (a drilled-in model list
// was at most 13 rows and NOTHING else) but would silently push the
// highlighted row and the hint line off-screen for the accordion. This
// function is the fix: it keeps the highlighted row inside the returned
// window, exactly the way layout.ts's own `scrollWindowFor` does for the
// picker's flattened tree rows.
//
// WHY THIS ISN'T blocks.ts's `windowBlocks` REUSED
// -----------------------------------------------------------------------
// blocks.ts's windowing is built for VARIABLE-height blocks (a 1-row project
// header next to a 3-row WorkspaceCard) and carries a STICKY window-start
// (the caller round-trips `previousStart`/`start` through its own state so
// the window doesn't recenter on every selection change within an
// already-visible range — see that file's "STICKY WINDOW START" note).
// Every accordion row here is uniform height (1), so the variable-height
// bookkeeping (a `height` field per block, `heightFrom`/`endForStart`
// summation) buys nothing — layout.ts's `scrollWindowFor` is the closer
// analog (also uniform-height rows) but is typed directly to
// `DisplayRow[]`, the picker's own row shape, and pulls in that module's
// import surface for no reason a plain array can't serve. This is that
// same "keep selection in view, minimal nudge, fixed affordance budget"
// algorithm, generalized to `T[]` and re-typed against a plain length +
// selected index the way blocks.ts documents its own scope split from
// layout.ts. Also, unlike windowBlocks, this is STATELESS (recomputed fresh
// from `highlightedIndex` on every call, no sticky start) — the accordion
// only re-renders on an explicit cursor move or expand/collapse, never on
// an unrelated re-render, so there's no risk of the spurious-recenter bug
// windowBlocks' sticky start exists to avoid; a plain recompute is simpler
// and there's nothing here for a sticky start to protect against.
// ---------------------------------------------------------------------------

export interface RowWindow<T> {
  /** Slice of `rows` that should actually be rendered this frame. */
  visible: T[]
  /** Index into `visible` (not into the original `rows`) of the highlighted
   *  row — callers use this instead of re-deriving it, since the window's
   *  own start offset shifts the original index. */
  visibleHighlightedIndex: number
  /** Count of rows scrolled off above the visible slice (0 if none). */
  aboveCount: number
  /** Count of rows scrolled off below the visible slice (0 if none). */
  belowCount: number
  /** True once windowing is engaged at all (rows.length > availableRows).
   *  Mirrors layout.ts's ScrollWindow.windowed contract. */
  windowed: boolean
}

/** Rows spent on "more above/below" affordances once scrolling engages at
 *  all — mirrors layout.ts's/blocks.ts's own AFFORDANCE_ROWS_WHEN_WINDOWED,
 *  redeclared here (rather than imported) because this module intentionally
 *  stays decoupled from layout.ts's DisplayRow-specific windowing (see this
 *  section's header) and re-declaring one small constant is cheaper than
 *  pulling in that coupling for it alone. */
const ACCORDION_AFFORDANCE_ROWS = 2

/** Scroll-off margin: how many rows of context to keep around the highlight
 *  when it's not near either edge of the full list — mirrors layout.ts's own
 *  SCROLL_OFF. */
const ACCORDION_SCROLL_OFF = 1

function clampWindowStart(highlightedIndex: number, totalRows: number, capacity: number): number {
  const maxStart = Math.max(0, totalRows - capacity)
  const desired = highlightedIndex - Math.min(ACCORDION_SCROLL_OFF, Math.floor((capacity - 1) / 2))
  return Math.min(maxStart, Math.max(0, desired))
}

/**
 * Keep `highlightedIndex` within a window of `availableRows` lines out of
 * `rows`, reserving a fixed affordance budget once windowing engages at all
 * so the content window's own height never changes mid-scroll (same
 * discipline as layout.ts's `scrollWindowFor`; see this section's header for
 * why that function itself isn't reused directly).
 */
export function windowListRows<T>(
  rows: T[],
  highlightedIndex: number,
  availableRows: number
): RowWindow<T> {
  if (availableRows <= 0 || rows.length === 0) {
    return {
      visible: [],
      visibleHighlightedIndex: -1,
      aboveCount: rows.length,
      belowCount: 0,
      windowed: rows.length > 0
    }
  }
  if (rows.length <= availableRows) {
    return {
      visible: rows,
      visibleHighlightedIndex: highlightedIndex,
      aboveCount: 0,
      belowCount: 0,
      windowed: false
    }
  }

  const capacity = Math.max(1, availableRows - ACCORDION_AFFORDANCE_ROWS)
  const start = clampWindowStart(highlightedIndex, rows.length, capacity)
  const end = Math.min(rows.length, start + capacity)

  return {
    visible: rows.slice(start, end),
    visibleHighlightedIndex: highlightedIndex - start,
    aboveCount: start,
    belowCount: rows.length - end,
    windowed: true
  }
}
