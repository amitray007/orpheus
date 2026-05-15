import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { CaretDown, Check } from '@phosphor-icons/react'

// ---------------------------------------------------------------------------
// SplitButton — primary action on the left + chevron picker on the right
//
// Common usage in the project header: the primary side opens (e.g. in editor)
// with the currently-selected app; the chevron lets the user pick a different
// app from a popover and persists the choice.
// ---------------------------------------------------------------------------

export interface SplitButtonOption<T extends string> {
  value: T
  label: string
  description?: string
}

export interface SplitButtonProps<T extends string> {
  /** Left side: short label or icon (renders as the button face). */
  children: React.ReactNode
  /** Primary click — typically performs the action with the current value. */
  onClick: () => void
  /** Options shown in the popover when the chevron is clicked. */
  options: SplitButtonOption<T>[]
  /** Currently selected value; null means "no selection yet" (auto-detect). */
  value: T | null
  /** Called when the user picks a new option. */
  onChange: (v: T) => void
  /** Optional aria-label for the primary button (icon-only buttons need this). */
  primaryAriaLabel?: string
  /** Disabled state for the primary button when no options exist. */
  primaryDisabled?: boolean
  /** Optional header rendered above the options popover. */
  popoverHeader?: React.ReactNode
}

export function SplitButton<T extends string>({
  children,
  onClick,
  options,
  value,
  onChange,
  primaryAriaLabel,
  primaryDisabled = false,
  popoverHeader
}: SplitButtonProps<T>): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        onClick={onClick}
        disabled={primaryDisabled}
        aria-label={primaryAriaLabel}
        className={[
          'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-l-md',
          'text-xs text-text-secondary border border-r-0 border-border-default',
          primaryDisabled
            ? 'opacity-40 cursor-not-allowed'
            : 'hover:text-text-primary hover:bg-surface-overlay cursor-pointer',
          'transition-colors duration-150'
        ].join(' ')}
      >
        {children}
      </button>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Pick app"
        disabled={options.length === 0}
        className={[
          'inline-flex items-center justify-center w-6 py-1.5 rounded-r-md',
          'border border-border-default',
          options.length === 0
            ? 'opacity-40 cursor-not-allowed text-text-muted'
            : 'text-text-secondary hover:text-text-primary hover:bg-surface-overlay cursor-pointer',
          'transition-colors duration-150'
        ].join(' ')}
      >
        <CaretDown size={9} weight="bold" />
      </button>

      {open && options.length > 0 && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-border-default bg-surface-overlay shadow-lg py-1">
          {popoverHeader && (
            <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-text-muted border-b border-border-default/60">
              {popoverHeader}
            </div>
          )}
          {options.map((opt) => {
            const isSelected = opt.value === value
            return (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className="w-full flex items-center justify-between gap-2 px-3 py-1.5 text-sm text-left text-text-primary hover:bg-surface-raised transition-colors duration-100 cursor-pointer"
              >
                <span className="flex flex-col min-w-0">
                  <span className="truncate">{opt.label}</span>
                  {opt.description && (
                    <span className="text-xs text-text-muted truncate">{opt.description}</span>
                  )}
                </span>
                {isSelected && (
                  <Check size={12} weight="bold" className="text-accent flex-shrink-0" />
                )}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
