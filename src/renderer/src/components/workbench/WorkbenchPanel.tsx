// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/WorkbenchPanel.tsx
//
// U4 (P1) — the Workbench frame: docked ("open") / expanded geometry and a
// placeholder body (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md §4).
// U5 (P1) — originally added the Git · Terminal · Files · Panes tab strip to
// a header row here, alongside ⤢/⤡ + ✕ controls.
// U9 (P4) — the section-tab strip AND the ⤢/⤡ + ✕ controls moved UP into the
// top bar (WorkspaceTitleBar), split-tracked against this panel's own
// width/expanded geometry so the two rows line up pixel-for-pixel. This
// panel's header row is now per-CONTENT only — for the Terminal tab that's
// `<TerminalTab />`'s own TerminalStrip (Terminal 1/2/+); other tabs have no
// header row of their own yet. `activeTab` itself now lives in the shared
// `WorkbenchApi` (workbenchReducer.ts / workbenchStore.ts) rather than local
// state, so the top bar's tab strip and this panel's body agree on
// selection.
// U6b (P2) — the Terminal tab now renders a real `<TerminalTab />` (a live
// $SHELL libghostty surface) instead of `<ComingSoon />`. This is also where
// the HARD CONSTRAINT from the plan's U6 lives: expanding the Workbench must
// HIDE claude's native surface (terminal:hide) — never resize it toward
// zero. The effect below fires terminal:hide on entering 'expanded' BEFORE
// the CSS transition can collapse the claude column to 0 width, and
// re-mounts claude (terminal:mount) on returning to 'open'/'dormant'. See
// docs/learnings/native-multisurface-investigation.md §7.6.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react'
import type React from 'react'
import { useWorkbenchApi } from './workbenchReducer'
import { ComingSoon } from './ComingSoon'
import { TerminalTab } from './TerminalTab'
import { WORKBENCH_TABS } from './workbenchTabs'

const TRANSITION = 'width 200ms ease'

export interface WorkbenchPanelProps {
  /** The owning claude workspace's id — needed to (a) hide/re-mount claude's
   *  own native surface on expand/collapse (the hard constraint below) and
   *  (b) key the Workbench Terminal tab's surface `workbench:<workspaceId>`. */
  workspaceId: string
}

export function WorkbenchPanel({ workspaceId }: WorkbenchPanelProps): React.JSX.Element | null {
  const api = useWorkbenchApi()
  const frameRef = useRef<HTMLDivElement>(null)
  const state = api?.state ?? 'dormant'
  const activeTab = api?.activeTab ?? 'terminal'
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
  const { width, beginDividerDrag, isDraggingDivider } = api

  // Dormant is fully invisible — no rail, no header — achieved with zero
  // width + hidden overflow on the SAME frame element the open/expanded
  // states use (not a different early-return subtree), so TerminalTab (and
  // the divider drag / keyboard listeners) stay mounted across the
  // dormant<->open<->expanded transitions instead of remounting.
  //
  // No header row of section-tabs / ⤢/⤡ / ✕ here anymore (U9) — those moved
  // up into the top bar (WorkspaceTitleBar), which reads/drives this same
  // `api`. Each tab body owns its OWN header row now, if it has one — the
  // Terminal tab's `<TerminalTab />` renders its own TerminalStrip
  // (Terminal 1/2/+) at the top of its tabpanel.
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
