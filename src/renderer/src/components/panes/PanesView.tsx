// ---------------------------------------------------------------------------
// src/renderer/src/components/panes/PanesView.tsx
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U5, R6,
// R9, KTD6). The top-level Panes view shell: a header (panel/layout crumb,
// pane-count cap badge, Auto-start toggle, Start/Stop, Restart, ＋ Add pane)
// over a flush split-tree "stage", matching the mockup's
// `.main`/`.vhead`/`.stage` layout (scratchpad/panes-final2.html) in spirit
// (Issue E promoted the layout controls that used to live behind a ⋯
// overflow menu directly into the bar — see the PanesHeader doc comment
// below for the current control order).
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
// ISSUE #17 — REAL layout-wide Restart/Stop, now in the top bar directly
// (Issue E moved these off the old ⋯ menu, which is gone — see PanesHeader).
// Two DISTINCT code paths share the "Stop"/"Restart" words, and it matters
// which one a caller uses:
//   - handleRestartLayout (the bar's Restart button) is STORE-ONLY: it
//     operates on every pane in the ACTIVE layout's tree (via
//     splitTreeOps.leafIds) through paneRunStateStore (setPaneRunning/
//     restartPane), which only affects panes while the layout tree is
//     mounted in the stage — it does NOT touch main's background surface
//     registry or `useIsLayoutLive`.
//   - The bar's Start/Stop button (handleTopBarStartStop) instead goes
//     through `window.api.panes.startLayoutBackground`/`stopLayout` (real
//     IPC, mirroring the sidebar's PanelsSection.tsx handleStartStop), so it
//     correctly reflects and drives the same background liveness signal the
//     sidebar shows.
// Restart destroys + re-marks-running each pane via paneRunStateStore, which
// drives PaneCell's own usePaneSurface effect to mount a FRESH surface
// (never a hide/show of a stale one — see PaneCell.tsx's file-header
// comment for why that's what fixes issue #18's blank-on-reenable bug).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react'
import { SquaresFour } from '@phosphor-icons/react'
import type { SplitDirection, SplitTree as SplitTreeShape } from '@shared/types'
import { usePanesSelection, setActivePanel, setActiveLayout } from '@/lib/panesSelectionStore'
import { useUiState } from '@/lib/uiStateStore'
import { restartPane } from '@/lib/paneRunStateStore'
import { useIsLayoutLive } from '@/lib/paneLiveLayoutsStore'
import { bumpPanesRefresh } from '@/lib/panesRefreshStore'
import { Toggle } from '../dashboard/settings/primitives'
import { usePanesData } from './usePanesData'
import { SplitTree } from './SplitTree'
import { splitLeaf, closeLeaf, swapLeaves, setRatio, countLeaves, leafIds } from './splitTreeOps'
import type { SplitPathStep } from './splitTreeOps'

/** R6 cap: no more than 4 panes in a single layout. */
const CAP_LAYOUT = 4
/** R12 cap: no more than 12 total panes in a panel, summed across all of the
 *  panel's layouts (persisted pane/terminal rows — NOT a count of currently-
 *  mounted live native surfaces; a layout's panes count toward this cap
 *  whether or not that layout is the one currently open). See
 *  panelPaneCount's doc comment above for exactly how the sum is derived. */
const CAP_PANEL = 12

/** How long a transient inline status message (restart/stop-layout stubs,
 *  cap-hit warnings) stays visible before clearing itself. This repo has no
 *  global toast/notice system (confirmed in
 *  workbench/git/diff/diffEmptyStates.tsx) — local transient text is the
 *  established substitute. */
const TRANSIENT_MESSAGE_MS = 1500

/** Sums countLeaves across every layout belonging to the ACTIVE panel — the
 *  TOTAL pane count across all of this panel's layouts (this is the number
 *  displayed by the header's "N/12 panes" badge and enforced by CAP_PANEL
 *  below, per R12). NOT a count of "live surfaces" — a layout's leaves are
 *  counted whether or not that layout is currently open/mounted, since the
 *  cap is meant to bound total persisted panes per panel, not just the ones
 *  with an active native surface right now. `layouts` here is already
 *  scoped to the active panel by usePanesData(activePanelId, ...), so no
 *  extra panel filtering is needed.
 *
 *  Leaf count is exact, not an approximation: a layout's `splitTree` leaf
 *  count always equals that layout's persisted terminal-row count (each
 *  leaf's paneId IS a terminal row's id — see splitLeaf/closeLeaf in
 *  splitTreeOps.ts, which always keep the two in lockstep). The one place
 *  this could drift is the ACTIVE layout immediately after a split/close:
 *  `localTree` (PanesView's own optimistic state) updates synchronously,
 *  but the corresponding `layouts` entry only catches up once
 *  `updateLayoutSplitTree`'s IPC round-trip resolves — summing the stale
 *  persisted `splitTree` for the active layout during that window would
 *  under/over-count by exactly one pane. Fixed by preferring `localTree`'s
 *  live leaf count for whichever layout is currently active, falling back
 *  to each OTHER layout's persisted `splitTree` (there's no local/optimistic
 *  state for a layout that isn't open) — this can never double-count since
 *  each layout contributes exactly one term to the sum. */
function panelPaneCount(
  layouts: { id: string; splitTree: SplitTreeShape | null }[],
  activeLayoutId: string | null,
  localTree: SplitTreeShape | null
): number {
  return layouts.reduce((sum, l) => {
    const tree = l.id === activeLayoutId ? localTree : l.splitTree
    return sum + countLeaves(tree)
  }, 0)
}

export function PanesView(): React.JSX.Element {
  const { activePanelId, activeLayoutId } = usePanesSelection()
  const uiState = useUiState()
  const {
    panels,
    layouts,
    layoutsPanelId,
    terminals,
    terminalsLayoutId,
    createTerminal,
    updateTerminalCommand,
    updateTerminalName,
    deleteTerminal,
    updateLayoutSplitTree
  } = usePanesData(activePanelId, activeLayoutId)

  const activePanel = panels.find((p) => p.id === activePanelId) ?? null
  const activeLayout = layouts.find((l) => l.id === activeLayoutId) ?? null
  // Real, background-aware liveness for the top bar's Start/Stop control —
  // same source PanelsSection's sidebar row reads (paneLiveLayoutsStore.ts),
  // NOT the store-only handleRestartLayout below (which only affects the
  // currently-mounted stage tree, not main's background surface registry).
  const activeLayoutLive = useIsLayoutLive(activeLayoutId ?? '')

  // BUG A FIX — "No layouts in this panel" stale-selection race.
  //
  // `layoutsReady` mirrors `terminalsReady` below one level up the
  // hierarchy: `layoutsPanelId` (usePanesData.ts) is set to `activePanelId`
  // ONLY once `listLayouts(activePanelId)` has resolved FOR that exact id,
  // and is invalidated to null the instant `activePanelId` changes. So
  // `layoutsReady` is the unambiguous "layouts is caught up with the
  // CURRENTLY active panel" signal — as opposed to `layouts.length === 0`
  // alone, which reads identically whether panel B's layouts genuinely
  // haven't loaded yet (still reflecting stale panel A data, or empty
  // pre-first-fetch state) or panel B truly has zero layouts. Rapidly
  // switching panels in the sidebar used to hit exactly that ambiguity: the
  // empty state rendered (or stuck rendering) "No layouts in this panel"
  // against a `layouts` list that hadn't caught up to the newly active
  // panel yet. Gating both the empty-state render AND the seeding effect
  // below on this flag closes the race.
  const layoutsReady = layoutsPanelId === activePanelId

  // MOUNT-RACE FIX — the persisted-layout setup-command bug.
  //
  // Root cause: usePanesData fetches `layouts` (which drives `localTree`,
  // below) and `terminals` (which drives `getCommand`) via TWO SEPARATE
  // async IPC round-trips that race each other. When a PERSISTED layout is
  // opened (fresh app launch/reload restoring lastPanelId/lastLayoutId, or
  // switching TO a layout whose terminals haven't been fetched before),
  // `localTree` can resolve first, SplitTree renders its PaneCells, and
  // each PaneCell's mount effect fires `pane:mount` with `getCommand(paneId)`
  // reading from a `terminals` array that STILL belongs to the previous (or
  // no) layout — i.e. `command=''`. That FIRST mount is the one that
  // actually execs the shell wrapper; libghostty only honors `env`/command
  // on a brand-new native surface (see packages/ghostty-surface/addon.mm's
  // "already attached" re-attach path, which explicitly ignores env because
  // the process is already running). So once that empty-command mount
  // creates the surface, every later mount call — even after `terminals`
  // catches up and PaneCell's effect re-runs with the REAL command — is a
  // pure no-op resize against the already-created surface. Confirmed via a
  // marker-file repro: `pane:mount`'s first call for a freshly-opened
  // persisted layout consistently carried `command=''`, and the addon log
  // showed every later call as "already attached (defensive resize)", never
  // a destroy+recreate — the setup command silently never ran.
  //
  // A newly-created pane never hits this: `createTerminal` (below) returns
  // the terminal row and optimistically appends it into `terminals`
  // (usePanesData.ts's own setTerminals) BEFORE `persistTree` ever renders a
  // PaneCell for it, so `getCommand` already has the right value on that
  // pane's first (and only) mount.
  //
  // Fix: don't let SplitTree mount LIVE surfaces until `terminals` is known
  // to belong to the layout currently selected — i.e. until usePanesData's
  // own `terminalsLayoutId` (set only once `listTerminals(activeLayoutId)`
  // has resolved FOR that id) matches `activeLayoutId`. Until then, render
  // the tree with `active={false}` (SplitTree/PaneCell already treat
  // `active=false` as "no live surface, no mount" — see PaneCell.tsx's
  // `usePaneSurface`), so the FIRST time a surface actually mounts, it
  // already carries the correct command. This is a narrow, one-render-late
  // gate: `terminalsLayoutId` flips to `activeLayoutId` as soon as that
  // fetch resolves (typically well before the tree finishes laying out and
  // triggering PaneCell's own rAF-deferred mount), so it doesn't introduce
  // a visible flash for the common case — it just closes the race window.
  const terminalsReady = terminalsLayoutId === activeLayoutId

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
    // BUG A FIX (continued from `layoutsReady`'s doc comment above): don't
    // seed a default layout until `layouts` is confirmed to belong to the
    // CURRENTLY active panel. Without this guard, switching panels A -> B
    // fast could run this effect while `layouts` still held panel A's list
    // (activeLayoutId is null immediately after setActivePanel(B) resets
    // it) — `layouts[0]?.id` would then seed activeLayoutId to one of
    // PANEL A's layout ids, which is wrong for panel B and is exactly the
    // "sticky stale selection" half of the race (the seeded id doesn't
    // belong to any of B's layouts, so `activeLayout` stays null and the
    // empty state renders/sticks even once B's real layouts arrive).
    if (!layoutsReady) return
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
  }, [activePanelId, activeLayoutId, layouts, layoutsReady, uiState])

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

  const panelPaneTotal = panelPaneCount(layouts, activeLayoutId, localTree)

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

  // Keyboard shortcuts — Cmd+D (split right) / Cmd+Shift+D (split below) /
  // Cmd+T (new pane), scoped to whenever PanesView is mounted (it's only
  // ever mounted while the Panes top-level view IS the active one, per the
  // file-header comment above, so no extra "is this view active" check is
  // needed here beyond that mount/unmount lifecycle).
  //
  // Split-target resolution deliberately mirrors handleAddPaneFromHeader's
  // own "focused pane, else first leaf, else add-first-pane" fallback chain
  // so Cmd+D behaves exactly like clicking the header's ＋ Add pane button
  // would for a 'v' split — just with an explicit direction for Cmd+D vs.
  // Cmd+Shift+D, neither of which the header button distinguishes.
  useEffect(() => {
    function resolveSplitTarget(): string | undefined {
      return focusedPaneId ?? terminals[0]?.id
    }

    function handleKeyDown(e: KeyboardEvent): void {
      // Guard against firing while the user is typing — pane name/command
      // inline-rename fields, the sidebar's own rename input, etc. all live
      // in plain <input>/<textarea>/contenteditable elements; Cmd+D/Cmd+T
      // there should behave like the OS/browser default (e.g. bookmark),
      // not hijack the keystroke into a pane split/add.
      const target = e.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return
      }

      // e.code is used (not e.key) so Shift's effect on the produced
      // character (e.g. macOS's Cmd+Shift+D reporting e.key === 'D') never
      // matters — KeyD/KeyT are the physical keys regardless of modifiers.
      if (e.metaKey && e.code === 'KeyD') {
        e.preventDefault()
        // No layout/pane to split yet — mirror handleAddPaneFromHeader's
        // empty-layout behavior (add the first pane) rather than no-op,
        // so Cmd+D on a freshly-created empty layout still does something
        // useful instead of silently swallowing the shortcut.
        if (!localTree) {
          void handleAddFirstPane()
          return
        }
        const paneId = resolveSplitTarget()
        if (!paneId) return
        void handleSplit(paneId, e.shiftKey ? 'h' : 'v')
        return
      }

      if (e.metaKey && !e.shiftKey && e.code === 'KeyT') {
        e.preventDefault()
        handleAddPaneFromHeader()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    localTree,
    focusedPaneId,
    terminals,
    handleAddFirstPane,
    handleSplit,
    handleAddPaneFromHeader
  ])

  // Restart LAYOUT (bulk, all panes at once) — issue #17. Distinct from the
  // per-pane ✎ edit-relaunch and ◼/▶ stop/start in PaneCell.tsx, but built
  // from the SAME primitive: paneRunStateStore (the shared running-flag
  // PaneCell's own usePaneSurface effect reads to decide mount vs. destroy).
  // Iterates every paneId currently in the active layout's tree via
  // splitTreeOps.leafIds — the flat, depth-first list of leaves, exactly
  // matching what SplitTree.tsx renders, so "every pane in the layout" here
  // means precisely the panes visibly in the stage right now.
  //
  // The bar's Stop button (Issue E) does NOT reuse a store-only counterpart
  // of this function — it goes through the real IPC path instead (see
  // handleTopBarStartStop below), so that "Stop" actually reflects in
  // useIsLayoutLive/the sidebar, not just the locally-mounted stage tree.
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

  // Top-bar Start/Stop (Issue E) — unlike handleStopLayout/handleRestartLayout
  // above (store-only, only affect the currently-mounted stage tree), this
  // drives REAL background liveness through the same IPC path the sidebar's
  // handleStartStop uses (PanelsSection.tsx), so the top-bar button and
  // useIsLayoutLive stay in sync with each other and with the sidebar.
  const handleTopBarStartStop = useCallback(() => {
    if (!activeLayoutId) return
    if (activeLayoutLive) {
      void window.api.panes
        .stopLayout(activeLayoutId)
        .catch((err) => console.error('[PanesView] stopLayout failed', err, activeLayoutId))
    } else {
      void window.api.panes
        .startLayoutBackground(activeLayoutId)
        .catch((err) =>
          console.error('[PanesView] startLayoutBackground failed', err, activeLayoutId)
        )
    }
  }, [activeLayoutId, activeLayoutLive])

  // Top-bar Auto-start toggle — persists via IPC, then bumps
  // panesRefreshStore so usePanesData's own layouts fetch (which is what
  // `activeLayout.autoStart` is derived from) refetches and reflects the
  // new value. Mirrors PanelsSection's handleToggleAutoStart +
  // handleAutoStartChanged pair exactly (see PanelsSection.tsx).
  const handleToggleAutoStart = useCallback(
    (next: boolean) => {
      if (!activeLayoutId) return
      void window.api.panes
        .setLayoutAutoStart(activeLayoutId, next)
        .then(() => bumpPanesRefresh())
        .catch((err) => console.error('[PanesView] setLayoutAutoStart failed', err, activeLayoutId))
    },
    [activeLayoutId]
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-base">
      <PanesHeader
        panelName={activePanel?.name ?? null}
        layoutName={activeLayout?.name ?? null}
        layoutDir={activeLayout?.dir ?? null}
        panelPaneTotal={panelPaneTotal}
        hasActiveLayout={activeLayout !== null}
        autoStart={activeLayout?.autoStart ?? false}
        isRunning={activeLayoutLive}
        onAddPane={handleAddPaneFromHeader}
        onToggleAutoStart={handleToggleAutoStart}
        onStartStop={handleTopBarStartStop}
        onRestart={handleRestartLayout}
        transientMessage={transientMessage}
      />

      <div className="flex-1 min-h-0 overflow-hidden p-0">
        {panels.length === 0 ? (
          <PanesEmptyState message="No panels yet." />
        ) : !layoutsReady ? (
          // BUG A FIX — while `layouts` hasn't caught up to `activePanelId`
          // yet (see `layoutsReady`'s doc comment above), render a NEUTRAL
          // loading state rather than either "No layouts in this panel"
          // (wrong — we don't know that yet, and the panel may well have
          // layouts) or the previous panel's stale tree (also wrong — it
          // isn't the selected panel's content). This is the fix's core:
          // "not loaded yet for the active panel" and "loaded and
          // genuinely empty" must never render the same message.
          <PanesEmptyState message="Loading layouts…" />
        ) : !activeLayout ? (
          // Reached only once `layoutsReady` is true, i.e. `layouts` is
          // confirmed to be the ACTIVE panel's real (possibly empty) list —
          // so this message is now trustworthy: the panel genuinely has no
          // layouts, not "hasn't loaded yet".
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
            // See the `terminalsReady` doc comment above (mount-race fix):
            // false here means SplitTree/PaneCell render the tree's chrome
            // but mount NO live surfaces yet, so the first real mount (once
            // this flips true) always has the correct per-pane command.
            active={terminalsReady}
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
  autoStart: boolean
  isRunning: boolean
  onAddPane: () => void
  onToggleAutoStart: (v: boolean) => void
  onStartStop: () => void
  onRestart: () => void
  transientMessage: string | null
}

/** Shared classes for the bar's labeled toolbar buttons (Start/Stop,
 *  Restart, ＋ Add pane) — copied from the pre-existing ＋ Add pane style so
 *  every button in the cluster reads as one consistent toolbar. */
const HEADER_BUTTON_CLASS =
  'flex h-6 items-center gap-1.5 rounded-md border border-border-default bg-surface-raised px-2.5 text-[11.5px] font-medium text-text-primary hover:border-accent hover:bg-surface-overlay cursor-pointer'

/** The view header — crumb, cap badge, and the layout toolbar (Issue E:
 *  auto-start toggle, start/stop, restart, add pane). Extracted from
 *  PanesView's body to keep that component's render function under the
 *  sonarjs cognitive-complexity cap.
 *
 *  Right-cluster order (left to right): N/12 panes badge · a divider ·
 *  Auto-start label+toggle · Start/Stop · Restart · ＋ Add pane. The ⋯
 *  overflow menu that used to hold Restart/Stop is gone — with both
 *  promoted into the bar it had nothing left in it, so it was removed
 *  rather than kept as dead chrome (issue E).
 *
 *  Crowding: the left crumb gets `min-w-0 truncate` so a long `layoutDir`
 *  monospace path shrinks/truncates instead of pushing the toolbar off the
 *  right edge or wrapping the h-11 single-row bar. */
function PanesHeader({
  panelName,
  layoutName,
  layoutDir,
  panelPaneTotal,
  hasActiveLayout,
  autoStart,
  isRunning,
  onAddPane,
  onToggleAutoStart,
  onStartStop,
  onRestart,
  transientMessage
}: PanesHeaderProps): React.JSX.Element {
  const warn = panelPaneTotal >= 10
  return (
    <div className="flex h-11 flex-shrink-0 items-center gap-2.5 border-b border-border-default bg-surface-raised px-3.5">
      <span className="flex min-w-0 items-center gap-2 truncate text-[13px] font-semibold text-text-primary">
        <span className="truncate">{panelName ?? '—'}</span>
        <span className="flex-shrink-0 font-normal text-text-muted">/</span>
        <span className="truncate">{layoutName ?? '—'}</span>
        {layoutDir ? (
          <span className="truncate font-mono text-[11px] font-normal text-text-muted">
            {layoutDir}
          </span>
        ) : null}
      </span>

      <span className="ml-auto flex-shrink-0 font-mono text-[10.5px] text-text-muted">
        <b className={warn ? 'text-accent' : 'text-text-secondary'}>{panelPaneTotal}</b>/{CAP_PANEL}{' '}
        panes
      </span>

      {hasActiveLayout ? (
        <>
          <span className="h-4 w-px flex-shrink-0 bg-border-default" aria-hidden="true" />

          <span className="flex flex-shrink-0 items-center gap-1.5">
            <span className="text-[11px] text-text-muted">Auto-start</span>
            <Toggle
              value={autoStart}
              onChange={onToggleAutoStart}
              ariaLabel="Auto-start layout on launch"
            />
          </span>

          <button
            type="button"
            onClick={onStartStop}
            title={isRunning ? 'Stop layout' : 'Start layout'}
            className={[
              HEADER_BUTTON_CLASS,
              isRunning ? 'hover:border-red-500/50 hover:text-red-400' : ''
            ].join(' ')}
          >
            {isRunning ? '◼ Stop' : '▷ Start'}
          </button>

          <button
            type="button"
            onClick={onRestart}
            title="Restart layout"
            className={HEADER_BUTTON_CLASS}
          >
            ↻ Restart
          </button>

          <button type="button" onClick={onAddPane} className={HEADER_BUTTON_CLASS}>
            ＋ Add pane
          </button>
        </>
      ) : null}

      {transientMessage ? (
        <span className="flex-shrink-0 font-mono text-[11px] text-text-muted">
          {transientMessage}
        </span>
      ) : null}
    </div>
  )
}
