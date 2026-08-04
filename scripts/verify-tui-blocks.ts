// ---------------------------------------------------------------------------
// scripts/verify-tui-blocks.ts
//
// Assertion harness for the PURE block-construction + variable-height
// windowing module (packages/orpheus-cli/src/tui/blocks.ts), covering both
// the Ink card picker (tui/App.tsx) and any future reuse of the same logic.
//
// MUST PASS FULLY OFFLINE, ON LINUX, WITH NO TTY — mirrors
// scripts/verify-tui-layout.ts's own constraint. blocks.ts imports nothing
// from solid-js/@opentui/react/ink/electron/better-sqlite3; this script
// exercises buildBlocks/windowBlocks directly over plain DisplayRow[]
// fixtures built with flattenTree(), with no actual rendering involved.
//
// Covers:
//   1. buildBlocks: project-header is always 1 row (just the name —
//      ProjectGroupHeader.tsx renders exactly one <Text> line, no rule, no
//      blank line — asserted here as an explicit constant-equality check so
//      a future edit to either side alone fails this harness, per this
//      file's REGRESSION GUARD block below), one `card` block per workspace
//      row regardless of status (including idle), the first card in each
//      group getting a REDUCED height (no reserved separator row — see
//      blocks.ts's `firstCardHeightDelta` param), every other card getting
//      the full height, and empty-project suppression (a project whose
//      workspaces are all filtered out contributes zero blocks, including
//      its own header).
//   2. windowBlocks: passthrough when total height fits, sticky window
//      start (no spurious recenter when the newly-selected block is
//      already fully visible — adjacent-selection case), forward/backward
//      nudge when selection falls outside the window, the "pull back if
//      there's slack" clawback, and the fixed AFFORDANCE_ROWS_WHEN_WINDOWED
//      budget once windowed — re-run against the new variable-height first
//      card at the top, middle, and bottom of a multi-project list.
//   3. Group total height: the sum of a project's own blocks (header + every
//      card) must equal `HEADER_HEIGHT + (CARD_HEIGHT - SEPARATOR_ROWS) +
//      CARD_HEIGHT * (workspaceCount - 1)` — the exact arithmetic App.tsx's
//      windowing relies on.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import { flattenTree, type DisplayRow } from '../packages/orpheus-cli/src/tui/layout.ts'
import {
  buildBlocks,
  windowBlocks,
  AFFORDANCE_ROWS_WHEN_WINDOWED,
  type Block
} from '../packages/orpheus-cli/src/tui/blocks.ts'
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
// ProjectGroupHeader.tsx renders exactly one <Text> line (the bare project
// name — no rule, no blank line). This constant is the harness's stand-in
// for "rows ProjectGroupHeader actually renders" — see the REGRESSION GUARD
// block below for why this can't just be a bare `1` inlined at each call
// site.
const HEADER_RENDERED_ROWS = 1

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

function rowsFor(f: TreeFrame, filter: 'active' | 'all' = 'all'): DisplayRow[] {
  return flattenTree(f, filter).rows
}

// ---------------------------------------------------------------------------
// 1. buildBlocks — header height, first-card height reduction, empty-project
//    suppression
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
  const headers = blocks.filter((b) => b.kind === 'project-header')
  assert.equal(headers.length, 2, 'both projects have surviving workspaces -> both headers emitted')
  // A header block is the project NAME only — no rule, no blank line. See the
  // REGRESSION GUARD block below for why this is pinned against
  // HEADER_RENDERED_ROWS (ProjectGroupHeader.tsx's actual render) rather than
  // a bare literal here.
  assert.equal(headers[0]!.height, HEADER_RENDERED_ROWS, 'a project header is 1 row: the name')
  assert.equal(
    headers[1]!.height,
    HEADER_RENDERED_ROWS,
    'every project header is 1 row, first or not — no inter-project blank line lives here'
  )

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
    '✓ buildBlocks: header is always 1 row, first card per group is reduced height, every workspace status -> a card block'
  )
}

// ---------------------------------------------------------------------------
// REGRESSION GUARD — the rendered header row count and blocks.ts's reported
// project-header block height must be the SAME NUMBER, asserted as a
// constant-equality check (not just "both equal HEADER_RENDERED_ROWS" in
// isolation) so a future edit to ProjectGroupHeader.tsx's JSX (e.g.
// reintroducing a rule or a blank line) that isn't mirrored in blocks.ts's
// `height: 1` — or vice versa — fails HERE instead of silently desyncing the
// windowing sum from what the terminal actually draws. See this file's
// mutation-test note in the task history: flipping either side alone without
// the other must fail this assertion.
// ---------------------------------------------------------------------------

{
  const f = frame(1, [
    project({ id: 'p1', name: 'proj-one', workspaces: [ws({ id: 'w1', name: 'w1' })] })
  ])
  const blocks = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
  const header = blocks.find((b) => b.kind === 'project-header')
  assert.ok(header != null)
  assert.equal(
    header!.height,
    HEADER_RENDERED_ROWS,
    'project-header block height must equal the row count ProjectGroupHeader.tsx actually renders (one <Text> line, no rule, no blank line)'
  )

  console.log(
    "✓ REGRESSION GUARD: project-header block height matches ProjectGroupHeader.tsx's rendered row count"
  )
}

// ---------------------------------------------------------------------------
// Group total height — the sum of a project's own blocks (header + every
// card) must equal the exact arithmetic App.tsx's windowing relies on:
// HEADER_RENDERED_ROWS + (CARD_HEIGHT - SEPARATOR_ROWS) for the first card +
// CARD_HEIGHT for every other card.
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
    const expectedTotal =
      HEADER_RENDERED_ROWS + (CARD_HEIGHT - SEPARATOR_ROWS) + CARD_HEIGHT * (count - 1)
    assert.equal(
      actualTotal,
      expectedTotal,
      `group of ${count} workspace(s): total block height must equal header + reduced-first-card + full-height rest`
    )
  }

  console.log(
    '✓ group total height matches HEADER_RENDERED_ROWS + reduced-first-card + full-height-rest for 1, 2, and 5 workspaces'
  )
}

{
  // Empty-project suppression: a project with zero workspaces, and a
  // project whose only workspace is filtered out under view:active, both
  // contribute NOTHING (not even a bare header).
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
  const headerProjectIds = blocksActiveView
    .filter((b) => b.kind === 'project-header')
    .map((b) => b.projectId)
  assert.deepEqual(
    headerProjectIds,
    ['has-active'],
    'under view:active, only the project with a surviving active workspace gets a header'
  )
  assert.equal(
    cardBlocks(blocksActiveView).length,
    1,
    'only the one active workspace becomes a card under view:active'
  )

  const blocksAllView = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT, SEPARATOR_ROWS)
  const headerProjectIdsAll = blocksAllView
    .filter((b) => b.kind === 'project-header')
    .map((b) => b.projectId)
  assert.deepEqual(
    headerProjectIdsAll,
    ['all-idle', 'has-active'],
    'under view:all, the idle-only project now has a surviving row and gets a header; the truly empty project still does not'
  )

  console.log('✓ buildBlocks: empty-project suppression holds under both view:active and view:all')
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
  const result = windowBlocks(blocks, 'w0', 100, 0)
  assert.equal(result.windowed, false, 'everything fits -> not windowed')
  assert.equal(result.visible.length, blocks.length)
  assert.equal(result.aboveCount, 0)
  assert.equal(result.belowCount, 0)
  console.log('✓ windowBlocks: passthrough when total block height fits the budget')
}

{
  // 10 workspaces: first card is (CARD_HEIGHT - SEPARATOR_ROWS) = 3 rows, the
  // other 9 are CARD_HEIGHT = 4 rows each, plus 1 header row = 1 + 3 + 9*4 =
  // 40 total. availableRows = 13 -> engages windowing.
  const blocks = manyWorkspaceBlocks(10)
  const totalHeight = blocks.reduce((s, b) => s + b.height, 0)
  assert.ok(totalHeight > 13, 'fixture must exceed the availableRows budget to engage windowing')

  const first = windowBlocks(blocks, 'w0', 13, 0)
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
  const second = windowBlocks(blocks, 'w1', 13, first.start)
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
  const atTop = windowBlocks(blocks, 'w0', budget, 0)
  const selectedLast = windowBlocks(blocks, 'w9', budget, atTop.start)
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
  const backToTop = windowBlocks(blocks, 'w0', budget, selectedLast.start)
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
  const atTop = windowBlocks(blocks, 'w0', budget, 0)
  const atBottom = windowBlocks(blocks, 'w9', budget, atTop.start)
  // Now select something in the middle that's already visible in the
  // bottom-anchored window — per the sticky-start contract this should NOT
  // move at all (already visible), which is itself evidence the clawback
  // isn't firing needlessly. Then force a case with real slack: select the
  // second-to-last workspace after being scrolled all the way to the end;
  // any slack should be reclaimed without losing the selection.
  const nearBottomSelected = windowBlocks(blocks, 'w8', budget, atBottom.start)
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
  const atTop = windowBlocks(blocks, 'w0', budget, 0)
  const visibleHeightTop = atTop.visible.reduce((s, b) => s + b.height, 0)
  assert.ok(
    visibleHeightTop <= contentBudget,
    'visible content height must never exceed the fixed content budget once windowed'
  )

  const atBottom = windowBlocks(blocks, 'w9', budget, atTop.start)
  const visibleHeightBottom = atBottom.visible.reduce((s, b) => s + b.height, 0)
  assert.ok(visibleHeightBottom <= contentBudget)

  console.log(
    '✓ windowBlocks: fixed AFFORDANCE_ROWS_WHEN_WINDOWED budget respected at multiple scroll positions'
  )
}

// ---------------------------------------------------------------------------
// Multi-project windowing with the new variable first-card height — keeps
// the selected card fully visible at the top, middle, and bottom of a list
// spanning several project groups, each with its own reduced-height first
// card. This is the exact shape App.tsx renders (several ProjectGroupHeader
// + WorkspaceCard runs back to back), unlike manyWorkspaceBlocks()'s
// single-project fixture above.
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
  // 4 projects * 3 workspaces each = 12 cards. Group height = 1 header + 3
  // (reduced first card) + 4 + 4 (two full cards) = 12 rows/group, 48 total.
  // Budget of 15 forces windowing well before the whole list fits.
  const blocks = multiProjectBlocks(4, 3)
  const budget = 15
  const totalHeight = blocks.reduce((s, b) => s + b.height, 0)
  assert.ok(totalHeight > budget, 'fixture must exceed the budget to engage windowing')

  // TOP: select the very first workspace of the very first project.
  const atTop = windowBlocks(blocks, 'p0-w0', budget, 0)
  assert.equal(atTop.windowed, true)
  assert.equal(atTop.start, 0, 'selecting the first workspace overall pins the window at the top')
  assert.ok(
    selectedCardFullyVisible(atTop, 'p0-w0'),
    'top: selected card (first card of first group, reduced height) must be fully visible'
  )

  // MIDDLE: select a workspace roughly in the middle of the flattened list —
  // the first workspace of the third project (p2-w0), itself a reduced-
  // height first-in-group card.
  const atMiddle = windowBlocks(blocks, 'p2-w0', budget, atTop.start)
  assert.ok(
    selectedCardFullyVisible(atMiddle, 'p2-w0'),
    'middle: selected first-in-group card of an interior project must be fully visible'
  )

  // BOTTOM: select the very last workspace of the very last project.
  const atBottom = windowBlocks(blocks, 'p3-w2', budget, atMiddle.start)
  assert.ok(
    selectedCardFullyVisible(atBottom, 'p3-w2'),
    'bottom: selected last card of the last group must be fully visible'
  )
  assert.equal(atBottom.belowCount, 0, 'scrolled to the very last card -> nothing left below')

  console.log(
    '✓ windowBlocks: multi-project list with variable first-card heights keeps the selection fully visible at top, middle, and bottom'
  )
}

{
  // Degenerate cases: zero availableRows, empty blocks list.
  const blocks = manyWorkspaceBlocks(3)
  const zeroRoom = windowBlocks(blocks, 'w0', 0, 0)
  assert.equal(zeroRoom.visible.length, 0)
  assert.equal(zeroRoom.windowed, true)
  assert.equal(zeroRoom.aboveCount, blocks.length)

  const emptyBlocks = windowBlocks([], null, 20, 0)
  assert.equal(emptyBlocks.visible.length, 0)
  assert.equal(emptyBlocks.windowed, false)
  assert.equal(emptyBlocks.aboveCount, 0)

  console.log('✓ windowBlocks: degenerate zero-room and empty-list cases handled without throwing')
}

console.log('\nAll tui-blocks assertions passed.')
