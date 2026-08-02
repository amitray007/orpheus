/**
 * tui/App.tsx — the Ink root component for `orpheus tui`.
 *
 * All layout/ordering/filtering math is delegated to tui/layout.ts (pure,
 * covered by scripts/verify-tui-layout.ts). This component owns only
 * interactive/presentational state: the current filter, the highlighted
 * row, the help-overlay visibility, and a transient "not yet wired" notice.
 *
 * The `frame` prop is pushed in from OUTSIDE React (tui/entry.ts's
 * /subscribe callback re-renders via Instance.rerender on every new `tree`
 * frame) — this component never subscribes/connects itself, keeping the
 * transport concern out of the render tree.
 */

import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import {
  columnPlanFor,
  flattenTree,
  resolveBreakpoint,
  truncate,
  type DisplayRow,
  type Filter,
  type ProjectScope
} from './layout.js'
import type { TreeFrame } from './types.js'
import { Header } from './components/Header.js'
import { Footer } from './components/Footer.js'
import { HelpOverlay } from './components/HelpOverlay.js'
import { WorkspaceRow } from './components/WorkspaceRow.js'

export interface AppProps {
  /** Latest applied `tree` frame, or null before the first one arrives. */
  frame: TreeFrame | null
  /** Set when `--project` narrows the picker to a single project. */
  scope?: ProjectScope
  onOpen: (workspaceId: string) => void
  onQuit: () => void
}

/** Keys explicitly documented but not implemented in this landing (see docs/TUI_SPEC.md D6). */
const NOT_WIRED_KEYS = new Set(['n', 'x', 'a', 'r'])

function useColumns(): number {
  const [columns, setColumns] = useState(process.stdout.columns || 80)
  useEffect(() => {
    const onResize = (): void => setColumns(process.stdout.columns || 80)
    process.stdout.on('resize', onResize)
    return () => {
      process.stdout.off('resize', onResize)
    }
  }, [])
  return columns
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

export function App({ frame, scope, onOpen, onQuit }: AppProps): React.JSX.Element {
  const columns = useColumns()
  const [filter, setFilter] = useState<Filter>('active')
  const [selected, setSelected] = useState(0)
  const [helpVisible, setHelpVisible] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

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

  const plan = columnPlanFor(resolveBreakpoint(columns), columns)
  const selectedWorkspaceId = workspaceRows[effectiveSelected]?.workspaceId

  return (
    <Box flexDirection="column">
      <Header
        scope={scope}
        connected={frame != null}
        filter={filter}
        hiddenCount={result?.hiddenCount ?? 0}
        totalCount={result?.totalCount ?? 0}
      />
      <Box flexDirection="column">
        {result == null ? (
          <Text dimColor>Connecting to Orpheus…</Text>
        ) : result.rows.length === 0 ? (
          <Text dimColor>(no workspaces{filter === 'active' ? ' — press f to show all' : ''})</Text>
        ) : (
          result.rows.map((row) =>
            row.kind === 'project-header' ? (
              <Text key={`project-${row.projectId}`} bold>
                {truncate(row.projectName, plan.nameWidth)}
              </Text>
            ) : (
              <WorkspaceRow
                key={row.workspaceId}
                row={row}
                plan={plan}
                selected={row.workspaceId === selectedWorkspaceId}
              />
            )
          )
        )}
      </Box>
      {helpVisible ? <HelpOverlay /> : <Footer notice={notice} />}
    </Box>
  )
}
