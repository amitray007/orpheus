// ---------------------------------------------------------------------------
// scripts/verify-tui-blocks.ts
//
// Assertion harness for the PURE block-construction + variable-height
// windowing module (packages/orpheus-cli/src/tui/blocks.ts), covering both
// the Ink card picker (tui/App.tsx) and any future reuse of the same logic,
// plus the project group header's pure width-computation module
// (packages/orpheus-cli/src/tui/projectHeaderLayout.ts).
//
// MUST PASS FULLY OFFLINE, ON LINUX, WITH NO TTY — mirrors
// scripts/verify-tui-layout.ts's own constraint. blocks.ts and
// projectHeaderLayout.ts import nothing from solid-js/@opentui/react/ink/
// electron/better-sqlite3; this script exercises buildBlocks/windowBlocks/
// buildProjectGroupHeaderLine directly over plain fixtures, with no actual
// rendering involved.
//
// Covers:
//   1. buildBlocks: project-header height is 2 rows for the FIRST header in
//      the list (name+rule line + a blank breather below, no blank above —
//      nothing to separate from at the very top) and 3 rows for every
//      header after it (+ a blank breather ABOVE, separating consecutive
//      project groups) — asserted as an explicit constant-equality check
//      against ProjectGroupHeader.tsx's OWN rendered row count (the
//      REGRESSION GUARD block below), one `card` block per workspace row
//      regardless of status (including idle), the first card in each group
//      getting a REDUCED height (no reserved separator row — see blocks.ts's
//      `firstCardHeightDelta` param), every other card getting the full
//      height, and empty-project suppression (a project whose workspaces
//      are all filtered out contributes zero blocks, including its own
//      header, AND does not count as "a header already rendered" for the
//      next surviving project's blankAbove decision).
//   2. windowBlocks: passthrough when total height fits, sticky window
//      start (no spurious recenter when the newly-selected block is
//      already fully visible — adjacent-selection case), forward/backward
//      nudge when selection falls outside the window, the "pull back if
//      there's slack" clawback, and the fixed AFFORDANCE_ROWS_WHEN_WINDOWED
//      budget once windowed — re-run against the new variable-height first
//      card AND variable-height headers at the top, middle, and bottom of a
//      multi-project list.
//   3. Group total height: the sum of a project's own blocks (header + every
//      card) must equal the exact arithmetic App.tsx's windowing relies on.
//   4. buildProjectGroupHeaderLine / joinHeaderLine (projectHeaderLayout.ts):
//      the composed line is EXACTLY the requested width at 38 columns for a
//      short name, a long name, and a name long enough to leave no room for
//      a rule; the count is always present and never truncated; a 3-digit
//      count still fits at 38 columns.
//   5. layout.ts's flattenTree: the project-header row's `visibleCount`
//      matches the actual surviving workspace-row count for that project,
//      under both view:all and view:active, across multiple projects.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import { flattenTree, type DisplayRow } from '../packages/orpheus-cli/src/tui/layout.ts'
import {
  buildBlocks,
  windowBlocks,
  AFFORDANCE_ROWS_WHEN_WINDOWED,
  type Block,
  type SelectedBlockId
} from '../packages/orpheus-cli/src/tui/blocks.ts'
import {
  buildProjectGroupHeaderLine,
  joinHeaderLine
} from '../packages/orpheus-cli/src/tui/projectHeaderLayout.ts'
import { NAV_DIVIDER_CHAR } from '../packages/orpheus-cli/src/tui/theme.ts'
import type {
  TreeFrame,
  TreeProject,
  TreeWorkspace,
  WorkspaceStatus
} from '../packages/orpheus-cli/src/tui/types.ts'

// Mirrors tui/App.tsx's own CARD_CONTENT_ROWS / CARD_SEPARATOR_ROWS /
// CARD_HEIGHT split (App.tsx composes CARD_HEIGHT = CARD_CONTENT_ROWS +
// CARD_SEPARATOR_ROWS and passes CARD_SEPARATOR_ROWS as buildBlocks()'s
// `firstCardHeightDelta`) rather than a single flat number, so this harness
// can assert the SAME relationship App.tsx relies on instead of a harness-
// local magic number that could silently drift from it.
const CARD_CONTENT_ROWS = 3
const SEPARATOR_ROWS = 1
const CARD_HEIGHT = CARD_CONTENT_ROWS + SEPARATOR_ROWS

// ProjectGroupHeader.tsx's OWN rendered row count for a header, mirroring
// its exact structure: [blank-above?] + name+rule+count line + blank-below.
// This is the harness's stand-in for "rows ProjectGroupHeader.tsx actually
// renders" — see the REGRESSION GUARD block below for why this can't just
// be inlined at each call site (a future edit to either side alone, without
// mirroring the other, must fail this harness).
const HEADER_NAME_LINE_ROWS = 1
const HEADER_BLANK_BELOW_ROWS = 1
const HEADER_BLANK_ABOVE_ROWS = 1
function headerRenderedRows(blankAbove: boolean): number {
  return (
    HEADER_NAME_LINE_ROWS + HEADER_BLANK_BELOW_ROWS + (blankAbove ? HEADER_BLANK_ABOVE_ROWS : 0)
  )
}

// ---------------------------------------------------------------------------
// Fixture helpers — mirrors verify-tui-layout.ts's own ws()/project()/frame()
// ---------------------------------------------------------------------------

function ws(overrides: Partial<TreeWorkspace> & { id: string; name: string }): TreeWorkspace {
  return {
    status: 'idle' as WorkspaceStatus,
    waitingFor: null,
    parentWorkspaceId: null,
    worktreeBranch: null,
    sortOrder: null,
    tmuxHosted: false,
    lastActivityAt: null,
    ...overrides
  }
}

function project(overrides: Partial<TreeProject> & { id: string; name: string }): TreeProject {
  return {
    cwd: `/code/${overrides.name}`,
    sortOrder: null,
    workspaces: [],
    ...overrides
  }
}

function frame(revision: number, projects: TreeProject[]): TreeFrame {
  return { type: 'tree', revision, projects }
}

function cardBlocks(blocks: Block[]): Array<Extract<Block, { kind: 'card' }>> {
  return blocks.filter((b): b is Extract<Block, { kind: 'card' }> => b.kind === 'card')
}

function headerBlocks(blocks: Block[]): Array<Extract<Block, { kind: 'project-header' }>> {
  return blocks.filter(
    (b): b is Extract<Block, { kind: 'project-header' }> => b.kind === 'project-header'
  )
}

function rowsFor(f: TreeFrame, filter: 'active' | 'all' = 'all'): DisplayRow[] {
  return flattenTree(f, filter).rows
}

// SelectedBlockId constructors — mirrors App.tsx's own `selectableRowId()`
// (tui/App.tsx), which windowBlocks() now expects instead of a bare
// workspace-id string, so a selection can also rest on an empty project's
// header (see blocks.ts's `SelectedBlockId` doc comment).
function wsSel(workspaceId: string): SelectedBlockId {
  return { kind: 'workspace', workspaceId }
}
function headerSel(projectId: string): SelectedBlockId {
  return { kind: 'project-header', projectId }
}

// ---------------------------------------------------------------------------
// 1. buildBlocks — header height (first vs. subsequent), first-card height
//    reduction, empty-group rendering
// ---------------------------------------------------------------------------

{
  const f = frame(1, [
    project({
      id: 'p1',
      name: 'proj-one',
      workspaces: [
        ws({ id: 'w1', name: 'active-one', status: 'in_progress' }),
        ws({ id: 'w2', name: 'idle-one', status: 'idle' }),
        ws({ id: 'w3', name: 'attn-one', status: 'attention' }),
        ws({ id: 'w4', name: 'awaiting-one', status: 'awaiting_input' })
      ]
    }),
    project({
      id: 'p2',
      name: 'proj-two',
      workspaces: [ws({ id: 'w5', name: 'idle-two', status: 'idle' })]
    })
  ])

  const blocks = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
  const headers = headerBlocks(blocks)
  assert.equal(headers.length, 2, 'both projects have surviving workspaces -> both headers emitted')

  assert.equal(
    headers[0]!.blankAbove,
    false,
    'the FIRST header in the whole list gets no blank above'
  )
  assert.equal(
    headers[0]!.height,
    headerRenderedRows(false),
    'first header: name+rule line + blank below only (2 rows) — no blank above'
  )
  assert.equal(headers[1]!.blankAbove, true, 'every header after the first gets a blank above')
  assert.equal(
    headers[1]!.height,
    headerRenderedRows(true),
    'second header: blank above + name+rule line + blank below (3 rows)'
  )

  // visibleCount threads straight from flattenTree's per-project count.
  assert.equal(headers[0]!.visibleCount, 4, 'p1 header carries its own 4 surviving workspaces')
  assert.equal(headers[1]!.visibleCount, 1, 'p2 header carries its own 1 surviving workspace')

  const cards = cardBlocks(blocks)
  assert.equal(cards.length, 5, 'one card block per workspace row, regardless of status')
  // THE FIRST-CARD-HEIGHT-REDUCTION FIX: the first card block belonging to
  // EACH project group has no previous CARD to rule off, so it gets a
  // REDUCED height with no reserved separator row; every other card in that
  // group keeps the full CARD_HEIGHT. "First" is read off the blocks list
  // itself (immediately after that project's header) rather than assumed
  // from fixture insertion order — flattenTree() sorts siblings
  // attention-first (layout.ts's sortSiblings), so p1's first-in-group card
  // is actually w3 ('attention'), not w1, even though w1 was listed first in
  // the fixture above.
  const p1HeaderIdx = blocks.findIndex((b) => b.kind === 'project-header' && b.projectId === 'p1')
  const p1Cards = blocks
    .slice(p1HeaderIdx + 1)
    .filter(
      (b): b is Extract<Block, { kind: 'card' }> => b.kind === 'card' && b.row.projectId === 'p1'
    )
  assert.equal(p1Cards.length, 4, 'p1 has 4 surviving workspaces')
  assert.equal(
    p1Cards[0]!.height,
    CARD_HEIGHT - SEPARATOR_ROWS,
    'the first card block in a project group reserves no separator row, regardless of which workspace sorts first'
  )
  for (const card of p1Cards.slice(1)) {
    assert.equal(
      card.height,
      CARD_HEIGHT,
      `non-first card ${card.row.workspaceId} keeps the full CARD_HEIGHT`
    )
  }

  const soloCardP2 = cards.find((c) => c.row.workspaceId === 'w5')
  assert.ok(soloCardP2 != null, 'idle workspace w5 (sole member of its own project) must appear')
  assert.equal(
    soloCardP2!.height,
    CARD_HEIGHT - SEPARATOR_ROWS,
    'a project with exactly one workspace: that card is still "first in group" -> reduced height'
  )

  // Idle workspaces get an ordinary `card` block, not a separate collapsed/
  // compact kind — asserted directly against the idle rows by id.
  for (const id of ['w2', 'w5']) {
    const card = cards.find((c) => c.row.workspaceId === id)
    assert.ok(card != null, `idle workspace ${id} must appear as a card block`)
  }

  console.log(
    '✓ buildBlocks: first header has no blank above (2 rows), later headers do (3 rows), first card per group is reduced height, every workspace status -> a card block'
  )
}

// ---------------------------------------------------------------------------
// REGRESSION GUARD — the rendered header row count and blocks.ts's reported
// project-header block height must be the SAME NUMBER, asserted as a
// constant-equality check (not just "both equal headerRenderedRows(...)" in
// isolation) so a future edit to ProjectGroupHeader.tsx's JSX (e.g. adding a
// second blank row, or dropping the rule) that isn't mirrored in blocks.ts's
// `headerHeight()` — or vice versa — fails HERE instead of silently
// desyncing the windowing sum from what the terminal actually draws.
//
// Both the FIRST-header case (blankAbove=false, 2 rows) and the SUBSEQUENT-
// header case (blankAbove=true, 3 rows) are asserted — this task folded in
// the blank-above gap on top of the original blank-below regression guard,
// and both must hold independently: flipping either side of EITHER case
// alone must fail this harness (see this file's mutation-test note in the
// task history).
// ---------------------------------------------------------------------------

{
  const f = frame(1, [
    project({ id: 'p1', name: 'proj-one', workspaces: [ws({ id: 'w1', name: 'w1' })] }),
    project({ id: 'p2', name: 'proj-two', workspaces: [ws({ id: 'w2', name: 'w2' })] })
  ])
  const blocks = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
  const headers = headerBlocks(blocks)
  assert.equal(headers.length, 2)

  assert.equal(
    headers[0]!.height,
    headerRenderedRows(headers[0]!.blankAbove),
    "FIRST project-header block height must equal ProjectGroupHeader.tsx's rendered row count for blankAbove=false (name+rule line + blank below, no blank above)"
  )
  assert.equal(
    headers[1]!.height,
    headerRenderedRows(headers[1]!.blankAbove),
    "SUBSEQUENT project-header block height must equal ProjectGroupHeader.tsx's rendered row count for blankAbove=true (blank above + name+rule line + blank below)"
  )

  console.log(
    "✓ REGRESSION GUARD: both first-header (2 rows) and subsequent-header (3 rows) block heights match ProjectGroupHeader.tsx's rendered row count"
  )
}

// ---------------------------------------------------------------------------
// Group total height — the sum of a project's own blocks (header + every
// card) must equal the exact arithmetic App.tsx's windowing relies on.
// ---------------------------------------------------------------------------

{
  const workspaceCounts = [1, 2, 5]
  for (const count of workspaceCounts) {
    const workspaces: TreeWorkspace[] = []
    for (let i = 0; i < count; i++) {
      workspaces.push(ws({ id: `w${i}`, name: `workspace-${i}` }))
    }
    const f = frame(1, [project({ id: 'p1', name: 'proj-one', workspaces })])
    const blocks = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
    const actualTotal = blocks.reduce((sum, b) => sum + b.height, 0)
    // Sole project in the list -> its header is the FIRST header -> no blank
    // above (headerRenderedRows(false)).
    const expectedTotal =
      headerRenderedRows(false) + (CARD_HEIGHT - SEPARATOR_ROWS) + CARD_HEIGHT * (count - 1)
    assert.equal(
      actualTotal,
      expectedTotal,
      `group of ${count} workspace(s): total block height must equal header + reduced-first-card + full-height rest`
    )
  }

  console.log(
    '✓ group total height matches first-header rows + reduced-first-card + full-height-rest for 1, 2, and 5 workspaces'
  )
}

{
  // EMPTY-GROUP RENDERING (the bug fix): a project with zero workspaces, and
  // a project whose only workspace is filtered out under view:active, both
  // now still produce a HEADER block — an earlier revision of buildBlocks()
  // suppressed it entirely, which meant a freshly `project.add`-ed project
  // with no workspaces yet rendered NOTHING: invisible, unhighlightable, and
  // therefore impossible to target with `n` (see blocks.ts's "EMPTY GROUPS
  // RENDER THEIR HEADER" note for the full story). The header must still
  // carry isEmpty=true, contribute ZERO card blocks, and — critically for
  // blankAbove bookkeeping — still count as "a header was already rendered"
  // for whichever header comes after it, since it now actually IS rendered.
  const f = frame(1, [
    project({ id: 'empty', name: 'empty-project', workspaces: [] }),
    project({
      id: 'all-idle',
      name: 'all-idle-project',
      workspaces: [ws({ id: 'w1', name: 'idle-only', status: 'idle' })]
    }),
    project({
      id: 'has-active',
      name: 'has-active-project',
      workspaces: [ws({ id: 'w2', name: 'active-one', status: 'in_progress' })]
    })
  ])

  const blocksActiveView = buildBlocks(rowsFor(f, 'active'), CARD_HEIGHT, SEPARATOR_ROWS)
  const headersActive = headerBlocks(blocksActiveView)
  assert.deepEqual(
    headersActive.map((h) => h.projectId),
    ['empty', 'all-idle', 'has-active'],
    'under view:active, EVERY project gets a header, even ones with zero surviving workspace rows'
  )
  assert.deepEqual(
    headersActive.map((h) => h.isEmpty),
    [true, true, false],
    'isEmpty is true for both zero-workspace and all-filtered-out projects, false for the one with a surviving card'
  )
  assert.deepEqual(
    headersActive.map((h) => h.blankAbove),
    [false, true, true],
    'blankAbove is a straight positional sequence now that nothing is suppressed: false only for the very first header in the list'
  )
  assert.equal(
    cardBlocks(blocksActiveView).length,
    1,
    'only the one active workspace becomes a card under view:active — the two empty headers contribute zero cards'
  )

  const blocksAllView = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
  const headersAll = headerBlocks(blocksAllView)
  assert.deepEqual(
    headersAll.map((h) => h.projectId),
    ['empty', 'all-idle', 'has-active'],
    'under view:all, every project still gets a header, including the genuinely empty one'
  )
  assert.deepEqual(
    headersAll.map((h) => h.isEmpty),
    [true, false, false],
    'view:all: only the truly empty project (zero workspaces at all) is isEmpty — all-idle now has a surviving idle row'
  )
  assert.equal(
    headersAll[0]!.blankAbove,
    false,
    'empty-project is the FIRST header in the whole list -> no blank above'
  )
  assert.equal(
    headersAll[1]!.blankAbove,
    true,
    'all-idle-project is the SECOND header -> blank above, because the empty header ahead of it now genuinely rendered and counts'
  )
  assert.equal(
    headersAll[2]!.blankAbove,
    true,
    'has-active-project is the third header -> blank above'
  )

  console.log(
    "✓ buildBlocks: every project renders its header (isEmpty for those with zero surviving cards), and an empty header still counts toward the next header's blankAbove"
  )
}

{
  // A project whose header committed empty must not itself receive the
  // first-card height reduction or otherwise leak card-shaped arithmetic —
  // its OWN height is exactly headerHeight(blankAbove), nothing added for
  // the placeholder text (ProjectGroupHeader.tsx repurposes the existing
  // blank-below row rather than reserving a new one — see that file's
  // header). Also: total block height for a solo empty project must equal
  // just the header, with zero contribution from cards.
  const f = frame(1, [project({ id: 'p1', name: 'solo-empty', workspaces: [] })])
  const blocks = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
  assert.equal(blocks.length, 1, 'a solo empty project contributes exactly one block: its header')
  const header = blocks[0]!
  assert.equal(header.kind, 'project-header')
  assert.ok(header.kind === 'project-header' && header.isEmpty)
  assert.equal(
    header.height,
    headerRenderedRows(false),
    'an empty header (first in the list) is exactly the ordinary first-header height — no extra rows for the placeholder text'
  )
  const totalHeight = blocks.reduce((s, b) => s + b.height, 0)
  assert.equal(
    totalHeight,
    headerRenderedRows(false),
    'a solo empty project group: total block height is JUST the header, zero card contribution'
  )

  console.log(
    "✓ buildBlocks: an empty project's own header height carries no extra rows for its placeholder text, and contributes zero card height to the group total"
  )
}

// ---------------------------------------------------------------------------
// 2. windowBlocks — passthrough, sticky start, nudge, clawback, fixed budget
// ---------------------------------------------------------------------------

function manyWorkspaceBlocks(count: number): Block[] {
  const workspaces: TreeWorkspace[] = []
  for (let i = 0; i < count; i++) {
    workspaces.push(ws({ id: `w${i}`, name: `workspace-${i}`, status: 'idle' }))
  }
  const f = frame(1, [project({ id: 'p1', name: 'proj', workspaces })])
  return buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
}

{
  const blocks = manyWorkspaceBlocks(3)
  const result = windowBlocks(blocks, wsSel('w0'), 100, 0)
  assert.equal(result.windowed, false, 'everything fits -> not windowed')
  assert.equal(result.visible.length, blocks.length)
  assert.equal(result.aboveCount, 0)
  assert.equal(result.belowCount, 0)
  console.log('✓ windowBlocks: passthrough when total block height fits the budget')
}

{
  // 10 workspaces: first (and only, and therefore FIRST-IN-LIST) header is
  // 2 rows (no blank above), first card is (CARD_HEIGHT - SEPARATOR_ROWS) =
  // 3 rows, the other 9 are CARD_HEIGHT = 4 rows each: 2 + 3 + 9*4 = 41
  // total. availableRows = 13 -> engages windowing.
  const blocks = manyWorkspaceBlocks(10)
  const totalHeight = blocks.reduce((s, b) => s + b.height, 0)
  assert.ok(totalHeight > 13, 'fixture must exceed the availableRows budget to engage windowing')

  const first = windowBlocks(blocks, wsSel('w0'), 13, 0)
  assert.equal(first.windowed, true)
  assert.equal(
    first.start,
    0,
    'selecting the very first workspace keeps the window pinned at the top'
  )

  // Move selection to an ADJACENT workspace that's already fully visible in
  // the current window — must NOT recenter (this is the exact regression
  // caught live via tui-mcp's adjacent-selection diff, per blocks.ts's own
  // doc comment).
  const second = windowBlocks(blocks, wsSel('w1'), 13, first.start)
  assert.equal(
    second.start,
    first.start,
    'moving selection to an adjacent, already-visible block must not shift the window start'
  )

  console.log(
    '✓ windowBlocks: no spurious recenter when the newly-selected block is already visible'
  )
}

{
  const blocks = manyWorkspaceBlocks(10)
  // Force a window purely at the top, then select the LAST workspace — the
  // window must nudge forward just enough to reveal it, engaging the fixed
  // affordance budget.
  const budget = 13
  const atTop = windowBlocks(blocks, wsSel('w0'), budget, 0)
  const selectedLast = windowBlocks(blocks, wsSel('w9'), budget, atTop.start)
  assert.ok(
    selectedLast.start > atTop.start,
    'selection past the visible window must nudge start forward'
  )
  const lastCardVisible = selectedLast.visible.some(
    (b) => b.kind === 'card' && b.row.workspaceId === 'w9'
  )
  assert.ok(lastCardVisible, 'the selected workspace card must be fully inside the visible slice')
  assert.equal(
    selectedLast.belowCount,
    0,
    'scrolled to the very last workspace -> nothing left below'
  )

  // Now walk back up to the FIRST workspace again — must nudge (or clamp)
  // back down to 0, not stay stuck scrolled down.
  const backToTop = windowBlocks(blocks, wsSel('w0'), budget, selectedLast.start)
  assert.equal(
    backToTop.start,
    0,
    'selecting the first workspace again must scroll fully back to the top'
  )

  console.log(
    '✓ windowBlocks: forward nudge reveals a selection scrolled below, backward nudge restores the top'
  )
}

{
  // "Pull back if there's slack" clawback: start deep in the list with slack
  // available (budget not fully used by [start, end)) should pull back down
  // toward 0 rather than leaving unused budget above a scrolled-down window.
  const blocks = manyWorkspaceBlocks(10)
  const budget = 13
  // Get to the bottom first.
  const atTop = windowBlocks(blocks, wsSel('w0'), budget, 0)
  const atBottom = windowBlocks(blocks, wsSel('w9'), budget, atTop.start)
  // Now select something in the middle that's already visible in the
  // bottom-anchored window — per the sticky-start contract this should NOT
  // move at all (already visible), which is itself evidence the clawback
  // isn't firing needlessly. Then force a case with real slack: select the
  // second-to-last workspace after being scrolled all the way to the end;
  // any slack should be reclaimed without losing the selection.
  const nearBottomSelected = windowBlocks(blocks, wsSel('w8'), budget, atBottom.start)
  const w8Visible = nearBottomSelected.visible.some(
    (b) => b.kind === 'card' && b.row.workspaceId === 'w8'
  )
  assert.ok(
    w8Visible,
    'w8 must remain visible after reselecting it from the bottom-anchored window'
  )

  console.log('✓ windowBlocks: clawback keeps the selection visible while reclaiming slack')
}

{
  // Fixed affordance budget: whenever windowed is true, aboveCount +
  // belowCount semantics aside, the number of VISIBLE rows worth of content
  // (by height) must never exceed availableRows - AFFORDANCE_ROWS_WHEN_WINDOWED,
  // and must be consistent across different scroll positions (content
  // window height doesn't change mid-scroll).
  const blocks = manyWorkspaceBlocks(10)
  const budget = 13
  const contentBudget = budget - AFFORDANCE_ROWS_WHEN_WINDOWED
  const atTop = windowBlocks(blocks, wsSel('w0'), budget, 0)
  const visibleHeightTop = atTop.visible.reduce((s, b) => s + b.height, 0)
  assert.ok(
    visibleHeightTop <= contentBudget,
    'visible content height must never exceed the fixed content budget once windowed'
  )

  const atBottom = windowBlocks(blocks, wsSel('w9'), budget, atTop.start)
  const visibleHeightBottom = atBottom.visible.reduce((s, b) => s + b.height, 0)
  assert.ok(visibleHeightBottom <= contentBudget)

  console.log(
    '✓ windowBlocks: fixed AFFORDANCE_ROWS_WHEN_WINDOWED budget respected at multiple scroll positions'
  )
}

// ---------------------------------------------------------------------------
// Multi-project windowing with the new variable first-card height AND
// variable header height (blankAbove) — keeps the selected card fully
// visible at the top, middle, and bottom of a list spanning several project
// groups, each with its own reduced-height first card and its own
// first-vs-subsequent header height. This is the exact shape App.tsx
// renders (several ProjectGroupHeader + WorkspaceCard runs back to back),
// unlike manyWorkspaceBlocks()'s single-project fixture above.
// ---------------------------------------------------------------------------

function multiProjectBlocks(projectCount: number, workspacesPerProject: number): Block[] {
  const projects: TreeProject[] = []
  for (let p = 0; p < projectCount; p++) {
    const workspaces: TreeWorkspace[] = []
    for (let w = 0; w < workspacesPerProject; w++) {
      workspaces.push(ws({ id: `p${p}-w${w}`, name: `p${p}-workspace-${w}`, status: 'idle' }))
    }
    projects.push(project({ id: `p${p}`, name: `project-${p}`, workspaces }))
  }
  const f = frame(1, projects)
  return buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
}

function selectedCardFullyVisible(window: ReturnType<typeof windowBlocks>, id: string): boolean {
  return window.visible.some((b) => b.kind === 'card' && b.row.workspaceId === id)
}

{
  // 4 projects * 3 workspaces each = 12 cards. Group height: first group is
  // 1 header (2 rows, no blank above) + 3 (reduced first card) + 4 + 4 = 13
  // rows; each of the other 3 groups is 1 header (3 rows, blank above) + 3 +
  // 4 + 4 = 14 rows. Total = 13 + 14*3 = 55 rows. Budget of 15 forces
  // windowing well before the whole list fits.
  const blocks = multiProjectBlocks(4, 3)
  const budget = 15
  const totalHeight = blocks.reduce((s, b) => s + b.height, 0)
  assert.ok(totalHeight > budget, 'fixture must exceed the budget to engage windowing')

  const headers = headerBlocks(blocks)
  assert.equal(headers.length, 4)
  assert.equal(headers[0]!.blankAbove, false, 'sanity: first of 4 groups has no blank above')
  assert.ok(
    headers.slice(1).every((h) => h.blankAbove),
    'sanity: every group after the first has a blank above'
  )

  // TOP: select the very first workspace of the very first project.
  const atTop = windowBlocks(blocks, wsSel('p0-w0'), budget, 0)
  assert.equal(atTop.windowed, true)
  assert.equal(atTop.start, 0, 'selecting the first workspace overall pins the window at the top')
  assert.ok(
    selectedCardFullyVisible(atTop, 'p0-w0'),
    'top: selected card (first card of first group, reduced height) must be fully visible'
  )

  // MIDDLE: select a workspace roughly in the middle of the flattened list —
  // the first workspace of the third project (p2-w0), itself a reduced-
  // height first-in-group card sitting under a blankAbove=true header.
  const atMiddle = windowBlocks(blocks, wsSel('p2-w0'), budget, atTop.start)
  assert.ok(
    selectedCardFullyVisible(atMiddle, 'p2-w0'),
    'middle: selected first-in-group card of an interior project must be fully visible'
  )

  // BOTTOM: select the very last workspace of the very last project.
  const atBottom = windowBlocks(blocks, wsSel('p3-w2'), budget, atMiddle.start)
  assert.ok(
    selectedCardFullyVisible(atBottom, 'p3-w2'),
    'bottom: selected last card of the last group must be fully visible'
  )
  assert.equal(atBottom.belowCount, 0, 'scrolled to the very last card -> nothing left below')

  console.log(
    '✓ windowBlocks: multi-project list with variable first-card AND variable header heights keeps the selection fully visible at top, middle, and bottom'
  )
}

// ---------------------------------------------------------------------------
// EMPTY GROUPS INTERLEAVED AMONG POPULATED ONES — the actual shape the bug
// fix has to survive: a mix of empty and non-empty projects in the SAME
// list, windowed tightly enough that scrolling is engaged, with selection
// exercised on BOTH an ordinary card AND an empty project's own header (the
// new selection target — see blocks.ts's `SelectedBlockId`).
// ---------------------------------------------------------------------------

{
  const f = frame(1, [
    project({ id: 'e1', name: 'empty-one', workspaces: [] }),
    project({
      id: 'p1',
      name: 'populated-one',
      workspaces: [
        ws({ id: 'p1-w0', name: 'p1-workspace-0' }),
        ws({ id: 'p1-w1', name: 'p1-workspace-1' }),
        ws({ id: 'p1-w2', name: 'p1-workspace-2' })
      ]
    }),
    project({ id: 'e2', name: 'empty-two', workspaces: [] }),
    project({
      id: 'p2',
      name: 'populated-two',
      workspaces: [
        ws({ id: 'p2-w0', name: 'p2-workspace-0' }),
        ws({ id: 'p2-w1', name: 'p2-workspace-1' })
      ]
    }),
    project({ id: 'e3', name: 'empty-three', workspaces: [] })
  ])
  const blocks = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)

  // Sanity: every project's header is present (the bug fix), in list order,
  // interleaved with the populated groups' cards.
  const headers = headerBlocks(blocks)
  assert.deepEqual(
    headers.map((h) => h.projectId),
    ['e1', 'p1', 'e2', 'p2', 'e3'],
    'all five projects render a header, empty and populated interleaved in list order'
  )
  assert.deepEqual(
    headers.map((h) => h.isEmpty),
    [true, false, true, false, true],
    'isEmpty tracks each project correctly through the interleaving'
  )

  const budget = 15
  const totalHeight = blocks.reduce((s, b) => s + b.height, 0)
  assert.ok(totalHeight > budget, 'fixture must exceed the budget to engage windowing')

  // Select the empty header at the very TOP of the list.
  const atE1 = windowBlocks(blocks, headerSel('e1'), budget, 0)
  assert.equal(atE1.windowed, true)
  assert.equal(atE1.start, 0, 'selecting the first block overall (an empty header) pins to the top')
  assert.ok(
    atE1.visible.some((b) => b.kind === 'project-header' && b.projectId === 'e1'),
    'the selected empty header must itself be inside the visible slice'
  )

  // Walk selection down onto an ordinary card in the first populated group —
  // must nudge the window forward and keep that card fully visible.
  const atP1Card = windowBlocks(blocks, wsSel('p1-w2'), budget, atE1.start)
  assert.ok(
    selectedCardFullyVisible(atP1Card, 'p1-w2'),
    'selecting an ordinary card past the empty header keeps it fully visible'
  )

  // Walk selection onto the SECOND empty group's header (e2), sitting
  // between two populated groups — must remain reachable and fully visible,
  // exactly like an ordinary card would be.
  const atE2 = windowBlocks(blocks, headerSel('e2'), budget, atP1Card.start)
  assert.ok(
    atE2.visible.some((b) => b.kind === 'project-header' && b.projectId === 'e2'),
    'an empty header sandwiched between two populated groups is reachable and fully visible when selected'
  )

  // Walk all the way down to the LAST project's header (e3, itself empty and
  // the final block in the whole list) — nothing should be left below.
  const atE3 = windowBlocks(blocks, headerSel('e3'), budget, atE2.start)
  assert.ok(
    atE3.visible.some((b) => b.kind === 'project-header' && b.projectId === 'e3'),
    'the final block in the list (an empty header) is reachable by selection'
  )
  assert.equal(atE3.belowCount, 0, 'scrolled to the very last block -> nothing left below')

  console.log(
    '✓ windowBlocks: empty groups interleaved among populated ones stay individually selectable and fully visible while scrolling, at the top, middle, and bottom of the list'
  )
}

{
  // Degenerate cases: zero availableRows, empty blocks list.
  const blocks = manyWorkspaceBlocks(3)
  const zeroRoom = windowBlocks(blocks, wsSel('w0'), 0, 0)
  assert.equal(zeroRoom.visible.length, 0)
  assert.equal(zeroRoom.windowed, true)
  assert.equal(zeroRoom.aboveCount, blocks.length)

  const emptyBlocks = windowBlocks([], null, 20, 0)
  assert.equal(emptyBlocks.visible.length, 0)
  assert.equal(emptyBlocks.windowed, false)
  assert.equal(emptyBlocks.aboveCount, 0)

  console.log('✓ windowBlocks: degenerate zero-room and empty-list cases handled without throwing')
}

// ---------------------------------------------------------------------------
// 4. buildProjectGroupHeaderLine / joinHeaderLine — exact width at 38
//    columns, count never truncated, rule dropped (not truncated) when it
//    doesn't fit.
// ---------------------------------------------------------------------------

const PHONE_WIDTH = 38

{
  const shortName = joinHeaderLine(
    buildProjectGroupHeaderLine('orpheus', 3, PHONE_WIDTH, NAV_DIVIDER_CHAR)
  )
  assert.equal(shortName.length, PHONE_WIDTH, 'short name: joined line is EXACTLY 38 columns')
  assert.ok(shortName.startsWith('orpheus'), 'short name: name renders in full, untruncated')
  assert.ok(shortName.endsWith('3'), 'short name: count renders at the exact right edge')
  assert.ok(shortName.includes(NAV_DIVIDER_CHAR), 'short name: a rule is drawn when there is room')

  const longName = joinHeaderLine(
    buildProjectGroupHeaderLine(
      'a-genuinely-long-monorepo-project-name-that-keeps-going',
      3,
      PHONE_WIDTH,
      NAV_DIVIDER_CHAR
    )
  )
  assert.equal(longName.length, PHONE_WIDTH, 'long name: joined line is still EXACTLY 38 columns')
  assert.ok(
    longName.endsWith('3'),
    'long name: count still renders at the exact right edge, never truncated'
  )

  // A name long enough that NO room is left for even one rule character —
  // reserving the count + its gap + the name's own truncated form + its gap
  // consumes the entire budget. Constructed by forcing the width down to
  // where minRuleSlice can't be satisfied (mirrors
  // projectHeaderLayout.ts's own "drop the rule entirely" branch).
  const noRuleParts = buildProjectGroupHeaderLine('x'.repeat(200), 3, 4, NAV_DIVIDER_CHAR)
  assert.equal(
    noRuleParts.rule,
    '',
    'name long enough to starve the rule -> rule is dropped, not truncated'
  )
  assert.equal(noRuleParts.count, '3', 'count still renders in full even when the rule is dropped')
  const noRuleJoined = joinHeaderLine(noRuleParts)
  assert.equal(
    noRuleJoined.length,
    4,
    'no-rule case: joined line is still EXACTLY the requested width'
  )

  console.log(
    '✓ buildProjectGroupHeaderLine: exact 38-column width for a short name, a long name, and a name that starves the rule'
  )
}

{
  // 3-digit count still fits at 38 columns, count never truncated at any
  // width down to the count's own length.
  const threeDigit = joinHeaderLine(
    buildProjectGroupHeaderLine('orpheus', 999, PHONE_WIDTH, NAV_DIVIDER_CHAR)
  )
  assert.equal(threeDigit.length, PHONE_WIDTH)
  assert.ok(threeDigit.endsWith('999'), '3-digit count renders in full at 38 columns')

  // Sweep every width from 0 to 38 with a long name and a 3-digit count —
  // the count segment must NEVER be shorter than its own full text unless
  // the width itself is smaller than the count's length (in which case the
  // count itself right-truncates, per buildProjectGroupHeaderLine's own
  // documented degenerate branch).
  for (let w = 0; w <= PHONE_WIDTH; w++) {
    const parts = buildProjectGroupHeaderLine('a-long-project-name-here', 999, w, NAV_DIVIDER_CHAR)
    const joined = joinHeaderLine(parts)
    assert.equal(joined.length, w, `width ${w}: joined line is always EXACTLY the requested width`)
    if (w >= 3) {
      assert.equal(
        parts.count,
        '999',
        `width ${w}: 3-digit count is never truncated once width >= 3`
      )
    }
  }

  console.log(
    '✓ buildProjectGroupHeaderLine: 3-digit count fits at 38 columns and is never truncated across the full 0..38 width sweep'
  )
}

// ---------------------------------------------------------------------------
// 5. flattenTree's per-project visibleCount — matches the actual surviving
//    workspace-row count for each project, under both filters.
// ---------------------------------------------------------------------------

{
  const f = frame(1, [
    project({
      id: 'p1',
      name: 'proj-one',
      workspaces: [
        ws({ id: 'w1', name: 'active-one', status: 'in_progress' }),
        ws({ id: 'w2', name: 'idle-one', status: 'idle' }),
        ws({ id: 'w3', name: 'attn-one', status: 'attention' })
      ]
    }),
    project({
      id: 'p2',
      name: 'proj-two',
      workspaces: [ws({ id: 'w4', name: 'idle-two', status: 'idle' })]
    })
  ])

  const allRows = rowsFor(f, 'all')
  const p1HeaderAll = allRows.find((r) => r.kind === 'project-header' && r.projectId === 'p1')
  const p2HeaderAll = allRows.find((r) => r.kind === 'project-header' && r.projectId === 'p2')
  assert.ok(p1HeaderAll?.kind === 'project-header')
  assert.ok(p2HeaderAll?.kind === 'project-header')
  assert.equal(
    p1HeaderAll.visibleCount,
    3,
    'view:all — p1 header count matches all 3 of its workspaces'
  )
  assert.equal(p2HeaderAll.visibleCount, 1, 'view:all — p2 header count matches its 1 workspace')

  const activeRows = rowsFor(f, 'active')
  const p1HeaderActive = activeRows.find((r) => r.kind === 'project-header' && r.projectId === 'p1')
  assert.ok(p1HeaderActive?.kind === 'project-header')
  assert.equal(
    p1HeaderActive.visibleCount,
    2,
    'view:active — p1 header count matches only its 2 active/attention workspaces, not all 3'
  )
  // p2 has zero active workspaces. flattenTree() itself still emits a
  // header row for p2 (row-level empty-project SUPPRESSION is buildBlocks()'s
  // job, not flattenTree's — see blocks.ts's own "EMPTY-PROJECT SUPPRESSION"
  // doc comment) — but that row's own visibleCount must correctly read 0,
  // not something stale or undefined, since buildBlocks() below discards it
  // precisely BECAUSE it reads 0 surviving workspace rows.
  const p2HeaderActive = activeRows.find((r) => r.kind === 'project-header' && r.projectId === 'p2')
  assert.ok(p2HeaderActive?.kind === 'project-header')
  assert.equal(
    p2HeaderActive.visibleCount,
    0,
    'view:active — p2 header row still exists (flattenTree does not suppress it) but its visibleCount correctly reads 0'
  )

  console.log(
    "✓ flattenTree: project-header visibleCount matches each project's own surviving workspace-row count under view:all and view:active"
  )
}

console.log('\nAll tui-blocks assertions passed.')
