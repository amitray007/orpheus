import type React from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

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
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Shift the menu left/up if it would overflow the viewport edges.
  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (nx + rect.width > window.innerWidth) nx = window.innerWidth - rect.width - 4
    if (ny + rect.height > window.innerHeight) ny = window.innerHeight - rect.height - 4
    setPos({ x: nx, y: ny })
  }, [x, y])

  // Close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Close on mousedown outside
  useEffect(() => {
    function onMouseDown(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-50 bg-surface-overlay border border-border-default rounded-md shadow-lg py-1 min-w-[180px]"
    >
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
            {item.icon && (
              <span className="flex-shrink-0 flex items-center">{item.icon}</span>
            )}
            {item.label}
          </button>
        )
      })}
    </div>
  )
}
