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
 *   false). Shown as a body-level "connecting…" message, distinct from the
 *   Header's own connecting/connected glyph.
 * connected: frame() is non-null. Normal picker UI.
 * disconnected mid-session: the /subscribe `done` promise settled (resolved
 *   OR rejected) without OUR code closing the subscription. THIS WAS AN
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

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { useKeyboard, useTerminalDimensions } from '@opentui/solid'
import { TextAttributes } from '@opentui/core'
import {
  columnPlanFor,
  flattenTree,
  resolveBreakpoint,
  scrollWindowFor,
  type DisplayRow,
  type Filter,
  type ProjectScope
} from '../tui/layout.js'
import type { TreeFrame } from './types.js'
import { PALETTE } from './theme.js'
import { useSpinnerVote } from './spinner.js'
import { Header } from './components/Header.js'
import { Footer } from './components/Footer.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { ProjectHeaderRow } from './components/ProjectHeaderRow.js'
import { WorkspaceRow } from './components/WorkspaceRow.js'
import { ScrollAffordance } from './components/ScrollAffordance.js'

export interface AppProps {
  scope?: ProjectScope
  /** Reactive accessor for the latest tree frame — null until the first frame lands. */
  frame: () => TreeFrame | null
  /** Reactive accessor: true once the /subscribe connection has ended (resolved or rejected) unexpectedly. */
  disconnected: () => string | null
  onOpen: (workspaceId: string) => void
  onQuit: () => void
}

const HEADER_ROWS_NARROW = 2
const HEADER_ROWS_WIDE = 3 // title + status + rule
const FOOTER_ROWS = 1

export function App(props: AppProps): JSX.Element {
  const dimensions = useTerminalDimensions()

  const [filter, setFilter] = createSignal<Filter>('active')
  const [selectedRowIndex, setSelectedRowIndex] = createSignal(0)
  const [helpOpen, setHelpOpen] = createSignal(false)

  const breakpoint = createMemo(() => resolveBreakpoint(dimensions().width))
  const plan = createMemo(() => columnPlanFor(breakpoint(), dimensions().width))

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

  // Clamp selection whenever the row list changes shape (filter toggle, a
  // workspace disappearing/appearing between frames).
  createEffect(() => {
    const count = workspaceRows().length
    if (count === 0) {
      setSelectedRowIndex(0)
      return
    }
    setSelectedRowIndex((i) => Math.min(Math.max(0, i), count - 1))
  })

  const headerReserved = createMemo(() =>
    breakpoint() === 'narrow' ? HEADER_ROWS_NARROW : HEADER_ROWS_WIDE
  )
  const availableRows = createMemo(() =>
    Math.max(0, dimensions().height - headerReserved() - FOOTER_ROWS)
  )

  // scrollWindowFor operates on the FULL row list (headers + workspace
  // rows), with selectedRowIndex expressed as an index into workspaceRows()
  // translated to its position in the full `rows` array — this mirrors
  // tui/App.tsx's own translation (kept local here since it's a small,
  // App-specific computation, not pure layout logic worth hoisting).
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

  function moveSelection(delta: number): void {
    const count = workspaceRows().length
    if (count === 0) return
    setSelectedRowIndex((i) => {
      const next = i + delta
      if (next < 0) return 0
      if (next >= count) return count - 1
      return next
    })
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
      <box flexShrink={0}>
        <Header
          scope={props.scope}
          connected={props.frame() != null && props.disconnected() == null}
          disconnected={props.disconnected() != null}
          filter={filter()}
          hiddenCount={flattened().hiddenCount}
          totalCount={flattened().totalCount}
          breakpoint={breakpoint()}
          palette={PALETTE}
        />
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="column">
        <Show
          when={!helpOpen()}
          fallback={<HelpOverlay breakpoint={breakpoint()} palette={PALETTE} />}
        >
          <Show
            when={props.disconnected() == null}
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
                <box flexDirection="column" flexGrow={1} minHeight={0}>
                  <Show when={scrollWindow().windowed}>
                    <ScrollAffordance
                      count={scrollWindow().aboveCount}
                      direction="up"
                      palette={PALETTE}
                    />
                  </Show>
                  <box flexDirection="column" flexGrow={1} minHeight={0}>
                    <For each={scrollWindow().visible}>
                      {(row) =>
                        row.kind === 'project-header' ? (
                          <ProjectHeaderRow
                            name={row.projectName}
                            palette={PALETTE}
                            breakpoint={breakpoint()}
                          />
                        ) : (
                          <WorkspaceRow
                            row={row}
                            plan={plan()}
                            selected={row.workspaceId === selectedWorkspaceId()}
                            open={row.tmuxHosted}
                            palette={PALETTE}
                            breakpoint={breakpoint()}
                          />
                        )
                      }
                    </For>
                  </box>
                  <Show when={scrollWindow().windowed}>
                    <ScrollAffordance
                      count={scrollWindow().belowCount}
                      direction="down"
                      palette={PALETTE}
                    />
                  </Show>
                </box>
              </Show>
            </Show>
          </Show>
        </Show>
      </box>
      <box flexShrink={0}>
        <Footer notice={null} palette={PALETTE} breakpoint={breakpoint()} />
      </box>
    </box>
  )
}
