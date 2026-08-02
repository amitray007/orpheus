/**
 * tui/App.tsx — the Ink root component for `orpheus tui`.
 *
 * All layout/ordering/filtering/windowing math is delegated to tui/layout.ts
 * (pure, covered by scripts/verify-tui-layout.ts). This component owns only
 * interactive/presentational state: the current filter, the highlighted
 * row, the help-overlay visibility, and a transient "not yet wired" notice.
 *
 * The live `tree` frame is read from tui/frameStore.ts via
 * `useSyncExternalStore`, NOT passed as a prop — frames arrive from OUTSIDE
 * React (tui/entry.ts's /subscribe callback pushes into the store) and this
 * is what lets Ink diff normally instead of reconciling a fresh element tree
 * on every frame (see entry.ts's file header).
 *
 * Terminal dimensions come from Ink 7's NATIVE `useWindowSize()` (columns
 * AND rows, auto-resubscribing on resize) rather than a hand-rolled
 * `process.stdout.columns`/`.rows` + manual resize-listener pair — fewer
 * moving parts, and it's the same hook Ink itself uses internally.
 */

import * as React from 'react'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import {
  columnPlanFor,
  flattenTree,
  resolveBreakpoint,
  scrollWindowFor,
  truncate,
  type Breakpoint,
  type DisplayRow,
  type Filter,
  type ProjectScope
} from './layout.js'
import { frameStore } from './frameStore.js'
import { Header } from './components/Header.js'
import { Footer } from './components/Footer.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { WorkspaceRow } from './components/WorkspaceRow.js'
import { ProjectHeaderRow } from './components/ProjectHeaderRow.js'
import { ScrollAffordance } from './components/ScrollAffordance.js'
import { activePalette } from './theme.js'

export interface AppProps {
  /** Set when `--project` narrows the picker to a single project. */
  scope?: ProjectScope
  onOpen: (workspaceId: string) => void
  onQuit: () => void
}

/** Keys explicitly documented but not implemented in this landing (see docs/TUI_SPEC.md D6). */
const NOT_WIRED_KEYS = new Set(['n', 'x', 'a', 'r'])

/**
 * Rows reserved outside the scrollable workspace list: the header's title +
 * status lines, plus its bottom rule (medium/wide only — see Header.tsx's
 * border discipline), plus the one-line footer. Help overlay replaces the
 * footer 1:1, so it's not counted separately. Scroll-affordance rows are
 * NOT included here — they're only reserved once scrollWindowFor actually
 * engages windowing (see its `windowed` field), inside its own budget.
 */
function chromeRowsFor(breakpoint: Breakpoint): number {
  const HEADER_LINES = 2
  const FOOTER_LINES = 1
  const RULE_LINES = breakpoint === 'narrow' ? 0 : 1
  return HEADER_LINES + FOOTER_LINES + RULE_LINES
}

type WorkspaceDisplayRow = Extract<DisplayRow, { kind: 'workspace' }>

function isWorkspaceRow(row: DisplayRow): row is WorkspaceDisplayRow {
  return row.kind === 'workspace'
}

/**
 * Handles a single non-navigation, non-quit, non-help keypress: filter
 * cycling and the "not yet wired" action keys. Extracted from the main
 * useInput callback to keep its cognitive complexity down.
 */
function handleActionKey(
  input: string,
  setFilter: React.Dispatch<React.SetStateAction<Filter>>,
  setNotice: (msg: string | null) => void
): void {
  if (input === 'f') {
    setFilter((f) => (f === 'active' ? 'all' : 'active'))
    setNotice(null)
    return
  }
  if (NOT_WIRED_KEYS.has(input)) {
    setNotice(`'${input}' is not yet wired in this build`)
  }
}

export function App({ scope, onOpen, onQuit }: AppProps): React.JSX.Element {
  const frame = useSyncExternalStore(
    frameStore.subscribe,
    frameStore.getSnapshot,
    frameStore.getSnapshot
  )
  const { columns, rows } = useWindowSize()
  const [filter, setFilter] = useState<Filter>('active')
  const [selected, setSelected] = useState(0)
  const [helpVisible, setHelpVisible] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const palette = activePalette

  const result = useMemo(
    () => (frame != null ? flattenTree(frame, filter, scope) : null),
    [frame, filter, scope]
  )
  const workspaceRows = useMemo(() => result?.rows.filter(isWorkspaceRow) ?? [], [result])

  // Derived, not synced-via-effect: the highlighted row is clamped to the
  // CURRENT visible set at render time, so a filter toggle/frame update/
  // disappearing workspace can never leave `selected` pointing past the end
  // (no separate effect needed to "fix up" state after the fact).
  const effectiveSelected =
    workspaceRows.length === 0 ? 0 : Math.min(selected, workspaceRows.length - 1)

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
    if (key.downArrow || input === 'j') {
      setSelected(Math.min(effectiveSelected + 1, Math.max(0, workspaceRows.length - 1)))
      return
    }
    if (key.upArrow || input === 'k') {
      setSelected(Math.max(effectiveSelected - 1, 0))
      return
    }
    if (key.return) {
      const row = workspaceRows[effectiveSelected]
      if (row != null) onOpen(row.workspaceId)
      return
    }
    handleActionKey(input, setFilter, setNotice)
  })

  const breakpoint = resolveBreakpoint(columns)
  const plan = columnPlanFor(breakpoint, columns)
  const selectedWorkspaceId = workspaceRows[effectiveSelected]?.workspaceId

  // Windowing: the selected row's position within `result.rows` (not
  // `workspaceRows`, since project-header rows also consume vertical space
  // and must scroll together with their workspaces) drives the window.
  const selectedRowPosition = useMemo(() => {
    if (result == null || selectedWorkspaceId == null) return 0
    return Math.max(
      0,
      result.rows.findIndex((r) => r.kind === 'workspace' && r.workspaceId === selectedWorkspaceId)
    )
  }, [result, selectedWorkspaceId])

  const availableRows = Math.max(1, rows - chromeRowsFor(breakpoint))
  const scrollWindow = useMemo(
    () =>
      result != null ? scrollWindowFor(result.rows, selectedRowPosition, availableRows) : null,
    [result, selectedRowPosition, availableRows]
  )

  return (
    <Box flexDirection="column">
      <Header
        scope={scope}
        connected={frame != null}
        filter={filter}
        hiddenCount={result?.hiddenCount ?? 0}
        totalCount={result?.totalCount ?? 0}
        breakpoint={breakpoint}
        palette={palette}
      />
      <Box flexDirection="column">
        {result == null || scrollWindow == null ? (
          <Text color={palette.secondary}>Connecting to Orpheus…</Text>
        ) : result.rows.length === 0 ? (
          <Text color={palette.secondary}>
            (no workspaces{filter === 'active' ? ' — press f to show all' : ''})
          </Text>
        ) : (
          <>
            {/* Both affordance rows are reserved ONLY once windowing actually
                engages (scrollWindow.windowed) — a list that fits entirely
                costs zero extra rows. Once engaged, BOTH stay mounted for the
                whole scrolling session (see ScrollAffordance.tsx's header). */}
            {scrollWindow.windowed ? (
              <ScrollAffordance count={scrollWindow.aboveCount} direction="up" palette={palette} />
            ) : null}
            {scrollWindow.visible.map((row) =>
              row.kind === 'project-header' ? (
                <ProjectHeaderRow
                  key={`project-${row.projectId}`}
                  name={truncate(row.projectName, plan.nameWidth)}
                  palette={palette}
                  breakpoint={breakpoint}
                />
              ) : (
                <WorkspaceRow
                  key={row.workspaceId}
                  row={row}
                  plan={plan}
                  selected={row.workspaceId === selectedWorkspaceId}
                  palette={palette}
                  breakpoint={breakpoint}
                />
              )
            )}
            {scrollWindow.windowed ? (
              <ScrollAffordance
                count={scrollWindow.belowCount}
                direction="down"
                palette={palette}
              />
            ) : null}
          </>
        )}
      </Box>
      {helpVisible ? (
        <HelpOverlay breakpoint={breakpoint} palette={palette} />
      ) : (
        <Footer notice={notice} palette={palette} breakpoint={breakpoint} />
      )}
    </Box>
  )
}
