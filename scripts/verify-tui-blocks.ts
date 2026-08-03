// ---------------------------------------------------------------------------
// scripts/verify-tui-blocks.ts
//
// Assertion harness for the PURE block-construction + variable-height
// windowing module (packages/orpheus-cli/src/tui/blocks.ts), extracted from
// tui-otui/App.tsx's own `blocks`/`windowedBlocks` memos so the same logic
// can eventually be reused by an Ink port of the card UI.
//
// MUST PASS FULLY OFFLINE, ON LINUX, WITH NO TTY — mirrors
// scripts/verify-tui-layout.ts's own constraint. blocks.ts imports nothing
// from solid-js/@opentui/react/ink/electron/better-sqlite3; this script
// exercises buildBlocks/windowBlocks directly over plain DisplayRow[]
// fixtures built with flattenTree(), with no Solid signals or rendering
// involved.
//
// Covers:
//   1. buildBlocks: project-header height alternation (1 for the first
//      rendered group, 2 for subsequent ones), one `card` block per
//      workspace row regardless of status (including idle — the bug this
//      whole task fixes), and empty-project suppression (a project whose
//      workspaces are all filtered out contributes zero blocks, including
//      its own header).
//   2. windowBlocks: passthrough when total height fits, sticky window
//      start (no spurious recenter when the newly-selected block is
//      already fully visible — adjacent-selection case), forward/backward
//      nudge when selection falls outside the window, the "pull back if
//      there's slack" clawback, and the fixed AFFORDANCE_ROWS_WHEN_WINDOWED
//      budget once windowed.
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

const CARD_HEIGHT = 3

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
// 1. buildBlocks — header height alternation, uniform cards, empty-project
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

  const blocks = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT)
  const headers = blocks.filter((b) => b.kind === 'project-header')
  assert.equal(headers.length, 2, 'both projects have surviving workspaces -> both headers emitted')
  // A header block is the project NAME plus its underline RULE — the two are
  // one block so windowing can never scroll a name away from its own rule.
  assert.equal(
    headers[0]!.height,
    2,
    'the first rendered header is 2 rows: name + rule, no leading blank'
  )
  assert.equal(
    headers[1]!.height,
    3,
    'every subsequent header is 3 rows: leading blank + name + rule'
  )

  const cards = cardBlocks(blocks)
  assert.equal(cards.length, 5, 'one card block per workspace row, regardless of status')
  // THE BUG THIS TASK FIXES: idle workspaces get an ordinary `card` block,
  // not a separate collapsed/compact kind — assert directly against the
  // idle rows by id.
  const idleCard = cards.find((c) => c.row.workspaceId === 'w2')
  assert.ok(idleCard != null, 'idle workspace w2 must appear as a card block')
  assert.equal(idleCard!.height, CARD_HEIGHT, 'idle workspace card height equals every other card')
  const idleTwoCard = cards.find((c) => c.row.workspaceId === 'w5')
  assert.ok(
    idleTwoCard != null,
    'idle workspace w5 (in its own project) must appear as a card block'
  )
  assert.equal(idleTwoCard!.height, CARD_HEIGHT)
  for (const c of cards) {
    assert.equal(
      c.height,
      CARD_HEIGHT,
      `card for ${c.row.workspaceId} must be CARD_HEIGHT regardless of status`
    )
  }

  console.log(
    '✓ buildBlocks: header height alternation (1 then 2), every workspace status -> uniform card block'
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

  const blocksActiveView = buildBlocks(rowsFor(f, 'active'), CARD_HEIGHT)
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

  const blocksAllView = buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT)
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
  return buildBlocks(rowsFor(f, 'all'), CARD_HEIGHT)
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
  // 10 workspaces * 3 rows/card = 30 rows of cards, plus 1 header (first, so
  // height 1) = 31 total. availableRows = 13 -> engages windowing.
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
