import { useEffect, useRef } from 'react'
import type React from 'react'
import { ArrowFatLineUp, Gear, House, Kanban, SquaresFour } from '@phosphor-icons/react'
import { hideOverlayCard, chipTooltipId, showChipTooltip } from '@/lib/overlayClient'
import { useOverlayHoverCard } from '@/lib/useOverlayHoverCard'
import type { NavigateSurface, SurfaceId } from '../home/home.types'

export interface SurfaceFooterProps {
  activeSurface: SurfaceId
  collapsed: boolean
  updateAvailable: boolean
  updateLatest: string | null
  onNavigate: NavigateSurface
  onOpenUpdates: (input: 'pointer' | 'keyboard') => void
}

interface SurfaceButtonProps {
  surface: SurfaceId
  label: string
  Icon: React.ComponentType<{ size?: number; weight?: 'regular' | 'fill'; className?: string }>
  active: boolean
  collapsed: boolean
  onNavigate: NavigateSurface
}

function SurfaceButton({
  surface,
  label,
  Icon,
  active,
  collapsed,
  onNavigate
}: SurfaceButtonProps): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<'pointer' | 'keyboard'>('pointer')
  const tooltipId = chipTooltipId(`surface-footer:${surface}`)
  const hoverCard = useOverlayHoverCard({ openDelay: 250, closeDelay: 80 })

  useEffect(() => {
    return () => {
      hoverCard.clearTimer()
      hideOverlayCard(tooltipId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function hideTooltip(): void {
    hideOverlayCard(tooltipId)
  }

  function showTooltip(): void {
    if (!collapsed || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    showChipTooltip(
      tooltipId,
      { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      { text: label }
    )
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      onPointerDown={() => {
        inputRef.current = 'pointer'
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') inputRef.current = 'keyboard'
      }}
      onClick={() => {
        onNavigate({ surface, input: inputRef.current })
      }}
      onMouseEnter={() => hoverCard.handleMouseEnter(showTooltip)}
      onMouseLeave={() => hoverCard.handleMouseLeave(hideTooltip)}
      className={[
        'relative flex items-center h-9 rounded-md transition-colors duration-150 cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        collapsed ? 'w-9 justify-center self-center' : 'w-full gap-2.5 px-3 text-sm',
        active
          ? 'bg-accent/15 text-text-primary font-medium'
          : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay'
      ].join(' ')}
    >
      <Icon
        size={18}
        weight={active ? 'fill' : 'regular'}
        className={active ? 'text-accent' : ''}
      />
      {!collapsed && <span>{label}</span>}
    </button>
  )
}

function UpdateButton({
  collapsed,
  updateLatest,
  onOpenUpdates
}: Pick<SurfaceFooterProps, 'collapsed' | 'updateLatest' | 'onOpenUpdates'>): React.JSX.Element {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<'pointer' | 'keyboard'>('pointer')
  const tooltipId = chipTooltipId('surface-footer:update')
  const hoverCard = useOverlayHoverCard({ openDelay: 250, closeDelay: 80 })
  const description = updateLatest ? `Update available — ${updateLatest}` : 'Update available'

  useEffect(() => {
    return () => {
      hoverCard.clearTimer()
      hideOverlayCard(tooltipId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function showTooltip(): void {
    if (!collapsed || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    showChipTooltip(
      tooltipId,
      { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      { text: description }
    )
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label="Update available — open Updates settings"
      onPointerDown={() => {
        inputRef.current = 'pointer'
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') inputRef.current = 'keyboard'
      }}
      onClick={() => onOpenUpdates(inputRef.current)}
      onMouseEnter={() => hoverCard.handleMouseEnter(showTooltip)}
      onMouseLeave={() => hoverCard.handleMouseLeave(() => hideOverlayCard(tooltipId))}
      className={[
        'absolute flex items-center justify-center w-4 h-4 rounded-full bg-accent text-surface-base',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
        collapsed ? 'right-0 top-0' : 'right-2 top-1/2 -translate-y-1/2'
      ].join(' ')}
    >
      <ArrowFatLineUp size={10} weight="bold" />
    </button>
  )
}

export function SurfaceFooter({
  activeSurface,
  collapsed,
  updateAvailable,
  updateLatest,
  onNavigate,
  onOpenUpdates
}: SurfaceFooterProps): React.JSX.Element {
  const entries: Array<Pick<SurfaceButtonProps, 'surface' | 'label' | 'Icon'>> = [
    { surface: 'home', label: 'Home', Icon: House },
    { surface: 'projects', label: 'Projects', Icon: Kanban },
    { surface: 'panes', label: 'Panes', Icon: SquaresFour },
    { surface: 'settings', label: 'Settings', Icon: Gear }
  ]

  return (
    <footer className="relative flex flex-col flex-shrink-0 gap-1 p-2 border-t border-border-default">
      {entries.map((entry) => (
        <div key={entry.surface} className="relative">
          <SurfaceButton
            {...entry}
            active={activeSurface === entry.surface}
            collapsed={collapsed}
            onNavigate={onNavigate}
          />
          {entry.surface === 'settings' && updateAvailable && (
            <UpdateButton
              collapsed={collapsed}
              updateLatest={updateLatest}
              onOpenUpdates={onOpenUpdates}
            />
          )}
        </div>
      ))}
    </footer>
  )
}
