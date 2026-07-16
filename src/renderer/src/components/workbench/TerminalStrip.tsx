// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/TerminalStrip.tsx
//
// U8 (P3) — the INNER tab strip for the Workbench Terminal tab: one tab per
// ad-hoc terminal, a pinned ＋ to spawn another, and horizontal scroll with
// edge chevrons that appear only on overflow
// (docs/brainstorms/2026-07-02-workbench-panes-requirements.md §5.2):
//
//   ‹ [Terminal 1 ✕][dev server][htop ✕] › | ＋
//
// Pure presentational component — it owns only the strip's own DOM/scroll
// mechanics (chevron visibility, auto-scroll-into-view for the active tab)
// and reuses the outer WorkbenchTabStrip's visual language (active-tab
// bg-accent/15 treatment, no-scrollbar + overflow-x-auto). All terminal
// list/id state is owned by the parent (TerminalTab.tsx) and passed in —
// this file has no state of its own beyond the scroll-chevron visibility.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { CaretLeft, CaretRight, Plus, X } from '@phosphor-icons/react'

export interface TerminalStripTerminal {
  id: number
  label: string
}

export interface TerminalStripProps {
  terminals: readonly TerminalStripTerminal[]
  activeTerminalId: number
  onSelect: (id: number) => void
  onClose: (id: number) => void
  onSpawn: () => void
}

/** Scroll-chevron visibility, recomputed on scroll/resize/list-length change.
 *  Split out so TerminalStrip's own render body stays under the cognitive-
 *  complexity ceiling. */
function useOverflowChevrons(
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  terminalCount: number
): { canScrollLeft: boolean; canScrollRight: boolean } {
  const [state, setState] = useState({ canScrollLeft: false, canScrollRight: false })

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return

    const recompute = (): void => {
      setState({
        canScrollLeft: el.scrollLeft > 1,
        canScrollRight: el.scrollLeft + el.clientWidth < el.scrollWidth - 1
      })
    }

    recompute()
    el.addEventListener('scroll', recompute, { passive: true })
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', recompute)
      ro.disconnect()
    }
    // Re-measures whenever the tab count changes (a new/closed tab can flip
    // overflow state even without a resize/scroll event).
  }, [scrollerRef, terminalCount])

  return state
}

function scrollByChevron(el: HTMLDivElement | null, direction: 1 | -1): void {
  el?.scrollBy({ left: direction * 120, behavior: 'smooth' })
}

export function TerminalStrip({
  terminals,
  activeTerminalId,
  onSelect,
  onClose,
  onSpawn
}: TerminalStripProps): React.JSX.Element {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const activeTabRef = useRef<HTMLButtonElement>(null)
  const { canScrollLeft, canScrollRight } = useOverflowChevrons(scrollerRef, terminals.length)

  // Auto-scroll the active tab into view — covers both ＋ spawning a new
  // (rightmost) terminal and clicking an off-screen tab directly.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTerminalId])

  return (
    <div
      role="tablist"
      aria-label="Terminals"
      className="flex items-center gap-0.5 min-w-0 flex-1 h-full px-1"
    >
      {canScrollLeft && (
        <button
          type="button"
          aria-label="Scroll terminals left"
          onClick={() => scrollByChevron(scrollerRef.current, -1)}
          className="flex items-center justify-center w-4 h-6 flex-shrink-0 text-text-muted hover:text-text-primary"
        >
          <CaretLeft size={11} />
        </button>
      )}
      <div
        ref={scrollerRef}
        className="flex items-center gap-0.5 min-w-0 flex-1 overflow-x-auto no-scrollbar"
      >
        {terminals.map((terminal) => (
          <TerminalStripTab
            key={terminal.id}
            terminal={terminal}
            isActive={terminal.id === activeTerminalId}
            tabRef={terminal.id === activeTerminalId ? activeTabRef : undefined}
            onSelect={onSelect}
            onClose={onClose}
          />
        ))}
      </div>
      {canScrollRight && (
        <button
          type="button"
          aria-label="Scroll terminals right"
          onClick={() => scrollByChevron(scrollerRef.current, 1)}
          className="flex items-center justify-center w-4 h-6 flex-shrink-0 text-text-muted hover:text-text-primary"
        >
          <CaretRight size={11} />
        </button>
      )}
      <button
        type="button"
        aria-label="New terminal"
        title="New terminal"
        onClick={onSpawn}
        className="flex items-center justify-center w-6 h-6 flex-shrink-0 rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

interface TerminalStripTabProps {
  terminal: TerminalStripTerminal
  isActive: boolean
  tabRef?: React.RefObject<HTMLButtonElement | null>
  onSelect: (id: number) => void
  onClose: (id: number) => void
}

/** A single terminal tab — split out so the ✕'s hover-visibility classes and
 *  the click-vs-close-click handling don't bloat TerminalStrip's own body.
 *  The ✕ is always present (per §5.2's mockup, even a lone "Terminal 1" has
 *  one) — closing the last terminal doesn't leave an empty state, it
 *  immediately respawns a fresh one (TerminalTab.tsx owns that policy). */
function TerminalStripTab({
  terminal,
  isActive,
  tabRef,
  onSelect,
  onClose
}: TerminalStripTabProps): React.JSX.Element {
  function handleCloseClick(e: React.MouseEvent): void {
    // No longer strictly needed to stop a bubble into a parent button (the
    // close control is now a sibling, not nested inside one) — kept as a
    // defensive no-op guard against any future wrapping click handler.
    e.stopPropagation()
    onClose(terminal.id)
  }

  // A `role="tab"` CONTAINER (not itself a <button>) holding two sibling
  // buttons — select and close. A `<button>` cannot validly nest another
  // interactive element (the previous shape had the ✕ as a nested span
  // inside the tab's own <button>), which is both invalid HTML and breaks
  // independent keyboard/AT reachability for the close action.
  return (
    <div
      role="tab"
      aria-selected={isActive}
      title={terminal.label}
      className={[
        'group flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 min-h-[26px] rounded text-xs font-medium whitespace-nowrap flex-shrink-0',
        'transition-colors duration-150',
        isActive
          ? 'bg-accent/15 text-text-primary'
          : 'text-text-muted hover:text-text-primary hover:bg-surface-overlay'
      ].join(' ')}
    >
      <button
        ref={tabRef}
        type="button"
        tabIndex={isActive ? 0 : -1}
        onClick={() => onSelect(terminal.id)}
        className="truncate max-w-32 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-sm"
      >
        {terminal.label}
      </button>
      <button
        type="button"
        aria-label={`Close ${terminal.label}`}
        title={`Close ${terminal.label}`}
        tabIndex={0}
        onClick={handleCloseClick}
        className={[
          'flex items-center justify-center w-4 h-4 rounded-sm flex-shrink-0 cursor-pointer',
          'hover:bg-surface-overlay hover:text-text-primary',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
        ].join(' ')}
      >
        <X size={9} />
      </button>
    </div>
  )
}
