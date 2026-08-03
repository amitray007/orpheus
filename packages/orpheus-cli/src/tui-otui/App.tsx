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
 * THREE GENUINELY DIFFERENT LAYOUTS, NOT ONE LAYOUT SCALED (visual redesign
 * pass, docs/TUI_UI_REDESIGN.md)
 * -----------------------------------------------------------------------
 * The first OpenTUI pass rendered the same shape at every width — a wide
 * terminal just got wider padding, not more information. This pass branches
 * on tui-otui/breakpoints.ts's resolveOtuiBreakpoint (a tui-otui-LOCAL
 * threshold set, ~60/120 — see that file's header for why it's not the
 * same resolveBreakpoint the Ink build uses):
 *   - narrow (<60): single column, stacked WorkspaceRow/ProjectHeaderRow —
 *     today's shape, composed through the new TitleBar/Rule/Footer devices.
 *   - medium (60-119): single column, but the list is now a REAL TextTable
 *     (WorkspaceTable.tsx) with status/name/branch/age columns, replacing
 *     the hand-computed padEnd row rendering.
 *   - wide (>=120): master/detail split — the SAME WorkspaceTable on the
 *     left, a DetailPane on the right showing the selected workspace's full
 *     detail. This is what fills the wide-terminal dead space with
 *     information instead of whitespace (docs/TUI_UI_REDESIGN.md problem
 *     #1) — the single vertical rule between panes is the ONLY vertical
 *     rule in the whole layout and only exists at this breakpoint (ghui
 *     device #2).
 *
 * SELECTION/SCROLLING STAYS UNIFIED ACROSS ALL THREE TIERS — one
 * `selectedRowIndex` signal, one `scrollWindowFor` call feeding whichever
 * tier is currently mounted. Only the RENDERING of a row differs by tier;
 * the keyboard/selection/scroll model is identical everywhere, so switching
 * tiers mid-session (a live resize crossing a breakpoint) never loses or
 * reshuffles the user's selection.
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
 *   TitleBar's own connecting/connected glyph.
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
 *   since attemptReconnect() otherwise retries indefinitely): THIS WAS AN
 *   EXPLICIT INK-VERSION BUG (task owner callout: entry.ts wrote to
 *   process.stderr AFTER the alt-screen had already torn down, so the
 *   message was invisible in practice). Fixed here by making
 *   "disconnected" a first-class piece of App state (setDisconnected, wired
 *   from entry.ts's subscription.done handlers) that fully replaces the
 *   body with a visible, on-screen notice and requires a keypress before
 *   entry.ts's loop is allowed to resolve `runPickerOnce`.
 *
 * HOST-REFUSED / COMMAND-FAILURE STATES
 * -----------------------------------------------------------------------
 * Both are OUTSIDE this component — they happen after the picker has
 * already resolved (the user pressed Enter and entry.ts is now awaiting
 * sendCommand('workspace.host', ...)). Rendering them correctly means NOT
 * tearing down the picker's alt-screen until the message has been shown and
 * acknowledged; see entry.ts's hostAndAttach() for how that's sequenced
 * (this component is unmounted/remounted per picker-loop iteration, so
 * these states render via plain process.stderr-free direct renderer text —
 * see entry.ts's renderNotice() helper — not through this component's own
 * signals).
 */

import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { TextAttributes } from '@opentui/core'
import {
  flattenTree,
  scrollWindowFor,
  type DisplayRow,
  type Filter,
  type ProjectScope
} from '../tui/layout.js'
import { resolveOtuiBreakpoint } from './breakpoints.js'
import type { TreeFrame } from './types.js'
import { PALETTE } from './theme.js'
import { useSpinnerVote } from './spinner.js'
import { TitleBar } from './components/TitleBar.js'
import { Footer } from './components/Footer.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { ProjectHeaderRow } from './components/ProjectHeaderRow.js'
import { WorkspaceRow } from './components/WorkspaceRow.js'
import { ScrollAffordance } from './components/ScrollAffordance.js'
import { WorkspaceTable, tableColumnPlanFor } from './components/WorkspaceTable.js'
import { DetailPane } from './components/DetailPane.js'
import { VRule } from './components/VRule.js'
import { columnPlanFor } from '../tui/layout.js'

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

export function App(props: AppProps): JSX.Element {
  const dimensions = useTerminalDimensions()

  const [filter, setFilter] = createSignal<Filter>('active')
  // Selection is tracked by WORKSPACE ID, not raw row index — a plain
  // numeric index clamped into bounds on frame changes (the previous
  // `createEffect` below did exactly that) stays IN BOUNDS across a
  // materially different tree (e.g. a reconnect after the Orpheus app
  // restarted, or workspaces created/archived/reordered while
  // disconnected) but can silently point at a DIFFERENT workspace than the
  // one actually highlighted — worse than an out-of-range index because
  // it's wrong without looking wrong. `null` means "no explicit selection
  // yet"; resolved against the CURRENT frame into `selectedRowIndex` below
  // (a derived memo, not the raw signal — everything else in this
  // component reads THAT, never `selectedRowIndexRaw` directly).
  const [selectedRowIndexRaw, setSelectedRowIndexRaw] = createSignal<string | null>(null)
  const [helpOpen, setHelpOpen] = createSignal(false)

  const breakpoint = createMemo(() => resolveOtuiBreakpoint(dimensions().width))
  // Narrow tier still uses the shared tui/layout.ts columnPlanFor (its own
  // row shape, WorkspaceRow.tsx, is unchanged from the pre-redesign build).
  const narrowPlan = createMemo(() => columnPlanFor('narrow', dimensions().width))

  const flattened = createMemo(() => {
    const f = props.frame()
    if (f == null)
      return { rows: [] as DisplayRow[], hiddenCount: 0, visibleCount: 0, totalCount: 0 }
    return flattenTree(f, filter(), props.scope)
  })

  const workspaceRows = createMemo(() => flattened().rows.filter((r) => r.kind === 'workspace'))

  // Any row currently in_progress? Drives the shared spinner timer's active
  // vote — see spinner.ts's file header for why this is a single vote at
  // the App root, not one per row.
  useSpinnerVote(() =>
    workspaceRows().some((r) => r.kind === 'workspace' && r.status === 'in_progress')
  )

  // Derived, not synced-via-effect: re-resolved from `selectedRowIndexRaw`
  // (a workspace id) against the CURRENT `workspaceRows()` on every read, so
  // a filter toggle/frame update/reconnect-with-a-different-tree/
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
    const idx = rows.findIndex((r) => r.kind === 'workspace' && r.workspaceId === id)
    return idx >= 0 ? idx : 0
  })

  // Reserved rows above the scrolling body: TitleBar is 1 row at narrow (no
  // rule), 2 rows at medium/wide (title row + Rule). Footer is always 1 row.
  const headerReserved = createMemo(() => (breakpoint() === 'narrow' ? 1 : 2))
  const availableRows = createMemo(() =>
    Math.max(0, dimensions().height - headerReserved() - FOOTER_ROWS)
  )

  // scrollWindowFor operates on the FULL row list (headers + workspace
  // rows), with selectedRowIndex expressed as an index into workspaceRows()
  // translated to its position in the full `rows` array.
  const selectedRowPositionInFullList = createMemo(() => {
    const wsRows = workspaceRows()
    const target = wsRows[selectedRowIndex()]
    if (target == null) return 0
    const idx = flattened().rows.indexOf(target)
    return idx < 0 ? 0 : idx
  })

  const scrollWindow = createMemo(() =>
    scrollWindowFor(flattened().rows, selectedRowPositionInFullList(), availableRows())
  )

  const selectedWorkspaceId = createMemo(() => {
    const row = workspaceRows()[selectedRowIndex()]
    return row?.kind === 'workspace' ? row.workspaceId : null
  })

  const selectedRow = createMemo((): Extract<DisplayRow, { kind: 'workspace' }> | null => {
    const row = workspaceRows()[selectedRowIndex()]
    return row?.kind === 'workspace' ? row : null
  })

  const selectedProjectName = createMemo(() => {
    const row = selectedRow()
    if (row == null) return null
    const frame = props.frame()
    if (frame == null) return null
    return frame.projects.find((p) => p.id === row.projectId)?.name ?? null
  })

  // Table column plan: at wide, the table's own pane width is narrowed by
  // the detail pane + vertical rule budget so the table doesn't compute a
  // name column wider than the space it's actually given.
  const tableWidth = createMemo(() =>
    breakpoint() === 'wide'
      ? Math.max(20, dimensions().width - DETAIL_PANE_WIDTH - VRULE_WIDTH)
      : dimensions().width
  )
  const tablePlan = createMemo(() => tableColumnPlanFor(breakpoint(), tableWidth()))

  function moveSelection(delta: number): void {
    const rows = workspaceRows()
    const count = rows.length
    if (count === 0) return
    const current = selectedRowIndex()
    let next = current + delta
    if (next < 0) next = 0
    if (next >= count) next = count - 1
    const nextRow = rows[next]
    setSelectedRowIndexRaw(nextRow?.kind === 'workspace' ? nextRow.workspaceId : null)
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
    if (key.name === 'f') {
      setFilter((f) => (f === 'active' ? 'all' : 'active'))
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
    // Nothing to clean up here directly — useKeyboard/useSpinnerVote own
    // their own teardown. This onCleanup exists as a documented anchor: if
    // a future change adds a resource here, it must be released here, not
    // left to process exit.
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

  const showTable = createMemo(() => breakpoint() !== 'narrow')

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
        filter={filter()}
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
                        {empty() ? 'no workspaces' : '(no workspaces — press f to show all)'}
                      </text>
                    </box>
                  }
                >
                  <box flexDirection="row" flexGrow={1} minHeight={0}>
                    <box flexDirection="column" flexGrow={1} minHeight={0}>
                      <Show when={scrollWindow().windowed}>
                        <ScrollAffordance
                          count={scrollWindow().aboveCount}
                          direction="up"
                          palette={PALETTE}
                        />
                      </Show>
                      <box flexDirection="column" flexGrow={1} minHeight={0}>
                        <Show
                          when={!showTable()}
                          fallback={
                            <WorkspaceTable
                              rows={() => scrollWindow().visible}
                              selectedWorkspaceId={selectedWorkspaceId}
                              plan={tablePlan}
                              palette={PALETTE}
                            />
                          }
                        >
                          <For each={scrollWindow().visible}>
                            {(row) =>
                              row.kind === 'project-header' ? (
                                <ProjectHeaderRow
                                  name={row.projectName}
                                  palette={PALETTE}
                                  breakpoint={breakpoint()}
                                  plan={narrowPlan()}
                                />
                              ) : (
                                <WorkspaceRow
                                  row={row}
                                  plan={narrowPlan()}
                                  selected={row.workspaceId === selectedWorkspaceId()}
                                  open={row.tmuxHosted}
                                  palette={PALETTE}
                                  breakpoint={breakpoint()}
                                />
                              )
                            }
                          </For>
                        </Show>
                      </box>
                      <Show when={scrollWindow().windowed}>
                        <ScrollAffordance
                          count={scrollWindow().belowCount}
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
