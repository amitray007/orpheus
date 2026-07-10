// ---------------------------------------------------------------------------
// src/renderer/src/components/panes/PanesView.tsx
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U5, R6,
// R9, KTD6). The top-level Panes view shell: a header (panel/layout crumb,
// pane-count cap badge, ＋ Add pane, ⋯ options dropdown) over a
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
//
// ISSUE #17 — REAL layout-wide Restart/Stop: the ⋯ menu used to be a
// transient-message stub. It's now real, and operates on every pane in the
// ACTIVE layout's tree (via splitTreeOps.leafIds, the flat list of every
// leaf's paneId): Stop calls `window.api.panes.destroy` for each pane AND
// marks each stopped in paneRunStateStore (so PaneCell's header/body
// immediately reflects the stopped state — a destroy the store doesn't know
// about would leave the ◼/▶ button and stopped-placeholder UI out of sync
// with reality). Restart destroys + re-marks-running each pane, which
// drives PaneCell's own usePaneSurface effect to mount a FRESH surface
// (never a hide/show of a stale one — see PaneCell.tsx's file-header
// comment for why that's what fixes issue #18's blank-on-reenable bug).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import { SquaresFour } from '@phosphor-icons/react'
import type { SplitDirection, SplitTree as SplitTreeShape } from '@shared/types'
import { showChipDropdown, chipDropdownId } from '@/lib/overlayClient'
import { usePanesSelection, setActivePanel, setActiveLayout } from '@/lib/panesSelectionStore'
import { useUiState } from '@/lib/uiStateStore'
import { setPaneRunning, restartPane } from '@/lib/paneRunStateStore'
import { usePanesData } from './usePanesData'
import { SplitTree } from './SplitTree'
import { splitLeaf, closeLeaf, swapLeaves, setRatio, countLeaves, leafIds } from './splitTreeOps'
import type { SplitPathStep } from './splitTreeOps'

/** R6 cap: no more than 4 panes in a single layout. */
const CAP_LAYOUT = 4
/** R12 cap: no more than 12 live pane surfaces per panel, summed across all
 *  of the panel's layouts. */
const CAP_PANEL = 12

/** How long a transient inline status message (restart/stop-layout stubs,
 *  cap-hit warnings) stays visible before clearing itself. This repo has no
 *  global toast/notice system (confirmed in
 *  workbench/git/diff/diffEmptyStates.tsx) — local transient text is the
 *  established substitute. */
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
  const uiState = useUiState()
  const {
    panels,
    layouts,
    terminals,
    createTerminal,
    updateTerminalCommand,
    updateTerminalName,
    deleteTerminal,
    updateLayoutSplitTree
  } = usePanesData(activePanelId, activeLayoutId)

  const activePanel = panels.find((p) => p.id === activePanelId) ?? null
  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? null

  // Restore-or-default: seed the store with the persisted lastPanelId
  // (app_ui_state, issue #1) once panels load and nothing is selected yet,
  // provided that id still resolves against a loaded panel — a panel
  // deleted since the last session falls back to the first panel instead.
  // Then the same restore-or-default logic for the layout once the active
  // panel's layouts load (also covers the case where the previously active
  // layout no longer belongs to the newly active panel). Guarded so these
  // only fire when something would actually change (setActivePanel/
  // setActiveLayout are themselves no-ops on an unchanged id, but the guard
  // here also avoids picking a "first layout" while a panel switch is still
  // resolving its own default).
  useEffect(() => {
    if (activePanelId !== null || panels.length === 0) return
    if (uiState === null) return
    const restored = uiState.lastPanelId
    const restoredPanel = restored !== null ? panels.find((p) => p.id === restored) : undefined
    setActivePanel(restoredPanel ? restoredPanel.id : panels[0].id)
  }, [activePanelId, panels, uiState])

  useEffect(() => {
    if (activePanelId === null) return
    // BUG #20 FIX — a non-null activeLayoutId is ALWAYS the user's (or the
    // persisted lastLayoutId's) live selection, and this effect must never
    // clobber it — even when it isn't (yet) found in `layouts` below.
    //
    // Why "not found in `layouts`" is NOT the same thing as "deleted": this
    // view and the sidebar's PanelsSection run TWO SEPARATE layout fetches
    // (see usePanesData.ts's + panesRefreshStore.ts's header comments).
    // Clicking a layout row calls setActiveLayout(layout.id) directly and
    // does NOT bump panesRefreshStore, so there's a real window where
    // activeLayoutId has already flipped to e.g. QA-B but this hook's OWN
    // `layouts` snapshot hasn't refetched yet and still only reflects
    // QA-A — that's a stale-list race, not a deletion. The original code
    // treated "non-null activeLayoutId absent from layouts" as "deleted →
    // re-seed to layouts[0]", which re-selected QA-A right back over the
    // user's QA-B click, making layout switching look broken (issue #20).
    //
    // The fix: only re-seed when activeLayoutId is null (nothing selected
    // — first-run/restore, or a fresh panel via setActivePanel's reset).
    // Once activeLayoutId is non-null, this effect always returns and
    // leaves it alone, whether or not `layouts` has caught up yet:
    //   - if it's a stale-list race, the list will refresh (activePanelId
    //     change, refetch(), or a panesRefreshStore bump) and pick it up —
    //     nothing reverts in the meantime.
    //   - if the layout really was deleted, PanelsSection's
    //     handleDeleteLayout is the sole owner of re-selecting a sibling or
    //     clearing selection (it already does so proactively, reading the
    //     live selection via getPanesSelection() and calling setActiveLayout
    //     itself) — this effect does not need to be, and must not act as, a
    //     backstop for that case.
    if (activeLayoutId !== null) return
    const canRestoreLayout = uiState !== null && uiState.lastPanelId === activePanelId
    const restoredLayout = canRestoreLayout
      ? layouts.find((l) => l.id === uiState.lastLayoutId)
      : undefined
    setActiveLayout(restoredLayout ? restoredLayout.id : (layouts[0]?.id ?? null))
  }, [activePanelId, activeLayoutId, layouts, uiState])

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
  // The ⋯ layout-options button ref is still needed to compute the anchor
  // rect for the chip-dropdown overlay below; the button itself no longer
  // owns any open/anchor state — the dropdown lives in a separate
  // child-window overlay layer (see openOptionsMenu), not an inline
  // <Overlay> DOM popover, because a DOM popover can never render above the
  // native libghostty NSView (docs/learnings/overlay-child-window-macos.md).
  const optionsButtonRef = useRef<HTMLButtonElement>(null)

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

  // getDisplayName (issue #21) — resolves a leaf's ready-to-render name:
  // the persisted `name` when set, else "Pane N" where N is the pane's
  // 1-based position among the ACTIVE layout's leaves in tree order
  // (splitTreeOps.leafIds — the same depth-first order the flat-render
  // model already uses everywhere else). Falls back to the terminal row's
  // own `position` column only if the pane isn't found in `localTree` (a
  // brief render where the tree hasn't caught up with `terminals` yet) so
  // this never throws/returns undefined for a paneId that legitimately
  // exists as a terminal row.
  const getDisplayName = useCallback(
    (paneId: string) => {
      const terminal = terminals.find((t) => t.id === paneId)
      if (terminal?.name) return terminal.name
      const treeIndex = localTree ? leafIds(localTree).indexOf(paneId) : -1
      const position = treeIndex >= 0 ? treeIndex : (terminal?.position ?? 0)
      return `Pane ${position + 1}`
    },
    [terminals, localTree]
  )

  const handleCommandChange = useCallback(
    (paneId: string, command: string) => {
      void updateTerminalCommand(paneId, command)
    },
    [updateTerminalCommand]
  )

  const handleNameChange = useCallback(
    (paneId: string, name: string) => {
      void updateTerminalName(paneId, name)
    },
    [updateTerminalName]
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
    // name: "Pane 1" — issue #21, new panes are named at creation so the
    // display never has to fall back for a pane the user hasn't touched yet
    // (the '' -> "Pane N" fallback in getDisplayName above still covers any
    // OLDER row from before this column existed).
    const created = await createTerminal({ command: '', name: 'Pane 1', position: 0 })
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
      // in U7 keys directly on this id). nextIndex is 1-based off the
      // CURRENT leaf count, matching getDisplayName's own "Pane N" fallback
      // numbering (issue #21) so a freshly split pane's default name lines
      // up with where it'll actually land in the tree.
      const nextIndex = countLeaves(localTree) + 1
      const created = await createTerminal({
        command: '',
        name: `Pane ${nextIndex}`,
        position: countLeaves(localTree)
      })
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

  // Restart/Stop LAYOUT (bulk, all panes at once) — issue #17. Distinct from
  // the per-pane ✎ edit-relaunch and ◼/▶ stop/start in PaneCell.tsx, but now
  // built from the SAME primitives: `window.api.panes.destroy` (real process
  // kill) and paneRunStateStore (the shared running-flag PaneCell's own
  // usePaneSurface effect reads to decide mount vs. destroy). Iterates every
  // paneId currently in the active layout's tree via splitTreeOps.leafIds —
  // the flat, depth-first list of leaves, exactly matching what SplitTree.tsx
  // renders, so "every pane in the layout" here means precisely the panes
  // visibly in the stage right now.
  const handleStopLayout = useCallback(() => {
    if (!localTree || !activeLayoutId) return
    const ids = leafIds(localTree)
    for (const paneId of ids) {
      // Mark stopped FIRST so PaneCell's own effect (which also reads this
      // store) is the thing that actually calls pane:destroy on cleanup —
      // this keeps ALL destroy calls flowing through usePaneSurface's own
      // guarded path (createdRef/pendingCloseRef) instead of a second,
      // parallel destroy call site here racing against it.
      setPaneRunning(paneId, false)
    }
    // No transient toast — Stop is now a real action (the panes visibly stop),
    // so a "stopped layout" message would be redundant noise.
  }, [localTree, activeLayoutId])

  const handleRestartLayout = useCallback(() => {
    if (!localTree || !activeLayoutId) return
    const ids = leafIds(localTree)
    // restartPane forces a false->true transition even for an already-
    // running pane (a plain "set true" would no-op and skip the destroy),
    // so every pane genuinely gets a fresh `pane:destroy` + `pane:mount`
    // round-trip — exactly the stop-then-start issue #17 asks for, and the
    // same fresh-mount guarantee issue #18 relies on to avoid a blank
    // repaint (see PaneCell.tsx's file-header comment).
    for (const paneId of ids) {
      restartPane(paneId)
    }
    // No transient toast — Restart is now a real action (panes visibly relaunch).
  }, [localTree, activeLayoutId])

  // The unique overlay id for this menu — stable across renders so repeated
  // opens/closes target the same child-window overlay slot (mirrors
  // DropdownChip's `chipDropdownId(...)` usage).
  const optionsMenuId = chipDropdownId('panes-layout-options')

  // Bug #6: the ⋯ menu used to render as an inline <Overlay portal fixed
  // z-20> DOM popover, which can NEVER paint above the native libghostty
  // NSView terminal (see docs/learnings/overlay-child-window-macos.md — the
  // terminal's NSView is attached above the ONE shared web compositor layer,
  // so no DOM z-index trick can beat it). Reusing the same child-window
  // overlay used for hover cards / footer dropdowns (showChipDropdown) fixes
  // this: it renders in a separate BrowserWindow that genuinely composites
  // above the terminal. showChipDropdown never rejects (resolves null on
  // cancel/outside-click/Escape), so this is a plain async handler with no
  // floating promise to `void`.
  const openOptionsMenu = useCallback(async (): Promise<void> => {
    if (!optionsButtonRef.current) return
    const rect = optionsButtonRef.current.getBoundingClientRect()
    const result = await showChipDropdown(
      optionsMenuId,
      { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      {
        items: [
          { value: 'restart', label: '↻ Restart layout' },
          // Destructive: true — matches the custom ContextMenu.tsx's red
          // treatment for destructive actions (e.g. sidebar "Delete"), now
          // mirrored here via ChipDropdown's new destructive support so
          // every Panes menu reads consistently (issue #22).
          { value: 'stop', label: '◼ Stop layout', destructive: true }
        ]
      }
    )
    if (result?.value === 'restart') {
      handleRestartLayout()
    } else if (result?.value === 'stop') {
      handleStopLayout()
    }
  }, [optionsMenuId, handleRestartLayout, handleStopLayout])

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-base">
      <PanesHeader
        panelName={activePanel?.name ?? null}
        layoutName={activeLayout?.name ?? null}
        layoutDir={activeLayout?.dir ?? null}
        panelPaneTotal={panelPaneTotal}
        hasActiveLayout={activeLayout !== null}
        optionsButtonRef={optionsButtonRef}
        onAddPane={handleAddPaneFromHeader}
        onOpenOptions={() => void openOptionsMenu()}
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
            getCommand={getCommand}
            getDisplayName={getDisplayName}
            focusedPaneId={focusedPaneId}
            onFocus={setFocusedPaneId}
            onSplit={(paneId, dir) => void handleSplit(paneId, dir)}
            onClose={handleClose}
            onCommandChange={handleCommandChange}
            onNameChange={handleNameChange}
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
  optionsButtonRef: React.RefObject<HTMLButtonElement | null>
  onAddPane: () => void
  onOpenOptions: () => void
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
  optionsButtonRef,
  onAddPane,
  onOpenOptions,
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
        <button
          ref={optionsButtonRef}
          type="button"
          title="layout options"
          onClick={onOpenOptions}
          className="flex h-6 w-[26px] items-center justify-center rounded-md border border-transparent bg-transparent text-[14px] leading-none text-text-muted hover:bg-surface-overlay hover:text-text-primary cursor-pointer"
        >
          ⋯
        </button>
      ) : null}

      {transientMessage ? (
        <span className="font-mono text-[11px] text-text-muted">{transientMessage}</span>
      ) : null}
    </div>
  )
}
