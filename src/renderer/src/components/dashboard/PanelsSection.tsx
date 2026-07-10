// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/PanelsSection.tsx
//
// Panes v2 — sidebar "Panels" tree (Panes v2 U6). Renders the Panels ·
// Layouts hierarchy inside the real Orpheus sidebar, reusing the exact
// visual treatment of ProjectRow (panel rows) and WorkspaceSubRow (layout
// sub-rows) from Sidebar.tsx — without pulling in their hover-card/rename/
// drag-reorder/context-menu machinery, which is out of scope for this unit.
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
// Selection (which panel/layout is "active") is read from and written to
// panesSelectionStore.ts (src/renderer/src/lib/panesSelectionStore.ts) —
// clicking a panel row calls setActivePanel, clicking a layout row calls
// setActiveLayout.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { CaretDown, CaretRight, Plus, Stack } from '@phosphor-icons/react'
import type { PaneLayout, PanePanel } from '@shared/types'
import { Identicon } from '../Identicon'
import { SectionHeader } from './SidebarNavItems'
import { usePanesSelection, setActivePanel, setActiveLayout } from '@/lib/panesSelectionStore'

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

/** Creates a layout under `panel`, named after its folder, and reports the
 *  new layout id via `onDone`.
 *
 *  Project panels are folder-bound — reuse the panel's own dir so adding a
 *  layout is one click, no Finder dialog (issue #5). Only the General panel
 *  (dir === null) is cross-project, so its layouts still need a folder pick. */
async function createLayoutFlow(
  panel: PanePanel,
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
      name: basename(dir),
      dir
    })
    onDone(created.id)
  } catch (err) {
    console.error('[PanelsSection] createLayout failed', err)
  }
}

// ---------------------------------------------------------------------------
// Layout sub-row — styled like WorkspaceSubRow (32px row, pl-8 indent, white
// active bar).
// ---------------------------------------------------------------------------

interface LayoutSubRowProps {
  layout: PaneLayout
  active: boolean
  onSelect: () => void
}

function LayoutSubRow({ layout, active, onSelect }: LayoutSubRowProps): React.JSX.Element {
  // Placeholder proxy for "is this layout running": a layout with a
  // persisted split tree has at least one terminal pane. Real live-process
  // state (whether those panes' shells are actually alive) lands in U7/U8
  // once native surfaces are wired to panels/layouts.
  const isLive = layout.splitTree !== null

  return (
    <div
      className={[
        'relative flex rounded-r-md transition-colors duration-150 group h-8',
        active
          ? 'bg-text-primary/10 text-text-primary border-l-2 border-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex items-center gap-1.5 pl-8 pr-9 flex-1 text-left min-w-0 h-8 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-r-md"
        aria-label={layout.name}
      >
        <span className="flex items-center justify-center w-3 h-3 flex-shrink-0">
          <Stack
            size={12}
            weight={active ? 'fill' : 'regular'}
            className={
              active ? 'text-text-primary' : 'text-text-muted group-hover:text-text-secondary'
            }
          />
        </span>
        <span className="text-xs truncate min-w-0 flex-1 leading-none">{layout.name}</span>
      </button>
      <span className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center pointer-events-none">
        {isLive ? (
          <span className="text-[11px] leading-none text-emerald-400" aria-label="running">
            ●
          </span>
        ) : null}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Panel row — styled like ProjectRow (identicon, name, layout count, expand
// caret, gold active bar).
// ---------------------------------------------------------------------------

interface PanelRowProps {
  panel: PanePanel
  active: boolean
  expanded: boolean
  layoutCount: number
  onSelect: () => void
  onToggleExpand: () => void
  onAddLayout: () => void
}

function PanelRow({
  panel,
  active,
  expanded,
  layoutCount,
  onSelect,
  onToggleExpand,
  onAddLayout
}: PanelRowProps): React.JSX.Element {
  return (
    <div
      className={[
        'relative flex items-center rounded-r-md transition-colors duration-150 group',
        active
          ? 'bg-accent/15 text-text-primary border-l-2 border-accent'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay border-l-2 border-transparent'
      ].join(' ')}
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
        <span className="text-sm truncate min-w-0 flex-1 flex items-center gap-1.5">
          <span className="truncate">{panel.name}</span>
          <span className="text-xs text-text-muted flex-shrink-0">· {layoutCount}</span>
        </span>
      </button>
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
  const { activePanelId, activeLayoutId } = usePanesSelection()

  const loadPanels = useCallback(() => {
    window.api.panes
      .listPanels()
      .then(setPanels)
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

  function handleSelectPanel(panelId: string): void {
    setActivePanel(panelId)
    setExpandedPanelIds((prev) => new Set(prev).add(panelId))
  }

  function handleToggleExpand(panelId: string): void {
    setExpandedPanelIds((prev) => {
      const next = new Set(prev)
      if (next.has(panelId)) next.delete(panelId)
      else next.add(panelId)
      return next
    })
  }

  function handleAddPanel(): void {
    void createPanelFlow((newPanelId) => {
      loadPanels()
      setActivePanel(newPanelId)
      setExpandedPanelIds((prev) => new Set(prev).add(newPanelId))
    })
  }

  function handleAddLayout(panel: PanePanel): void {
    void createLayoutFlow(panel, (newLayoutId) => {
      loadLayouts(panel.id)
      setActivePanel(panel.id)
      setActiveLayout(newLayoutId)
      setExpandedPanelIds((prev) => new Set(prev).add(panel.id))
    })
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
                  onSelect={() => handleSelectPanel(panel.id)}
                  onToggleExpand={() => handleToggleExpand(panel.id)}
                  onAddLayout={() => handleAddLayout(panel)}
                />
                {expanded && (
                  <div className="flex flex-col gap-0.5 mt-0.5">
                    {layouts.map((layout) => (
                      <LayoutSubRow
                        key={layout.id}
                        layout={layout}
                        active={activePanelId === panel.id && activeLayoutId === layout.id}
                        onSelect={() => {
                          setActivePanel(panel.id)
                          setActiveLayout(layout.id)
                        }}
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
