// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/WorkbenchPanel.tsx
//
// U4 (P1) — the Workbench frame: docked ("open") / expanded geometry, a
// header (⤢/⤡ expand-toggle + ✕ close) and a placeholder body
// (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md §4).
// U5 (P1) — adds the Git · Terminal · Files · Panes tab strip to the header
// row (left of the ⤢/⤡ + ✕ controls) and renders the active tab's
// `<ComingSoon />` body below. See WorkbenchTabStrip.tsx for the tab
// affordance itself; this file only owns which tab is active and the layout
// slot it renders into.
//
// SCOPE BOUNDARY (U4/U5): this is pure DOM + CSS geometry driving
// placeholders. It does NOT touch the claude native terminal surface or its
// host container — when state is 'expanded' this frame simply grows (via
// WorkspaceView's flex sizing) to visually occupy the claude column's space;
// the native libghostty surface underneath keeps running exactly as it does
// today. U6 is where the native reframe/hide actually happens — see the
// comment marker below. No real tab content yet (that's P3-P6).
//
// Always rendered (Workbench is always on); returns the dormant zero-width
// placeholder when state === 'dormant' (dormant is fully invisible per the
// state table — no rail, no strip).
// ---------------------------------------------------------------------------

import { useRef, useState } from 'react'
import type React from 'react'
import { ArrowsOutSimple, ArrowsInSimple, X } from '@phosphor-icons/react'
import { useWorkbenchApi } from './workbenchReducer'
import { ComingSoon } from './ComingSoon'
import { WorkbenchTabStrip } from './WorkbenchTabStrip'
import { WORKBENCH_TABS, type WorkbenchTabId } from './workbenchTabs'

const TRANSITION = 'width 200ms ease'

// Default tab: Terminal. It's the most immediately useful "give me a shell"
// action per the requirements doc (§5.2 — "Job: give me a shell, quickly")
// and is the tab most likely to be reached for first once P3 lands real
// content; Git/Files/Panes are comparatively exploratory. Tab selection is
// ephemeral component state (not persisted) — it resets to this default each
// time the Workbench panel remounts, and is preserved across
// open<->expanded transitions since the panel itself stays mounted across
// those state changes.
const DEFAULT_TAB: WorkbenchTabId = 'terminal'

export function WorkbenchPanel(): React.JSX.Element | null {
  const api = useWorkbenchApi()
  const frameRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<WorkbenchTabId>(DEFAULT_TAB)
  if (!api) return null
  const { state, width, toggleExpand, close, beginDividerDrag, isDraggingDivider } = api

  if (state === 'dormant') {
    // Dormant is fully invisible — no rail, no strip. Still mounted (so the
    // divider drag / keyboard listeners above it keep working) but renders
    // zero width and is inert to layout + a11y trees.
    return <div aria-hidden="true" style={{ width: 0, flexShrink: 0 }} />
  }

  const expanded = state === 'expanded'

  function handleDividerMouseDown(e: React.MouseEvent): void {
    // Available width = the claude column's current rendered width plus the
    // workbench frame's own current width — the total the divider is
    // redistributing between the two. Looked up via a data attribute
    // (rather than assuming DOM order) so it stays correct regardless of
    // whether other siblings (e.g. the legacy settings drawer) are present.
    // Falls back to a generous default if either hasn't laid out yet.
    const frameWidth = frameRef.current?.getBoundingClientRect().width ?? width
    const claudeColumn = document.querySelector('[data-workbench-claude-column]')
    const claudeWidth = claudeColumn?.getBoundingClientRect().width ?? 0
    beginDividerDrag(e, claudeWidth + frameWidth)
  }

  // U6 WIRING POINT: when `expanded` is true, the claude native surface must
  // be HIDDEN (via terminal:hide / addon.hide) here — NOT resized toward zero
  // width. Hiding removes the surface from view while preserving it intact at
  // its last size; resizing a surface with large scrollback down to ~0px would
  // force libghostty to reflow the whole buffer to a degenerate size, which is
  // expensive and risks renderer/memory pressure. Restore on collapse re-shows
  // the surface verbatim (hide != destroy, lossless). For U4 the native surface
  // is left running untouched; only the DOM geometry below reflects the
  // expanded state — and the claude DOM column collapsing to 0 here is harmless
  // because the native view ignores DOM width; U6 owns the real hide.
  return (
    <>
      {!expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Workbench"
          onMouseDown={handleDividerMouseDown}
          className={[
            'w-1 flex-shrink-0 cursor-col-resize hover:bg-accent/40 transition-colors duration-150',
            isDraggingDivider ? 'bg-accent/40' : 'bg-transparent'
          ].join(' ')}
        />
      )}
      <div
        ref={frameRef}
        className="flex flex-col h-full min-h-0 border-l border-border-default bg-surface-raised flex-shrink-0"
        style={{
          width: expanded ? '100%' : width,
          transition: isDraggingDivider ? 'none' : TRANSITION
        }}
      >
        <div className="flex items-center justify-between gap-2 h-8 px-2 border-b border-border-default flex-shrink-0">
          <WorkbenchTabStrip activeTab={activeTab} onChange={setActiveTab} />
          <div className="flex items-center gap-1 flex-shrink-0 pl-2 border-l border-border-default">
            <button
              type="button"
              onClick={toggleExpand}
              aria-label={expanded ? 'Collapse Workbench' : 'Expand Workbench'}
              aria-expanded={expanded}
              title={expanded ? 'Collapse' : 'Expand'}
              className="flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              {expanded ? <ArrowsInSimple size={13} /> : <ArrowsOutSimple size={13} />}
            </button>
            <button
              type="button"
              onClick={close}
              aria-label="Close Workbench"
              title="Close"
              className="flex items-center justify-center w-6 h-6 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {WORKBENCH_TABS.map(({ id, label }) => (
          <div
            key={id}
            id={`workbench-tabpanel-${id}`}
            role="tabpanel"
            aria-labelledby={`workbench-tab-${id}`}
            hidden={id !== activeTab}
            className="flex-1 flex flex-col min-h-0"
          >
            {id === activeTab && <ComingSoon label={label} />}
          </div>
        ))}
      </div>
    </>
  )
}
