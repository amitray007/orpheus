/**
 * tui/App.tsx — the Ink root component for `orpheus tui`.
 *
 * CARD REDESIGN — ONE LAYOUT, NOT THREE (port of tui-otui/App.tsx's Solid
 * version — see that file's header for the fuller design rationale this
 * preserves verbatim, translated to React/Ink)
 * -----------------------------------------------------------------------
 * Every breakpoint renders the list body with the same 3-line WorkspaceCard
 * (see components/WorkspaceCard.tsx), grouped by project
 * (ProjectGroupHeader) — one layout that breathes (spacing grows with
 * width) rather than reflowing into a different shape. The only
 * breakpoint-conditional structure is the wide-tier (>=120 cols)
 * master/detail split: cards on the left, DetailPane + VRule on the right.
 *
 * BREAKPOINT RESOLUTION — cardBreakpoints.ts, NOT layout.ts's
 * resolveBreakpoint. The two disagree on where "narrow" ends (59 vs 51) —
 * see cardBreakpoints.ts's file header for the real gap this closes.
 *
 * VARIABLE-HEIGHT BLOCK WINDOWING — blocks.ts's buildBlocks()/windowBlocks(),
 * NOT layout.ts's scrollWindowFor (which assumes one row per DisplayRow and
 * cannot window 3-line cards). flattenTree() from layout.ts is still reused
 * unchanged for the row list itself (project grouping, attention-first
 * sibling ordering, active-filter, flat numbering).
 *
 * MODEL/EFFORT/GITBRANCH LOOKUP — layout.ts's DisplayRow (workspace variant)
 * doesn't carry model/effort/gitBranch. `workspaceById` below builds a flat
 * `workspaceId -> TreeWorkspace` lookup directly from the raw `frame`
 * (frameStore's snapshot), which DOES carry these fields (see types.ts).
 * WorkspaceCard/DetailPane receive them as separate props from this lookup,
 * not from the `row` prop.
 *
 * SOLID -> REACT TRANSLATION: THE STICKY WINDOW START
 * -----------------------------------------------------------------------
 * tui-otui/App.tsx holds `windowStartIndex` in a Solid signal, written back
 * from a `createEffect` that reacts to the windowing memo's OWN computed
 * `start` (not `windowStartIndex()` itself, to avoid a self-referential
 * cycle). A naive React port using `useEffect` to mirror that write-back
 * would render ONE FRAME with the STALE window before the effect fires
 * (effects run after paint), visible as a one-frame flash of the wrong
 * window on selection changes that cross a window boundary. A ref mutated
 * during render was tried first but rejected: this repo's `react-hooks/refs`
 * lint rule (React Compiler's ESLint plugin) hard-errors on both reading
 * and writing a ref's `.current` during render, since it can't verify the
 * safety invariant a human reviewer could. Fixed instead with React's own
 * documented "adjust state during render" pattern: `windowStart` is
 * `useState`, and calling its setter mid-render — when the freshly computed
 * `windowBlocks().start` differs from the current state — triggers an
 * immediate re-render before paint (React bails out of committing the
 * stale render), converging in the same tick with no visible flash and no
 * extra effect pass.
 *
 * Terminal dimensions come from Ink 7's native `useWindowSize()`.
 */

import * as React from 'react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import {
  flattenTree,
  truncate,
  type Breakpoint,
  type DisplayRow,
  type Filter,
  type ProjectScope
} from './layout.js'
import { CARD_MEDIUM_MAX, resolveCardBreakpoint } from './cardBreakpoints.js'
import { buildBlocks, windowBlocks, type Block } from './blocks.js'
import { frameStore } from './frameStore.js'
import { connectionStore } from './connectionStore.js'
import { TitleBar } from './components/TitleBar.js'
import { Footer } from './components/Footer.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { ProjectGroupHeader } from './components/ProjectGroupHeader.js'
import { WorkspaceCard } from './components/WorkspaceCard.js'
import { ScrollAffordance } from './components/ScrollAffordance.js'
import { DetailPane } from './components/DetailPane.js'
import { VRule } from './components/VRule.js'
import { activePalette } from './theme.js'
import type { Palette } from './theme.js'
import type { TreeWorkspace } from './types.js'

export interface AppProps {
  /** Set when `--project` narrows the picker to a single project. */
  scope?: ProjectScope
  onOpen: (workspaceId: string) => void
  onQuit: () => void
}

const FOOTER_ROWS = 1
const DETAIL_PANE_WIDTH = 42
const VRULE_WIDTH = 1
/** Every workspace card is exactly this many terminal rows — see
 *  blocks.ts's file header for why this is a caller-supplied parameter
 *  rather than a constant baked into that module. */
const CARD_HEIGHT = 3
/** Master/detail split engages at this width — one more than
 *  cardBreakpoints.ts's own CARD_MEDIUM_MAX, so this can never drift out of
 *  sync with resolveCardBreakpoint()'s own wide-tier threshold the way the
 *  hardcoded 120 previously could (see cardBreakpoints.ts's file header for
 *  the bug that caused). */
const WIDE_MIN_COLUMNS = CARD_MEDIUM_MAX + 1

type WorkspaceDisplayRow = Extract<DisplayRow, { kind: 'workspace' }>

function isWorkspaceRow(row: DisplayRow): row is WorkspaceDisplayRow {
  return row.kind === 'workspace'
}

/** Reserved rows above the scrolling body: TitleBar is 1 row at narrow, 2 at
 *  medium/wide (title row + a blank line — see TitleBar.tsx). Footer is
 *  always 1 row. */
function headerReservedFor(breakpoint: Breakpoint): number {
  return breakpoint === 'narrow' ? 1 : 2
}

/**
 * Handles a single non-navigation, non-quit, non-help keypress: view
 * cycling. Extracted from the main useInput callback to keep its cognitive
 * complexity down (mirrors the pre-redesign App.tsx's handleActionKey).
 */
function handleViewKey(input: string, setView: React.Dispatch<React.SetStateAction<Filter>>): void {
  if (input === 'v') {
    setView((f) => (f === 'active' ? 'all' : 'active'))
  }
}

interface PickerBodyProps {
  windowedBlocks: ReturnType<typeof windowBlocks>
  cardAreaWidth: number
  selectedWorkspaceId: string | null
  selectedRow: WorkspaceDisplayRow | null
  selectedProjectName: string | null
  workspaceById: Map<string, TreeWorkspace>
  isWide: boolean
  availableRows: number
  palette: Palette
}

/**
 * The card list + (at wide) detail pane split — extracted from App() itself
 * so the map/conditional nesting doesn't count against App()'s own
 * cognitive-complexity budget (sonarjs/cognitive-complexity, capped at 20).
 */
function PickerBody({
  windowedBlocks,
  cardAreaWidth,
  selectedWorkspaceId,
  selectedRow,
  selectedProjectName,
  workspaceById,
  isWide,
  availableRows,
  palette
}: PickerBodyProps): React.JSX.Element {
  return (
    <Box flexDirection="row">
      <Box flexDirection="column">
        {windowedBlocks.windowed ? (
          <ScrollAffordance count={windowedBlocks.aboveCount} direction="up" palette={palette} />
        ) : null}
        <Box flexDirection="column">
          {windowedBlocks.visible.map((block) => {
            if (block.kind === 'project-header') {
              return (
                <ProjectGroupHeader
                  key={`project-${block.projectId}`}
                  name={truncate(block.projectName, cardAreaWidth)}
                  palette={palette}
                  withLeadingBlank={block.height === 2}
                />
              )
            }
            const workspace = workspaceById.get(block.row.workspaceId)
            return (
              <WorkspaceCard
                key={block.row.workspaceId}
                row={block.row}
                model={workspace?.model ?? null}
                effort={workspace?.effort ?? null}
                gitBranch={workspace?.gitBranch ?? null}
                selected={block.row.workspaceId === selectedWorkspaceId}
                width={cardAreaWidth}
                palette={palette}
              />
            )
          })}
        </Box>
        {windowedBlocks.windowed ? (
          <ScrollAffordance count={windowedBlocks.belowCount} direction="down" palette={palette} />
        ) : null}
      </Box>
      {isWide ? (
        <>
          <VRule palette={palette} rows={availableRows} />
          <Box width={DETAIL_PANE_WIDTH} flexShrink={0}>
            <DetailPane
              row={selectedRow}
              projectName={selectedProjectName}
              gitBranch={workspaceById.get(selectedRow?.workspaceId ?? '')?.gitBranch ?? null}
              palette={palette}
              width={Math.max(0, DETAIL_PANE_WIDTH - 2)}
              rows={availableRows}
            />
          </Box>
        </>
      ) : null}
    </Box>
  )
}

export function App({ scope, onOpen, onQuit }: AppProps): React.JSX.Element {
  const frame = useSyncExternalStore(
    frameStore.subscribe,
    frameStore.getSnapshot,
    frameStore.getSnapshot
  )
  // Reconnect/disconnected notice — see connectionStore.ts's header for why
  // this is a separate store from frameStore.
  const connectionNotice = useSyncExternalStore(
    connectionStore.subscribe,
    connectionStore.getSnapshot,
    connectionStore.getSnapshot
  )
  const { columns, rows } = useWindowSize()
  const [view, setView] = useState<Filter>('active')
  // Selection is tracked by WORKSPACE ID, not raw row index — see tui-otui/
  // App.tsx's identical note: a plain numeric index clamped into bounds
  // across a materially different tree (reconnect, workspaces created/
  // archived/reordered while disconnected) can silently point at a
  // DIFFERENT workspace than the one actually highlighted. `null` means "no
  // explicit selection yet"; resolved against the CURRENT frame into
  // `selectedWorkspaceId` below (a derived value, not this raw state —
  // everything else in this component reads THAT).
  const [selectedWorkspaceIdRaw, setSelectedWorkspaceIdRaw] = useState<string | null>(null)
  const [helpVisible, setHelpVisible] = useState(false)

  const palette = activePalette

  const flattened = useMemo(
    () =>
      frame != null
        ? flattenTree(frame, view, scope)
        : { rows: [] as DisplayRow[], hiddenCount: 0, visibleCount: 0, totalCount: 0 },
    [frame, view, scope]
  )

  // Idle workspaces are selectable and openable, exactly like every other
  // workspace — opening one is how you wake it up. Under view:active, idle
  // rows are already absent from flattened.rows entirely (existing
  // isActiveStatus/filter behavior in layout.ts).
  const workspaceRows = useMemo(() => flattened.rows.filter(isWorkspaceRow), [flattened])

  // Flat workspaceId -> TreeWorkspace lookup, built directly from the raw
  // frame (NOT from DisplayRow, which doesn't carry model/effort/gitBranch)
  // — see the file header's "MODEL/EFFORT/GITBRANCH LOOKUP" note.
  const workspaceById = useMemo(() => {
    const map = new Map<string, TreeWorkspace>()
    if (frame == null) return map
    for (const project of frame.projects) {
      for (const ws of project.workspaces) map.set(ws.id, ws)
    }
    return map
  }, [frame])

  // Derived, not synced-via-effect: re-resolved from `selectedWorkspaceIdRaw`
  // against the CURRENT `workspaceRows` every render (see tui-otui/App.tsx's
  // identical `selectedRowIndex` memo for the full rationale). Falls back to
  // index 0 when there's no selection yet OR the previously-selected id is
  // no longer present in this frame.
  const selectedRowIndex = useMemo(() => {
    if (workspaceRows.length === 0) return 0
    if (selectedWorkspaceIdRaw == null) return 0
    const idx = workspaceRows.findIndex((r) => r.workspaceId === selectedWorkspaceIdRaw)
    return idx >= 0 ? idx : 0
  }, [workspaceRows, selectedWorkspaceIdRaw])

  const selectedRow = workspaceRows[selectedRowIndex] ?? null
  const selectedWorkspaceId = selectedRow?.workspaceId ?? null

  const selectedProjectName = useMemo(() => {
    if (selectedRow == null || frame == null) return null
    return frame.projects.find((p) => p.id === selectedRow.projectId)?.name ?? null
  }, [selectedRow, frame])

  function moveSelection(delta: number): void {
    const count = workspaceRows.length
    if (count === 0) return
    let next = selectedRowIndex + delta
    if (next < 0) next = 0
    if (next >= count) next = count - 1
    setSelectedWorkspaceIdRaw(workspaceRows[next]?.workspaceId ?? null)
  }

  useInput((input, key) => {
    if (helpVisible) {
      setHelpVisible(false)
      return
    }
    if (input === 'q' || key.escape) {
      onQuit()
      return
    }
    if (input === '?') {
      setHelpVisible(true)
      return
    }
    if (key.return) {
      if (selectedWorkspaceId != null) onOpen(selectedWorkspaceId)
      return
    }
    if (key.downArrow || input === 'j') {
      moveSelection(1)
      return
    }
    if (key.upArrow || input === 'k') {
      moveSelection(-1)
      return
    }
    handleViewKey(input, setView)
  })

  const breakpoint = resolveCardBreakpoint(columns)
  const isWide = columns >= WIDE_MIN_COLUMNS

  const headerReserved = headerReservedFor(breakpoint)
  const availableRows = Math.max(0, rows - headerReserved - FOOTER_ROWS)

  // Card width == full available terminal width at every breakpoint —
  // narrowed by the detail pane + vertical rule budget only at wide.
  const cardAreaWidth = isWide ? Math.max(20, columns - DETAIL_PANE_WIDTH - VRULE_WIDTH) : columns

  const blocks = useMemo((): Block[] => buildBlocks(flattened.rows, CARD_HEIGHT), [flattened])

  // STICKY WINDOW START — see file header's "SOLID -> REACT TRANSLATION"
  // note. `windowStart` is state, not a ref: React's documented "adjust
  // state during render" pattern (calling the setter mid-render when the
  // freshly-computed value differs from the current one) immediately
  // re-renders before paint, with no flash of a stale window and no
  // ref-mutation-during-render lint violation (react-hooks/refs forbids
  // exactly that). windowBlocks() is a pure function of its arguments;
  // calling it again next render with the corrected `windowStart` converges
  // in the same tick.
  const [windowStart, setWindowStart] = useState(0)
  const windowedBlocks = windowBlocks(blocks, selectedWorkspaceId, availableRows, windowStart)
  if (windowedBlocks.start !== windowStart) {
    setWindowStart(windowedBlocks.start)
  }

  const connecting = frame == null && connectionNotice == null
  const empty = frame != null && flattened.totalCount === 0
  const filteredEmpty = frame != null && flattened.totalCount > 0 && flattened.visibleCount === 0

  return (
    <Box flexDirection="column">
      <TitleBar
        scope={scope}
        connected={frame != null && connectionNotice == null}
        disconnected={connectionNotice != null}
        view={view}
        hiddenCount={flattened.hiddenCount}
        totalCount={flattened.totalCount}
        breakpoint={breakpoint}
        palette={palette}
        width={columns}
      />
      <Box flexDirection="column">
        {connectionNotice != null ? (
          <Text color={palette.secondary}>{connectionNotice}</Text>
        ) : connecting ? (
          <Text color={palette.secondary}>Connecting to Orpheus…</Text>
        ) : empty || filteredEmpty ? (
          <Text color={palette.secondary}>
            {empty ? 'no workspaces' : '(no workspaces — press v to show all)'}
          </Text>
        ) : (
          <PickerBody
            windowedBlocks={windowedBlocks}
            cardAreaWidth={cardAreaWidth}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedRow={selectedRow}
            selectedProjectName={selectedProjectName}
            workspaceById={workspaceById}
            isWide={isWide}
            availableRows={availableRows}
            palette={palette}
          />
        )}
      </Box>
      {helpVisible ? (
        <HelpOverlay breakpoint={breakpoint} palette={palette} />
      ) : (
        <Footer notice={null} palette={palette} breakpoint={breakpoint} />
      )}
    </Box>
  )
}
