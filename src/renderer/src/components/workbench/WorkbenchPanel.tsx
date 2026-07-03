// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/WorkbenchPanel.tsx
//
// U4 (P1) — the Workbench frame: docked ("open") / expanded geometry, a
// header (⤢/⤡ expand-toggle + ✕ close) and a placeholder body
// (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md §4).
//
// SCOPE BOUNDARY (U4): this is pure DOM + CSS geometry driving a placeholder.
// It does NOT touch the claude native terminal surface or its host container
// — when state is 'expanded' this frame simply grows (via WorkspaceView's
// flex sizing) to visually occupy the claude column's space; the native
// libghostty surface underneath keeps running exactly as it does today.
// U6 is where the native reframe/hide actually happens — see the comment
// marker below.
//
// Rendered only when `workbenchEnabled` (gated at the WorkspaceView call
// site) AND state !== 'dormant' (dormant is fully invisible per the state
// table — no rail, no strip).
// ---------------------------------------------------------------------------

import { useRef } from 'react'
import type React from 'react'
import { ArrowsOutSimple, ArrowsInSimple, X } from '@phosphor-icons/react'
import { useWorkbenchApi } from './workbenchReducer'
import { ComingSoon } from './ComingSoon'

const TRANSITION = 'width 200ms ease'

export function WorkbenchPanel(): React.JSX.Element | null {
  const api = useWorkbenchApi()
  const frameRef = useRef<HTMLDivElement>(null)
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

  // U6 WIRING POINT: when `expanded` is true, the claude native surface
  // should be hidden (via terminal:hide) here — or reframed to zero width —
  // instead of merely being visually covered by this frame growing over its
  // DOM column. For U4 the native surface is left running untouched; only
  // the DOM geometry below reflects the expanded state.
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
        <div className="flex items-center justify-between h-8 px-2 border-b border-border-default flex-shrink-0">
          <span className="text-xs font-medium text-text-primary truncate">Workbench</span>
          <div className="flex items-center gap-1">
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

        <ComingSoon />
      </div>
    </>
  )
}
