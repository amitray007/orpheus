import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check } from '@phosphor-icons/react'
import type { ChipDropdownProps } from '@shared/types'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// ChipDropdown — interactive dropdown/list popover, cloned from ChipPrompt.tsx.
// Opens bottom-full (upward into the terminal rect), same anchoring contract
// as chipTooltip/chipPrompt. Used by the footer Model chip (and any future
// chip that needs a picklist rather than a free-text prompt).
//
// Keyboard: Up/Down moves a local highlighted-row index, Enter selects the
// highlighted row (same as a click), Escape emits 'cancel'. The container is
// autofocused on mount (mirroring ChipPrompt's input autoFocus) so arrow keys
// work immediately without an extra click.
// ---------------------------------------------------------------------------

export function ChipDropdown({ props, emit }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as ChipDropdownProps
  const { items, selectedValue, title } = data

  const initialIndex = Math.max(
    0,
    items.findIndex((it) => it.value === selectedValue)
  )
  const [highlighted, setHighlighted] = useState(initialIndex)
  const containerRef = useRef<HTMLDivElement>(null)

  function handleSelect(value: string): void {
    emit('select', { value })
  }

  function handleCancel(): void {
    emit('cancel')
  }

  useEffect(() => {
    containerRef.current?.focus()

    // Backstop for FIX A (hover-then-click-to-close): if macOS doesn't
    // deliver a DOM `blur` on the popover container reliably (window-level
    // deactivation), a native `window` blur still fires when the main
    // window reactivates. Treat that the same as focus leaving the popover
    // — self-dismiss so the reactivating click isn't eaten by a stale
    // focus-taking child window.
    window.addEventListener('blur', handleCancel)
    return () => window.removeEventListener('blur', handleCancel)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleCancel just emits a stable 'cancel' event; re-subscribing per-render would add churn without behavior change.
  }, [])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((i) => Math.min(items.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[highlighted]
      if (item) handleSelect(item.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onBlur={(e) => {
        // Only cancel when focus leaves the whole popover (not row→row —
        // button-to-button focus moves keep relatedTarget inside the
        // container). This is what makes the reactivation click that
        // refocuses the main window also close the dropdown on the SAME
        // click (bug 1): the click blurs this container, we emit 'cancel',
        // the overlay hides — no dead first click.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) handleCancel()
      }}
      className="w-56 bg-surface-overlay border border-border-default rounded-lg shadow-lg p-1.5 flex flex-col gap-0.5 font-[family-name:var(--font-sans)] outline-none"
    >
      {title && (
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider px-1.5 pt-0.5 pb-1">
          {title}
        </span>
      )}
      {items.map((item, idx) => {
        const isSelected = item.value === selectedValue
        const isHighlighted = idx === highlighted
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => handleSelect(item.value)}
            onMouseEnter={() => setHighlighted(idx)}
            className={[
              'flex items-center justify-between gap-2 px-2 py-1.5 rounded-md text-xs text-left transition-colors cursor-pointer',
              isSelected ? 'text-accent' : 'text-text-primary',
              isHighlighted ? 'bg-surface-raised' : ''
            ].join(' ')}
          >
            <span className="flex flex-col min-w-0">
              <span className="truncate">{item.label}</span>
              {item.sublabel && (
                <span className="text-[10px] text-text-muted truncate">{item.sublabel}</span>
              )}
            </span>
            {isSelected && <Check size={12} className="flex-shrink-0" />}
          </button>
        )
      })}
    </div>
  )
}
