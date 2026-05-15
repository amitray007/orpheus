import { useRef, useCallback } from 'react'
import type React from 'react'

// ---------------------------------------------------------------------------
// Tabs — page-level tab navigation
// ---------------------------------------------------------------------------

export interface TabOption<T extends string> {
  value: T
  label: string
  count?: number
}

export interface TabsProps<T extends string> {
  value: T
  onChange: (v: T) => void
  options: TabOption<T>[]
  ariaLabel?: string
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  ariaLabel = 'Page tabs'
}: TabsProps<T>): React.JSX.Element {
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map())

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, currentIndex: number): void => {
      let nextIndex: number | null = null

      if (e.key === 'ArrowRight') {
        nextIndex = (currentIndex + 1) % options.length
      } else if (e.key === 'ArrowLeft') {
        nextIndex = (currentIndex - 1 + options.length) % options.length
      } else if (e.key === 'Home') {
        nextIndex = 0
      } else if (e.key === 'End') {
        nextIndex = options.length - 1
      }

      if (nextIndex !== null) {
        e.preventDefault()
        const nextOption = options[nextIndex]
        onChange(nextOption.value)
        const nextEl = tabRefs.current.get(nextOption.value)
        nextEl?.focus()
      }
    },
    [options, onChange]
  )

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="relative flex items-end gap-0 border-b border-border-default"
    >
      {options.map((opt, i) => {
        const isActive = opt.value === value
        return (
          <button
            key={opt.value}
            ref={(el) => {
              if (el) tabRefs.current.set(opt.value, el)
              else tabRefs.current.delete(opt.value)
            }}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={[
              'relative flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded-t-sm',
              'cursor-pointer select-none',
              // The active underline is rendered as a bottom pseudo-border that
              // overlaps the tablist's border-b. We use bottom-[-1px] so it
              // sits flush with (and covers) the 1px container border.
              isActive
                ? 'text-text-primary after:absolute after:bottom-[-1px] after:left-0 after:right-0 after:h-[2px] after:bg-accent after:rounded-t'
                : 'text-text-muted hover:text-text-primary'
            ].join(' ')}
          >
            {opt.label}
            {opt.count !== undefined && (
              <span
                className={[
                  'text-xs tabular-nums',
                  isActive ? 'text-text-secondary' : 'text-text-muted'
                ].join(' ')}
              >
                ({opt.count})
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
