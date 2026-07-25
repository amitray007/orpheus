import { forwardRef } from 'react'
import type React from 'react'
import { resolveSidebarWidth } from './sidebarLayout'
import type { SurfaceId } from '../home/home.types'

export interface SurfaceSidebarShellProps {
  surface: SurfaceId
  collapsed: boolean
  width: number
  ariaLabel: string
  children: React.ReactNode
  footer: React.ReactNode
}

export const SurfaceSidebarShell = forwardRef<HTMLElement, SurfaceSidebarShellProps>(
  function SurfaceSidebarShell({ surface, collapsed, width, ariaLabel, children, footer }, ref) {
    return (
      <aside
        ref={ref}
        aria-label={ariaLabel}
        data-surface={surface}
        className="flex flex-col h-full shrink-0 overflow-hidden bg-surface-raised border-r border-border-default transition-[width] duration-150 ease-out"
        style={{ width: resolveSidebarWidth(collapsed, width) }}
      >
        <div className="flex flex-col flex-1 min-h-0 overflow-hidden">{children}</div>
        {footer}
      </aside>
    )
  }
)
