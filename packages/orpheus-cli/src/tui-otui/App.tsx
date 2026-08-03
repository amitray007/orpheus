/**
 * tui-otui/App.tsx — root Solid component for the OpenTUI picker.
 *
 * ROOT LAYOUT SHAPE (docs/TUI_OPENTUI_DESIGN.md "Root layout")
 * -----------------------------------------------------------------------
 * Explicit `width`/`height` from useTerminalDimensions() on the outer box,
 * flexDirection="column", header/footer `flexShrink={0}`, body
 * `flexGrow={1} minHeight={0}` — minHeight=0 is LOAD-BEARING (flex children
 * otherwise refuse to shrink below content size and the layout overflows).
 * Ported directly from OpenCode's app.tsx:1089-1124.
 *
 * CARD REDESIGN — ONE LAYOUT, NOT THREE (supersedes the prior "three
 * genuinely different layouts" pass)
 * -----------------------------------------------------------------------
 * The prior OpenTUI pass branched narrow/medium/wide into three different
 * SHAPES (stacked rows / TextTable / TextTable+detail-pane). This pass
 * replaces the list body at EVERY breakpoint with the same 3-line
 * WorkspaceCard renderer, grouped by project (ProjectGroupHeader) — one
 * layout that breathes (spacing grows with width) rather than reflowing
 * into a different shape. The ONLY breakpoint-conditional structure left is
 * the wide-tier (>=120 cols) master/detail split: cards on the left,
 * DetailPane + VRule on the right — kept because it's an orthogonal
 * concern to the card-vs-table decision and still earns its space at that
 * width (see VRule.tsx's file header). tableColumnPlanFor/columnPlanFor and
 * the old WorkspaceTable/WorkspaceRow/ProjectHeaderRow components are gone.
 *
 * VARIABLE-HEIGHT BLOCK WINDOWING — WHY THIS DOESN'T REUSE tui/layout.ts's
 * scrollWindowFor DIRECTLY
 * -----------------------------------------------------------------------
 * scrollWindowFor operates on a flat DisplayRow[] where every row is
 * assumed to occupy exactly ONE terminal row. Cards are 3 terminal rows
 * each, project headers are 1 (2 including a leading blank line for every
 * project after the first), and view:all idle workspaces render as their
 * own compact 1-row blocks (see IdleWorkspaceRow.tsx) — none of that fits
 * scrollWindowFor's uniform-row assumption (cards alone already break it).
 * So this file builds its OWN small "Block" model (below): each DisplayRow
 * becomes one Block with a KNOWN terminal-row height, and `windowBlocks()`
 * finds the window of blocks that keeps the selected card fully in view
 * within the available body height, mirroring scrollWindowFor's spirit
 * (keep selection in view with a little context) but operating on heights
 * instead of counts. flattenTree() from
 * tui/layout.ts is still reused UNCHANGED for the row list itself (project
 * grouping, attention-first sibling ordering, active-filter, flat
 * numbering) — only the WINDOWING math is local to this file.
 *
 * MODEL/EFFORT LOOKUP — WHY THIS ISN'T THREADED THROUGH DisplayRow
 * -----------------------------------------------------------------------
 * tui/layout.ts's DisplayRow (workspace variant) doesn't carry model/effort
 * — extending it would mean editing tui/layout.ts, which is shared with the
 * Ink build and out of scope for this task. Instead, `modelEffortByWorkspaceId`
 * below builds a flat `workspaceId -> { model, effort }` lookup directly
 * from the raw `TreeFrame` (props.frame()), which DOES carry these fields
 * (see types.ts's TreeWorkspace). WorkspaceCard receives model/effort as
 * separate props from this lookup, not from its `row` prop.
 *
 * FRAME DELIVERY: PLAIN SIGNAL, NOT frameStore.ts's COALESCING STORE
 * -----------------------------------------------------------------------
 * tui/frameStore.ts exists to work around React's useSyncExternalStore
 * forcing a full-tree reconcile on every setState — it buffers frames and
 * flushes on a 32ms timer so ~20 socket frames/sec collapse into far fewer
 * renders. Solid doesn't have that problem: setFrame() inside entry.ts's
 * subscribe() callback updates a signal, and only the DOM-like nodes that
 * actually read that signal re-run — Solid's own fine-grained reactivity
 * already gives the batching/dedup effect frameStore.ts hand-rolls for Ink.
 * A `tree` frame received during a tight burst still results in one signal
 * write; Solid coalesces synchronous updates within a microtask by default.
 * No extra debounce was added after testing — see entry.ts's file header
 * for confirmation this was verified, not assumed.
 *
 * CONNECTION STATE MACHINE — THE STATES THIS TASK REQUIRES REAL UI FOR
 * -----------------------------------------------------------------------
 * connecting: no frame has arrived yet (frame() is null, disconnected() is
 *   null). Shown as a body-level "connecting…" message, distinct from the
 *   TitleBar's own connection text.
 * connected: frame() is non-null AND disconnected() is null. Normal picker UI.
 * reconnecting (RECONNECT-WITH-BACKOFF, see entry.ts's file header): the
 *   /subscribe `done` promise settled (resolved OR rejected) without OUR
 *   code closing the subscription, and entry.ts's attemptReconnect() is
 *   actively retrying. Reuses this SAME `disconnected` signal — no separate
 *   third signal — but with a message DISTINGUISHABLE from the terminal
 *   "connection lost" case below: entry.ts calls
 *   `setDisconnected('reconnecting… (attempt N)')` while a retry is in
 *   flight. isReconnecting() below detects this by checking the message
 *   text; the fallback UI shows a calmer "reconnecting" notice (no "press
 *   any key to quit" framing — that's reserved for the genuinely terminal
 *   case) even though quitting still works identically in both states (see
 *   entry.ts's useKeyboard note: quit must always be live).
 * disconnected mid-session (TERMINAL — reconnect exhausted or gave up, which
 *   per entry.ts's current policy only happens if render() itself rejects,
 *   since attemptReconnect() otherwise retries indefinitely): fully replaces
 *   the body with a visible, on-screen notice and requires a keypress before
 *   entry.ts's loop is allowed to resolve `runPickerOnce`.
 *
 * RENAME: filter -> view (card redesign) — see TitleBar.tsx's file header
 * for the full rationale. tui/layout.ts's real exported type is still named
 * `Filter` there (out of scope to rename — shared with the Ink build) and
 * its own `flattenTree(frame, filter, scope)` parameter is still literally
 * named `filter`. This file imports that type under the local alias `View`
 * (`type Filter as View`) so every type reference INSIDE tui-otui/ reads
 * "view" consistently — only the call into flattenTree() itself still
 * passes a `View`-typed value into a parameter tui/layout.ts calls `filter`,
 * which is fine (parameter names don't need to match at a call site). The
 * LOCAL signal/setter/keybinding are all named `view`/`setView`/`v`.
 */

import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { TextAttributes } from '@opentui/core'
import {
  flattenTree,
  type DisplayRow,
  type Filter as View,
  type ProjectScope
} from '../tui/layout.js'
import { resolveOtuiBreakpoint } from './breakpoints.js'
import type { TreeFrame, TreeWorkspace } from './types.js'
import { PALETTE } from './theme.js'
import { TitleBar } from './components/TitleBar.js'
import { Footer } from './components/Footer.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { ProjectGroupHeader } from './components/ProjectGroupHeader.js'
import { WorkspaceCard } from './components/WorkspaceCard.js'
import { IdleWorkspaceRow } from './components/IdleWorkspaceRow.js'
import { ScrollAffordance } from './components/ScrollAffordance.js'
import { DetailPane } from './components/DetailPane.js'
import { VRule } from './components/VRule.js'

export interface AppProps {
  scope?: ProjectScope
  /** Reactive accessor for the latest tree frame — null until the first frame lands. */
  frame: () => TreeFrame | null
  /**
   * Reactive accessor: non-null once the /subscribe connection has ended
   * (resolved or rejected) unexpectedly. Carries TWO distinguishable kinds
   * of message — see the file header's "CONNECTION STATE MACHINE" note and
   * `isReconnecting()` below: a "reconnecting… (attempt N)" message while
   * entry.ts's attemptReconnect() is actively retrying (transient, quit
   * still works, picker UI keeps trying to recover), or any other message
   * once reconnect has genuinely given up (terminal — requires a keypress
   * to quit).
   */
  disconnected: () => string | null
  onOpen: (workspaceId: string) => void
  onQuit: () => void
}

const FOOTER_ROWS = 1
const DETAIL_PANE_WIDTH = 42
const VRULE_WIDTH = 1
const CARD_HEIGHT = 3
/** Rows spent on the "more above/below" affordances once scrolling is
 *  engaged at all — always both, mirroring tui/layout.ts's
 *  ScrollWindow.windowed discipline (fixed budget, never variable, so the
 *  content window's height never changes mid-scroll). */
const AFFORDANCE_ROWS_WHEN_WINDOWED = 2

type WorkspaceRow = Extract<DisplayRow, { kind: 'workspace' }>

/** One renderable unit of the scrolling body, with a KNOWN terminal-row
 *  height — see the file header's "VARIABLE-HEIGHT BLOCK WINDOWING" note.
 *  `idle-row` is its own block kind (not batched into a group) because idle
 *  workspaces are now ordinary, individually selectable rows — see
 *  IdleWorkspaceRow.tsx's file header for why the prior collapsed-group
 *  treatment was dropped. */
type Block =
  | { kind: 'project-header'; projectId: string; projectName: string; height: number }
  | { kind: 'card'; row: WorkspaceRow; height: typeof CARD_HEIGHT }
  | { kind: 'idle-row'; row: WorkspaceRow; height: typeof IDLE_ROW_HEIGHT }

const IDLE_ROW_HEIGHT = 1

export function App(props: AppProps): JSX.Element {
  const dimensions = useTerminalDimensions()

  const [view, setView] = createSignal<View>('active')
  // Selection is tracked by WORKSPACE ID, not raw row index — a plain
  // numeric index clamped into bounds on frame changes stays IN BOUNDS
  // across a materially different tree (e.g. a reconnect after the Orpheus
  // app restarted, or workspaces created/archived/reordered while
  // disconnected) but can silently point at a DIFFERENT workspace than the
  // one actually highlighted — worse than an out-of-range index because
  // it's wrong without looking wrong. `null` means "no explicit selection
  // yet"; resolved against the CURRENT frame into `selectedRowIndex` below
  // (a derived memo, not the raw signal — everything else in this
  // component reads THAT, never `selectedRowIndexRaw` directly).
  const [selectedRowIndexRaw, setSelectedRowIndexRaw] = createSignal<string | null>(null)
  const [helpOpen, setHelpOpen] = createSignal(false)

  const breakpoint = createMemo(() => resolveOtuiBreakpoint(dimensions().width))

  const flattened = createMemo(() => {
    const f = props.frame()
    if (f == null)
      return { rows: [] as DisplayRow[], hiddenCount: 0, visibleCount: 0, totalCount: 0 }
    // NOTE: `view` (not `filter`) is the local name; flattenTree()'s own
    // parameter is still literally named/typed `filter: Filter` in
    // tui/layout.ts (out of scope to rename there) — the VALUE domain is
    // identical, only this file's own signal/prop names changed.
    return flattenTree(f, view(), props.scope)
  })

  // Idle workspaces are selectable and openable, exactly like every other
  // workspace — opening one is how you wake it up, so it's a primary action,
  // not an edge case (owner's call; supersedes the prior "idle rows collapse
  // into a non-selectable group" behavior). Under view:active, idle rows are
  // already absent from flattened().rows entirely (existing isActiveStatus/
  // filter behavior in tui/layout.ts) — this filter only needs to keep
  // 'workspace' rows generally, no idle-specific exclusion.
  const workspaceRows = createMemo(() =>
    flattened().rows.filter((r): r is WorkspaceRow => r.kind === 'workspace')
  )

  // Flat workspaceId -> TreeWorkspace lookup, built directly from the raw
  // frame (NOT from DisplayRow, which doesn't carry model/effort) — see the
  // file header's "MODEL/EFFORT LOOKUP" note.
  const workspaceById = createMemo(() => {
    const map = new Map<string, TreeWorkspace>()
    const f = props.frame()
    if (f == null) return map
    for (const project of f.projects) {
      for (const ws of project.workspaces) map.set(ws.id, ws)
    }
    return map
  })

  // Derived, not synced-via-effect: re-resolved from `selectedRowIndexRaw`
  // (a workspace id) against the CURRENT `workspaceRows()` on every read, so
  // a view toggle/frame update/reconnect-with-a-different-tree/
  // disappearing workspace can never leave the effective index silently
  // pointing at the wrong row. Falls back to index 0 when there's no
  // selection yet OR the previously-selected id is no longer present in
  // this frame — matching the Ink build's own fallback-to-0 behavior for
  // the same situation (see tui/App.tsx's `effectiveSelected`).
  const selectedRowIndex = createMemo(() => {
    const rows = workspaceRows()
    if (rows.length === 0) return 0
    const id = selectedRowIndexRaw()
    if (id == null) return 0
    const idx = rows.findIndex((r) => r.workspaceId === id)
    return idx >= 0 ? idx : 0
  })

  const selectedWorkspaceId = createMemo(() => {
    const row = workspaceRows()[selectedRowIndex()]
    return row?.workspaceId ?? null
  })

  const selectedRow = createMemo(
    (): WorkspaceRow | null => workspaceRows()[selectedRowIndex()] ?? null
  )

  const selectedProjectName = createMemo(() => {
    const row = selectedRow()
    if (row == null) return null
    const frame = props.frame()
    if (frame == null) return null
    return frame.projects.find((p) => p.id === row.projectId)?.name ?? null
  })

  // Reserved rows above the scrolling body: TitleBar is 1 row at narrow (no
  // rule/blank line), 2 rows at medium/wide (title row + a blank line — the
  // rule was dropped entirely, see TitleBar.tsx's file header). Footer is
  // always 1 row.
  const headerReserved = createMemo(() => (breakpoint() === 'narrow' ? 1 : 2))
  const availableRows = createMemo(() =>
    Math.max(0, dimensions().height - headerReserved() - FOOTER_ROWS)
  )

  // Card width == full available terminal width at every breakpoint (one
  // layout that breathes, not a fixed 44-col card floating in a wider
  // terminal) — narrowed by the detail pane + vertical rule budget only at
  // wide, so the card list doesn't compute a width wider than the space
  // it's actually given.
  const cardAreaWidth = createMemo(() =>
    breakpoint() === 'wide'
      ? Math.max(20, dimensions().width - DETAIL_PANE_WIDTH - VRULE_WIDTH)
      : dimensions().width
  )

  // ---- Build Blocks: project headers, cards, and (view:all only) idle
  // rows — idle workspaces are ordinary, individually selectable 1-row
  // blocks now (see IdleWorkspaceRow.tsx's file header), not a collapsed
  // group, so this just maps each workspace row to its Block kind while
  // preserving flattenTree's own ordering.
  //
  // EMPTY-PROJECT SUPPRESSION: flattenTree() (tui/layout.ts, out of scope —
  // deliberately, correctly, and test-locked) ALWAYS emits a project-header
  // row even for a project with zero workspaces. Rendering that bare header
  // with nothing under it is a presentation bug, not a data bug — fixed
  // HERE by buffering each project's own header+body into a pending group
  // and only committing it to `out` once at least one workspace row actually
  // survives the current view filter for that project. An empty project
  // (zero workspaces, or all its workspaces filtered out under view:active)
  // contributes NOTHING to the rendered list.
  const blocks = createMemo((): Block[] => {
    const rows = flattened().rows
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
      if (row.status === 'idle') {
        pendingBody.push({ kind: 'idle-row', row, height: IDLE_ROW_HEIGHT })
        continue
      }
      pendingBody.push({ kind: 'card', row, height: CARD_HEIGHT })
    }
    commitPendingGroup()
    return out
  })

  // ---- Windowing over Blocks (see file header's "VARIABLE-HEIGHT BLOCK
  // WINDOWING" note) — keeps the selected card's Block fully in view within
  // availableRows(), reserving a FIXED 2-row affordance budget for the
  // whole scrolling session once windowing engages at all (never a variable
  // 0/1/2, so the content window's own height never changes mid-scroll —
  // same discipline as tui/layout.ts's scrollWindowFor).
  //
  // STICKY WINDOW START, NOT RECOMPUTED-FROM-SCRATCH PER SELECTION — a first
  // version recomputed [start, end) fresh on every selection change via a
  // "walk out from the selected block" pass; that recentered the window even
  // when the newly-selected card was ALREADY fully visible, producing a
  // spurious scroll (e.g. moving from card 1 to card 2 when both already fit
  // on screen still shifted the window and popped a "more above" affordance
  // that shouldn't have appeared — caught live via tui-mcp's adjacent-
  // selection diff). Fixed by keeping `windowStartIndex` as PERSISTENT state
  // (a signal, not a memo) that's only nudged the MINIMUM amount needed to
  // bring the selected block back into view when it falls outside the
  // current window — exactly scrollWindowFor's "keep in view, don't
  // recenter" contract, just adapted to variable block heights.
  const [windowStartIndex, setWindowStartIndex] = createSignal(0)

  const windowedBlocks = createMemo(
    (): {
      visible: Block[]
      aboveCount: number
      belowCount: number
      windowed: boolean
    } => {
      const all = blocks()
      const totalHeight = all.reduce((sum, b) => sum + b.height, 0)
      const budget = availableRows()
      if (budget <= 0 || all.length === 0) {
        return { visible: [], aboveCount: all.length, belowCount: 0, windowed: all.length > 0 }
      }
      if (totalHeight <= budget) {
        setWindowStartIndex(0)
        return { visible: all, aboveCount: 0, belowCount: 0, windowed: false }
      }

      const contentBudget = Math.max(1, budget - AFFORDANCE_ROWS_WHEN_WINDOWED)
      const selectedId = selectedWorkspaceId()
      const selectedBlockIndex = Math.max(
        0,
        all.findIndex(
          (b) => (b.kind === 'card' || b.kind === 'idle-row') && b.row.workspaceId === selectedId
        )
      )

      // Clamp any prior start into the current block list's bounds first
      // (a frame update / view toggle can change block count out from under
      // a stale index).
      let start = Math.min(windowStartIndex(), Math.max(0, all.length - 1))

      const heightFrom = (from: number, to: number): number => {
        let sum = 0
        for (let i = from; i < to; i++) sum += all[i]!.height
        return sum
      }
      const endForStart = (s: number): number => {
        let used = 0
        let e = s
        while (e < all.length && used + all[e]!.height <= contentBudget) {
          used += all[e]!.height
          e++
        }
        // Always show at least the selected block itself even if it alone
        // exceeds contentBudget (shouldn't happen with a 3-line card + a
        // realistic terminal height, but never render zero rows).
        return Math.max(e, s + 1)
      }

      // Nudge `start` forward if the selection fell BELOW the current
      // window's end, or backward if it fell ABOVE the current start —
      // minimal adjustment, never a full recenter.
      let end = endForStart(start)
      if (selectedBlockIndex < start) {
        start = selectedBlockIndex
      } else if (selectedBlockIndex >= end) {
        // Walk start forward just far enough that selectedBlockIndex is the
        // LAST block that fits — mirrors how a real scrolling list reveals
        // one more row at a time rather than jumping to center.
        while (
          start < selectedBlockIndex &&
          heightFrom(start, selectedBlockIndex + 1) > contentBudget
        ) {
          start++
        }
      }
      end = endForStart(start)
      // If start is deep enough that the tail end no longer reaches the
      // list's end but there's slack (budget not fully used) and room to
      // pull start back down without losing the selection, prefer showing
      // more content — mirrors clampWindowStart's maxStart clamp so the
      // window never scrolls needlessly past the point where the remaining
      // content still fills the budget.
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

      setWindowStartIndex(start)

      const aboveHeight = heightFrom(0, start)
      const belowHeight = heightFrom(end, all.length)
      return {
        visible: all.slice(start, end),
        aboveCount: aboveHeight > 0 ? Math.max(1, start) : 0,
        belowCount: belowHeight > 0 ? Math.max(1, all.length - end) : 0,
        windowed: true
      }
    }
  )

  function moveSelection(delta: number): void {
    const rows = workspaceRows()
    const count = rows.length
    if (count === 0) return
    const current = selectedRowIndex()
    let next = current + delta
    if (next < 0) next = 0
    if (next >= count) next = count - 1
    const nextRow = rows[next]
    setSelectedRowIndexRaw(nextRow?.workspaceId ?? null)
  }

  useKeyboard((key) => {
    // Help overlay swallows all keys except the one that closes it — any
    // key closes it (matches the Ink version's "press any key to close").
    if (helpOpen()) {
      setHelpOpen(false)
      return
    }
    if (key.name === 'q' || key.name === 'escape') {
      props.onQuit()
      return
    }
    if (key.name === 'return') {
      const id = selectedWorkspaceId()
      if (id != null) props.onOpen(id)
      return
    }
    if (key.name === 'up' || key.name === 'k') {
      moveSelection(-1)
      return
    }
    if (key.name === 'down' || key.name === 'j') {
      moveSelection(1)
      return
    }
    if (key.name === 'v') {
      setView((f) => (f === 'active' ? 'all' : 'active'))
      return
    }
    if (key.name === '?') {
      setHelpOpen(true)
    }
  })

  // Never process.exit() — renderer.destroy() only, and only from entry.ts
  // after this component has unmounted. This component itself never calls
  // destroy(); it just signals intent via onQuit/onOpen.
  onCleanup(() => {
    // Nothing to clean up here directly — useKeyboard owns its own
    // teardown. This onCleanup exists as a documented anchor: if a future
    // change adds a resource here, it must be released here, not left to
    // process exit.
  })

  const connecting = createMemo(() => props.frame() == null && props.disconnected() == null)
  // See the file header's "reconnecting" bullet — entry.ts's attemptReconnect()
  // reuses `disconnected()` for BOTH the transient retry-in-progress notice
  // AND the terminal give-up notice, distinguished by this prefix check.
  // Keeping the distinguishing string in ONE place (this memo) rather than
  // matching it ad hoc at each render call site.
  const isReconnecting = createMemo(() => props.disconnected()?.startsWith('reconnecting') ?? false)
  const empty = createMemo(() => props.frame() != null && flattened().totalCount === 0)
  const filteredEmpty = createMemo(
    () => props.frame() != null && flattened().totalCount > 0 && flattened().visibleCount === 0
  )

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={PALETTE.background}
    >
      <TitleBar
        scope={props.scope}
        connected={props.frame() != null && props.disconnected() == null}
        disconnected={props.disconnected() != null && !isReconnecting()}
        view={view()}
        hiddenCount={flattened().hiddenCount}
        totalCount={flattened().totalCount}
        breakpoint={breakpoint()}
        palette={PALETTE}
        width={dimensions().width}
      />
      <box flexGrow={1} minHeight={0} flexDirection="column">
        <Show
          when={!helpOpen()}
          fallback={<HelpOverlay breakpoint={breakpoint()} palette={PALETTE} />}
        >
          <Show
            when={props.disconnected() == null || isReconnecting()}
            fallback={
              <box flexDirection="column" padding={1}>
                <text fg={PALETTE.attention} attributes={TextAttributes.BOLD}>
                  connection to Orpheus lost
                </text>
                <text fg={PALETTE.secondary}>{props.disconnected()}</text>
                <text fg={PALETTE.secondary}>press any key to quit</text>
              </box>
            }
          >
            <Show
              when={!isReconnecting()}
              fallback={
                // Reconnecting — reuses this exact "connecting…"-shaped body
                // slot (same padding/position as the plain connecting state
                // below) rather than adding new layout, per the "no third
                // signal / no new UI surface" constraint. Shows the attempt
                // detail from entry.ts's setDisconnected() call so a long
                // outage reads as "still trying", not a frozen screen.
                <box padding={1}>
                  <text fg={PALETTE.secondary}>{props.disconnected()}</text>
                </box>
              }
            >
              <Show
                when={!connecting()}
                fallback={
                  <box padding={1}>
                    <text fg={PALETTE.secondary}>connecting…</text>
                  </box>
                }
              >
                <Show
                  when={!empty() && !filteredEmpty()}
                  fallback={
                    <box padding={1}>
                      <text fg={PALETTE.secondary}>
                        {empty() ? 'no workspaces' : '(no workspaces — press v to show all)'}
                      </text>
                    </box>
                  }
                >
                  <box flexDirection="row" flexGrow={1} minHeight={0}>
                    <box flexDirection="column" flexGrow={1} minHeight={0}>
                      <Show when={windowedBlocks().windowed}>
                        <ScrollAffordance
                          count={windowedBlocks().aboveCount}
                          direction="up"
                          palette={PALETTE}
                        />
                      </Show>
                      <box flexDirection="column" flexGrow={1} minHeight={0}>
                        <For each={windowedBlocks().visible}>
                          {(block) => {
                            if (block.kind === 'project-header') {
                              return (
                                <ProjectGroupHeader
                                  name={block.projectName}
                                  palette={PALETTE}
                                  withLeadingBlank={block.height === 2}
                                />
                              )
                            }
                            if (block.kind === 'idle-row') {
                              return (
                                <IdleWorkspaceRow
                                  row={block.row}
                                  selected={block.row.workspaceId === selectedWorkspaceId()}
                                  width={cardAreaWidth()}
                                  palette={PALETTE}
                                />
                              )
                            }
                            const workspace = workspaceById().get(block.row.workspaceId)
                            return (
                              <WorkspaceCard
                                row={block.row}
                                model={workspace?.model ?? null}
                                effort={workspace?.effort ?? null}
                                selected={block.row.workspaceId === selectedWorkspaceId()}
                                width={cardAreaWidth()}
                                palette={PALETTE}
                              />
                            )
                          }}
                        </For>
                      </box>
                      <Show when={windowedBlocks().windowed}>
                        <ScrollAffordance
                          count={windowedBlocks().belowCount}
                          direction="down"
                          palette={PALETTE}
                        />
                      </Show>
                    </box>
                    <Show when={breakpoint() === 'wide'}>
                      <VRule palette={PALETTE} rows={availableRows()} />
                      <box width={DETAIL_PANE_WIDTH} flexShrink={0}>
                        <DetailPane
                          row={selectedRow()}
                          projectName={selectedProjectName()}
                          palette={PALETTE}
                        />
                      </box>
                    </Show>
                  </box>
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </box>
      <Footer notice={null} palette={PALETTE} breakpoint={breakpoint()} />
    </box>
  )
}
