import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import { CaretDown, MagnifyingGlass } from '@phosphor-icons/react'
import { IconByName } from '../../footer/iconMap'

// ---------------------------------------------------------------------------
// Curated icon list for the picker grid (~40 icons from Phosphor)
// These must all be registered in iconMap.tsx
// ---------------------------------------------------------------------------

export const PICKER_ICONS: string[] = [
  'GitFork',
  'Clipboard',
  'Brain',
  'Eraser',
  'Gauge',
  'Pulse',
  'Play',
  'Stop',
  'Terminal',
  'Code',
  'FileCode',
  'FilePlus',
  'Folder',
  'Trash',
  'PencilSimple',
  'MagnifyingGlass',
  'Lightning',
  'Flame',
  'Sparkle',
  'Robot',
  'Chat',
  'Note',
  'PushPin',
  'Tag',
  'Clock',
  'Database',
  'Globe',
  'Lock',
  'Wrench',
  'Bug',
  'Lightbulb',
  'Stack',
  'Star',
  'Heart',
  'Flag',
  'Plus',
  'Minus',
  'X',
  'Check',
  'ArrowRight',
  'Info',
  'Warning',
  'Bookmark'
]

interface IconPickerProps {
  value: string | null
  onChange: (name: string) => void
}

/**
 * Dropdown button that opens a popover grid of curated Phosphor icons.
 * Shows the currently selected icon + name on the trigger. Supports text
 * filter via a search input at the top of the popover.
 */
export function IconPicker({ value, onChange }: IconPickerProps): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [pos, setPos] = useState<{
    left: number
    top: number
    width: number
    maxHeight: number
    above: boolean
  } | null>(null)

  const filtered = filter.trim()
    ? PICKER_ICONS.filter((n) => n.toLowerCase().includes(filter.toLowerCase()))
    : PICKER_ICONS

  function openPicker(): void {
    setFilter('')
    setOpen(true)
  }

  function closePicker(): void {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function pick(name: string): void {
    onChange(name)
    closePicker()
  }

  // Position the popover relative to trigger
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 8
    const desiredHeight = 260
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const spaceAbove = rect.top - margin
    const above = spaceBelow < desiredHeight && spaceAbove > spaceBelow
    const maxHeight = Math.max(180, above ? spaceAbove : spaceBelow)
    setPos({
      left: rect.left,
      top: above ? rect.top - 4 : rect.bottom + 4,
      width: Math.max(rect.width, 260),
      maxHeight,
      above
    })
    // Auto-focus search input on open
    setTimeout(() => searchRef.current?.focus(), 30)
  }, [open])

  // Close on outside mousedown
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent): void {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      closePicker()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePicker()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="relative inline-flex w-full">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePicker() : openPicker())}
        className={[
          'w-full inline-flex items-center justify-between gap-2',
          'pl-3 pr-2.5 py-1.5 rounded-md',
          'text-xs text-text-primary text-left',
          'bg-surface-raised border border-border-default',
          'cursor-pointer hover:border-border-hover',
          'transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40'
        ].join(' ')}
      >
        <span className="inline-flex items-center gap-2 truncate">
          {value ? (
            <>
              <span className="flex-shrink-0 text-text-secondary">
                <IconByName name={value} size={12} />
              </span>
              <span className="text-text-primary truncate">{value}</span>
            </>
          ) : (
            <span className="text-text-muted">Choose icon…</span>
          )}
        </span>
        <CaretDown
          size={11}
          weight="bold"
          className={[
            'flex-shrink-0 text-text-muted transition-transform duration-150',
            open ? 'rotate-180' : ''
          ].join(' ')}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.above ? undefined : pos.top,
              bottom: pos.above ? window.innerHeight - pos.top : undefined,
              width: pos.width,
              maxHeight: pos.maxHeight
            }}
            className="z-50 bg-surface-overlay border border-border-default rounded-md shadow-lg flex flex-col overflow-hidden"
          >
            {/* Search */}
            <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border-default/60">
              <MagnifyingGlass size={11} className="text-text-muted flex-shrink-0" />
              <input
                ref={searchRef}
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter icons…"
                className="flex-1 bg-transparent text-xs text-text-primary placeholder-text-muted outline-none"
              />
            </div>

            {/* Icon grid */}
            <div className="overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <p className="text-[11px] text-text-muted text-center py-4">No icons match</p>
              ) : (
                <div className="grid grid-cols-8 gap-0.5">
                  {filtered.map((name) => (
                    <button
                      key={name}
                      type="button"
                      title={name}
                      onClick={() => pick(name)}
                      className={[
                        'flex items-center justify-center w-8 h-8 rounded transition-colors duration-100 cursor-pointer',
                        'hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                        value === name
                          ? 'bg-accent/15 text-accent'
                          : 'text-text-secondary hover:text-text-primary'
                      ].join(' ')}
                    >
                      <IconByName name={name} size={14} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
