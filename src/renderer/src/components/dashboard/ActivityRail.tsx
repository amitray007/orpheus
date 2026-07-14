// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/ActivityRail.tsx
//
// The generic two-tier activity rail (VS Code / Linear pattern): a permanent
// slim (~46px) column pinned to the far left of the app that switches the
// top-level SURFACE (dashboard | projects | panes), with Settings + the
// update chip anchored to the bottom.
//
// This component is deliberately surface-agnostic — it knows nothing about
// panels/projects internals, only which surface icon is active and where to
// send clicks. It is the anti-collision seam for future surfaces: adding a
// new surface later is one icon here + one secondary-sidebar component
// rendered by Dashboard.tsx, with no changes to this file's structure
// otherwise.
//
// Each top-level surface renders its own secondary sidebar column to the
// right of this rail (Sidebar.tsx for projects, PanelsSection for panes,
// none for dashboard) — see Dashboard.tsx's render body for that wiring.
// ---------------------------------------------------------------------------

import type React from 'react'
import { useEffect, useRef } from 'react'
import { ArrowFatLineUp, Gear, House, Kanban, SquaresFour } from '@phosphor-icons/react'
import { useOverlayHoverCard } from '@/lib/useOverlayHoverCard'
import { showChipTooltip, hideOverlayCard, chipTooltipId } from '@/lib/overlayClient'

// The rail's fixed width (px). Exported so the TopBar can offset its left
// section by the SAME amount — the TopBar's left block must span rail + sidebar
// so the workspace title slot lines up with the content column below (rail +
// secondary sidebar + main). Keeping it here (single source) prevents the
// TopBar offset from drifting from the rail's actual width.
export const ACTIVITY_RAIL_WIDTH = 46

interface ActivityRailProps {
  /** Which top-level surface is active. null while in Settings — the rail
   *  has no active icon in that case (Settings is a bottom button). */
  activeSurface: 'dashboard' | 'projects' | 'panes' | null
  settingsActive: boolean
  updateAvailable: boolean
  updateLatest: string | null
  onSelectSurface: (s: 'dashboard' | 'projects' | 'panes') => void
  onSelectSettings: () => void
  onOpenUpdates: () => void
}

interface RailButtonProps {
  Icon: React.ComponentType<{ size?: number; weight?: 'regular' | 'fill'; className?: string }>
  label: string
  /** Tooltip title, if it should read differently from `label` (which also
   *  drives aria-label/aria-current semantics). E.g. the "dashboard" surface
   *  is user-facing "Home" even though the surface id/aria-label stays
   *  "Dashboard". Defaults to `label`. */
  tooltipLabel?: string
  active: boolean
  onClick: () => void
}

// Rail buttons sit at the far-left edge of the window (see ACTIVITY_RAIL_WIDTH
// above) — like Sidebar's collapsed project tiles (showProjectCard) and the
// workspace hover card (showHoverCard), the OVERLAY tooltip is anchored with
// preferredSide 'right' since there's no room to open left/top without going
// off-screen. Reuses the footer ActionChip's chipTooltip overlay kind rather
// than the native `title` attribute, which the terminal NSView can occlude.
//
// The ref + mouse handlers are kept inline in each component (rather than
// factored into a shared custom hook returning them) to mirror Sidebar.tsx's
// WorkspaceSubRow hover-card wiring exactly — routing a ref through a hook's
// return value trips the react-hooks/refs compiler rule ("cannot access refs
// during render") because it can no longer prove the ref read only happens
// inside the event-handler closure.
function RailButton({
  Icon,
  label,
  tooltipLabel,
  active,
  onClick
}: RailButtonProps): React.JSX.Element {
  const title = tooltipLabel ?? label
  const btnRef = useRef<HTMLButtonElement>(null)
  const tooltipId = chipTooltipId(`rail:${label}`)
  const hoverCard = useOverlayHoverCard({ openDelay: 250, closeDelay: 80 })

  function hideTooltip(): void {
    hideOverlayCard(tooltipId)
  }

  function handleMouseEnter(): void {
    hoverCard.handleMouseEnter(() => {
      if (!btnRef.current) return
      const r = btnRef.current.getBoundingClientRect()
      const text = title
      showChipTooltip(
        tooltipId,
        { x: r.left, y: r.top, w: r.width, h: r.height },
        { text },
        undefined,
        'right'
      )
    })
  }

  function handleMouseLeave(): void {
    hoverCard.handleMouseLeave(hideTooltip)
  }

  // Unmount safety: cancel any pending timer and make sure the tooltip
  // doesn't outlive the button (mirrors WorkspaceSubRow's cleanup effect).
  useEffect(() => {
    return () => {
      hoverCard.clearTimer()
      hideTooltip()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <button
      ref={btnRef}
      type="button"
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={[
        'w-9 h-9 flex items-center justify-center rounded-md transition-colors duration-150 cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        // Active = soft accent pill (matches the old top-level NavItem language:
        // bg-accent/15 + accent-colored fill icon, NO left border bar). The
        // left-bar treatment is reserved for tree ROWS (ProjectRow/WorkspaceSubRow);
        // stacking it on a slim icon rail read as cluttered.
        active
          ? 'bg-accent/15 text-text-primary'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
      ].join(' ')}
    >
      <Icon
        size={20}
        weight={active ? 'fill' : 'regular'}
        className={active ? 'text-accent' : ''}
      />
    </button>
  )
}

interface UpdateButtonProps {
  updateLatest: string | null
  onOpenUpdates: () => void
}

// Standalone (not RailButton) because it has its own always-accent-colored
// styling (never toggles active/inactive) — but shows the same overlay
// tooltip the same way, inline for the same react-hooks/refs reason as above.
function UpdateButton({ updateLatest, onOpenUpdates }: UpdateButtonProps): React.JSX.Element {
  const btnRef = useRef<HTMLButtonElement>(null)
  const tooltipId = chipTooltipId('rail:update')
  const hoverCard = useOverlayHoverCard({ openDelay: 250, closeDelay: 80 })
  const description = updateLatest
    ? `v${updateLatest.startsWith('v') ? updateLatest.slice(1) : updateLatest} is ready to install`
    : undefined

  function hideTooltip(): void {
    hideOverlayCard(tooltipId)
  }

  function handleMouseEnter(): void {
    hoverCard.handleMouseEnter(() => {
      if (!btnRef.current) return
      const r = btnRef.current.getBoundingClientRect()
      const text = description ? `Update available — ${description}` : 'Update available'
      showChipTooltip(
        tooltipId,
        { x: r.left, y: r.top, w: r.width, h: r.height },
        { text },
        undefined,
        'right'
      )
    })
  }

  function handleMouseLeave(): void {
    hoverCard.handleMouseLeave(hideTooltip)
  }

  useEffect(() => {
    return () => {
      hoverCard.clearTimer()
      hideTooltip()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <button
      ref={btnRef}
      type="button"
      className={[
        'w-9 h-9 flex items-center justify-center rounded-md transition-colors duration-150 cursor-pointer',
        'text-accent bg-transparent hover:bg-accent/15',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
      ].join(' ')}
      onClick={onOpenUpdates}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      aria-label="Update available — open Updates settings"
    >
      <ArrowFatLineUp size={20} weight="bold" />
    </button>
  )
}

export function ActivityRail({
  activeSurface,
  settingsActive,
  updateAvailable,
  updateLatest,
  onSelectSurface,
  onSelectSettings,
  onOpenUpdates
}: ActivityRailProps): React.JSX.Element {
  return (
    <div
      style={{ width: ACTIVITY_RAIL_WIDTH }}
      className={[
        'flex flex-col items-center h-full shrink-0 py-2 gap-1',
        'bg-surface-raised border-r border-border-default'
      ].join(' ')}
    >
      <RailButton
        Icon={House}
        label="Dashboard"
        tooltipLabel="Home"
        active={activeSurface === 'dashboard'}
        onClick={() => onSelectSurface('dashboard')}
      />
      <RailButton
        Icon={Kanban}
        label="Projects"
        active={activeSurface === 'projects'}
        onClick={() => onSelectSurface('projects')}
      />
      <RailButton
        Icon={SquaresFour}
        label="Panes"
        active={activeSurface === 'panes'}
        onClick={() => onSelectSurface('panes')}
      />

      <div className="flex-1" />

      <RailButton Icon={Gear} label="Settings" active={settingsActive} onClick={onSelectSettings} />
      {updateAvailable && (
        <UpdateButton updateLatest={updateLatest} onOpenUpdates={onOpenUpdates} />
      )}
    </div>
  )
}
