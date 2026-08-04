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
 * height. `project-header` is `HEADER_NAME_ROWS` (name+rule line) +
 * `HEADER_BLANK_BELOW_ROWS` (the breather row under the name, owned by the
 * header block — see `buildBlocks`'s doc comment) + `HEADER_BLANK_ABOVE_ROWS`
 * when `blankAbove` is true (every project after the first in the list —
 * see `buildBlocks`'s "BLANK ABOVE" section). `card` blocks are `cardHeight`
 * rows for every card EXCEPT the first one in a group, which is
 * `cardHeight - firstCardHeightDelta` — that card has no leading separator
 * to draw (it sits directly under the header, which has nothing above it to
 * separate from), so its block simply doesn't reserve the row instead of
 * reserving-then-blanking it. `buildBlocks` computes all of this, callers
 * never need to.
 */
export type Block =
  | {
      kind: 'project-header'
      projectId: string
      projectName: string
      visibleCount: number
      /** True for every project header EXCEPT the very first one rendered
       *  in the whole list — see `buildBlocks`'s "BLANK ABOVE" section for
       *  why the first is suppressed. Threaded straight into `height` (the
       *  windowing arithmetic) AND read back by App.tsx to decide whether
       *  ProjectGroupHeader renders its leading blank row, so the two can
       *  never desync (mirrors how `separatorRows` is derived from a card
       *  block's own `height` rather than recomputed — see App.tsx). */
      blankAbove: boolean
      /** True when this project committed zero card blocks — either it has
       *  no workspaces at all, or the active-view filter hid every one it
       *  has. Read by ProjectGroupHeader.tsx to swap its (normally blank)
       *  breather row for a quiet "no workspaces" placeholder line, so an
       *  empty group reads as deliberate content rather than a rendering
       *  glitch — and by App.tsx to decide whether this header itself is a
       *  valid selection target (see "EMPTY-PROJECT SUPPRESSION" below: an
       *  empty group's header is now the ONLY row a caret can land on for
       *  that project, since it has no cards to select instead). Does NOT
       *  change `height` — the placeholder text replaces the existing
       *  blank-below row rather than adding a new one, so windowing math is
       *  identical for empty and non-empty groups. */
      isEmpty: boolean
      height: number
    }
  | { kind: 'card'; row: WorkspaceRow; height: number }

/** Rows ProjectGroupHeader.tsx renders for the name+rule line itself. */
const HEADER_NAME_ROWS = 1
/** Rows ProjectGroupHeader.tsx renders below the name+rule line — the
 *  breather separating it from the first card beneath it. Lives on the
 *  header block, NOT on the first card: commit 720e68e7 deliberately
 *  deleted a DIFFERENT blank row that used to live on the first card's
 *  suppressed separator (dead space reserved for a rule that was never
 *  drawn there) — this is a new, deliberate 1-row breather owned by the
 *  header, not a reintroduction of that dead space. The first card's block
 *  still gets zero separator rows (see `firstCardHeightDelta` below). */
const HEADER_BLANK_BELOW_ROWS = 1
/** Rows ProjectGroupHeader.tsx renders ABOVE the name+rule line, separating
 *  this project's group from the PREVIOUS project's last card — see
 *  `buildBlocks`'s "BLANK ABOVE" section for why this is 0 for the first
 *  header in the whole list and 1 for every one after it. */
const HEADER_BLANK_ABOVE_ROWS = 1

function headerHeight(blankAbove: boolean): number {
  return HEADER_NAME_ROWS + HEADER_BLANK_BELOW_ROWS + (blankAbove ? HEADER_BLANK_ABOVE_ROWS : 0)
}

/**
 * Group flattened rows (flattenTree()'s output) into Blocks, one per
 * project-header/workspace row, with an explicit `height` per block.
 *
 * EMPTY GROUPS RENDER THEIR HEADER: flattenTree() (layout.ts) ALWAYS emits a
 * project-header row even for a project with zero (or, under view:active,
 * zero surviving) workspaces. An earlier revision of this function
 * suppressed that header entirely whenever no card block survived for it —
 * defensible when the only way to reach an empty group was the `active`
 * filter hiding everything, since the project was still reachable some
 * other way (switch view, or it had workspaces elsewhere). It stopped being
 * defensible once `project.add` shipped: a freshly-registered project with
 * zero workspaces would render NOTHING — invisible, unhighlightable, and
 * therefore impossible to target with `n` (which infers its project from
 * the highlighted row — see App.tsx's `handleNewWorkspaceKey`). You could
 * add a project you could then never use from the TUI. So every project's
 * header is now committed unconditionally — `pendingBody.length > 0` is no
 * longer a gate, only an input to `isEmpty` (see the `Block` doc comment)
 * and the "blank above" bookkeeping below still runs off `out`'s actual
 * contents, which now always includes every project, so no separate
 * suppression accounting is needed at all.
 *
 * BLANK ABOVE (breathing room between consecutive project groups) — the
 * first header in the returned list never gets a leading blank (nothing
 * above it to separate from — a blank row at the very top of the list is
 * wasted vertical space on a phone); every header after it does. Tracked by
 * whether `out` already contains a 'project-header' block at commit time —
 * now trivially correct for every project since none are suppressed
 * anymore, but left as a live check (rather than a running index) since
 * `out`'s contents are the actual source of truth this list gets rendered
 * from.
 *
 * FIRST-CARD HEIGHT REDUCTION: a card's separator row exists to rule off
 * consecutive cards from EACH OTHER. The first card in a group has no
 * predecessor card — the project header sits above it instead — so that
 * card's separator row used to reserve a row and render nothing in it,
 * leaving a dead blank line under every project name. Rather than special-
 * casing the RENDER while the block still claims the old uniform height
 * (which would desync the windowing sum from what's actually drawn), the
 * first card's block itself is `firstCardHeightDelta` rows shorter. Every
 * other card in the group is unaffected and stays exactly `cardHeight`. An
 * empty group has no first card at all, so this reduction simply doesn't
 * apply to it — its header's own height already accounts for everything it
 * renders.
 */
export function buildBlocks(
  rows: DisplayRow[],
  cardHeight: number,
  firstCardHeightDelta = 0
): Block[] {
  const out: Block[] = []

  let pendingHeader: { projectId: string; projectName: string; visibleCount: number } | null = null
  let pendingBody: Block[] = []

  const commitPendingGroup = (): void => {
    if (pendingHeader != null) {
      const blankAbove = out.some((b) => b.kind === 'project-header')
      out.push({
        kind: 'project-header',
        projectId: pendingHeader.projectId,
        projectName: pendingHeader.projectName,
        visibleCount: pendingHeader.visibleCount,
        blankAbove,
        isEmpty: pendingBody.length === 0,
        height: headerHeight(blankAbove)
      })
      out.push(...pendingBody)
    }
    pendingHeader = null
    pendingBody = []
  }

  for (const row of rows) {
    if (row.kind === 'project-header') {
      commitPendingGroup()
      pendingHeader = {
        projectId: row.projectId,
        projectName: row.projectName,
        visibleCount: row.visibleCount
      }
      continue
    }
    // First card of the (still-pending) group -> shorter block, no reserved
    // separator row. Every subsequent card in the same group -> full height.
    const isFirstInGroup = pendingBody.length === 0
    const height = isFirstInGroup ? Math.max(1, cardHeight - firstCardHeightDelta) : cardHeight
    pendingBody.push({ kind: 'card', row, height })
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
 * Identifies whichever row is currently highlighted — either an ordinary
 * workspace card, or (new, for the empty-group fix) an empty project's own
 * header, since that header is the only block an empty group contributes
 * for the caret to land on. `null` means nothing is selected (empty list).
 * A NON-empty project's header is never a valid selection target here —
 * App.tsx's selection model only ever produces this variant when the
 * highlighted row IS that project's header, which only happens for empty
 * groups (see App.tsx's `selectableRows`).
 */
export type SelectedBlockId =
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'project-header'; projectId: string }
  | null

function blockMatchesSelection(block: Block, selected: SelectedBlockId): boolean {
  if (selected == null) return false
  if (selected.kind === 'workspace') {
    return block.kind === 'card' && block.row.workspaceId === selected.workspaceId
  }
  return block.kind === 'project-header' && block.projectId === selected.projectId
}

/**
 * Keep the block containing `selected` fully in view within `availableRows`,
 * reserving a FIXED `AFFORDANCE_ROWS_WHEN_WINDOWED`-row budget for the whole
 * scrolling session once windowing engages at all (never a variable 0/1/2,
 * so the content window's own height never changes mid-scroll — same
 * discipline as layout.ts's scrollWindowFor).
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
  selected: SelectedBlockId,
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
    blocks.findIndex((b) => blockMatchesSelection(b, selected))
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
