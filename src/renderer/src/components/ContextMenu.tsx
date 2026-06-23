import { useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import { Overlay } from '@/components/ui/Overlay'

export interface ContextMenuItem {
  label: string
  icon?: React.ReactNode
  onClick: () => void
  destructive?: boolean
  divider?: boolean
  disabled?: boolean
}

export interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
  /** When provided, clamps the menu inside this element's bounding rect instead of the viewport. */
  boundsRef?: React.RefObject<HTMLElement | null>
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
  boundsRef
}: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Shift the menu left/up if it would overflow the clamp boundary.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    const bounds = boundsRef?.current?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight
    }
    if (nx + rect.width > bounds.right) nx = bounds.right - rect.width - 4
    if (ny + rect.height > bounds.bottom) ny = bounds.bottom - rect.height - 4
    if (nx < bounds.left) nx = bounds.left + 4
    if (ny < bounds.top) ny = bounds.top + 4
    setPos({ x: nx, y: ny })
  }, [x, y, boundsRef])

  return (
    <Overlay
      open
      interactive
      onDismiss={onClose}
      portal
      style={{ position: 'fixed', left: pos.x, top: pos.y }}
      className="z-50 bg-surface-overlay border border-border-default rounded-md shadow-lg py-1 min-w-[180px]"
    >
      <div ref={menuRef}>
        {items.map((item, i) => {
          if (item.divider) {
            return <div key={i} className="my-1 border-t border-border-default" />
          }

          return (
            <button
              key={i}
              disabled={item.disabled}
              className={[
                'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors duration-100',
                item.disabled
                  ? 'opacity-40 cursor-not-allowed text-text-secondary'
                  : item.destructive
                    ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300 cursor-pointer'
                    : 'text-text-primary hover:bg-surface-raised cursor-pointer'
              ].join(' ')}
              onClick={() => {
                if (item.disabled) return
                item.onClick()
                onClose()
              }}
            >
              {item.icon && <span className="flex-shrink-0 flex items-center">{item.icon}</span>}
              {item.label}
            </button>
          )
        })}
      </div>
    </Overlay>
  )
}
