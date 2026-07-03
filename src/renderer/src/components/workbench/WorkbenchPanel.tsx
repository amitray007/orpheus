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
// U6b (P2) — the Terminal tab now renders a real `<TerminalTab />` (a live
// $SHELL libghostty surface) instead of `<ComingSoon />`. This is also where
// the HARD CONSTRAINT from the plan's U6 lives: expanding the Workbench must
// HIDE claude's native surface (terminal:hide) — never resize it toward
// zero. The effect below fires terminal:hide on entering 'expanded' BEFORE
// the CSS transition can collapse the claude column to 0 width, and
// re-mounts claude (terminal:mount) on returning to 'open'/'dormant'. See
// docs/learnings/native-multisurface-investigation.md §7.6.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { ArrowsOutSimple, ArrowsInSimple, X } from '@phosphor-icons/react'
import { useWorkbenchApi } from './workbenchReducer'
import { ComingSoon } from './ComingSoon'
import { TerminalTab } from './TerminalTab'
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

export interface WorkbenchPanelProps {
  /** The owning claude workspace's id — needed to (a) hide/re-mount claude's
   *  own native surface on expand/collapse (the hard constraint below) and
   *  (b) key the Workbench Terminal tab's surface `workbench:<workspaceId>`. */
  workspaceId: string
}

export function WorkbenchPanel({ workspaceId }: WorkbenchPanelProps): React.JSX.Element | null {
  const api = useWorkbenchApi()
  const frameRef = useRef<HTMLDivElement>(null)
  const [activeTab, setActiveTab] = useState<WorkbenchTabId>(DEFAULT_TAB)
  const state = api?.state ?? 'dormant'
  const expanded = state === 'expanded'

  // ---------------------------------------------------------------------------
  // HARD CONSTRAINT (U6, folded into U6b): expanding the Workbench must HIDE
  // claude's native surface, never resize it toward zero. A surface holding
  // large scrollback forced to reflow to a degenerate size on a near-zero
  // resize is expensive and risks renderer/memory pressure (plan §U6;
  // investigation doc §7.6).
  //
  // Sequencing: this effect fires terminal:hide the instant `expanded`
  // becomes true — synchronously in the SAME tick React commits the new
  // `state`, i.e. BEFORE the CSS width transition on the claude column even
  // starts (the transition is driven by WorkspaceView's flex layout reacting
  // to this same state; effects run after DOM mutations are committed but
  // before the browser paints the transition's first frame). This wins the
  // race against WorkspaceView's ResizeObserver, which is guarded on the
  // renderer side by `activeRef`/component being unmounted-inactive — but the
  // authoritative guard is this explicit hide-before-collapse call, not a
  // hope that the observer fires late.
  //
  // On leaving 'expanded' (back to 'open', or all the way to 'dormant'),
  // claude is re-mounted (terminal:mount) — hide != destroy, so this is a
  // lossless re-attach of the same surface, not a fresh boot.
  // ---------------------------------------------------------------------------
  const wasExpandedRef = useRef(false)
  useEffect(() => {
    if (expanded === wasExpandedRef.current) return
    wasExpandedRef.current = expanded

    if (expanded) {
      // Entering expanded: hide claude FIRST, before any resize IPC from a
      // collapsing container can reach the addon.
      window.api.terminal
        .hide(workspaceId)
        .catch((e) => console.error('[WorkbenchPanel] claude hide (expand) failed:', e))
      return
    }

    // Leaving expanded (-> open or dormant, though dormant can't follow
    // expanded directly per the reducer's transition table — restoreToOpen/
    // stepDown always land on 'open' first): re-show claude's surface. The
    // claude column's own container ref remeasures via its ResizeObserver
    // once the DOM reflows back to non-zero width, but the surface itself
    // needs an explicit re-mount since it was hidden (removed from the
    // contentView), not merely resized.
    const termEl = document.querySelector<HTMLElement>('[data-workbench-claude-terminal-host]')
    const rect = termEl?.getBoundingClientRect()
    if (!rect) return
    const scaleFactor = window.devicePixelRatio ?? 1
    const termRect = {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    }
    window.api.terminal
      .mount(workspaceId, termRect, scaleFactor)
      .catch((e) => console.error('[WorkbenchPanel] claude re-mount (collapse) failed:', e))
  }, [expanded, workspaceId])

  const dormant = state === 'dormant'

  // TerminalTab is rendered at ONE stable position in the tree across
  // dormant/open/expanded (never behind an early return that would swap out
  // the whole subtree) — specifically so React never tears it down (which
  // would run its cleanup effect and fire workbench:destroy) on a mere
  // close-to-dormant. Closing the Workbench should only HIDE the shell (R10,
  // hide != destroy) so reopening reuses the same session instead of booting
  // a fresh one; it is only truly destroyed when this whole WorkbenchPanel
  // unmounts (the owning workspace itself is torn down) — see TerminalTab's
  // own mount-effect cleanup. `active` (not JSX presence/dormant's width:0)
  // drives hide/re-mount.
  const terminalTabActive = !dormant && activeTab === 'terminal'

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

  if (!api) return null
  const { width, toggleExpand, close, beginDividerDrag, isDraggingDivider } = api

  // Dormant is fully invisible — no rail, no strip — achieved with zero
  // width + hidden overflow on the SAME frame element the open/expanded
  // states use (not a different early-return subtree), so TerminalTab (and
  // the divider drag / keyboard listeners) stay mounted across the
  // dormant<->open<->expanded transitions instead of remounting.
  return (
    <>
      {!expanded && !dormant && (
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
        aria-hidden={dormant}
        className={[
          'flex flex-col h-full min-h-0 flex-shrink-0',
          dormant ? '' : 'border-l border-border-default bg-surface-raised'
        ].join(' ')}
        style={{
          width: dormant ? 0 : expanded ? '100%' : width,
          overflow: dormant ? 'hidden' : undefined,
          transition: isDraggingDivider ? 'none' : TRANSITION
        }}
      >
        {!dormant && (
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
        )}

        {WORKBENCH_TABS.map(({ id, label }) => (
          <div
            key={id}
            id={`workbench-tabpanel-${id}`}
            role="tabpanel"
            aria-labelledby={`workbench-tab-${id}`}
            hidden={dormant || id !== activeTab}
            className="flex-1 flex flex-col min-h-0"
          >
            {id === 'terminal' ? (
              <TerminalTab workspaceId={workspaceId} active={terminalTabActive} />
            ) : (
              id === activeTab && !dormant && <ComingSoon label={label} />
            )}
          </div>
        ))}
      </div>
    </>
  )
}
