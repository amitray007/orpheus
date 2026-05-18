import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type React from 'react'
import { X, Plus, CaretDown, Check } from '@phosphor-icons/react'
import { CLAUDE_MODEL_OPTIONS } from '@shared/types'
import { playSound } from '../../../lib/sound'

// ---------------------------------------------------------------------------
// Shared form primitives for Settings sections
// ---------------------------------------------------------------------------

export interface SettingRowProps {
  label: string
  description?: string
  mapsTo?: string | string[]
  children: React.ReactNode
}
function labelToSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export function SettingRow({
  label,
  description,
  mapsTo,
  children
}: SettingRowProps): React.JSX.Element {
  // Two-column row: label+description on the left, control on the right.
  // On narrow widths it stacks; min 480px wide it goes side-by-side.
  const chips = mapsTo ? (Array.isArray(mapsTo) ? mapsTo : [mapsTo]) : []
  const id = `setting-${labelToSlug(label)}`
  return (
    <div
      id={id}
      className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6 py-4 border-b border-border-default/40 last:border-b-0"
    >
      <div className="flex flex-col gap-0.5 min-w-0 sm:max-w-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <label className="text-sm font-medium text-text-primary">{label}</label>
          {chips.map((key) => (
            <code
              key={key}
              className="text-[10px] font-mono text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 leading-none"
            >
              {key}
            </code>
          ))}
        </div>
        {description && <p className="text-xs text-text-muted">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel
}: SegmentedControlProps<T>): React.JSX.Element {
  // Horizontal pill group; selected option highlighted with bg-accent/15 + text-text-primary.
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5"
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          role="radio"
          aria-checked={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={[
            'px-3 py-1.5 text-xs font-medium rounded transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            value === opt.value
              ? 'bg-accent/15 text-text-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
          ].join(' ')}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Select — custom popover dropdown (no native <select>). Renders the option
// list into a body-level portal positioned against the trigger's bounding
// rect so it escapes any overflow:hidden ancestor (the settings panels,
// drawer overrides, project tab filters all scroll). Keyboard navigation
// mirrors the macOS popup: Up/Down to step, Enter to commit, Esc to close.
// ---------------------------------------------------------------------------

export interface SelectProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
  className?: string
  disabled?: boolean
  placeholder?: string
  /** Focus the trigger button on mount — replaces the old pattern where callers
   *  put a ref on the native <select>. */
  autoFocus?: boolean
}

export function Select<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
  disabled,
  placeholder,
  autoFocus
}: SelectProps<T>): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (autoFocus) triggerRef.current?.focus()
  }, [autoFocus])
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState<number>(-1)
  // Anchor rect captured at open time + viewport-clamped popover geometry.
  const [pos, setPos] = useState<{
    left: number
    top: number
    width: number
    maxHeight: number
    above: boolean
  } | null>(null)

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : (placeholder ?? '')

  function openMenu(): void {
    if (disabled) return
    setHighlight(selectedIndex >= 0 ? selectedIndex : 0)
    setOpen(true)
  }

  function closeMenu(): void {
    setOpen(false)
    // Return focus to the trigger so keyboard users stay in flow.
    triggerRef.current?.focus()
  }

  function commit(idx: number): void {
    const opt = options[idx]
    if (!opt) return
    onChange(opt.value)
    setOpen(false)
    triggerRef.current?.focus()
  }

  // Measure trigger + clamp inside the viewport on every open. Flip above the
  // trigger when there's more room there than below.
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const margin = 8
    const desiredHeight = Math.min(280, options.length * 28 + 8)
    const spaceBelow = window.innerHeight - rect.bottom - margin
    const spaceAbove = rect.top - margin
    const above = spaceBelow < desiredHeight && spaceAbove > spaceBelow
    const maxHeight = Math.max(120, above ? spaceAbove : spaceBelow)
    setPos({
      left: rect.left,
      top: above ? rect.top - 4 : rect.bottom + 4,
      width: rect.width,
      maxHeight,
      above
    })
  }, [open, options.length])

  // Close on outside mousedown.
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent): void {
      const t = e.target as Node
      if (popoverRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  // Reposition on scroll / resize so the popover tracks layout shifts.
  useEffect(() => {
    if (!open) return
    function reposition(): void {
      const trigger = triggerRef.current
      if (!trigger) return
      const rect = trigger.getBoundingClientRect()
      const margin = 8
      const desiredHeight = Math.min(280, options.length * 28 + 8)
      const spaceBelow = window.innerHeight - rect.bottom - margin
      const spaceAbove = rect.top - margin
      const above = spaceBelow < desiredHeight && spaceAbove > spaceBelow
      setPos({
        left: rect.left,
        top: above ? rect.top - 4 : rect.bottom + 4,
        width: rect.width,
        maxHeight: Math.max(120, above ? spaceAbove : spaceBelow),
        above
      })
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, options.length])

  // Scroll highlighted option into view as the user navigates.
  useEffect(() => {
    if (!open || highlight < 0) return
    const el = popoverRef.current?.querySelector<HTMLElement>(`[data-option-index="${highlight}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, highlight])

  function onTriggerKeyDown(e: React.KeyboardEvent): void {
    if (disabled) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openMenu()
    }
  }

  function onPopoverKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (h + 1) % options.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h - 1 + options.length) % options.length)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setHighlight(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setHighlight(options.length - 1)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (highlight >= 0) commit(highlight)
    }
  }

  return (
    <div className={['relative inline-flex w-full', className ?? ''].join(' ')}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onTriggerKeyDown}
        className={[
          'w-full inline-flex items-center justify-between gap-2',
          'pl-3 pr-2.5 py-1.5 rounded-md',
          'text-xs text-text-primary text-left',
          'bg-surface-raised border border-border-default',
          'transition-colors duration-150',
          disabled
            ? 'opacity-50 cursor-not-allowed'
            : 'cursor-pointer hover:border-border-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:border-accent/40'
        ].join(' ')}
      >
        <span className={['truncate', selectedIndex < 0 ? 'text-text-muted' : ''].join(' ')}>
          {selectedLabel || ' '}
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
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            autoFocus
            onKeyDown={onPopoverKeyDown}
            style={{
              position: 'fixed',
              left: pos.left,
              top: pos.above ? undefined : pos.top,
              bottom: pos.above ? window.innerHeight - pos.top : undefined,
              width: pos.width,
              maxHeight: pos.maxHeight
            }}
            className="z-50 bg-surface-overlay border border-border-default rounded-md shadow-lg py-1 overflow-y-auto focus:outline-none"
          >
            {options.map((opt, idx) => {
              const isSelected = opt.value === value
              const isHighlighted = idx === highlight
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-option-index={idx}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => commit(idx)}
                  className={[
                    'w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left transition-colors duration-100 cursor-pointer',
                    isHighlighted ? 'bg-surface-raised' : '',
                    isSelected ? 'text-text-primary' : 'text-text-secondary'
                  ].join(' ')}
                >
                  <span className="flex-shrink-0 w-3 inline-flex items-center justify-center">
                    {isSelected ? <Check size={10} weight="bold" className="text-accent" /> : null}
                  </span>
                  <span className="truncate flex-1">{opt.label}</span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}

export interface ToggleProps {
  value: boolean
  onChange: (v: boolean) => void
  ariaLabel: string
}
export function Toggle({ value, onChange, ariaLabel }: ToggleProps): React.JSX.Element {
  // iOS-style switch: 36x20 track with 14x14 knob, no border on off-state.
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      onClick={() => {
        playSound(!value ? 'toggle-on' : 'toggle-off')
        onChange(!value)
      }}
      className={[
        'relative inline-flex items-center w-9 h-5 rounded-full transition-colors duration-200 cursor-pointer',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-base',
        value ? 'bg-accent' : 'bg-surface-overlay'
      ].join(' ')}
    >
      <span
        className={[
          'inline-block w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform duration-200',
          value ? 'translate-x-[18px]' : 'translate-x-[2px]'
        ].join(' ')}
      />
    </button>
  )
}

// ---------------------------------------------------------------------------
// NumberInput — controlled text input that commits as integer or null
// ---------------------------------------------------------------------------

export interface NumberInputProps {
  value: number | null
  onChange: (v: number | null) => void
  placeholder?: string
  className?: string
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  className
}: NumberInputProps): React.JSX.Element {
  const [local, setLocal] = useState(value === null ? '' : String(value))
  // Track whether we have focus to avoid overwriting user's in-progress edits
  const hasFocus = useRef(false)

  // Sync external value changes when not focused
  // eslint-disable-next-line react-hooks/refs -- read-only ref check to derive display value; focus tracking avoids wiping user input
  const displayValue = hasFocus.current ? local : value === null ? '' : String(value)

  function commit(): void {
    hasFocus.current = false
    const trimmed = local.trim()
    if (trimmed === '') {
      onChange(null)
      return
    }
    const n = parseInt(trimmed, 10)
    if (Number.isNaN(n)) {
      // Revert to external value on bad input
      setLocal(value === null ? '' : String(value))
      return
    }
    onChange(n)
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      value={displayValue}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => {
        hasFocus.current = true
        setLocal(value === null ? '' : String(value))
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          ;(e.currentTarget as HTMLInputElement).blur()
        }
      }}
      placeholder={placeholder}
      className={
        className ??
        'w-32 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono text-right cursor-text'
      }
    />
  )
}

// ---------------------------------------------------------------------------
// RuleListEditor — add/remove string rules (no autocomplete, no validation)
// ---------------------------------------------------------------------------

export interface RuleListEditorProps {
  value: string[]
  onChange: (v: string[]) => void
  placeholder?: string
  label?: string
  mapsTo?: string | string[]
}

export function RuleListEditor({
  value,
  onChange,
  placeholder,
  label,
  mapsTo
}: RuleListEditorProps): React.JSX.Element {
  const chips = mapsTo ? (Array.isArray(mapsTo) ? mapsTo : [mapsTo]) : []
  const [localItems, setLocalItems] = useState<string[]>(value)
  // Keep in sync with external changes (e.g. initial load)
  // Only update if external value reference changed and we're not mid-edit
  const prevValueRef = useRef(value)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time comparison to avoid a sync effect
  if (prevValueRef.current !== value) {
    // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track previous value
    prevValueRef.current = value
    // Only sync if our local state doesn't match — this avoids fighting user edits
    if (JSON.stringify(localItems) !== JSON.stringify(value)) {
      setLocalItems(value)
    }
  }

  function updateItem(idx: number, text: string): void {
    const next = [...localItems]
    next[idx] = text
    setLocalItems(next)
  }

  function commitItem(idx: number): void {
    const trimmed = localItems[idx].trim()
    const filtered = localItems
      .map((item, i) => (i === idx ? trimmed : item))
      .filter((item) => item !== '')
    setLocalItems(filtered)
    onChange(filtered)
  }

  function removeItem(idx: number): void {
    const next = localItems.filter((_, i) => i !== idx)
    setLocalItems(next)
    onChange(next)
  }

  function addItem(): void {
    const next = [...localItems, '']
    setLocalItems(next)
    // Focus the new input on next tick
    setTimeout(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>('[data-rule-input]')
      const last = inputs[inputs.length - 1]
      if (last) last.focus()
    }, 0)
  }

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-text-primary">{label}</span>
          {chips.map((key) => (
            <code
              key={key}
              className="text-[10px] font-mono text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 leading-none"
            >
              {key}
            </code>
          ))}
        </div>
      )}
      {localItems.length > 0 && (
        <div className="flex flex-col gap-1">
          {localItems.map((item, idx) => (
            <div key={idx} className="flex items-center gap-1.5">
              <input
                data-rule-input
                type="text"
                value={item}
                onChange={(e) => updateItem(idx, e.target.value)}
                onBlur={() => commitItem(idx)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    ;(e.currentTarget as HTMLInputElement).blur()
                  }
                  if (e.key === 'Escape') {
                    removeItem(idx)
                  }
                }}
                placeholder={placeholder ?? 'e.g. Bash(npm run *)'}
                className="flex-1 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono"
              />
              <button
                onClick={() => removeItem(idx)}
                className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                aria-label="Remove rule"
              >
                <X size={11} weight="bold" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={addItem}
        className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors self-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded px-1"
      >
        <Plus size={11} weight="bold" />
        Add rule
      </button>
    </div>
  )
}

export interface ModelPickerProps {
  value: string
  onChange: (v: string) => void
}
export function ModelPicker({ value, onChange }: ModelPickerProps): React.JSX.Element {
  // Pre-defined aliases + a "Custom..." option that reveals a text input
  const aliases = CLAUDE_MODEL_OPTIONS
  const isCustom = !aliases.some((a) => a.value === value)
  const [showCustom, setShowCustom] = useState(isCustom)
  const [customValue, setCustomValue] = useState(isCustom ? value : '')

  return (
    <div className="flex flex-col gap-1.5 items-end">
      <div className="inline-flex bg-surface-overlay border border-border-default rounded-md p-0.5">
        {aliases.map((opt) => (
          <button
            key={opt.value}
            role="radio"
            aria-checked={!isCustom && value === opt.value}
            onClick={() => {
              setShowCustom(false)
              onChange(opt.value)
            }}
            className={[
              'px-3 py-1.5 text-xs font-medium rounded transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
              !isCustom && value === opt.value
                ? 'bg-accent/15 text-text-primary'
                : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
            ].join(' ')}
          >
            {opt.label}
          </button>
        ))}
        <button
          role="radio"
          aria-checked={isCustom}
          onClick={() => setShowCustom(true)}
          className={[
            'px-3 py-1.5 text-xs font-medium rounded transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
            isCustom
              ? 'bg-accent/15 text-text-primary'
              : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
          ].join(' ')}
        >
          Custom…
        </button>
      </div>
      {showCustom && (
        <input
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onBlur={() => {
            const v = customValue.trim()
            if (v) onChange(v)
          }}
          placeholder="model-id (e.g. claude-sonnet-4-6)"
          className="w-64 px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus:border-accent/50 transition-colors duration-150 font-mono"
        />
      )}
    </div>
  )
}
