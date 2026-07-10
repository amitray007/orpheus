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
import { ArrowFatLineUp, Gear, House, Kanban, SquaresFour } from '@phosphor-icons/react'

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
  active: boolean
  onClick: () => void
}

function RailButton({ Icon, label, active, onClick }: RailButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      title={label}
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

export function ActivityRail({
  activeSurface,
  settingsActive,
  updateAvailable,
  updateLatest,
  onSelectSurface,
  onSelectSettings,
  onOpenUpdates
}: ActivityRailProps): React.JSX.Element {
  const updateTitle = updateLatest
    ? `Update available — v${updateLatest.startsWith('v') ? updateLatest.slice(1) : updateLatest}`
    : 'Update available'

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
        <button
          type="button"
          className={[
            'w-9 h-9 flex items-center justify-center rounded-md transition-colors duration-150 cursor-pointer',
            'text-accent bg-transparent hover:bg-accent/15',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
          ].join(' ')}
          onClick={onOpenUpdates}
          title={updateTitle}
          aria-label="Update available — open Updates settings"
        >
          <ArrowFatLineUp size={20} weight="bold" />
        </button>
      )}
    </div>
  )
}
