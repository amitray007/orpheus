import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, CaretRight } from '@phosphor-icons/react'
import type { ChipGroupedDropdownProps, ChipDropdownGroup } from '@shared/types'
import type { OverlayKindProps } from '../registry'
import { ProviderIcon } from '../../components/ProviderIcon'
import { RefreshModelsButton } from '../../components/RefreshModelsButton'
import {
  computeSubmenuSide,
  reduceRowHover,
  type HoveredRow
} from '../../lib/newWorkspaceMenuLogic'
import { useGenuineHoverGate } from '../../lib/useGenuineHoverGate'

// ---------------------------------------------------------------------------
// ChipGroupedDropdown — the footer Model chip's provider -> model FLYOUT
// popover (model-routing unit 10-creation, footer follow-up). The flat
// per-model list ChipDropdown renders (buildModelDropdownItems) got long and
// unstructured once every provider's models were shown in one column; this
// kind groups them: a provider list, where hovering/clicking a provider opens
// a flyout submenu of that provider's models — the SAME hierarchical-menu
// pattern NewWorkspaceMenu.tsx's "+ new workspace" popover already validated.
//
// THIS COMPONENT DELIBERATELY REUSES newWorkspaceMenuLogic.ts RATHER THAN
// RE-DERIVING ITS OWN COPY of the four hard-won fixes that module encodes:
//
//   1. Flyout, not in-place swap — computeSubmenuSide (left/right flip when
//      there's no room on the right of the parent panel).
//   2. Genuine-hover gate — reduceHoverGate/isGenuineHover. This popover's
//      card ALSO resizes as a direct consequence of a hover handler (opening
//      a provider's submenu grows the card), which is the exact mechanism
//      that produced phantom mouseenter/mouseleave cascades in the creation
//      menu — the same gate applies here unchanged.
//   3. Single JS-tracked HoveredRow (reduceRowHover) — no CSS `hover:` on any
//      row, so at most one row can ever be visually highlighted, structurally
//      (not incidentally).
//   4. Diagonal traversal — entering the submenu cancels any close scheduled
//      by leaving the provider row; leaving either re-arms the same timer.
//      Implemented at the call site (DropdownChip.tsx) via the same
//      close-delay pattern the creation menu's call site uses, since (like
//      that popover) diagonal-traversal timing is a side-effecting concern
//      that belongs in the "smart half", not this dumb render+emit kind.
//
// UNLIKE NewWorkspaceMenu.tsx, this popover is TRANSIENT (promise-settled via
// showChipGroupedDropdown, mirroring showChipDropdown) rather than long-lived
// — there's no isolation toggle, no branch panel, no top-line "create"
// action. Picking a model row settles the popover's promise immediately (a
// leaf pick IS the action here, same as the original flat ChipDropdown) —
// this is the one behavioral difference from the creation menu's inverted
// flow, because this surface has no separate "create" step to defer to.
//
// useGenuineHoverGate (point 2 above) is imported from
// ../../lib/useGenuineHoverGate.ts, NOT redefined here — that hook was
// factored out of NewWorkspaceMenu.tsx specifically so this kind (whose card
// resizes for the exact same reason and hits the exact same phantom-hover
// mechanism) could reuse it verbatim instead of carrying a second copy.
// ---------------------------------------------------------------------------

function ProviderRow({
  providerId,
  label,
  modelCount,
  highlighted,
  hasSubmenuOpen,
  onHover,
  onLeave,
  onClick
}: {
  providerId: string
  label: string
  modelCount: number
  highlighted: boolean
  hasSubmenuOpen: boolean
  onHover: () => void
  onLeave: () => void
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={hasSubmenuOpen}
      onPointerEnter={onHover}
      onPointerLeave={onLeave}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={[
        // Deliberately NO CSS `hover:` — see this file's header comment
        // (point 3). Highlight is entirely JS-driven via `highlighted`.
        'w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-left text-text-primary transition-colors duration-100 focus-visible:outline-none focus-visible:bg-surface-raised cursor-pointer',
        highlighted || hasSubmenuOpen ? 'bg-surface-raised' : ''
      ].join(' ')}
    >
      <span className="flex items-center justify-center w-3 h-3 flex-shrink-0">
        <ProviderIcon providerId={providerId} size={12} />
      </span>
      <span className="flex-1 truncate">{label}</span>
      <span className="text-[10px] text-text-muted flex-shrink-0">{modelCount}</span>
      <CaretRight size={10} className="text-text-muted flex-shrink-0" />
    </button>
  )
}

function SubmenuPanel({
  activeGroup,
  selectedValue,
  highlighted,
  onPointerEnter,
  onPointerLeave,
  onRowHover,
  onRowLeave,
  onSelect
}: {
  activeGroup: ChipDropdownGroup
  selectedValue: string | undefined
  highlighted: number
  onPointerEnter: () => void
  onPointerLeave: () => void
  onRowHover: (idx: number) => void
  onRowLeave: (idx: number) => void
  onSelect: (value: string) => void
}): React.JSX.Element {
  return (
    <div
      role="menu"
      aria-label={`${activeGroup.label} models`}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      className="w-64 flex-shrink-0 self-start rounded-lg border border-border-default bg-surface-overlay shadow-lg p-1.5 max-h-80 overflow-y-auto"
    >
      <div className="flex items-center gap-2 px-1.5 pt-0.5 pb-1 text-xs text-text-muted">
        <ProviderIcon providerId={activeGroup.providerId} size={12} />
        <span className="flex-1 truncate">{activeGroup.label}</span>
      </div>
      {activeGroup.models.map((m, idx) => {
        const isSelected = m.value === selectedValue
        return (
          <button
            key={m.value}
            type="button"
            role="menuitem"
            onPointerEnter={() => onRowHover(idx)}
            onPointerLeave={() => onRowLeave(idx)}
            onClick={(e) => {
              e.stopPropagation()
              onSelect(m.value)
            }}
            className={[
              // No CSS `hover:` here either — same fix as ProviderRow above.
              'w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-xs text-left transition-colors duration-100 cursor-pointer',
              isSelected ? 'text-accent' : 'text-text-primary',
              idx === highlighted ? 'bg-surface-raised' : ''
            ].join(' ')}
          >
            <span className="truncate">{m.label}</span>
            {isSelected && <Check size={12} className="flex-shrink-0" />}
          </button>
        )
      })}
    </div>
  )
}

export function ChipGroupedDropdown({ props, emit }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as ChipGroupedDropdownProps
  const { groups, selectedValue, title, routingProxyEnabled, refreshState } = data

  // Which provider's submenu is open — starts on whichever group contains
  // the currently-selected model (so opening the chip shows the running
  // model's provider expanded immediately, matching the old flat list's
  // "selected row already visible" behavior), falling back to the first
  // group when nothing matches (or the list is empty pre-load).
  const initialProviderId =
    groups.find((g) => g.models.some((m) => m.value === selectedValue))?.providerId ??
    groups[0]?.providerId ??
    null
  const [activeProviderId, setActiveProviderId] = useState<string | null>(initialProviderId)

  // Local highlighted-row index for KEYBOARD nav — 'providers' or 'models'
  // panel, whichever currently has keyboard focus. Mirrors
  // NewWorkspaceMenu.tsx's own split between keyboard index and mouse hover.
  const [focusPanel, setFocusPanel] = useState<'providers' | 'models'>('providers')
  const [highlighted, setHighlighted] = useState<number | null>(null)
  const [hoveredRow, setHoveredRow] = useState<HoveredRow>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const rowContainerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  const hasGenuinelyMoved = useGenuineHoverGate(() => {
    setHoveredRow((current) => reduceRowHover({ type: 'clear' }, current))
  })

  const activeGroup = groups.find((g) => g.providerId === activeProviderId) ?? null
  const rows = focusPanel === 'providers' ? groups : (activeGroup?.models ?? [])

  const defaultHighlighted =
    focusPanel === 'providers'
      ? Math.max(
          0,
          groups.findIndex((g) => g.providerId === activeProviderId)
        )
      : Math.max(
          0,
          (activeGroup?.models ?? []).findIndex((m) => m.value === selectedValue)
        )

  const hoveredInThisPanel = hoveredRow && hoveredRow.panel === focusPanel ? hoveredRow.index : null
  const effectiveHighlighted =
    hoveredInThisPanel !== null && hoveredInThisPanel < rows.length
      ? hoveredInThisPanel
      : highlighted !== null && highlighted < rows.length
        ? highlighted
        : defaultHighlighted

  // Left/right flip — same client-side geometry decision NewWorkspaceMenu.tsx
  // uses (computeSubmenuSide), recomputed whenever the active provider
  // changes (the whole card can flip sides between opens).
  const [submenuSide, setSubmenuSide] = useState<'left' | 'right'>('right')
  useLayoutEffect(() => {
    if (!activeGroup) return
    const parentEl = rowContainerRef.current
    if (!parentEl) return
    const rect = parentEl.getBoundingClientRect()
    const side = computeSubmenuSide({
      parentPanelLeft: window.screenX + rect.left,
      parentPanelWidth: rect.width,
      submenuWidth: 256, // matches SubmenuPanel's w-64
      screenWidth: window.screen.availWidth,
      gap: 0 // panels now adjoin (gap-0 above) — no gutter to reserve fitment room for
    })
    setSubmenuSide(side)
  }, [activeGroup])

  function handleCancel(): void {
    setHoveredRow(null)
    emit('cancel')
  }

  function handleSelect(value: string): void {
    emit('select', { value })
  }

  /** Hover switches which provider's submenu is shown — purely navigational,
   *  mirrors NewWorkspaceMenu.tsx's previewSubmenuFor. */
  function previewSubmenuFor(providerId: string): void {
    setHoveredRow((current) => (current && current.panel === 'models' ? null : current))
    setActiveProviderId(providerId)
    emit('hoverProvider', { providerId })
  }

  function selectRow(index: number): void {
    const clamped = Math.max(0, Math.min(rows.length - 1, index))
    setHighlighted(clamped)
    if (focusPanel === 'providers') {
      const group = groups[clamped]
      if (group) previewSubmenuFor(group.providerId)
    } else if (activeGroup) {
      const model = activeGroup.models[clamped]
      if (model) handleSelect(model.value)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (focusPanel === 'models') {
        setHighlighted(null)
        setHoveredRow(null)
        setFocusPanel('providers')
        return
      }
      handleCancel()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectRow(effectiveHighlighted + 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectRow(effectiveHighlighted - 1)
      return
    }
    if (e.key === 'ArrowRight' && focusPanel === 'providers') {
      e.preventDefault()
      const group = groups[effectiveHighlighted]
      if (group) {
        previewSubmenuFor(group.providerId)
        setFocusPanel('models')
        setHighlighted(0)
      }
      return
    }
    if (e.key === 'ArrowLeft' && focusPanel === 'models') {
      e.preventDefault()
      setHighlighted(null)
      setHoveredRow(null)
      setFocusPanel('providers')
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (focusPanel === 'providers') {
        const group = groups[effectiveHighlighted]
        if (group) {
          previewSubmenuFor(group.providerId)
          setFocusPanel('models')
          setHighlighted(0)
        }
        return
      }
      const model = activeGroup?.models[effectiveHighlighted]
      if (model) handleSelect(model.value)
    }
  }

  const parentPanel = (
    <div
      ref={rowContainerRef}
      // This panel is the sole child of a `flex` order-wrapper div (see the
      // return statement below) whose own cross-axis is stretched by the
      // outer row's `items-stretch` — a plain flex child defaults to
      // align-self: stretch, so this div fills that wrapper's full height
      // (self-stretch below is explicit for clarity/resilience, not load-
      // bearing over the default). That means this panel's own surface
      // (background/border/shadow) always fills the ROW's height — i.e.
      // matches the submenu's height whenever the submenu is taller than
      // the provider list's natural content. This is flexbox's own stretch
      // sizing, computed as part of the cross-axis layout algorithm itself
      // (not a CSS percentage-height lookup against a not-yet-resolved
      // auto-height ancestor, which would be circular) — well-defined and
      // circularity-free even though the row container has no explicit
      // height. Without this, the two panels sat at `items-start` with
      // independent natural heights: the row's height was driven by
      // whichever panel was tallest (usually the scrollable model
      // submenu), and the shorter provider panel's background stopped well
      // short of that, leaving bare (transparent overlay-window) space
      // beneath it that read as the panel "floating". Stretching this
      // panel's box to fill the row — while its content stays top-aligned
      // via `justify-start` in its own flex column — makes both panels'
      // surfaces always reach the same bottom edge, so they read as one
      // coherent menu at any content height. See SubmenuPanel's max-h-80
      // comment for why the submenu itself still needs an independent
      // scroll cap (13+ model lists) rather than also stretching. This
      // outer box is now `flex flex-col` with TWO children — the scroll
      // region (title + provider rows) and, when routing is enabled, a
      // pinned footer (RefreshModelsButton, model-routing unit 12) — rather
      // than being the single scrolling box itself; self-stretch/flex-col
      // still make its OWN surface fill the row's height exactly as this
      // comment describes, the split just moves where the padding/scroll
      // cap live (see the scroll-region div immediately below).
      className="w-64 flex-shrink-0 self-stretch rounded-lg border border-border-default bg-surface-overlay shadow-lg flex flex-col"
    >
      {/* Scroll region — title + provider rows. `min-h-0` is required for a
          flex child's max-h/overflow to actually cap it (a flex item's
          default min-height is `auto`, i.e. "at least as tall as my
          content", which silently defeats max-h-80 without this). Capped at
          the SAME max-h-80 the model submenu already uses (SubmenuPanel,
          above) so a long provider list scrolls instead of growing the
          popover unboundedly, while the footer below stays pinned and never
          scrolls with it. */}
      <div className="flex-1 min-h-0 overflow-y-auto max-h-80 p-1.5 flex flex-col justify-start gap-0.5">
        {title && (
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider px-1.5 pt-0.5 pb-1">
            {title}
          </span>
        )}
        <div
          role="menu"
          onMouseEnter={() => {
            if (!hasGenuinelyMoved()) return
            emit('enterSubmenu')
          }}
          onMouseLeave={() => {
            if (!hasGenuinelyMoved()) return
            emit('leaveSubmenu')
          }}
        >
          {groups.map((group, idx) => (
            <ProviderRow
              key={group.providerId}
              providerId={group.providerId}
              label={group.label}
              modelCount={group.models.length}
              highlighted={focusPanel === 'providers' && idx === effectiveHighlighted}
              hasSubmenuOpen={activeProviderId === group.providerId}
              onHover={() => {
                const genuine = hasGenuinelyMoved()
                setHoveredRow((current) =>
                  reduceRowHover(
                    { type: 'pointerEnter', panel: 'providers', index: idx, genuine },
                    current
                  )
                )
                if (!genuine) return
                previewSubmenuFor(group.providerId)
                setFocusPanel('providers')
              }}
              onLeave={() => {
                setHoveredRow((current) =>
                  reduceRowHover({ type: 'pointerLeave', panel: 'providers', index: idx }, current)
                )
              }}
              onClick={() => {
                setHighlighted(idx)
                setHoveredRow(null)
                previewSubmenuFor(group.providerId)
                setFocusPanel('models')
              }}
            />
          ))}
        </div>
      </div>
      {/* Pinned footer — NEVER scrolls with the provider list above (see the
          scroll-region div's own comment). Only shown when routing is
          actually enabled (multiple providers possible) — a Claude-only
          flyout has nothing to refresh (RefreshModelsButton's own doc
          comment). `onRefresh` emits 'refresh' back to the call site
          (DropdownChip.tsx) rather than touching window.api itself — this
          component (like every other kind in this file) has no access to it;
          see RefreshModelsButton.tsx's own header comment for why. */}
      {routingProxyEnabled && (
        <div className="flex-shrink-0 border-t border-border-default/60 p-1.5">
          <RefreshModelsButton state={refreshState} onRefresh={() => emit('refresh')} />
        </div>
      )}
    </div>
  )

  const submenu = activeGroup ? (
    <SubmenuPanel
      activeGroup={activeGroup}
      selectedValue={selectedValue}
      highlighted={focusPanel === 'models' ? effectiveHighlighted : -1}
      onPointerEnter={() => {
        if (!hasGenuinelyMoved()) return
        emit('enterSubmenu')
      }}
      onPointerLeave={() => {
        if (!hasGenuinelyMoved()) return
        emit('leaveSubmenu')
        setHoveredRow((current) => reduceRowHover({ type: 'clear' }, current))
      }}
      onRowHover={(idx) => {
        const genuine = hasGenuinelyMoved()
        setHoveredRow((current) =>
          reduceRowHover({ type: 'pointerEnter', panel: 'models', index: idx, genuine }, current)
        )
      }}
      onRowLeave={(idx) => {
        setHoveredRow((current) =>
          reduceRowHover({ type: 'pointerLeave', panel: 'models', index: idx }, current)
        )
      }}
      onSelect={handleSelect}
    />
  ) : null

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          handleCancel()
        }
      }}
      // gap-0 (was gap-1.5): the two panels adjoin with no visible gutter
      // between them, reading as one continuous surface (user-reported —
      // "connect them"). Safe to close: the diagonal-traversal tolerance
      // that keeps the submenu open while the pointer crosses between
      // panels is TIME-based (the close-delay timers at the call site,
      // DropdownChip.tsx's MODEL_SUBMENU_CLOSE_DELAY_MS) and the genuine-
      // hover gate (useGenuineHoverGate), never distance/gap-based — see
      // computeSubmenuSide's own `gap` param, which only ever affects the
      // LEFT/RIGHT FITMENT decision (does the submenu fit on screen), not
      // any hover-bridge tolerance. Closing the gap only shortens the
      // distance the pointer has to travel, making traversal easier, not
      // harder.
      className="flex items-stretch gap-0 outline-none font-[family-name:var(--font-sans)]"
    >
      {/* items-stretch (not items-start): the row's height is set by
          whichever panel is naturally taller (usually the model submenu,
          capped at max-h-80 — see SubmenuPanel), and both order-wrapper
          divs below are FLEX ITEMS of this row, so items-stretch stretches
          THEM (not the panels nested inside them) to that same height.
          Each wrapper is `flex` itself so its own single child (submenu or
          parentPanel) can be told to fill it via self-stretch/h-full —
          otherwise a plain block child of a stretched block wrapper does
          NOT automatically grow to fill it. Without this the two panels
          sat at independent natural heights: the row's height was driven
          by whichever panel was tallest (usually the scrollable model
          submenu), and the shorter provider panel's own surface stopped
          well short of that, leaving bare transparent overlay-window space
          beneath it that read as the panel "floating" beside a taller one.
          Flex order controls visual side — same in-flow-sibling technique as
          NewWorkspaceMenu.tsx (see that file's header comment for why an
          out-of-flow `position: absolute` submenu would get clipped by the
          overlay window's ResizeObserver-driven auto-sizing). */}
      <div className="flex" style={{ order: submenuSide === 'left' ? 0 : 2 }}>
        {submenu}
      </div>
      <div className="flex" style={{ order: 1 }}>
        {parentPanel}
      </div>
    </div>
  )
}
