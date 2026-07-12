// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/PanelsSection.tsx
//
// Panes v2 — sidebar "Panels" tree (Panes v2 U6, extended in U7 with the
// Projects-sidebar UX parity pass: auto-focus new layout, delete, context
// menu + inline rename, running-state loader). Renders the Panels ·
// Layouts hierarchy inside the real Orpheus sidebar, reusing the exact
// visual treatment of ProjectRow (panel rows) and WorkspaceSubRow (layout
// sub-rows) from Sidebar.tsx — including their hover-delete/rename/
// context-menu affordances — without pulling in drag-reorder, which stays
// out of scope for this unit.
//
// Extracted into its own file (rather than inlined in Sidebar.tsx) because
// Sidebar.tsx is already large (~1450 lines) and its own top-level function
// is already near the sonarjs cognitive-complexity ceiling (20) — adding the
// panel/layout tree rendering + add-panel/add-layout flows directly into
// Sidebar() would push it over. This file owns its own local fetch of
// panels/layouts (via window.api.panes.listPanels/listLayouts) rather than
// sharing usePanesData's fetch state with PanesView — a deliberate
// simplicity tradeoff: the sidebar's nav-tree concern (which panels/layouts
// exist, for navigation) is different from PanesView's data concern (the
// active layout's terminals), so a second, independent fetch here is
// expected duplication, not a bug.
//
// Because the two fetchers are independent, a mutation made here (delete/
// rename/create) does NOT automatically update usePanesData's state — every
// mutation handler below therefore calls bumpPanesRefresh()
// (panesRefreshStore.ts) right after its own local refetch, so PanesView's
// data hook also refetches and never serves stale data (e.g. re-selecting a
// layout this sidebar just deleted).
//
// Selection (which panel/layout is "active") is read from and written to
// panesSelectionStore.ts (src/renderer/src/lib/panesSelectionStore.ts) —
// clicking a panel row calls setActivePanel, clicking a layout row calls
// setActiveLayout.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { CaretDown, CaretRight, Plus, Stack, Trash } from '@phosphor-icons/react'
import type { PaneLayout, PanePanel } from '@shared/types'
import { Identicon } from '../Identicon'
import { ContextMenu } from '../ContextMenu'
import type { ContextMenuItem } from '../ContextMenu'
import { ActivityIndicator } from './ActivityIndicator'
import { SectionHeader } from './SidebarNavItems'
import { useSidebarBounds } from './SidebarBoundsContext'
import { useInlineRename } from '@/lib/useInlineRename'
import { RenameInput } from './settings/primitives'
import { showConfirmModalReact } from '@/lib/overlayClient'
import {
  usePanesSelection,
  getPanesSelection,
  setActivePanel,
  setActiveLayout
} from '@/lib/panesSelectionStore'
import { bumpPanesRefresh } from '@/lib/panesRefreshStore'
import { useIsLayoutLive } from '@/lib/paneLiveLayoutsStore'

const ADD_LAYOUT_LABEL = 'Add Layout'

/** The folder's basename, used as the default panel/layout name — Electron
 *  disables `window.prompt()` (it silently returns null, which used to make
 *  the whole add flow no-op), so we skip a name prompt entirely: pick a
 *  folder, name it after that folder, and let the user rename inline later.
 *  Matches the "open something fast" intent — one native dialog, no gate. */
function basename(dir: string): string {
  const parts = dir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || dir
}

/** Issue #25 — return the next available "Layout N" name given an existing
 *  list, mirroring dashboard.helpers.ts's nextWorkspaceName exactly (scan
 *  used numbers from names matching /^Layout \d+$/, pick the smallest
 *  positive integer not yet taken). Layouts previously defaulted to the
 *  folder's basename, which read as a duplicate of the panel name one level
 *  up (a project panel is already named after its folder) — "Layout N"
 *  matches the app's other auto-naming ("Workspace N", "Pane N") instead. */
function nextLayoutName(existing: PaneLayout[]): string {
  const usedNumbers = new Set(
    existing
      .map((l) => /^Layout\s+(\d+)$/.exec(l.name)?.[1])
      .filter((s): s is string => typeof s === 'string')
      .map((s) => parseInt(s, 10))
  )
  let n = 1
  while (usedNumbers.has(n)) n++
  return `Layout ${n}`
}

/** Opens the folder picker, creates a project panel named after the chosen
 *  folder, and selects it. (No name prompt — see `basename` above for why.) */
async function createPanelFlow(onDone: (newPanelId: string) => void): Promise<void> {
  const dir = await window.api.panes.pickDirectory()
  if (!dir) return
  try {
    const created = await window.api.panes.createPanel({
      kind: 'project',
      name: basename(dir),
      dir
    })
    onDone(created.id)
  } catch (err) {
    console.error('[PanelsSection] createPanel failed', err)
  }
}

/** Creates a layout under `panel`, named "Layout N" (issue #25 — see
 *  nextLayoutName above), and reports the new layout id via `onDone`.
 *
 *  Project panels are folder-bound — reuse the panel's own dir so adding a
 *  layout is one click, no Finder dialog (issue #5). Only the General panel
 *  (dir === null) is cross-project, so its layouts still need a folder pick.
 *
 *  `existingLayouts` is the panel's current layout list (passed in by the
 *  caller from PanelsSection's layoutsByPanel state) — used only to compute
 *  the next unused "Layout N" number, not persisted anywhere itself. */
async function createLayoutFlow(
  panel: PanePanel,
  existingLayouts: PaneLayout[],
  onDone: (newLayoutId: string) => void
): Promise<void> {
  let dir = panel.dir
  if (dir === null) {
    dir = await window.api.panes.pickDirectory()
    if (!dir) return
  }
  try {
    const created = await window.api.panes.createLayout({
      panelId: panel.id,
      name: nextLayoutName(existingLayouts),
      dir
    })
    onDone(created.id)
  } catch (err) {
    console.error('[PanelsSection] createLayout failed', err)
  }
}

/** Confirm-then-delete a layout. Hard delete (FK CASCADE removes its
 *  terminals) — layouts have no archive concept, unlike workspaces, so this
 *  mirrors the worktree-archive confirm pattern (Dashboard.tsx's
 *  runWorktreeArchiveFlow) rather than a soft-archive one. */
async function confirmDeleteLayout(layout: PaneLayout): Promise<boolean> {
  const result = await showConfirmModalReact({
    title: 'Delete layout?',
    body: `Delete layout "${layout.name}"? This removes its panes.`,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'confirm', label: 'Delete', style: 'danger' }
    ]
  })
  return result.buttonId === 'confirm'
}

/** Confirm-then-delete a panel. Heavier than a layout delete (cascades
 *  through every layout + terminal it owns), so the copy calls that out
 *  explicitly. Never offered for the 'general' panel — see PanelRow's menu
 *  construction, which omits Delete entirely when kind === 'general'. */
async function confirmDeletePanel(panel: PanePanel, layoutCount: number): Promise<boolean> {
  const layoutNote =
    layoutCount > 0 ? ` and its ${layoutCount} layout${layoutCount === 1 ? '' : 's'}` : ''
  const result = await showConfirmModalReact({
    title: 'Delete panel?',
    body: `Delete panel "${panel.name}"${layoutNote}? This cannot be undone.`,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'confirm', label: 'Delete', style: 'danger' }
    ]
  })
  return result.buttonId === 'confirm'
}

// ---------------------------------------------------------------------------
// Layout sub-row — styled like WorkspaceSubRow (32px row, pl-8 indent, white
// active bar), including its hover-delete button, context menu, and inline
// rename.
// ---------------------------------------------------------------------------

interface LayoutSubRowProps {
  layout: PaneLayout
  active: boolean
  renaming: boolean
  onSelect: () => void
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onDelete: () => void
}

/** The layout row's leading status-icon slot: an animated braille spinner
 *  (mirrors WorkspaceSubRow's ActivityIndicator) when the layout is
 *  "running", else the static Stack icon.
 *
 *  Issue #24 — REAL liveness, sourced from paneLiveLayoutsStore.ts (backed
 *  by main's paneSurfacesByWorkspace registry): "running" means the layout
 *  has at least one pane with a live native surface, background-aware (a
 *  layout switched away from keeps its hidden-not-destroyed panes counted,
 *  so its spinner stays lit while you're looking at a different layout).
 *  Not gated on `active` — a layout never opened this session simply never
 *  appears in the live set, so it renders idle without any extra check.
 */
function LayoutStatusIcon({
  active,
  isRunning
}: {
  active: boolean
  isRunning: boolean
}): React.JSX.Element {
  if (isRunning) {
    return <ActivityIndicator detail="working" />
  }
  return (
    <Stack
      size={12}
      weight={active ? 'fill' : 'regular'}
      className={active ? 'text-text-primary' : 'text-text-muted group-hover:text-text-secondary'}
    />
  )
}

function LayoutSubRow({
  layout,
  active,
  renaming,
  onSelect,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onDelete
}: LayoutSubRowProps): React.JSX.Element {
  // See LayoutStatusIcon's comment — real, background-aware liveness from
  // paneLiveLayoutsStore.ts, not gated on `active` (the sidebar selection
  // highlight, which stays a separate concern below).
  const isRunning = useIsLayoutLive(layout.id)

  const [hovered, setHovered] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const sidebarBoundsRef = useSidebarBounds()
  const rename = useInlineRename(layout.name, (trimmed) => onFinishRename(trimmed))

  useEffect(() => {
    if (renaming) rename.seed(layout.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming])

  function handleRenameCommit(): void {
    const trimmed = rename.value.trim()
    const willCommit = trimmed && trimmed !== layout.name
    rename.commit()
    if (!willCommit) onCancelRename()
  }

  // Issue #22 — always show the custom ContextMenu (no OS-native fallback),
  // so every Panes menu uses the same internal design regardless of sidebar
  // width. The custom ContextMenu already clamps itself inside
  // sidebarBoundsRef (see ContextMenu.tsx's useLayoutEffect), so a narrow
  // sidebar just shifts the menu rather than needing a different renderer.
  function handleContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const menuItems: ContextMenuItem[] = [
    { label: 'Rename', onClick: onBeginRename },
    { label: 'Delete', onClick: onDelete, destructive: true }
  ]

  return (
    <div
      className={[
        'relative flex rounded-r-md transition-colors duration-150 group h-8',
        active
          ? 'bg-text-primary/10 text-text-primary border-l-2 border-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
      ].join(' ')}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex items-center gap-1.5 pl-8 pr-9 flex-1 text-left min-w-0 h-8 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-r-md"
        aria-label={layout.name}
      >
        <span className="flex items-center justify-center w-3 h-3 flex-shrink-0">
          <LayoutStatusIcon active={active} isRunning={isRunning} />
        </span>
        {renaming ? (
          <RenameInput
            ariaLabel="Rename layout"
            value={rename.value}
            onChange={(e) => rename.setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameCommit()
              if (e.key === 'Escape') onCancelRename()
            }}
            onBlur={handleRenameCommit}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-surface-overlay border border-accent/40 rounded px-1.5 py-0 outline-none text-xs text-text-primary min-w-0 flex-1"
          />
        ) : (
          <span className="text-xs truncate min-w-0 flex-1 leading-none">{layout.name}</span>
        )}
      </button>
      {!renaming && hovered && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Delete layout"
          title="Delete layout"
        >
          <Trash size={13} />
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
          boundsRef={sidebarBoundsRef ?? undefined}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel row — styled like ProjectRow (identicon, name, layout count, expand
// caret, gold active bar), including its context menu + inline rename.
// Delete is context-menu-only (no hover button) since removing a panel is
// heavier than removing a layout — and is omitted entirely for 'general'.
// ---------------------------------------------------------------------------

interface PanelRowProps {
  panel: PanePanel
  active: boolean
  expanded: boolean
  layoutCount: number
  renaming: boolean
  onSelect: () => void
  onToggleExpand: () => void
  onAddLayout: () => void
  onBeginRename: () => void
  onFinishRename: (newName: string) => void
  onCancelRename: () => void
  onDelete: () => void
}

function PanelRow({
  panel,
  active,
  expanded,
  layoutCount,
  renaming,
  onSelect,
  onToggleExpand,
  onAddLayout,
  onBeginRename,
  onFinishRename,
  onCancelRename,
  onDelete
}: PanelRowProps): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const sidebarBoundsRef = useSidebarBounds()
  const rename = useInlineRename(panel.name, (trimmed) => onFinishRename(trimmed))
  const isGeneral = panel.kind === 'general'

  useEffect(() => {
    if (renaming) rename.seed(panel.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renaming])

  function handleRenameCommit(): void {
    const trimmed = rename.value.trim()
    const willCommit = trimmed && trimmed !== panel.name
    rename.commit()
    if (!willCommit) onCancelRename()
  }

  // Issue #22 — always show the custom ContextMenu (no OS-native fallback);
  // see the matching comment on LayoutSubRow's handleContextMenu above.
  function handleContextMenu(e: React.MouseEvent): void {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const menuItems: ContextMenuItem[] = [
    { label: 'Rename', onClick: onBeginRename },
    ...(isGeneral ? [] : [{ label: 'Delete', onClick: onDelete, destructive: true }])
  ]

  return (
    <div
      className={[
        'relative flex items-center rounded-r-md transition-colors duration-150 group',
        active
          ? 'bg-accent/15 text-text-primary border-l-2 border-accent'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
      ].join(' ')}
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex items-center gap-2 px-2 py-2 flex-1 text-left min-w-0 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-r-md"
        title={panel.dir ?? panel.name}
        aria-label={panel.name}
      >
        <span className="relative inline-flex items-center flex-shrink-0">
          <Identicon seed={panel.dir ?? panel.id} size={20} />
        </span>
        {renaming ? (
          <RenameInput
            ariaLabel="Rename panel"
            value={rename.value}
            onChange={(e) => rename.setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameCommit()
              if (e.key === 'Escape') onCancelRename()
            }}
            onBlur={handleRenameCommit}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-surface-overlay border border-accent/40 rounded px-2 py-0.5 outline-none text-sm font-medium text-text-primary min-w-0 flex-1"
          />
        ) : (
          <span className="text-sm truncate min-w-0 flex-1 flex items-center gap-1.5">
            <span className="truncate">{panel.name}</span>
            <span className="text-xs text-text-muted flex-shrink-0">· {layoutCount}</span>
          </span>
        )}
      </button>
      {!renaming && (
        <div className="flex items-center gap-0.5 pr-1 flex-shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onAddLayout()
            }}
            className="w-8 h-8 flex items-center justify-center rounded-md cursor-pointer text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            title="Add layout"
            aria-label="Add layout"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onToggleExpand()
            }}
            className="w-8 h-8 flex items-center justify-center rounded-md cursor-pointer text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            title={expanded ? 'Collapse' : 'Expand layouts'}
            aria-label={expanded ? 'Collapse layouts' : 'Expand layouts'}
          >
            {expanded ? <CaretDown size={14} /> : <CaretRight size={14} />}
          </button>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
          boundsRef={sidebarBoundsRef ?? undefined}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panels section — the whole "Panels" tree, header through nested layouts.
// ---------------------------------------------------------------------------

export function PanelsSection(): React.JSX.Element {
  const [panels, setPanels] = useState<PanePanel[]>([])
  const [layoutsByPanel, setLayoutsByPanel] = useState<Map<string, PaneLayout[]>>(new Map())
  const [expandedPanelIds, setExpandedPanelIds] = useState<Set<string>>(new Set())
  const [renamingPanelId, setRenamingPanelId] = useState<string | null>(null)
  const [renamingLayoutId, setRenamingLayoutId] = useState<string | null>(null)
  const { activePanelId, activeLayoutId } = usePanesSelection()

  const loadPanels = useCallback(() => {
    window.api.panes
      .listPanels()
      .then((loaded) => {
        setPanels(loaded)
        // Seed expand state from the persisted expandedInSidebar flag on
        // each panel row (issue #1) — mirrors Dashboard.tsx's restore of
        // expandedProjectIds from projects.expandedInSidebar. Only applied
        // once, on first load: subsequent loadPanels() calls (e.g. after
        // creating a panel) must NOT clobber expand/collapse toggles the
        // user has made locally since the initial load.
        setExpandedPanelIds((prev) => {
          if (prev.size > 0) return prev
          return new Set(loaded.filter((p) => p.expandedInSidebar).map((p) => p.id))
        })
      })
      .catch((err) => console.error('[PanelsSection] listPanels failed', err))
  }, [])

  useEffect(() => {
    loadPanels()
  }, [loadPanels])

  const loadLayouts = useCallback((panelId: string) => {
    window.api.panes
      .listLayouts(panelId)
      .then((loaded) => {
        setLayoutsByPanel((prev) => {
          const next = new Map(prev)
          next.set(panelId, loaded)
          return next
        })
      })
      .catch((err) => console.error('[PanelsSection] listLayouts failed', err, panelId))
  }, [])

  // Fetch layouts for any expanded panel that hasn't been loaded yet, and
  // for the active panel (so the active layout can be resolved even when
  // collapsed).
  useEffect(() => {
    const idsToLoad = new Set(expandedPanelIds)
    if (activePanelId) idsToLoad.add(activePanelId)
    for (const id of idsToLoad) {
      if (!layoutsByPanel.has(id)) loadLayouts(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutsByPanel is read, not a dep: including it would refetch every time any panel's layouts load
  }, [expandedPanelIds, activePanelId, loadLayouts])

  // Persist the expand/collapse flag for a single panel (issue #1) — fire
  // and forget, mirrors how ProjectRow's expand toggle calls
  // window.api.projects.setExpandedInSidebar without awaiting it.
  function persistExpanded(panelId: string, expanded: boolean): void {
    window.api.panes
      .setPanelExpanded(panelId, expanded)
      .catch((err) => console.error('[PanelsSection] setPanelExpanded failed', err, panelId))
  }

  function handleSelectPanel(panelId: string): void {
    setActivePanel(panelId)
    setExpandedPanelIds((prev) => new Set(prev).add(panelId))
    persistExpanded(panelId, true)
  }

  function handleToggleExpand(panelId: string): void {
    setExpandedPanelIds((prev) => {
      const next = new Set(prev)
      const nowExpanded = !next.has(panelId)
      if (nowExpanded) next.add(panelId)
      else next.delete(panelId)
      persistExpanded(panelId, nowExpanded)
      return next
    })
  }

  function handleAddPanel(): void {
    void createPanelFlow((newPanelId) => {
      loadPanels()
      setActivePanel(newPanelId)
      setExpandedPanelIds((prev) => new Set(prev).add(newPanelId))
      persistExpanded(newPanelId, true)
      bumpPanesRefresh()
    })
  }

  // Issue #8 — auto-focus the newly created layout. setActivePanel(panelId)
  // unconditionally resets activeLayoutId to null (see
  // panesSelectionStore.ts's setActivePanel), so setActiveLayout MUST run
  // AFTER setActivePanel or the fresh selection gets clobbered back to null
  // right after being set. Ordering below is deliberate — do not reorder.
  function handleAddLayout(panel: PanePanel): void {
    const existingLayouts = layoutsByPanel.get(panel.id) ?? []
    void createLayoutFlow(panel, existingLayouts, (newLayoutId) => {
      loadLayouts(panel.id)
      setActivePanel(panel.id)
      setActiveLayout(newLayoutId)
      setExpandedPanelIds((prev) => new Set(prev).add(panel.id))
      persistExpanded(panel.id, true)
      bumpPanesRefresh()
    })
  }

  // Issue #4 (+ bug fix: deleting the active layout used to leave the main
  // Panes view stuck showing the just-deleted layout) — delete a layout,
  // confirm first (destructive, FK CASCADE takes its terminals with it).
  //
  // Two things make this robust against the bug this handler used to have:
  //
  // 1. Reads the CURRENT selection via getPanesSelection() rather than the
  //    `activeLayoutId` destructured from usePanesSelection() at render
  //    time. That render-time value is captured by this closure and can go
  //    stale by the time the `await confirmDeleteLayout` below resolves
  //    (the user could switch layouts while the confirm dialog is up) — so
  //    checking the LIVE selection at the moment of deletion is the only
  //    way to reliably know whether the just-deleted layout was active.
  // 2. Re-lists the panel's layouts directly from the source of truth
  //    (window.api.panes.listLayouts) rather than trusting the
  //    in-memory layoutsByPanel list, which could itself be stale. If the
  //    deleted layout was active, prefer selecting a SIBLING layout that
  //    still exists in this panel (nicer UX than dropping to the empty
  //    state) — else fall back to null.
  //
  // bumpPanesRefresh() at the end is the other half of the fix: it forces
  // usePanesData (PanesView's data hook) to refetch too, so its `layouts`
  // list also drops the deleted row and PanesView's seeding effect never
  // sees a stale list that still contains it.
  function handleDeleteLayout(panel: PanePanel, layout: PaneLayout): void {
    void (async () => {
      const confirmed = await confirmDeleteLayout(layout)
      if (!confirmed) return
      try {
        await window.api.panes.deleteLayout(layout.id)
        loadLayouts(panel.id)
        const wasActive = getPanesSelection().activeLayoutId === layout.id
        if (wasActive) {
          const remaining = await window.api.panes.listLayouts(panel.id)
          const sibling = remaining.find((l) => l.id !== layout.id)
          setActiveLayout(sibling ? sibling.id : null)
        }
        bumpPanesRefresh()
      } catch (err) {
        console.error('[PanelsSection] deleteLayout failed', err, layout.id)
      }
    })()
  }

  // Issue #4/#7 — delete a panel (context-menu only, never for 'general').
  // Clears the panel from local state + selection so the sidebar doesn't
  // keep pointing at a row that no longer exists.
  function handleDeletePanel(panel: PanePanel): void {
    void (async () => {
      const layoutCount = layoutsByPanel.get(panel.id)?.length ?? 0
      const confirmed = await confirmDeletePanel(panel, layoutCount)
      if (!confirmed) return
      try {
        await window.api.panes.deletePanel(panel.id)
        loadPanels()
        setLayoutsByPanel((prev) => {
          const next = new Map(prev)
          next.delete(panel.id)
          return next
        })
        if (activePanelId === panel.id) setActivePanel(null)
        bumpPanesRefresh()
      } catch (err) {
        console.error('[PanelsSection] deletePanel failed', err, panel.id)
      }
    })()
  }

  function handleRenameLayout(panel: PanePanel, layout: PaneLayout, newName: string): void {
    window.api.panes
      .updateLayout(layout.id, { name: newName })
      .then(() => {
        loadLayouts(panel.id)
        bumpPanesRefresh()
      })
      .catch((err) => console.error('[PanelsSection] updateLayout (rename) failed', err, layout.id))
    setRenamingLayoutId(null)
  }

  function handleRenamePanel(panel: PanePanel, newName: string): void {
    window.api.panes
      .updatePanel(panel.id, { name: newName })
      .then(() => {
        loadPanels()
        bumpPanesRefresh()
      })
      .catch((err) => console.error('[PanelsSection] updatePanel (rename) failed', err, panel.id))
    setRenamingPanelId(null)
  }

  const addPanelButton = (
    <button
      type="button"
      aria-label="Add panel"
      className="p-1 rounded cursor-pointer transition-colors duration-150 text-text-muted hover:text-text-primary hover:bg-surface-overlay"
      onClick={handleAddPanel}
    >
      <Plus size={14} weight="bold" />
    </button>
  )

  return (
    <div className="mt-4 flex flex-col gap-0.5 flex-1 min-h-0">
      <SectionHeader label="Panels" action={addPanelButton} />
      {panels.length === 0 ? (
        <p className="text-xs text-text-muted px-3 mt-1">No panels yet</p>
      ) : (
        <div className="flex flex-col gap-0.5 overflow-y-auto flex-1 min-h-0 no-scrollbar">
          {panels.map((panel) => {
            const expanded = expandedPanelIds.has(panel.id)
            const layouts = layoutsByPanel.get(panel.id) ?? []
            return (
              <div key={panel.id} className="flex flex-col">
                <PanelRow
                  panel={panel}
                  active={activePanelId === panel.id}
                  expanded={expanded}
                  layoutCount={layouts.length}
                  renaming={renamingPanelId === panel.id}
                  onSelect={() => handleSelectPanel(panel.id)}
                  onToggleExpand={() => handleToggleExpand(panel.id)}
                  onAddLayout={() => handleAddLayout(panel)}
                  onBeginRename={() => setRenamingPanelId(panel.id)}
                  onFinishRename={(name) => handleRenamePanel(panel, name)}
                  onCancelRename={() => setRenamingPanelId(null)}
                  onDelete={() => handleDeletePanel(panel)}
                />
                {expanded && (
                  <div className="flex flex-col gap-0.5 mt-0.5">
                    {layouts.map((layout) => (
                      <LayoutSubRow
                        key={layout.id}
                        layout={layout}
                        active={activePanelId === panel.id && activeLayoutId === layout.id}
                        renaming={renamingLayoutId === layout.id}
                        onSelect={() => {
                          setActivePanel(panel.id)
                          setActiveLayout(layout.id)
                        }}
                        onBeginRename={() => setRenamingLayoutId(layout.id)}
                        onFinishRename={(name) => handleRenameLayout(panel, layout, name)}
                        onCancelRename={() => setRenamingLayoutId(null)}
                        onDelete={() => handleDeleteLayout(panel, layout)}
                      />
                    ))}
                    <button
                      type="button"
                      onClick={() => handleAddLayout(panel)}
                      className="w-full h-8 flex items-center gap-2 pl-8 pr-2 text-left text-xs text-text-muted border-l-2 border-transparent cursor-pointer hover:text-text-primary hover:bg-surface-overlay rounded-r-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                      aria-label={ADD_LAYOUT_LABEL}
                    >
                      <Plus size={12} />
                      <span>{ADD_LAYOUT_LABEL}</span>
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
