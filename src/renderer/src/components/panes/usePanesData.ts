// ---------------------------------------------------------------------------
// src/renderer/src/components/panes/usePanesData.ts
//
// Panes v2 — top-level Panels · Layouts · split Panes
// (docs/plans/2026-07-10-001-feat-panes-v2-toplevel-layouts-plan.md, U5, U6).
//
// Loads the panel -> layout -> terminal hierarchy through the typed
// `window.api.panes.*` CRUD surface (src/preload/index.ts, backed by
// src/main/paneStore.ts) and exposes the narrow set of mutation helpers
// PanesView needs: creating/deleting a terminal and persisting a layout's
// split tree.
//
// Selection (which panel/layout is "active") now lives OUTSIDE this hook, in
// src/renderer/src/lib/panesSelectionStore.ts (a small external store the
// sidebar's PanelsSection writes to on click). This hook is a pure data
// fetcher parameterized by the caller-supplied `activePanelId`/
// `activeLayoutId` — it no longer owns that state or defaults it to "first
// panel/first layout" itself. That "pick a sensible default" responsibility
// moved to PanesView, which reads panesSelectionStore and seeds it with the
// first panel/layout on first load when nothing is selected yet (preserving
// the old single-panel dev-environment default behavior).
//
// Cross-fetcher invalidation: PanelsSection.tsx (the sidebar tree) fetches
// panels/layouts independently of this hook by design (see PanelsSection's
// header comment) — but that means a sidebar mutation (delete/rename layout
// or panel) never updates the `layouts`/`panels` state below on its own.
// panesRefreshStore.ts's `usePanesRefresh()` is the fix: PanelsSection bumps
// it after every mutation, and this hook folds the resulting counter into
// each load effect's deps (alongside the existing `reloadToken`, which
// remains this hook's own manual refetch() trigger) so a sidebar-driven
// mutation forces a real refetch here too — closing the stale-list gap that
// let a deleted layout get re-selected by PanesView's seeding effect.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react'
import type { PanePanel, PaneLayout, PaneTerminal, SplitTree } from '@shared/types'
import { usePanesRefresh } from '@/lib/panesRefreshStore'

interface UsePanesDataResult {
  /** All panels (e.g. 'General' + any project panels), position-ordered. */
  panels: PanePanel[]
  /** Layouts belonging to `activePanelId`, position-ordered. Empty until a
   *  panel is selected/loaded. */
  layouts: PaneLayout[]
  /** The panelId whose layouts are CURRENTLY reflected in `layouts` — null
   *  until the first `listLayouts` call for some panel resolves. Mirrors
   *  `terminalsLayoutId` below (same lag-tracking pattern, one level up the
   *  hierarchy): switching panels flips `activePanelId` synchronously, but
   *  `layouts` only catches up once `listLayouts(activePanelId)` resolves
   *  FOR that exact id. PanesView needs this EXACT signal (not just
   *  `loading`) to fix the panel-switch stale-selection race (Bug A) — an
   *  empty `layouts` array mid-fetch used to read identically to a
   *  genuinely-empty panel, so rapidly switching panels could flash (or
   *  stick on) "No layouts in this panel" for a panel that actually has
   *  layouts, because the empty state was gated on `layouts.length === 0`
   *  alone with no way to tell "not loaded yet" from "loaded and empty".
   *  Cleared to null the instant `activePanelId` changes (including to
   *  null) so a stale panel's `layoutsPanelId` can never be mistaken for
   *  the new one's — see the load effect below. */
  layoutsPanelId: string | null
  /** Terminals (panes) belonging to `activeLayoutId`, position-ordered. */
  terminals: PaneTerminal[]
  /** The layoutId whose terminals are CURRENTLY reflected in `terminals` —
   *  null until the first `listTerminals` call for some layout resolves.
   *  This lags `activeLayoutId` by exactly one async round-trip: switching
   *  layouts flips `activeLayoutId` synchronously, but `terminals` (and this
   *  field) only catch up once `listTerminals(activeLayoutId)` resolves.
   *  PanesView needs this EXACT lag exposed (not just `loading`) to fix the
   *  mount-race documented in PaneCell.tsx/PanesView.tsx below — see
   *  PanesView's `terminalsReady` for the consumer. */
  terminalsLayoutId: string | null
  /** True while the initial panels load, or a panel/layout switch is
   *  refetching its children. Intentionally coarse — this unit doesn't need
   *  per-list loading granularity. */
  loading: boolean
  /** Set when any load/mutation call rejects; cleared on the next
   *  successful call. Message is whatever the thrown error stringifies to. */
  error: string | null
  /** Re-runs the full panels -> layouts -> terminals load from scratch. */
  refetch: () => void
  /** Creates a terminal row under the active layout and returns it (so
   *  PanesView can splice its real DB id into the split tree via
   *  splitTree.ts's splitLeaf, per KTD2/KTD6 — the native surface keys on
   *  this row's id, so a client-side placeholder id would be wrong). `name`
   *  is optional so existing call sites keep compiling; PanesView always
   *  passes one (issue #21 — new panes default to "Pane N"). */
  createTerminal: (args: {
    command: string
    name?: string
    position: number
  }) => Promise<PaneTerminal | null>
  /** Persists an edited setup rule for an existing pane (U7's ✎ edit — a
   *  changed command relaunches PaneCell's surface; see SplitTree.tsx's
   *  onCommandChange). */
  updateTerminalCommand: (terminalId: string, command: string) => Promise<void>
  /** Persists an edited display name (issue #21) — unlike command, renaming
   *  NEVER relaunches the pane's surface (PaneCell's mount effect isn't
   *  keyed on `name`). */
  updateTerminalName: (terminalId: string, name: string) => Promise<void>
  deleteTerminal: (terminalId: string) => Promise<void>
  /** Persists a new split tree for the active layout (optimistic local
   *  update is the caller's job — PanesView updates its own tree state
   *  immediately, then calls this to persist). */
  updateLayoutSplitTree: (layoutId: string, splitTree: SplitTree | null) => Promise<void>
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function usePanesData(
  activePanelId: string | null,
  activeLayoutId: string | null
): UsePanesDataResult {
  const [panels, setPanels] = useState<PanePanel[]>([])
  const [layouts, setLayouts] = useState<PaneLayout[]>([])
  // Tracks which panelId `layouts` actually belongs to — see the
  // UsePanesDataResult field doc comment above (Bug A fix) for why PanesView
  // needs this exact lag exposed to gate the "No layouts in this panel"
  // empty state correctly.
  const [layoutsPanelId, setLayoutsPanelId] = useState<string | null>(null)
  const [terminals, setTerminals] = useState<PaneTerminal[]>([])
  // Tracks which layoutId `terminals` actually belongs to — see the
  // UsePanesDataResult field doc comment above for why PanesView needs this
  // exact lag (not just `loading`) to gate pane mounting correctly.
  const [terminalsLayoutId, setTerminalsLayoutId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // External invalidation signal from panesRefreshStore.ts — bumped by
  // PanelsSection.tsx after sidebar mutations. See the file-header comment
  // above for why this hook needs it alongside its own reloadToken.
  const refreshCounter = usePanesRefresh()

  const refetch = useCallback(() => setReloadToken((t) => t + 1), [])

  // Load panels once (and on refetch). Selection defaulting now happens in
  // PanesView via panesSelectionStore, not here.
  useEffect(() => {
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- kicks off this effect's own fetch; must flip true synchronously so a fast reload doesn't briefly read as "loaded" between fetches
    setLoading(true)
    window.api.panes
      .listPanels()
      .then((loaded) => {
        if (cancelled) return
        setPanels(loaded)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(toErrorMessage(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [reloadToken, refreshCounter])

  // Load the active panel's layouts whenever it changes.
  //
  // BUG A FIX (panel-switch stale-selection race, "No layouts in this
  // panel" flashing for a panel that HAS layouts): `layoutsPanelId` is
  // invalidated to null SYNCHRONOUSLY the instant `activePanelId` changes —
  // same pattern as the terminals effect below invalidating
  // `terminalsLayoutId` on `activeLayoutId` change. Without this, rapidly
  // switching panels A -> B left `layouts` holding panel A's (possibly
  // non-empty) list while `activePanelId` already pointed at B; PanesView's
  // `!activeLayout` check (which derives from `layouts.find(...)`) had no
  // way to tell "B's layouts haven't loaded yet, this list is stale A data"
  // from "B genuinely has zero layouts" — both looked like `layouts` not
  // containing the id it wanted. Only once `listLayouts(activePanelId)`
  // resolves FOR that exact id does `layoutsPanelId` flip to match it, so
  // `layoutsPanelId === activePanelId` is the unambiguous "layouts is
  // caught up with the CURRENT panel" signal PanesView gates its empty
  // state on.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronously invalidates the "layouts is caught up" signal the instant activePanelId changes, so a stale panel's layouts can never be read as belonging to the new one
    setLayoutsPanelId(null)
    if (!activePanelId) {
      // clears derived state synchronously when no panel is selected (not an
      // async-settle callback) — no separate eslint-disable needed; the
      // directive above already covers this effect body.
      setLayouts([])
      return
    }
    let cancelled = false
    window.api.panes
      .listLayouts(activePanelId)
      .then((loaded) => {
        if (cancelled) return
        setLayouts(loaded)
        setLayoutsPanelId(activePanelId)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(toErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [activePanelId, reloadToken, refreshCounter])

  // Load the active layout's terminals whenever it changes.
  //
  // MOUNT-RACE FIX (see PanesView.tsx's `terminalsReady` + PaneCell.tsx's
  // file-header comment for the full story): `terminals` used to be the
  // ONLY signal exposed here, and it's a plain array — a caller reading it
  // right after `activeLayoutId` flips can't tell "this IS layout X's
  // (possibly empty) terminal list" from "this is layout Y's stale list,
  // layout X's fetch just hasn't resolved yet". PanesView used that stale/
  // empty array to resolve each pane's `command` for the FIRST native
  // mount, so a persisted layout opened with `command=''` (plain shell)
  // every time — the setup command silently never ran. `terminalsLayoutId`
  // closes that gap: it's set to `activeLayoutId` ONLY once THIS fetch
  // resolves for THAT id, so `terminalsLayoutId === activeLayoutId` is an
  // unambiguous "terminals is caught up" signal. Cleared to null the moment
  // activeLayoutId changes (including to null) so a stale layout's
  // terminalsLayoutId can never be mistaken for the new one's.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronously invalidates the "terminals is caught up" signal the instant activeLayoutId changes, so a stale value never lingers into the next render
    setTerminalsLayoutId(null)
    if (!activeLayoutId) {
      // clears derived state synchronously when no layout is selected (not
      // an async-settle callback) — no separate eslint-disable needed here;
      // the directive above already covers this effect body.
      setTerminals([])
      return
    }
    let cancelled = false
    window.api.panes
      .listTerminals(activeLayoutId)
      .then((loaded) => {
        if (cancelled) return
        setTerminals(loaded)
        setTerminalsLayoutId(activeLayoutId)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(toErrorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [activeLayoutId, reloadToken, refreshCounter])

  const createTerminal = useCallback(
    async (args: {
      command: string
      name?: string
      position: number
    }): Promise<PaneTerminal | null> => {
      if (!activeLayoutId) return null
      try {
        const created = await window.api.panes.createTerminal({
          layoutId: activeLayoutId,
          command: args.command,
          name: args.name,
          position: args.position
        })
        setTerminals((prev) => [...prev, created])
        setError(null)
        return created
      } catch (err: unknown) {
        setError(toErrorMessage(err))
        return null
      }
    },
    [activeLayoutId]
  )

  const updateTerminalCommand = useCallback(
    async (terminalId: string, command: string): Promise<void> => {
      try {
        const updated = await window.api.panes.updateTerminal(terminalId, { command })
        setTerminals((prev) => prev.map((t) => (t.id === terminalId ? updated : t)))
        setError(null)
      } catch (err: unknown) {
        setError(toErrorMessage(err))
      }
    },
    []
  )

  const updateTerminalName = useCallback(
    async (terminalId: string, name: string): Promise<void> => {
      try {
        const updated = await window.api.panes.updateTerminal(terminalId, { name })
        setTerminals((prev) => prev.map((t) => (t.id === terminalId ? updated : t)))
        setError(null)
      } catch (err: unknown) {
        setError(toErrorMessage(err))
      }
    },
    []
  )

  const deleteTerminal = useCallback(async (terminalId: string): Promise<void> => {
    try {
      await window.api.panes.deleteTerminal(terminalId)
      setTerminals((prev) => prev.filter((t) => t.id !== terminalId))
      setError(null)
    } catch (err: unknown) {
      setError(toErrorMessage(err))
    }
  }, [])

  const updateLayoutSplitTree = useCallback(
    async (layoutId: string, splitTree: SplitTree | null): Promise<void> => {
      try {
        const updated = await window.api.panes.updateLayout(layoutId, { splitTree })
        setLayouts((prev) => prev.map((l) => (l.id === layoutId ? updated : l)))
        setError(null)
      } catch (err: unknown) {
        setError(toErrorMessage(err))
      }
    },
    []
  )

  return {
    panels,
    layouts,
    layoutsPanelId,
    terminals,
    terminalsLayoutId,
    loading,
    error,
    refetch,
    createTerminal,
    updateTerminalCommand,
    updateTerminalName,
    deleteTerminal,
    updateLayoutSplitTree
  }
}
