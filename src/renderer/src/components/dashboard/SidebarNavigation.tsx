import { useEffect, useRef } from 'react'
import type React from 'react'
import { Gear, House, Kanban, SquaresFour } from '@phosphor-icons/react'
import { chipTooltipId, hideOverlayCard, showChipTooltip } from '@/lib/overlayClient'
import { useOverlayHoverCard } from '@/lib/useOverlayHoverCard'

export type SidebarDestination = 'home' | 'workspaces' | 'panes' | 'settings'

interface SidebarNavigationProps {
  activeDestination: SidebarDestination
  onNavigate: (destination: SidebarDestination) => void
}

interface NavigationButtonProps {
  destination: SidebarDestination
  label: string
  Icon: React.ComponentType<{ size?: number; weight?: 'regular' | 'fill'; className?: string }>
  active: boolean
  onNavigate: (destination: SidebarDestination) => void
}

const DESTINATIONS: Array<Pick<NavigationButtonProps, 'destination' | 'label' | 'Icon'>> = [
  { destination: 'home', label: 'Home', Icon: House },
  { destination: 'workspaces', label: 'Workspaces', Icon: Kanban },
  { destination: 'panes', label: 'Panes', Icon: SquaresFour },
  { destination: 'settings', label: 'Settings', Icon: Gear }
]

function NavigationButton({
  destination,
  label,
  Icon,
  active,
  onNavigate
}: NavigationButtonProps): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const tooltipId = chipTooltipId(`sidebar-navigation:${destination}`)
  const hoverCard = useOverlayHoverCard({ openDelay: 250, closeDelay: 80 })

  function hideTooltip(): void {
    hideOverlayCard(tooltipId)
  }

  function showTooltip(): void {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    showChipTooltip(
      tooltipId,
      { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      { text: label }
    )
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
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        hoverCard.clearTimer()
        hideTooltip()
        onNavigate(destination)
      }}
      onMouseEnter={() => hoverCard.handleMouseEnter(showTooltip)}
      onMouseLeave={() => hoverCard.handleMouseLeave(hideTooltip)}
      onBlur={() => {
        hoverCard.clearTimer()
        hideTooltip()
      }}
      className={[
        'flex h-9 items-center justify-center rounded-md cursor-pointer',
        'transition-[color,background-color,transform] duration-150',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        'active:scale-[0.97] active:bg-accent/20 motion-reduce:transform-none',
        'min-w-0 flex-1',
        active
          ? 'bg-accent/15 text-accent'
          : 'text-text-secondary hover:bg-surface-overlay hover:text-text-primary'
      ].join(' ')}
    >
      <Icon size={18} weight={active ? 'fill' : 'regular'} />
    </button>
  )
}

export function SidebarNavigation({
  activeDestination,
  onNavigate
}: SidebarNavigationProps): React.JSX.Element {
  return (
    <nav
      aria-label="Primary"
      className="flex flex-shrink-0 flex-row gap-1 border-t border-border-default p-2"
    >
      {DESTINATIONS.map((entry) => (
        <NavigationButton
          key={entry.destination}
          {...entry}
          active={activeDestination === entry.destination}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  )
}
