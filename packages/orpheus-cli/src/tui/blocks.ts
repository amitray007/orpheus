/**
 * tui/blocks.ts — pure, renderer-agnostic block construction + variable-
 * height windowing for the card-based workspace picker.
 *
 * Sibling of layout.ts (see that file's header): nothing here imports
 * solid-js, @opentui/*, react, or ink — plain data in, plain data out, so a
 * future no-TTY assertion script can exercise it exactly like
 * scripts/verify-tui-layout.ts exercises layout.ts. It exists because
 * layout.ts's own `scrollWindowFor` assumes every DisplayRow occupies
 * exactly ONE terminal row, which doesn't hold once workspace rows render
 * as multi-row "cards" (the tui-otui/ picker's WorkspaceCard is 3 rows;
 * project headers are 1 or 2). `buildBlocks` groups flattened rows into
 * project-header/card units carrying an explicit height, and `windowBlocks`
 * finds the slice of those units that keeps the selected card fully in
 * view — the same "keep selection in view, minimal nudge, fixed affordance
 * budget" contract as scrollWindowFor, generalized from row counts to
 * summed heights.
 *
 * Originally embedded directly in tui-otui/App.tsx (the Solid/OpenTUI
 * picker); extracted here unchanged in behavior so a future Ink port of the
 * same card UI (tui/App.tsx) can reuse it without depending on Solid.
 * `cardHeight` is a caller-supplied parameter rather than a hardcoded
 * constant so a different renderer can use a different card shape (e.g. a
 * 2-line card) without editing this module.
 */

import type { DisplayRow } from './layout.js'

type WorkspaceRow = Extract<DisplayRow, { kind: 'workspace' }>

/**
 * One renderable unit of the scrolling body, with a KNOWN terminal-row
 * height. Every workspace — including idle ones — renders as a uniform
 * `card` block; there is no separate collapsed/compact block kind for any
 * particular status. `project-header` height is 1 for the very first
 * rendered group and 2 for every subsequent one (a leading blank line
 * separates groups after the first) — `buildBlocks` computes this, callers
 * never need to.
 */
export type Block =
  | { kind: 'project-header'; projectId: string; projectName: string; height: number }
  | { kind: 'card'; row: WorkspaceRow; height: number }

/**
 * Group flattened rows (flattenTree()'s output) into Blocks, one per
 * project-header/workspace row, with an explicit `height` per block.
 *
 * EMPTY-PROJECT SUPPRESSION: flattenTree() (layout.ts) ALWAYS emits a
 * project-header row even for a project with zero (or, under view:active,
 * zero surviving) workspaces. Rendering that bare header with nothing under
 * it is a presentation bug, not a data bug — fixed HERE by buffering each
 * project's own header+body into a pending group and only committing it to
 * the output once at least one workspace row actually survives for that
 * project. An empty project contributes NOTHING to the returned list.
 */
export function buildBlocks(rows: DisplayRow[], cardHeight: number): Block[] {
  const out: Block[] = []
  let renderedGroupCount = 0

  let pendingHeader: { projectId: string; projectName: string } | null = null
  let pendingBody: Block[] = []

  const commitPendingGroup = (): void => {
    if (pendingHeader != null && pendingBody.length > 0) {
      out.push({
        kind: 'project-header',
        projectId: pendingHeader.projectId,
        projectName: pendingHeader.projectName,
        height: renderedGroupCount > 0 ? 2 : 1
      })
      renderedGroupCount++
      out.push(...pendingBody)
    }
    pendingHeader = null
    pendingBody = []
  }

  for (const row of rows) {
    if (row.kind === 'project-header') {
      commitPendingGroup()
      pendingHeader = { projectId: row.projectId, projectName: row.projectName }
      continue
    }
    pendingBody.push({ kind: 'card', row, height: cardHeight })
  }
  commitPendingGroup()
  return out
}

/** Rows spent on the "more above/below" affordances once scrolling is
 *  engaged at all — always both, mirroring layout.ts's own
 *  ScrollWindow.windowed discipline (fixed budget, never variable, so the
 *  content window's height never changes mid-scroll). */
export const AFFORDANCE_ROWS_WHEN_WINDOWED = 2

export interface BlockWindow {
  /** Slice of `blocks` that should actually be rendered this frame. */
  visible: Block[]
  /** Count of blocks scrolled off above the visible slice (0 if none). */
  aboveCount: number
  /** Count of blocks scrolled off below the visible slice (0 if none). */
  belowCount: number
  /** True once windowing is engaged at all (total block height >
   *  availableRows). Mirrors ScrollWindow.windowed's contract — see
   *  layout.ts's doc comment on that field for why callers should always
   *  mount both affordance rows once this is true, recoloring rather than
   *  conditionally mounting either direction. */
  windowed: boolean
  /**
   * The resolved window start index into `blocks` — callers own a signal/
   * state cell seeded from the PREVIOUS call's `start` (via
   * `previousStart`) and write this value back into it after each call.
   * See the "STICKY WINDOW START" note below for why this round-trip
   * exists instead of this function owning the state itself.
   */
  start: number
}

/**
 * Keep the block containing `selectedWorkspaceId` fully in view within
 * `availableRows`, reserving a FIXED `AFFORDANCE_ROWS_WHEN_WINDOWED`-row
 * budget for the whole scrolling session once windowing engages at all
 * (never a variable 0/1/2, so the content window's own height never
 * changes mid-scroll — same discipline as layout.ts's scrollWindowFor).
 *
 * STICKY WINDOW START, NOT RECOMPUTED-FROM-SCRATCH PER SELECTION — an
 * early version of this algorithm recomputed [start, end) fresh on every
 * selection change via a "walk out from the selected block" pass; that
 * recentered the window even when the newly-selected card was ALREADY
 * fully visible, producing a spurious scroll (e.g. moving from card 1 to
 * card 2 when both already fit on screen still shifted the window and
 * popped a "more above" affordance that shouldn't have appeared — caught
 * live via tui-mcp's adjacent-selection diff). Fixed by treating the window
 * start as PERSISTENT state that's only nudged the MINIMUM amount needed to
 * bring the selected block back into view when it falls outside the
 * current window — exactly scrollWindowFor's "keep in view, don't
 * recenter" contract, adapted to variable block heights.
 *
 * `previousStart` IS that persistent state, passed in by the caller (in
 * tui-otui/App.tsx: a Solid signal read at call time) rather than owned as
 * module-level mutable state, so this function stays a pure function of
 * its arguments — trivially testable, and safe to call from any reactive
 * system (Solid memo, React state, or a plain synchronous loop) without
 * this module depending on any of them. The caller is responsible for
 * writing the RETURNED `start` back into whatever it read `previousStart`
 * from before the next call — see tui-otui/App.tsx's `createEffect` for the
 * Solid-specific half of this wiring, which is NOT portable and stays
 * there.
 */
export function windowBlocks(
  blocks: Block[],
  selectedWorkspaceId: string | null,
  availableRows: number,
  previousStart: number
): BlockWindow {
  const totalHeight = blocks.reduce((sum, b) => sum + b.height, 0)
  const budget = availableRows
  if (budget <= 0 || blocks.length === 0) {
    return {
      visible: [],
      aboveCount: blocks.length,
      belowCount: 0,
      windowed: blocks.length > 0,
      start: 0
    }
  }
  if (totalHeight <= budget) {
    return { visible: blocks, aboveCount: 0, belowCount: 0, windowed: false, start: 0 }
  }

  const contentBudget = Math.max(1, budget - AFFORDANCE_ROWS_WHEN_WINDOWED)
  const selectedBlockIndex = Math.max(
    0,
    blocks.findIndex((b) => b.kind === 'card' && b.row.workspaceId === selectedWorkspaceId)
  )

  // Clamp any prior start into the current block list's bounds first (a
  // frame update / view toggle can change block count out from under a
  // stale index).
  let start = Math.min(previousStart, Math.max(0, blocks.length - 1))

  const heightFrom = (from: number, to: number): number => {
    let sum = 0
    for (let i = from; i < to; i++) sum += blocks[i]!.height
    return sum
  }
  const endForStart = (s: number): number => {
    let used = 0
    let e = s
    while (e < blocks.length && used + blocks[e]!.height <= contentBudget) {
      used += blocks[e]!.height
      e++
    }
    // Always show at least the selected block itself even if it alone
    // exceeds contentBudget (shouldn't happen with a realistic card height
    // + terminal height, but never render zero rows).
    return Math.max(e, s + 1)
  }

  // Nudge `start` forward if the selection fell BELOW the current window's
  // end, or backward if it fell ABOVE the current start — minimal
  // adjustment, never a full recenter.
  let end = endForStart(start)
  if (selectedBlockIndex < start) {
    start = selectedBlockIndex
  } else if (selectedBlockIndex >= end) {
    // Walk start forward just far enough that selectedBlockIndex is the
    // LAST block that fits — mirrors how a real scrolling list reveals one
    // more row at a time rather than jumping to center.
    while (
      start < selectedBlockIndex &&
      heightFrom(start, selectedBlockIndex + 1) > contentBudget
    ) {
      start++
    }
  }
  end = endForStart(start)
  // If start is deep enough that the tail end no longer reaches the list's
  // end but there's slack (budget not fully used) and room to pull start
  // back down without losing the selection, prefer showing more content —
  // mirrors layout.ts's clampWindowStart maxStart clamp so the window never
  // scrolls needlessly past the point where the remaining content still
  // fills the budget.
  while (
    start > 0 &&
    heightFrom(start - 1, endForStart(start - 1)) <= contentBudget &&
    endForStart(start - 1) > selectedBlockIndex
  ) {
    const candidateEnd = endForStart(start - 1)
    if (candidateEnd - 1 < selectedBlockIndex) break
    start--
    end = endForStart(start)
  }

  const aboveHeight = heightFrom(0, start)
  const belowHeight = heightFrom(end, blocks.length)
  return {
    visible: blocks.slice(start, end),
    aboveCount: aboveHeight > 0 ? Math.max(1, start) : 0,
    belowCount: belowHeight > 0 ? Math.max(1, blocks.length - end) : 0,
    windowed: true,
    start
  }
}
