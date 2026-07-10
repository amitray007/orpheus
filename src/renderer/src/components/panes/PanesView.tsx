// ---------------------------------------------------------------------------
// src/renderer/src/components/panes/PanesView.tsx
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U5, R6,
// R9, KTD6). The top-level Panes view shell: a header (panel/layout crumb,
// pane-count cap badge, ＋ Add pane, ⋯ options dropdown, ⤢ Pop out) over a
// flush split-tree "stage", matching the mockup's `.main`/`.vhead`/`.stage`
// layout (scratchpad/panes-final2.html) exactly.
//
// U7: SplitTree's leaves now mount REAL libghostty surfaces (PaneCell.tsx),
// so `active` is always true here — this view is only ever rendered while
// the Panes top-level view IS the active one (MainContent.tsx's view.kind
// branch), and it only ever renders the CURRENTLY selected layout's tree.
// Switching layouts (or navigating away from Panes entirely) unmounts the
// outgoing SplitTree, which hides (not destroys) every pane surface in it
// via each PaneCell's own teardown effect — no extra plumbing needed here
// beyond passing `active` through.
//
// Sidebar-driven panel/layout selection (U6): the active panel/layout ids
// live in panesSelectionStore.ts (written by Sidebar.tsx's PanelsSection),
// and this view reads them via usePanesSelection() and passes them into
// usePanesData(). It also seeds the store with the first panel / first
// layout on first load when nothing is selected yet, preserving the old
// "defaults to first panel/layout" behavior for a fresh install (only
// 'General' exists until a project panel is added).
//
// All split/close/swap/resize mutations follow the same pattern: compute the
// new tree via the pure ops in splitTree.ts, setLocalTree immediately
// (optimistic), then persist via usePanesData's updateLayoutSplitTree. This
// keeps the split-tree UI responsive without waiting on an IPC round-trip
// per interaction.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import { SquaresFour } from '@phosphor-icons/react'
import type { SplitDirection, SplitTree as SplitTreeShape } from '@shared/types'
import { Overlay } from '@/components/ui/Overlay'
import { usePanesSelection, setActivePanel, setActiveLayout } from '@/lib/panesSelectionStore'
import { usePanesData } from './usePanesData'
import { SplitTree } from './SplitTree'
import { splitLeaf, closeLeaf, swapLeaves, setRatio, countLeaves } from './splitTreeOps'
import type { SplitPathStep } from './splitTreeOps'

/** R6 cap: no more than 4 panes in a single layout. */
const CAP_LAYOUT = 4
/** R12 cap: no more than 12 live pane surfaces per panel, summed across all
 *  of the panel's layouts. */
const CAP_PANEL = 12

/** How long a transient inline status message (Pop-out stub, cap-hit
 *  warnings) stays visible before clearing itself. This repo has no global
 *  toast/notice system (confirmed in workbench/git/diff/diffEmptyStates.tsx)
 *  — local transient text is the established substitute. */
const TRANSIENT_MESSAGE_MS = 1500

/** Sums countLeaves across every layout in a panel — the panel-wide pane
 *  count the header's cap badge and the ≤12/panel cap both need. Panes
 *  living in layouts OTHER than the active one aren't loaded by
 *  usePanesData (it only fetches the active layout's terminals), so this is
 *  necessarily an approximation from split-tree shape alone: it counts
 *  leaves in each layout's persisted splitTree, which is accurate because
 *  the tree's leaf count always equals that layout's terminal count. */
function panelPaneCount(layouts: { splitTree: SplitTreeShape | null }[]): number {
  return layouts.reduce((sum, l) => sum + countLeaves(l.splitTree), 0)
}

export function PanesView(): React.JSX.Element {
  const { activePanelId, activeLayoutId } = usePanesSelection()
  const {
    panels,
    layouts,
    terminals,
    createTerminal,
    updateTerminalCommand,
    deleteTerminal,
    updateLayoutSplitTree
  } = usePanesData(activePanelId, activeLayoutId)

  const activePanel = panels.find((p) => p.id === activePanelId) ?? null
  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? null

  // First-run defaults: seed the store with the first panel once panels load
  // and nothing is selected yet, then the first layout of whatever panel is
  // active once ITS layouts load (also covers the case where the previously
  // active layout no longer belongs to the newly active panel). Guarded so
  // these only fire when something would actually change (setActivePanel/
  // setActiveLayout are themselves no-ops on an unchanged id, but the guard
  // here also avoids picking a "first layout" while a panel switch is still
  // resolving its own default).
  useEffect(() => {
    if (activePanelId === null && panels.length > 0) {
      setActivePanel(panels[0].id)
    }
  }, [activePanelId, panels])

  useEffect(() => {
    if (activePanelId === null) return
    if (activeLayoutId !== null && layouts.some((l) => l.id === activeLayoutId)) return
    setActiveLayout(layouts[0]?.id ?? null)
  }, [activePanelId, activeLayoutId, layouts])

  // Local optimistic split-tree state, seeded from (and re-synced to) the
  // loaded layout. Mutations update this immediately; the persisted copy
  // catches up via updateLayoutSplitTree.
  const [localTree, setLocalTree] = useState<SplitTreeShape | null>(null)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-syncs localTree synchronously whenever a different layout (or its persisted tree) loads; not an async-settle callback
    setLocalTree(activeLayout?.splitTree ?? null)
  }, [activeLayout?.id, activeLayout?.splitTree])

  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null)
  const [draggingPaneId, setDraggingPaneId] = useState<string | null>(null)
  const [transientMessage, setTransientMessage] = useState<string | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const optionsButtonRef = useRef<HTMLButtonElement>(null)
  const [optionsAnchor, setOptionsAnchor] = useState<{ top: number; right: number } | null>(null)

  const transientTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showTransientMessage = useCallback((message: string) => {
    setTransientMessage(message)
    if (transientTimeoutRef.current) clearTimeout(transientTimeoutRef.current)
    transientTimeoutRef.current = setTimeout(() => setTransientMessage(null), TRANSIENT_MESSAGE_MS)
  }, [])
  useEffect(
    () => () => {
      if (transientTimeoutRef.current) clearTimeout(transientTimeoutRef.current)
    },
    []
  )

  const getCommand = useCallback(
    (paneId: string) => terminals.find((t) => t.id === paneId)?.command ?? '',
    [terminals]
  )

  const handleCommandChange = useCallback(
    (paneId: string, command: string) => {
      void updateTerminalCommand(paneId, command)
    },
    [updateTerminalCommand]
  )

  const panelPaneTotal = panelPaneCount(layouts)

  const persistTree = useCallback(
    (next: SplitTreeShape | null) => {
      if (!activeLayoutId) return
      setLocalTree(next)
      void updateLayoutSplitTree(activeLayoutId, next)
    },
    [activeLayoutId, updateLayoutSplitTree]
  )

  const handleAddFirstPane = useCallback(async () => {
    if (!activeLayoutId) return
    const created = await createTerminal({ command: '', position: 0 })
    if (!created) return
    setFocusedPaneId(created.id)
    persistTree({ paneId: created.id })
  }, [activeLayoutId, createTerminal, persistTree])

  const handleSplit = useCallback(
    async (paneId: string, dir: SplitDirection) => {
      if (!localTree) return
      if (countLeaves(localTree) >= CAP_LAYOUT) {
        showTransientMessage('max 4 panes per layout')
        return
      }
      if (panelPaneTotal >= CAP_PANEL) {
        showTransientMessage('panel cap: 12 panes')
        return
      }
      // Create the real DB row FIRST so the new leaf's paneId is a genuine
      // terminal id, not a fake client-side placeholder (the native surface
      // in U7 keys directly on this id).
      const created = await createTerminal({ command: '', position: countLeaves(localTree) })
      if (!created) return
      setFocusedPaneId(created.id)
      persistTree(splitLeaf(localTree, paneId, dir, created.id))
    },
    [localTree, panelPaneTotal, createTerminal, persistTree, showTransientMessage]
  )

  const handleClose = useCallback(
    (paneId: string) => {
      if (!localTree) return
      void deleteTerminal(paneId)
      persistTree(closeLeaf(localTree, paneId))
      setFocusedPaneId((prev) => (prev === paneId ? null : prev))
    },
    [localTree, deleteTerminal, persistTree]
  )

  const handleSwap = useCallback(
    (a: string, b: string) => {
      if (!localTree) return
      persistTree(swapLeaves(localTree, a, b))
    },
    [localTree, persistTree]
  )

  const handleRatioChange = useCallback(
    (path: SplitPathStep[], ratio: number) => {
      if (!localTree) return
      persistTree(setRatio(localTree, path, ratio))
    },
    [localTree, persistTree]
  )

  const handleAddPaneFromHeader = useCallback(() => {
    if (!localTree) {
      void handleAddFirstPane()
      return
    }
    const target = focusedPaneId ?? undefined
    if (target) {
      void handleSplit(target, 'v')
      return
    }
    // No focused pane to split from — fall back to splitting the tree's
    // first leaf (mirrors the mockup's addPaneBtn: split from the first
    // leaf when nothing is explicitly focused).
    const firstPaneId = terminals[0]?.id
    if (firstPaneId) void handleSplit(firstPaneId, 'v')
  }, [localTree, focusedPaneId, terminals, handleAddFirstPane, handleSplit])

  const toggleOptions = useCallback(() => {
    if (!optionsOpen && optionsButtonRef.current) {
      const rect = optionsButtonRef.current.getBoundingClientRect()
      setOptionsAnchor({ top: rect.bottom + 6, right: window.innerWidth - rect.right })
    }
    setOptionsOpen((prev) => !prev)
  }, [optionsOpen])

  // Restart/Stop LAYOUT (bulk, all panes at once) — distinct from U7's
  // per-pane ✎ edit-relaunch and ◼/▶ stop/start (both real as of U7). A
  // layout-wide restart/stop needs the background-running + explicit-stop
  // process model U8 introduces; stubbed here as a transient-message no-op
  // so the affordance + menu shape are already in place for U8 to wire up.
  const handleRestartLayout = useCallback(() => {
    setOptionsOpen(false)
    showTransientMessage('restarted layout') // stub — real restart lands in U8
  }, [showTransientMessage])
  const handleStopLayout = useCallback(() => {
    setOptionsOpen(false)
    showTransientMessage('stopped layout') // stub — real stop lands in U8
  }, [showTransientMessage])
  const handlePopOut = useCallback(() => {
    showTransientMessage('own-window mode — a later phase')
  }, [showTransientMessage])

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-base">
      <PanesHeader
        panelName={activePanel?.name ?? null}
        layoutName={activeLayout?.name ?? null}
        layoutDir={activeLayout?.dir ?? null}
        panelPaneTotal={panelPaneTotal}
        hasActiveLayout={activeLayout !== null}
        optionsOpen={optionsOpen}
        optionsAnchor={optionsAnchor}
        optionsButtonRef={optionsButtonRef}
        onAddPane={handleAddPaneFromHeader}
        onToggleOptions={toggleOptions}
        onDismissOptions={() => setOptionsOpen(false)}
        onRestartLayout={handleRestartLayout}
        onStopLayout={handleStopLayout}
        onPopOut={handlePopOut}
        transientMessage={transientMessage}
      />

      <div className="flex-1 min-h-0 overflow-hidden p-0">
        {panels.length === 0 ? (
          <PanesEmptyState message="No panels yet." />
        ) : !activeLayout ? (
          <PanesEmptyState message="No layouts in this panel." />
        ) : !localTree ? (
          <PanesEmptyState
            message={`Empty layout "${activeLayout.name}".`}
            actionLabel="＋ Add first pane"
            onAction={() => void handleAddFirstPane()}
          />
        ) : (
          <SplitTree
            tree={localTree}
            layoutId={activeLayout.id}
            active
            path={[]}
            getCommand={getCommand}
            focusedPaneId={focusedPaneId}
            onFocus={setFocusedPaneId}
            onSplit={(paneId, dir) => void handleSplit(paneId, dir)}
            onClose={handleClose}
            onCommandChange={handleCommandChange}
            onSwap={handleSwap}
            onRatioChange={handleRatioChange}
            draggingPaneId={draggingPaneId}
            onDragStart={setDraggingPaneId}
            onDragEnd={() => setDraggingPaneId(null)}
          />
        )}
      </div>
    </div>
  )
}

/** Empty-state body for the stage — no panels, no layouts, or a layout with
 *  a null split tree (zero panes). Mirrors the mockup's `.emptyfolder`. */
function PanesEmptyState({
  message,
  actionLabel,
  onAction
}: {
  message: string
  actionLabel?: string
  onAction?: () => void
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
      <SquaresFour size={32} weight="thin" />
      <span className="text-[13px]">{message}</span>
      {actionLabel && onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="rounded-md border border-border-default bg-surface-raised px-2.5 py-1 text-[11.5px] font-medium text-text-primary hover:border-accent hover:bg-surface-overlay cursor-pointer"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  )
}

interface PanesHeaderProps {
  panelName: string | null
  layoutName: string | null
  layoutDir: string | null
  panelPaneTotal: number
  hasActiveLayout: boolean
  optionsOpen: boolean
  optionsAnchor: { top: number; right: number } | null
  optionsButtonRef: React.RefObject<HTMLButtonElement | null>
  onAddPane: () => void
  onToggleOptions: () => void
  onDismissOptions: () => void
  onRestartLayout: () => void
  onStopLayout: () => void
  onPopOut: () => void
  transientMessage: string | null
}

/** The view header — crumb, cap badge, and the three top-bar actions (R9).
 *  Extracted from PanesView's body to keep that component's render function
 *  under the cognitive-complexity cap. */
function PanesHeader({
  panelName,
  layoutName,
  layoutDir,
  panelPaneTotal,
  hasActiveLayout,
  optionsOpen,
  optionsAnchor,
  optionsButtonRef,
  onAddPane,
  onToggleOptions,
  onDismissOptions,
  onRestartLayout,
  onStopLayout,
  onPopOut,
  transientMessage
}: PanesHeaderProps): React.JSX.Element {
  const warn = panelPaneTotal >= 10
  return (
    <div className="flex h-11 flex-shrink-0 items-center gap-2.5 border-b border-border-default bg-surface-raised px-3.5">
      <span className="flex items-center gap-2 text-[13px] font-semibold text-text-primary">
        {panelName ?? '—'}
        <span className="font-normal text-text-muted">/</span>
        {layoutName ?? '—'}
        {layoutDir ? (
          <span className="font-mono text-[11px] font-normal text-text-muted">{layoutDir}</span>
        ) : null}
      </span>

      <span className="ml-auto font-mono text-[10.5px] text-text-muted">
        <b className={warn ? 'text-accent' : 'text-text-secondary'}>{panelPaneTotal}</b>/{CAP_PANEL}{' '}
        panes
      </span>

      {hasActiveLayout ? (
        <button
          type="button"
          onClick={onAddPane}
          className="flex h-6 items-center gap-1.5 rounded-md border border-border-default bg-surface-raised px-2.5 text-[11.5px] font-medium text-text-primary hover:border-accent hover:bg-surface-overlay cursor-pointer"
        >
          ＋ Add pane
        </button>
      ) : null}

      {hasActiveLayout ? (
        <div className="relative">
          <button
            ref={optionsButtonRef}
            type="button"
            title="layout options"
            onClick={onToggleOptions}
            className="flex h-6 w-[26px] items-center justify-center rounded-md border border-transparent bg-transparent text-[14px] leading-none text-text-muted hover:bg-surface-overlay hover:text-text-primary cursor-pointer"
          >
            ⋯
          </button>
          <Overlay
            open={optionsOpen}
            interactive
            portal
            onDismiss={onDismissOptions}
            className="fixed z-20 min-w-[158px] rounded-lg border border-border-default bg-surface-overlay p-1 shadow-[0_8px_24px_rgba(0,0,0,0.5)]"
            style={
              optionsAnchor ? { top: optionsAnchor.top, right: optionsAnchor.right } : undefined
            }
          >
            <button
              type="button"
              onClick={onRestartLayout}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary cursor-pointer"
            >
              ↻ Restart layout
            </button>
            <button
              type="button"
              onClick={onStopLayout}
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-[#e07a7a] hover:bg-[rgba(224,122,122,0.12)] cursor-pointer"
            >
              ◼ Stop layout
            </button>
          </Overlay>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {transientMessage ? (
          <span className="font-mono text-[11px] text-text-muted">{transientMessage}</span>
        ) : null}
        <button
          type="button"
          title="own-window mode (later phase)"
          onClick={onPopOut}
          className="flex h-6 items-center gap-1.5 rounded-md border border-border-default px-2.5 text-[11px] text-text-muted hover:border-border-hover hover:text-text-secondary cursor-pointer"
        >
          ⤢ Pop out
        </button>
      </div>
    </div>
  )
}
