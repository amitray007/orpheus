// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/WorkbenchTabStrip.tsx
//
// U5 (P1) — the Git · Terminal · Files · Panes tab strip that lives inside
// the Workbench frame's header row, alongside the ⤢/⤡ expand-toggle + ✕
// close controls (docs/plans/2026-07-02-001-feat-workbench-panes-plan.md;
// docs/brainstorms/2026-07-02-workbench-panes-requirements.md §5).
//
// SCOPE BOUNDARY (U5): every tab body is a `<ComingSoon />` placeholder — no
// real tab content (that's P3-P6). This module owns only the tab affordance
// itself: a `role="tablist"` of four `role="tab"` buttons with roving
// tabindex (active tab is the only one in the Tab order; arrow keys move
// focus + selection between tabs, Home/End jump to the ends) plus active-tab
// styling consistent with the app's existing selected-state treatment (see
// SegmentedControl in dashboard/settings/primitives.tsx: bg-accent/15 +
// text-text-primary for the active option, text-muted otherwise).
// ---------------------------------------------------------------------------

import { useRef } from 'react'
import type React from 'react'
import { WORKBENCH_TABS, type WorkbenchTabId } from './workbenchTabs'

export interface WorkbenchTabStripProps {
  activeTab: WorkbenchTabId
  onChange: (tab: WorkbenchTabId) => void
}

/** Computes the next tab id for arrow-key roving navigation, wrapping around
 *  both ends. Kept as a small pure helper so the keydown handler below stays
 *  under the cognitive-complexity ceiling. */
function nextTabId(current: WorkbenchTabId, direction: 1 | -1): WorkbenchTabId {
  const idx = WORKBENCH_TABS.findIndex((t) => t.id === current)
  const count = WORKBENCH_TABS.length
  const nextIdx = (idx + direction + count) % count
  return WORKBENCH_TABS[nextIdx].id
}

export function WorkbenchTabStrip({
  activeTab,
  onChange
}: WorkbenchTabStripProps): React.JSX.Element {
  const tabRefs = useRef<Partial<Record<WorkbenchTabId, HTMLButtonElement | null>>>({})

  function focusAndSelect(tab: WorkbenchTabId): void {
    onChange(tab)
    tabRefs.current[tab]?.focus()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>): void {
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        focusAndSelect(nextTabId(activeTab, 1))
        return
      case 'ArrowLeft':
        e.preventDefault()
        focusAndSelect(nextTabId(activeTab, -1))
        return
      case 'Home':
        e.preventDefault()
        focusAndSelect(WORKBENCH_TABS[0].id)
        return
      case 'End':
        e.preventDefault()
        focusAndSelect(WORKBENCH_TABS[WORKBENCH_TABS.length - 1].id)
        return
      default:
        return
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Workbench tabs"
      className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto no-scrollbar"
    >
      {WORKBENCH_TABS.map(({ id, label, icon: Icon }) => {
        const isActive = id === activeTab
        return (
          <button
            key={id}
            ref={(el) => {
              tabRefs.current[id] = el
            }}
            type="button"
            role="tab"
            id={`workbench-tab-${id}`}
            aria-selected={isActive}
            aria-controls={`workbench-tabpanel-${id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={handleKeyDown}
            title={label}
            className={[
              'flex items-center gap-1 px-2 py-1 rounded text-xs font-medium whitespace-nowrap',
              'transition-colors duration-150 cursor-pointer',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
              // Active tab: a stronger warm accent fill + a thin accent
              // border so it visibly pops against the inactive tabs (this
              // strip has no bottom rule to key an underline off of — it's
              // an inline row, not a bordered strip — so the "pop" comes
              // from fill contrast, not a border-tick). Bumped from a flat
              // bg-accent/15 with no border in the earlier pass.
              isActive
                ? 'bg-accent/20 text-text-primary border border-accent/40'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay border border-transparent'
            ].join(' ')}
          >
            <Icon size={12} className="flex-shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
