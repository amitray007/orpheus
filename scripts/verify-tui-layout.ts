// ---------------------------------------------------------------------------
// scripts/verify-tui-layout.ts
//
// Assertion harness for `orpheus tui`'s PURE layout module
// (packages/orpheus-cli/src/tui/layout.ts) plus the tmux socket-name mapping
// in packages/orpheus-cli/src/paths.ts.
//
// MUST PASS FULLY OFFLINE, ON LINUX, WITH NO TTY. layout.ts imports nothing
// from react/ink/electron/better-sqlite3 — it's pure data transforms over
// plain objects, mirroring scripts/verify-model-picker.ts's own no-Electron/
// no-DB constraint. This script never mounts an Ink component and never opens
// a socket; it exercises the same functions the Ink layer (tui/App.tsx,
// tui/components/*) consumes, so a layout bug here is a layout bug there too.
//
// Covers:
//   1. resolveBreakpoint boundaries (51/52/103/104)
//   2. columnPlanFor totals at the three reference widths (44/80/104)
//   3. truncate() at various widths, including a name longer than the column
//   4. flattenTree: flat 1..N numbering across multiple projects,
//      attention-first ordering, child indentation, filter behaviour, empty tree
//   5. flattenTree with a single-project scope (--project): filtering to one
//      project, header suppression, numbering still holds
//   6. Status glyphs + isActiveStatus: single-width, colour-agnostic contract
//   7. scrollWindowFor: fits-without-windowing passthrough, fixed 2-row
//      affordance budget once windowing engages (never variable), selection
//      stays in view while scrolling
//   8. WorkspaceRow's gutter-carve-out width invariant: the selection gutter
//      (theme.gutterWidthFor) is carved OUT of columnPlanFor's own numWidth
//      budget, so a rendered row's total width must still equal plan.total
//      exactly at all three breakpoints — including the tightest real case,
//      a selected CHILD row (depth>0, "└ " indent) with a worktree marker
//   9. tmuxSocketNameForAppName for all four app variants
//   10. resolveEffectiveVariant / variantEmbeddedInPath — the cross-variant
//       talk guard (packages/orpheus-cli/src/paths.ts): agreeing variants,
//       disagreeing variants (invoked wins), env-vars-absent, malformed/
//       unrecognized paths, and the ORPHEUS_FORCE_CROSS_VARIANT escape hatch
//   11. extractSubscriptionErrorDetail / buildSubscriptionHttpError
//       (packages/orpheus-cli/src/socket-client.ts) — surfacing the
//       server's { ok: false, error } body on a non-200 /subscribe response
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  resolveBreakpoint,
  columnPlanFor,
  truncate,
  displayTitleFor,
  flattenTree,
  scrollWindowFor,
  isActiveStatus,
  statusGlyph,
  ATTENTION_GLYPH,
  WORKING_GLYPH,
  IDLE_GLYPH,
  CHILD_INDENT,
  type Breakpoint,
  type DisplayRow
} from '../packages/orpheus-cli/src/tui/layout.ts'
import type {
  TreeFrame,
  TreeProject,
  TreeWorkspace,
  WorkspaceStatus
} from '../packages/orpheus-cli/src/tui/types.ts'
import {
  tmuxSocketNameForAppName,
  resolveEffectiveVariant,
  variantEmbeddedInPath
} from '../packages/orpheus-cli/src/paths.ts'
import { gutterWidthFor } from '../packages/orpheus-cli/src/tui/theme.ts'
import {
  extractSubscriptionErrorDetail,
  buildSubscriptionHttpError
} from '../packages/orpheus-cli/src/socket-client.ts'
import {
  resolveSubscribeTimeoutMs,
  SERVER_DEFAULT_TIMEOUT_MS,
  SERVER_MAX_TIMEOUT_MS,
  SERVER_NO_DEADLINE_TIMEOUT_MS
} from '../src/main/subscribeTimeout.ts'
import { nextBackoffMs } from '../packages/orpheus-cli/src/tui/reconnect.ts'

// ---------------------------------------------------------------------------
// Fixture helpers
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

function workspaceRows(rows: DisplayRow[]): Array<Extract<DisplayRow, { kind: 'workspace' }>> {
  return rows.filter((r): r is Extract<DisplayRow, { kind: 'workspace' }> => r.kind === 'workspace')
}

// ---------------------------------------------------------------------------
// 1. resolveBreakpoint boundaries
// ---------------------------------------------------------------------------

{
  assert.equal(resolveBreakpoint(51), 'narrow', '51 cols must still be narrow (< 52)')
  assert.equal(resolveBreakpoint(52), 'medium', '52 cols is the first medium column count')
  assert.equal(resolveBreakpoint(103), 'medium', '103 cols is still medium (<= 103)')
  assert.equal(resolveBreakpoint(104), 'wide', '104 cols is the first wide column count')

  // Sanity at the extremes referenced by the spec (44/80/104 reference widths).
  assert.equal(resolveBreakpoint(44), 'narrow')
  assert.equal(resolveBreakpoint(80), 'medium')
  assert.equal(resolveBreakpoint(1), 'narrow')
  assert.equal(resolveBreakpoint(1000), 'wide')

  console.log('✓ resolveBreakpoint: exact boundaries at 51/52 and 103/104')
}

// ---------------------------------------------------------------------------
// 2. columnPlanFor — totals at the three reference widths
// ---------------------------------------------------------------------------

{
  const narrow = columnPlanFor('narrow', 44)
  assert.equal(narrow.total, 44, 'narrow plan at 44 cols must sum to exactly 44')
  assert.equal(
    narrow.numWidth +
      narrow.glyphWidth +
      narrow.nameWidth +
      narrow.worktreeWidth +
      narrow.statusWidth,
    44,
    'narrow plan fields must themselves sum to total'
  )

  const medium = columnPlanFor('medium', 80)
  assert.equal(medium.total, 80, 'medium plan at 80 cols must sum to exactly 80')
  assert.equal(
    medium.numWidth +
      medium.glyphWidth +
      medium.nameWidth +
      medium.worktreeWidth +
      medium.statusWidth,
    80
  )

  const wide = columnPlanFor('wide', 104)
  assert.equal(wide.total, 104, 'wide plan at 104 cols must sum to exactly 104')
  assert.equal(
    wide.numWidth + wide.glyphWidth + wide.nameWidth + wide.worktreeWidth + wide.statusWidth,
    104
  )

  // Widening/narrowing within a breakpoint reflows entirely into the name column.
  const wideAt150 = columnPlanFor('wide', 150)
  assert.equal(
    wideAt150.total,
    150,
    'plan total must track an arbitrary terminal width, not just the reference ones'
  )
  assert.equal(
    wideAt150.nameWidth,
    wide.nameWidth + (150 - 104),
    'extra width goes entirely to the name column'
  )

  // Below the fixed overhead + min name width, degrade gracefully rather than
  // producing a negative or zero name column.
  const tiny = columnPlanFor('narrow', 4)
  assert.ok(tiny.nameWidth >= 1, 'name column must never go below 1 char, even on a tiny terminal')

  console.log(
    '✓ columnPlanFor: totals sum to 44/80/104 at the reference widths, reflow correctly, degrade gracefully below minimum'
  )
}

// ---------------------------------------------------------------------------
// 3. truncate()
// ---------------------------------------------------------------------------

{
  assert.equal(
    truncate('short', 10),
    'short',
    'a name shorter than the width is returned unchanged'
  )
  assert.equal(
    truncate('exactly10c', 10),
    'exactly10c',
    'a name exactly at the width is returned unchanged'
  )
  assert.equal(
    truncate('this-is-a-very-long-workspace-name', 10),
    'this-is...',
    'longer than width: hard-truncate + 3-char ascii ellipsis, total length == width'
  )
  assert.equal(truncate('this-is-a-very-long-workspace-name', 10).length, 10)
  // A 3-char ellipsis doesn't fit in a 1- or 2-column budget the way the old
  // 1-char '…' always did — these degrade to as many literal dots as fit.
  assert.equal(truncate('anything', 1), '.', 'width 1 degrades to a single dot')
  assert.equal(truncate('anything', 2), '..', 'width 2 degrades to two dots')
  assert.equal(truncate('anything', 3), '...', 'width 3 exactly fits the ellipsis, no content')
  assert.equal(truncate('anything', 0), '', 'width 0 truncates to empty')
  assert.equal(truncate('anything', -5), '', 'negative width truncates to empty (never throws)')

  // Wide-unicode (CJK) case: Claude can write arbitrary text into an OSC
  // title, and each CJK character is 1 JS `.length` unit but 2 terminal
  // display columns. A char-count-only truncate would think a 10-char CJK
  // string like this one (20 display columns) fits inside a 10-column
  // budget and return it unclipped, corrupting alignment. The
  // display-width-aware implementation must clip it down to fit 10 columns
  // (7 columns of content budget minus the 3-char ascii ellipsis reserves 3
  // columns — see truncate()'s ELLIPSIS.length-aware budget), and every
  // prefix character it keeps must be one that was actually present in the
  // source string, in order (no mid-character corruption).
  const wide = '日本語のタイトルです' // 10 code points, 20 display columns
  const wideTruncated = truncate(wide, 10)
  assert.notEqual(
    wideTruncated,
    wide,
    'a 20-column string must not fit unclipped in a 10-column budget'
  )
  assert.ok(
    wideTruncated.endsWith('...'),
    'wide truncation still ends in the 3-char ascii ellipsis'
  )
  assert.ok(
    wide.startsWith(wideTruncated.slice(0, -3)),
    'kept prefix is a real prefix of the source'
  )

  console.log(
    '✓ truncate: unchanged under/at width, hard-truncated + ellipsis over width, degenerate widths handled, wide-unicode display-width-aware'
  )
}

// ---------------------------------------------------------------------------
// 3b. displayTitleFor() — title-primary-with-name-fallback rule
// ---------------------------------------------------------------------------

{
  assert.equal(
    displayTitleFor({ name: 'Workspace 1', lastTitle: null }),
    'Workspace 1',
    'null lastTitle falls back to name'
  )
  assert.equal(
    displayTitleFor({ name: 'Workspace 1', lastTitle: '' }),
    'Workspace 1',
    'empty-string lastTitle falls back to name'
  )
  assert.equal(
    displayTitleFor({ name: 'Workspace 1', lastTitle: '   ' }),
    'Workspace 1',
    'whitespace-only lastTitle falls back to name'
  )
  assert.equal(
    displayTitleFor({ name: 'Workspace 1', lastTitle: undefined }),
    'Workspace 1',
    'absent (undefined) lastTitle falls back to name'
  )
  assert.equal(
    displayTitleFor({ name: 'Workspace 1', lastTitle: 'Understand codebase structure' }),
    'Understand codebase structure',
    'a non-empty lastTitle wins over name'
  )
  assert.equal(
    displayTitleFor({ name: 'Workspace 1', lastTitle: '  Understand codebase structure  ' }),
    'Understand codebase structure',
    'a non-empty lastTitle is trimmed'
  )

  console.log(
    '✓ displayTitleFor: title wins when non-empty (trimmed), falls back to name when null/empty/whitespace/absent'
  )
}

// ---------------------------------------------------------------------------
// 4. flattenTree — numbering, attention-first ordering, indentation, filter, empty
// ---------------------------------------------------------------------------

{
  // 4a. Flat 1..N numbering across MULTIPLE projects (headers never consume a number).
  const twoProjects = frame(1, [
    project({
      id: 'p1',
      name: 'orpheus',
      workspaces: [
        ws({ id: 'p1-a', name: 'alpha', status: 'idle' }),
        ws({ id: 'p1-b', name: 'bravo', status: 'in_progress' })
      ]
    }),
    project({
      id: 'p2',
      name: 'sidecar',
      workspaces: [ws({ id: 'p2-a', name: 'charlie', status: 'idle' })]
    })
  ])

  const all = flattenTree(twoProjects, 'all')
  const headers = all.rows.filter((r) => r.kind === 'project-header')
  assert.equal(headers.length, 2, 'multi-project mode shows one header row per project')
  const indices = workspaceRows(all.rows).map((r) => r.index)
  assert.deepEqual(
    indices,
    [1, 2, 3],
    'flat 1..N numbering runs across ALL projects, not restarting per project'
  )
  assert.equal(all.totalCount, 3)
  assert.equal(all.visibleCount, 3)
  assert.equal(all.hiddenCount, 0)

  // 4b. Attention-first ordering: an 'attention' workspace sorts before an
  // earlier-declared 'in_progress'/'idle' sibling, regardless of input order.
  const attentionFrame = frame(1, [
    project({
      id: 'p1',
      name: 'orpheus',
      workspaces: [
        ws({ id: 'w-idle', name: 'idle-one', status: 'idle', sortOrder: 0 }),
        ws({ id: 'w-working', name: 'working-one', status: 'in_progress', sortOrder: 1 }),
        ws({ id: 'w-attention', name: 'attention-one', status: 'attention', sortOrder: 2 })
      ]
    })
  ])
  const attentionRows = workspaceRows(flattenTree(attentionFrame, 'all').rows)
  assert.deepEqual(
    attentionRows.map((r) => r.workspaceId),
    ['w-attention', 'w-working', 'w-idle'],
    'attention sorts first always, ahead of its declared sortOrder'
  )

  // 4c. Child indentation: a workspace whose parentWorkspaceId matches
  // another workspace in the SAME project gets depth 1+ and is placed
  // directly under its parent (pre-order), even though the wire format is a
  // flat array with no nesting.
  const nestedFrame = frame(1, [
    project({
      id: 'p1',
      name: 'orpheus',
      workspaces: [
        ws({ id: 'root', name: 'root-ws', status: 'idle' }),
        ws({ id: 'child', name: 'child-ws', status: 'idle', parentWorkspaceId: 'root' })
      ]
    })
  ])
  const nestedRows = workspaceRows(flattenTree(nestedFrame, 'all').rows)
  assert.deepEqual(
    nestedRows.map((r) => r.workspaceId),
    ['root', 'child'],
    'child follows its parent (pre-order)'
  )
  assert.equal(nestedRows[0]!.depth, 0, 'root workspace has depth 0')
  assert.equal(nestedRows[1]!.depth, 1, 'direct child has depth 1')

  // A dangling parentWorkspaceId (references nothing in this project) is
  // defensively treated as a root, never dropped or crashed on.
  const danglingFrame = frame(1, [
    project({
      id: 'p1',
      name: 'orpheus',
      workspaces: [
        ws({ id: 'orphan', name: 'orphan-ws', status: 'idle', parentWorkspaceId: 'does-not-exist' })
      ]
    })
  ])
  const danglingRows = workspaceRows(flattenTree(danglingFrame, 'all').rows)
  assert.equal(danglingRows.length, 1, 'a dangling parent reference must not drop the workspace')
  assert.equal(
    danglingRows[0]!.depth,
    0,
    'a dangling parent reference is treated as a root (depth 0)'
  )

  // 4d. Filter behaviour: 'active' hides idle/awaiting_input, keeps
  // attention/in_progress; hiddenCount reflects exactly what was hidden.
  const mixedFrame = frame(1, [
    project({
      id: 'p1',
      name: 'orpheus',
      workspaces: [
        ws({ id: 'a', name: 'a', status: 'attention' }),
        ws({ id: 'b', name: 'b', status: 'in_progress' }),
        ws({ id: 'c', name: 'c', status: 'awaiting_input' }),
        ws({ id: 'd', name: 'd', status: 'idle' })
      ]
    })
  ])
  const activeResult = flattenTree(mixedFrame, 'active')
  assert.deepEqual(
    workspaceRows(activeResult.rows).map((r) => r.workspaceId),
    ['a', 'b'],
    "'active' filter keeps only attention/in_progress"
  )
  assert.equal(
    activeResult.hiddenCount,
    2,
    "'active' filter hides the other two (awaiting_input, idle)"
  )
  assert.equal(activeResult.visibleCount, 2)
  assert.equal(activeResult.totalCount, 4)

  const allResult = flattenTree(mixedFrame, 'all')
  assert.equal(allResult.hiddenCount, 0, "'all' filter hides nothing")
  assert.equal(allResult.visibleCount, 4)
  // Numbering is still flat/sequential even when the filter changes what's visible.
  assert.deepEqual(
    workspaceRows(allResult.rows).map((r) => r.index),
    [1, 2, 3, 4]
  )

  // An active CHILD must not be hidden just because its idle parent is
  // filtered out of view — children are walked regardless of parent visibility.
  const activeChildFrame = frame(1, [
    project({
      id: 'p1',
      name: 'orpheus',
      workspaces: [
        ws({ id: 'idle-parent', name: 'idle-parent', status: 'idle' }),
        ws({
          id: 'busy-child',
          name: 'busy-child',
          status: 'in_progress',
          parentWorkspaceId: 'idle-parent'
        })
      ]
    })
  ])
  const activeChildRows = workspaceRows(flattenTree(activeChildFrame, 'active').rows)
  assert.deepEqual(
    activeChildRows.map((r) => r.workspaceId),
    ['busy-child'],
    'an active child stays visible under the active filter even when its parent is idle/hidden'
  )

  // 4e. Empty tree: no projects at all -> no rows, all counts zero, no throw.
  const empty = flattenTree(frame(1, []), 'active')
  assert.deepEqual(empty.rows, [])
  assert.equal(empty.hiddenCount, 0)
  assert.equal(empty.visibleCount, 0)
  assert.equal(empty.totalCount, 0)

  // A project with zero workspaces still gets a header (nothing to hide/crash on).
  const emptyProject = flattenTree(
    frame(1, [project({ id: 'p1', name: 'orpheus', workspaces: [] })]),
    'all'
  )
  assert.equal(emptyProject.rows.length, 1)
  assert.equal(emptyProject.rows[0]!.kind, 'project-header')

  console.log(
    '✓ flattenTree: flat cross-project numbering, attention-first ordering, child indentation (incl. dangling parents), active-filter hides idle/awaiting_input but never an active child, empty tree is a no-op'
  )
}

// ---------------------------------------------------------------------------
// 5. flattenTree with a single-project scope (--project)
// ---------------------------------------------------------------------------

{
  const twoProjects = frame(7, [
    project({
      id: 'p1',
      name: 'orpheus',
      workspaces: [
        ws({ id: 'p1-a', name: 'alpha', status: 'attention' }),
        ws({ id: 'p1-b', name: 'bravo', status: 'idle' })
      ]
    }),
    project({
      id: 'p2',
      name: 'sidecar',
      workspaces: [
        ws({ id: 'p2-a', name: 'charlie', status: 'attention' }),
        ws({ id: 'p2-b', name: 'delta', status: 'idle' })
      ]
    })
  ])

  const scoped = flattenTree(twoProjects, 'all', { id: 'p2', name: 'sidecar' })

  // Filters to exactly the one project's workspaces.
  const scopedIds = workspaceRows(scoped.rows).map((r) => r.workspaceId)
  assert.deepEqual(
    scopedIds,
    ['p2-a', 'p2-b'],
    "--project scope must show ONLY that project's workspaces"
  )
  assert.equal(scoped.totalCount, 2, 'scoped totalCount excludes the other project entirely')

  // Header suppression: no project-header row at all in single-project mode.
  const scopedHeaders = scoped.rows.filter((r) => r.kind === 'project-header')
  assert.equal(
    scopedHeaders.length,
    0,
    '--project scope must suppress the (now-redundant) project header row'
  )

  // Flat 1..N numbering still holds (starts at 1, contiguous) even though
  // only one project is in scope.
  assert.deepEqual(
    workspaceRows(scoped.rows).map((r) => r.index),
    [1, 2],
    'numbering still starts at 1 and is contiguous under single-project scope'
  )

  // A scope id that matches nothing in the frame yields an empty (not
  // crashing, not falling back to all-projects) result.
  const scopedToMissing = flattenTree(twoProjects, 'all', { id: 'does-not-exist', name: 'ghost' })
  assert.deepEqual(scopedToMissing.rows, [])
  assert.equal(scopedToMissing.totalCount, 0)

  console.log(
    '✓ flattenTree with a project scope: filters to exactly one project, suppresses its header row, numbering still starts at 1'
  )
}

// ---------------------------------------------------------------------------
// 6. Glyphs + isActiveStatus — single-width, colour-carries-meaning contract
// ---------------------------------------------------------------------------

{
  assert.equal(statusGlyph('attention'), ATTENTION_GLYPH)
  assert.equal(statusGlyph('in_progress'), WORKING_GLYPH)
  assert.equal(statusGlyph('awaiting_input'), IDLE_GLYPH)
  assert.equal(statusGlyph('idle'), IDLE_GLYPH)
  for (const glyph of [ATTENTION_GLYPH, WORKING_GLYPH, IDLE_GLYPH]) {
    assert.equal(
      [...glyph].length,
      1,
      `glyph "${glyph}" must be a single character (no emoji/ZWJ sequences)`
    )
  }
  assert.equal([...CHILD_INDENT].length, 2, 'CHILD_INDENT is the glyph + one separating space')

  assert.equal(isActiveStatus('attention'), true)
  assert.equal(isActiveStatus('in_progress'), true)
  assert.equal(isActiveStatus('awaiting_input'), false)
  assert.equal(isActiveStatus('idle'), false)

  console.log(
    "✓ status glyphs are single-width and colour-agnostic; isActiveStatus matches the active filter's contract"
  )
}

// ---------------------------------------------------------------------------
// 7. scrollWindowFor — fixed affordance budget, selection stays in view
// ---------------------------------------------------------------------------

{
  const rows: DisplayRow[] = Array.from({ length: 20 }, (_, i) => ({
    kind: 'workspace',
    index: i + 1,
    workspaceId: `w${i}`,
    projectId: 'p1',
    name: `w${i}`,
    status: 'idle',
    waitingFor: null,
    depth: 0,
    worktreeBranch: null,
    tmuxHosted: false
  }))

  // Fits entirely: passthrough, windowing does NOT engage, zero affordance rows reserved.
  const fits = scrollWindowFor(rows.slice(0, 5), 2, 10)
  assert.equal(fits.windowed, false, 'a list that fits must not engage windowing')
  assert.deepEqual(fits.visible, rows.slice(0, 5))
  assert.equal(fits.aboveCount, 0)
  assert.equal(fits.belowCount, 0)

  // Windowing engaged, selection near the END: aboveCount > 0, belowCount == 0.
  const nearEnd = scrollWindowFor(rows, 18, 8)
  assert.equal(nearEnd.windowed, true)
  assert.ok(nearEnd.aboveCount > 0, 'scrolling near the end must report rows scrolled off above')
  assert.equal(nearEnd.belowCount, 0, 'scrolling to the end must report nothing scrolled off below')
  assert.ok(
    nearEnd.visible.some((r) => r.kind === 'workspace' && r.workspaceId === 'w18'),
    'the selected row must stay inside the visible window'
  )

  // Windowing engaged, selection near the START: belowCount > 0, aboveCount == 0.
  const nearStart = scrollWindowFor(rows, 1, 8)
  assert.equal(nearStart.aboveCount, 0)
  assert.ok(nearStart.belowCount > 0)

  // Windowing engaged, selection in the MIDDLE: both directions have something scrolled off.
  const middle = scrollWindowFor(rows, 10, 8)
  assert.ok(middle.aboveCount > 0 && middle.belowCount > 0)

  // THE FIXED-BUDGET INVARIANT: once windowing engages at all, the reserved
  // affordance budget (and therefore the content window's height,
  // `availableRows - 2`) must be IDENTICAL regardless of scroll position —
  // never a variable 0/1/2 rows depending on whether one/both/neither
  // direction currently has something to show. This is what prevents the
  // content window from visibly reflowing as the user scrolls past an edge
  // (see ScrollWindow.windowed's doc comment in layout.ts).
  assert.equal(nearEnd.visible.length, nearStart.visible.length)
  assert.equal(nearStart.visible.length, middle.visible.length)
  assert.equal(
    middle.visible.length,
    8 - 2,
    'content window is always availableRows - 2 once windowed'
  )

  // Degenerate: zero available rows never throws, reports everything as scrolled off above.
  const noRoom = scrollWindowFor(rows, 5, 0)
  assert.deepEqual(noRoom.visible, [])
  assert.equal(noRoom.aboveCount, rows.length)

  console.log(
    '✓ scrollWindowFor: passthrough when the list fits, fixed affordance budget (content window height never changes mid-scroll), selection always stays visible, degenerate zero-room case handled'
  )
}

// ---------------------------------------------------------------------------
// 8. WorkspaceRow's gutter-carve-out width invariant
//
// Mirrors the arithmetic in tui/components/WorkspaceRow.tsx exactly (see its
// comment above `numLabel`): the gutter is carved OUT of numWidth's own
// budget, not added on top. This can't be asserted by rendering the actual
// Ink component here (this harness stays react/ink-free by design — see the
// file header), so it re-derives the same formula and checks it against
// columnPlanFor's total at all three breakpoints — including the tightest
// realistic case: a selected CHILD row (depth 1, "└ " indent) with a
// worktree marker present, at whichever breakpoint actually renders one
// (worktreeWidth is 0 at narrow, so that column simply doesn't exist there).
// ---------------------------------------------------------------------------

{
  function rowTotalWidth(breakpoint: Breakpoint, columns: number): number {
    const plan = columnPlanFor(breakpoint, columns)
    const gutterWidth = gutterWidthFor(breakpoint)
    // numLabel = digits (padStart to numWidth - gutterWidth - 1) + one trailing space.
    const numLabelWidth = Math.max(1, plan.numWidth - gutterWidth - 1) + 1
    return (
      gutterWidth +
      numLabelWidth +
      plan.glyphWidth +
      plan.nameWidth +
      plan.worktreeWidth +
      plan.statusWidth
    )
  }

  for (const [breakpoint, columns] of [
    ['narrow', 44],
    ['medium', 80],
    ['wide', 104]
  ] as const) {
    const plan = columnPlanFor(breakpoint, columns)
    assert.equal(
      rowTotalWidth(breakpoint, columns),
      plan.total,
      `${breakpoint} (${columns} cols): a rendered row's total width must equal plan.total exactly, even for a selected child row with a worktree marker (name/worktree content varies, but their COLUMN WIDTHS are fixed by the plan regardless of depth/worktree presence)`
    )
  }

  console.log(
    '✓ WorkspaceRow gutter-carve-out: row total width equals plan.total exactly at narrow/medium/wide, including the tightest case (selected child + worktree marker) — the gutter never overflows the 44-col narrow layout'
  )
}

// ---------------------------------------------------------------------------
// 9. tmuxSocketNameForAppName — all four app variants (docs/TUI_SPEC.md)
// ---------------------------------------------------------------------------

{
  assert.equal(tmuxSocketNameForAppName('Orpheus'), 'orpheus')
  assert.equal(tmuxSocketNameForAppName('Orpheus Dev'), 'orpheus-dev')
  assert.equal(tmuxSocketNameForAppName('Orpheus WT'), 'orpheus-wt')
  assert.equal(tmuxSocketNameForAppName('Orpheus Nightly'), 'orpheus-nightly')
  // Defensive default for an unrecognized name — must not throw, falls back to prod.
  assert.equal(tmuxSocketNameForAppName('Something Else'), 'orpheus')

  console.log(
    '✓ tmuxSocketNameForAppName: all four app variants map to distinct sockets (dev/wt/nightly never collide with prod)'
  )
}

// ---------------------------------------------------------------------------
// 10. resolveEffectiveVariant / variantEmbeddedInPath — cross-variant talk guard
// ---------------------------------------------------------------------------

{
  // Agreeing variants: invoked and ambient match — behavior is just "that variant".
  assert.equal(resolveEffectiveVariant({ invoked: 'dev', ambient: 'dev' }), 'dev')
  assert.equal(resolveEffectiveVariant({ invoked: 'prod', ambient: 'prod' }), 'prod')

  // Disagreeing variants: the invoked binary's own variant wins, NOT the
  // ambient/inherited one — this is the fix for the cross-talk bug (a Dev
  // binary invoked from a prod-hosted workspace shell must still target Dev).
  assert.equal(resolveEffectiveVariant({ invoked: 'dev', ambient: 'prod' }), 'dev')
  assert.equal(resolveEffectiveVariant({ invoked: 'prod', ambient: 'wt' }), 'prod')
  assert.equal(resolveEffectiveVariant({ invoked: 'nightly', ambient: 'dev' }), 'nightly')

  // Env-vars-absent cases: no shim-set signal at all.
  assert.equal(
    resolveEffectiveVariant({ ambient: 'dev' }),
    'dev',
    'no invoked signal falls back to ambient (bare SSH session inside a workspace terminal, pre-guard behavior)'
  )
  assert.equal(
    resolveEffectiveVariant({}),
    'prod',
    'neither var set (bare SSH/Terminal.app session) defaults to prod, same as before this guard existed'
  )

  // Malformed values: an unrecognized string on either side is treated as absent.
  assert.equal(resolveEffectiveVariant({ invoked: 'bogus', ambient: 'dev' }), 'dev')
  assert.equal(resolveEffectiveVariant({ invoked: 'dev', ambient: 'bogus' }), 'dev')
  assert.equal(resolveEffectiveVariant({ invoked: '', ambient: '' }), 'prod')

  // ORPHEUS_FORCE_CROSS_VARIANT=1 is the deliberate escape hatch: only when
  // BOTH a disagreement exists AND the flag is exactly "1" does ambient win.
  assert.equal(
    resolveEffectiveVariant({ invoked: 'dev', ambient: 'prod', forceCrossVariant: '1' }),
    'prod',
    'explicit force flag lets ambient win over invoked'
  )
  assert.equal(
    resolveEffectiveVariant({ invoked: 'dev', ambient: 'prod', forceCrossVariant: 'true' }),
    'dev',
    'anything other than the literal string "1" is NOT the escape hatch — must not accidentally match'
  )
  assert.equal(
    resolveEffectiveVariant({ invoked: 'dev', forceCrossVariant: '1' }),
    'dev',
    'force flag with no ambient value to fall back to still returns invoked'
  )

  // variantEmbeddedInPath — pure path parsing used to cross-check
  // ORPHEUS_CMD_SOCK/ORPHEUS_CMD_TOKEN_FILE overrides.
  assert.equal(
    variantEmbeddedInPath('/Users/x/Library/Application Support/Orpheus Dev/cmd.sock'),
    'dev'
  )
  assert.equal(
    variantEmbeddedInPath('/Users/x/Library/Application Support/Orpheus WT/cmd.sock'),
    'wt'
  )
  assert.equal(
    variantEmbeddedInPath('/Users/x/Library/Application Support/Orpheus Nightly/cmd.token'),
    'nightly'
  )
  assert.equal(
    variantEmbeddedInPath('/Users/x/Library/Application Support/Orpheus/cmd.sock'),
    'prod'
  )
  // No "Application Support" segment at all — e.g. a test harness path — is
  // left alone (undefined), matching pre-guard behavior for such overrides.
  assert.equal(variantEmbeddedInPath('/tmp/test-fixtures/custom.sock'), undefined)
  // "Application Support" present but an unrecognized app name under it.
  assert.equal(
    variantEmbeddedInPath('/Users/x/Library/Application Support/SomeOtherApp/cmd.sock'),
    undefined
  )

  console.log(
    '✓ resolveEffectiveVariant/variantEmbeddedInPath: invoked wins on disagreement, force escape hatch, malformed/absent inputs'
  )
}

// ---------------------------------------------------------------------------
// 11. extractSubscriptionErrorDetail / buildSubscriptionHttpError
// ---------------------------------------------------------------------------

{
  // The server's real shape: { ok: false, error: "..." } — commandServer.ts's
  // writeJsonResponse()/parseSubscribeRequestBody() error path.
  assert.equal(
    extractSubscriptionErrorDetail(
      '{"ok":false,"error":"workspaceIds must be a non-empty string[]"}'
    ),
    'workspaceIds must be a non-empty string[]'
  )

  // Malformed/absent bodies must not throw — caller falls back to a bare
  // status-only message in that case.
  assert.equal(extractSubscriptionErrorDetail(''), undefined)
  assert.equal(extractSubscriptionErrorDetail('   '), undefined)
  assert.equal(extractSubscriptionErrorDetail('not json'), undefined)
  assert.equal(extractSubscriptionErrorDetail('null'), undefined)
  assert.equal(extractSubscriptionErrorDetail('[]'), undefined)
  assert.equal(extractSubscriptionErrorDetail('{"ok":false}'), undefined)
  assert.equal(extractSubscriptionErrorDetail('{"error":123}'), undefined)
  assert.equal(extractSubscriptionErrorDetail('{"error":""}'), undefined)

  // buildSubscriptionHttpError: detail folded into the message when present,
  // falls back to the pre-existing bare-status message when absent —
  // preserves the exact prior copy so existing callers/tests matching on
  // "Orpheus subscription failed with HTTP 400" (no detail) still match.
  const withDetail = buildSubscriptionHttpError(400, '{"ok":false,"error":"bad request"}')
  assert.equal(withDetail.kind, 'http')
  assert.equal(withDetail.statusCode, 400)
  assert.equal(withDetail.message, 'Orpheus subscription failed with HTTP 400: bad request')

  const withoutDetail = buildSubscriptionHttpError(500, '')
  assert.equal(withoutDetail.kind, 'http')
  assert.equal(withoutDetail.message, 'Orpheus subscription failed with HTTP 500')

  const authWithDetail = buildSubscriptionHttpError(401, '{"ok":false,"error":"unauthorized"}')
  assert.equal(authWithDetail.kind, 'auth')
  assert.equal(
    authWithDetail.message,
    'Orpheus subscription authentication was rejected: unauthorized'
  )

  const authWithoutDetail = buildSubscriptionHttpError(401, '')
  assert.equal(authWithoutDetail.kind, 'auth')
  assert.equal(authWithoutDetail.message, 'Orpheus subscription authentication was rejected')

  console.log(
    '✓ extractSubscriptionErrorDetail/buildSubscriptionHttpError: server error body surfaced, malformed bodies degrade to bare-status message'
  )
}

// ---------------------------------------------------------------------------
// 12. resolveSubscribeTimeoutMs (src/main/subscribeTimeout.ts) — the /subscribe
//     server-side timeout resolution table (Layer 1 of the reconnect fix:
//     `timeoutMs: 0` used to be indistinguishable from "omitted" under the
//     old `> 0` guard, silently downgrading the TUI's long-lived tree-mode
//     subscription to the 5-minute default and getting killed by
//     commandServer.ts's own setTimeout at exactly 300s).
// ---------------------------------------------------------------------------

{
  // Omitted / non-number / NaN / negative, non-tree subscription (the
  // ws-wait shape: workspaceIds-based, includeTree=false) → 5 min default —
  // unchanged from the original inline logic.
  assert.equal(resolveSubscribeTimeoutMs(undefined, false), SERVER_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(null, false), SERVER_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs('300000', false), SERVER_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(Number.NaN, false), SERVER_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(-1, false), SERVER_DEFAULT_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(0 - 1, false), SERVER_DEFAULT_TIMEOUT_MS)

  // Explicit 0 (any subscription — the primary rule, never silently
  // overridden by includeTree or anything else) → no-deadline ceiling. This
  // is the exact case the TUI's `{ tree: true, timeoutMs: 0 }` payload now
  // hits (see tui/entry.ts, tui-otui/entry.ts).
  assert.equal(resolveSubscribeTimeoutMs(0, true), SERVER_NO_DEADLINE_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(0, false), SERVER_NO_DEADLINE_TIMEOUT_MS)

  // Omitted timeoutMs on a TREE-ONLY subscription (includeTree=true) — the
  // narrower UX-only nicety: a live tree view has no workspaceIds terminal
  // condition to wait for, so it also defaults to no-deadline rather than
  // the 5-minute ws-wait default.
  assert.equal(resolveSubscribeTimeoutMs(undefined, true), SERVER_NO_DEADLINE_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(Number.NaN, true), SERVER_NO_DEADLINE_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(-5, true), SERVER_NO_DEADLINE_TIMEOUT_MS)

  // Explicit positive value, non-tree subscription → respected (below the
  // 1-hour cap) — unchanged from the original behavior.
  assert.equal(resolveSubscribeTimeoutMs(10_000, false), 10_000)
  assert.equal(resolveSubscribeTimeoutMs(1, false), 1)

  // Explicit positive value, TREE subscription → an explicit caller-stated
  // deadline is NEVER silently discarded by includeTree — this is the
  // load-bearing invariant the "keyed off includeTree alone" draft of this
  // fix got wrong (see subscribeTimeout.ts's file header). A future tree
  // caller that DOES want a bounded wait must get exactly that bound.
  assert.equal(resolveSubscribeTimeoutMs(10_000, true), 10_000)

  // Over-cap explicit positive value (any subscription) → clamped to the
  // 1-hour SERVER_MAX_TIMEOUT_MS — unchanged from the original behavior.
  assert.equal(resolveSubscribeTimeoutMs(SERVER_MAX_TIMEOUT_MS + 1, false), SERVER_MAX_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(SERVER_MAX_TIMEOUT_MS * 10, false), SERVER_MAX_TIMEOUT_MS)
  assert.equal(resolveSubscribeTimeoutMs(SERVER_MAX_TIMEOUT_MS, false), SERVER_MAX_TIMEOUT_MS)

  // Sanity on the constants themselves — catches an accidental value edit
  // silently changing behavior without any of the above assertions moving.
  assert.equal(SERVER_DEFAULT_TIMEOUT_MS, 5 * 60 * 1000)
  assert.equal(SERVER_MAX_TIMEOUT_MS, 60 * 60 * 1000)
  assert.equal(SERVER_NO_DEADLINE_TIMEOUT_MS, 24 * 60 * 60 * 1000)

  console.log(
    '✓ resolveSubscribeTimeoutMs: explicit 0 always no-deadline, omitted+includeTree defaults to no-deadline, omitted otherwise 5min, positive respected up to 1h cap, explicit positive never overridden by includeTree'
  )
}

// ---------------------------------------------------------------------------
// 13. nextBackoffMs (packages/orpheus-cli/src/tui/reconnect.ts) — the client
//     reconnect backoff schedule (Layer 2 of the reconnect fix).
// ---------------------------------------------------------------------------

{
  // Deterministic random sources for reproducible bounds-testing.
  const always0 = (): number => 0
  const always1 = (): number => 0.999999 // just under 1 — random() never returns exactly 1
  const alwaysHalf = (): number => 0.5

  // Floor holds even when jitter rolls near 0 — this is the fix for the
  // UI-flicker failure mode (near-zero delays making "reconnecting…" and
  // the next failed attempt land in the same terminal frame).
  assert.equal(nextBackoffMs(1, always0), 200, 'MIN_DELAY_MS floor holds at attempt 1, jitter=0')
  assert.equal(nextBackoffMs(2, always0), 200, 'floor holds at attempt 2, jitter=0')
  assert.equal(nextBackoffMs(50, always0), 200, 'floor holds even at a very high attempt, jitter=0')

  // Growth is monotonic-ish across attempts at a fixed jitter fraction
  // (full jitter means the SAME random() draw scales with the exponential
  // base, so holding random() fixed isolates the exponential-growth part).
  const a1 = nextBackoffMs(1, alwaysHalf)
  const a2 = nextBackoffMs(2, alwaysHalf)
  const a3 = nextBackoffMs(3, alwaysHalf)
  const a4 = nextBackoffMs(4, alwaysHalf)
  assert.ok(a1 <= a2, `attempt 1 (${a1}) must not exceed attempt 2 (${a2})`)
  assert.ok(a2 <= a3, `attempt 2 (${a2}) must not exceed attempt 3 (${a3})`)
  assert.ok(a3 <= a4, `attempt 3 (${a3}) must not exceed attempt 4 (${a4})`)
  // Concretely: base 500ms, doubling, at random()=0.5 → 250, 500, 1000, 2000.
  assert.equal(a1, 250)
  assert.equal(a2, 500)
  assert.equal(a3, 1000)
  assert.equal(a4, 2000)

  // Hard cap (30s) holds even at a very high attempt number where the raw
  // exponential would otherwise be astronomically larger than the cap.
  assert.equal(nextBackoffMs(100, always1), 30_000 * 0.999999)
  assert.ok(nextBackoffMs(100, always1) <= 30_000, 'cap holds at attempt 100')
  assert.ok(nextBackoffMs(1000, always1) <= 30_000, 'cap holds at attempt 1000')

  // Jitter stays within [MIN_DELAY_MS, cappedExponential] bounds for a range
  // of injected deterministic random values, at an attempt where the
  // exponential is already at the 30s cap (attempt large enough that
  // BASE_DELAY_MS * 2^(attempt-1) exceeds MAX_DELAY_MS).
  for (const r of [0, 0.1, 0.25, 0.5, 0.75, 0.999999]) {
    const delay = nextBackoffMs(20, () => r)
    assert.ok(delay >= 200, `delay ${delay} for random()=${r} must be >= the 200ms floor`)
    assert.ok(delay <= 30_000, `delay ${delay} for random()=${r} must be <= the 30s cap`)
  }

  // attempt <= 0 is clamped to 1 (never a negative/zero exponent) — same
  // result as calling with attempt=1 explicitly.
  assert.equal(nextBackoffMs(0, alwaysHalf), nextBackoffMs(1, alwaysHalf))
  assert.equal(nextBackoffMs(-5, alwaysHalf), nextBackoffMs(1, alwaysHalf))

  // Default random source (Math.random, no explicit arg) never throws and
  // always stays within the documented bounds — smoke test for the default
  // parameter itself, not just the injectable override used everywhere above.
  for (let attempt = 1; attempt <= 10; attempt++) {
    const delay = nextBackoffMs(attempt)
    assert.ok(delay >= 200 && delay <= 30_000, `default-random delay ${delay} out of bounds`)
  }

  console.log(
    '✓ nextBackoffMs: 200ms floor holds at all attempts, exponential growth matches the documented formula, 30s cap holds at high attempts, jitter stays in bounds, attempt<=0 clamped to 1'
  )
}

console.log('\nAll tui-layout assertions passed.')
