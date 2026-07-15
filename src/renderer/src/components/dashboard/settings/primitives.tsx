import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import { Overlay } from '@/components/ui/Overlay'
import { X, Plus, CaretDown, Check } from '@phosphor-icons/react'
import { CLAUDE_MODEL_OPTIONS, CLAUDE_MODEL_ALIAS_START_INDEX } from '@shared/types'
import { parseFlagEntry, mergeFlagScopes, isFlagParseError } from '@shared/cliFlags'
import { playSound } from '../../../lib/sound'
import { useFocusOnMount } from '@/lib/useFocusOnMount'

// ---------------------------------------------------------------------------
// Shared form primitives for Settings sections
// ---------------------------------------------------------------------------

// Small, focus-on-mount text input shared by the workspace/project rename UIs
// in Sidebar and WorkspacesTab.
export function RenameInput({
  value,
  onChange,
  onKeyDown,
  onBlur,
  onClick,
  onMouseDown,
  className,
  ariaLabel
}: {
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onBlur: () => void
  onClick: (e: React.MouseEvent<HTMLInputElement>) => void
  onMouseDown?: (e: React.MouseEvent<HTMLInputElement>) => void
  className: string
  ariaLabel: string
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  useFocusOnMount(ref)
  return (
    <input
      ref={ref}
      aria-label={ariaLabel}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      onClick={onClick}
      onMouseDown={onMouseDown}
      className={className}
    />
  )
}

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
              className="text-xs font-mono text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 leading-none"
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
          type="button"
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
  id?: string
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
  id,
  className,
  disabled,
  placeholder,
  autoFocus
}: SelectProps<T>): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
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

  // Navigable options are those whose value does NOT start with '__sep'.
  // Separator sentinel values are rendered as non-interactive dividers and are
  // skipped by keyboard navigation. highlight indexes into navigable[], not options[].
  const navigable = options.filter((o) => !o.value.startsWith('__sep'))
  const selectedNavIndex = navigable.findIndex((o) => o.value === value)
  const selectedLabel =
    navigable[selectedNavIndex]?.label ??
    options.find((o) => o.value === value)?.label ??
    placeholder ??
    ''
  // Keep selectedIndex for the legacy trigger muted-text class (negative = no selection)
  const selectedIndex = selectedNavIndex

  function openMenu(): void {
    if (disabled) return
    // No navigable options = nothing to choose.
    if (navigable.length === 0) return
    setHighlight(selectedNavIndex >= 0 ? selectedNavIndex : 0)
    setOpen(true)
  }

  function closeMenu(): void {
    setOpen(false)
    // Return focus to the trigger so keyboard users stay in flow.
    triggerRef.current?.focus()
  }

  function commit(navIdx: number): void {
    const opt = navigable[navIdx]
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
    const el = popoverRef.current?.querySelector<HTMLElement>(`[data-nav-index="${highlight}"]`)
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
      setHighlight((h) => (h + 1) % navigable.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h - 1 + navigable.length) % navigable.length)
      return
    }
    if (e.key === 'Home') {
      e.preventDefault()
      setHighlight(0)
      return
    }
    if (e.key === 'End') {
      e.preventDefault()
      setHighlight(navigable.length - 1)
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      if (highlight >= 0) commit(highlight)
    }
  }

  // Track navigable index across the flat options list for correct keyboard highlight
  let navIdxCounter = -1

  return (
    <div className={['relative inline-flex w-full', className ?? ''].join(' ')}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
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
      {open && pos && (
        <Overlay
          open
          interactive
          onDismiss={closeMenu}
          portal
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
          <div
            id={listboxId}
            ref={popoverRef}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            autoFocus
            onKeyDown={onPopoverKeyDown}
          >
            {options.map((opt) => {
              // Separator — render as non-interactive section divider
              if (opt.value.startsWith('__sep')) {
                return (
                  <div
                    key={opt.value}
                    aria-hidden="true"
                    className="px-2.5 py-1 mt-1 text-xs text-text-muted uppercase tracking-wider font-medium border-t border-border-default/40"
                  >
                    Always latest
                  </div>
                )
              }
              // Regular navigable option — assign a stable nav index
              navIdxCounter++
              const myNavIdx = navIdxCounter
              const isSelected = opt.value === value
              const isHighlighted = myNavIdx === highlight
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-nav-index={myNavIdx}
                  onMouseEnter={() => setHighlight(myNavIdx)}
                  onClick={() => commit(myNavIdx)}
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
          </div>
        </Overlay>
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
      type="button"
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
  ariaLabel?: string
}

export function NumberInput({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel
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
      aria-label={ariaLabel}
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

// Each row needs a stable identity independent of its string value/position —
// index keys would make React reuse/misplace input DOM nodes (and their focus/
// selection state) across reorders. crypto.randomUUID() gives each row a
// value-independent id, generated once per item and threaded alongside it.
interface RuleRow {
  id: string
  value: string
}

function toRows(values: string[]): RuleRow[] {
  return values.map((value) => ({ id: crypto.randomUUID(), value }))
}

export function RuleListEditor({
  value,
  onChange,
  placeholder,
  label,
  mapsTo
}: RuleListEditorProps): React.JSX.Element {
  const chips = mapsTo ? (Array.isArray(mapsTo) ? mapsTo : [mapsTo]) : []
  const [localItems, setLocalItems] = useState<RuleRow[]>(() => toRows(value))
  // Container ref — scopes addItem's focus query to THIS editor instance so
  // multiple RuleListEditor mounts (e.g. ClaudePermissionsSection's 4 rule
  // lists) never steal focus across each other.
  const containerRef = useRef<HTMLDivElement>(null)
  // Keep in sync with external changes (e.g. initial load)
  // Only update if external value reference changed and we're not mid-edit
  const prevValueRef = useRef(value)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time comparison to avoid a sync effect
  if (prevValueRef.current !== value) {
    // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track previous value
    prevValueRef.current = value
    // Only sync if our local state doesn't match — this avoids fighting user edits
    if (JSON.stringify(localItems.map((r) => r.value)) !== JSON.stringify(value)) {
      setLocalItems(toRows(value))
    }
  }

  function updateItem(idx: number, text: string): void {
    const next = [...localItems]
    next[idx] = { ...next[idx], value: text }
    setLocalItems(next)
  }

  function commitItem(idx: number): void {
    const trimmed = localItems[idx].value.trim()
    const filteredRows = localItems.flatMap((row, i) => {
      const v = i === idx ? trimmed : row.value
      return v !== '' ? [{ ...row, value: v }] : []
    })
    setLocalItems(filteredRows)
    onChange(filteredRows.map((r) => r.value))
  }

  function removeItem(idx: number): void {
    const next = localItems.filter((_, i) => i !== idx)
    setLocalItems(next)
    onChange(next.map((r) => r.value))
  }

  function addItem(): void {
    const next = [...localItems, { id: crypto.randomUUID(), value: '' }]
    setLocalItems(next)
    // Focus the new input on next tick — scoped to this editor's own
    // container so it can never reach into a sibling RuleListEditor.
    setTimeout(() => {
      const inputs = containerRef.current?.querySelectorAll<HTMLInputElement>('[data-rule-input]')
      const last = inputs?.[inputs.length - 1]
      if (last) last.focus()
    }, 0)
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5">
      {label && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-text-primary">{label}</span>
          {chips.map((key) => (
            <code
              key={key}
              className="text-xs font-mono text-text-muted bg-surface-overlay border border-border-default rounded px-1.5 py-0.5 leading-none"
            >
              {key}
            </code>
          ))}
        </div>
      )}
      {localItems.length > 0 && (
        <div className="flex flex-col gap-1">
          {localItems.map((row, idx) => (
            <div key={row.id} className="flex items-center gap-1.5">
              <input
                data-rule-input
                type="text"
                aria-label="Rule"
                value={row.value}
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
                type="button"
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
        type="button"
        onClick={addItem}
        className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors self-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded px-1"
      >
        <Plus size={11} weight="bold" />
        Add rule
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// CliFlagsEditor — add/remove free-text CLI flag entries, with live syntax
// validation (parseFlagEntry) and a live command preview (mergeFlagScopes).
//
// Copies RuleListEditor's proven mechanics: crypto.randomUUID() row ids (so
// React never misplaces focus/selection across a reorder), render-time
// prevValueRef sync (never fights an in-progress edit), commit-on-blur/Enter,
// drop-empty-on-commit, Escape-removes-row, and a containerRef-scoped
// focus-on-add so multiple CliFlagsEditor mounts (global + project) never
// steal focus from each other.
//
// Unlike RuleListEditor, each row is validated live via parseFlagEntry —
// syntax only, never "unknown flag" (see cliFlags.ts's module doc). An
// invalid row stays visible with its error but is excluded from onChange
// until it's fixed or removed, so the user is never fighting a revert.
// ---------------------------------------------------------------------------

export interface CliFlagsEditorProps {
  value: string[]
  onChange: (v: string[]) => void
  /** Flags inherited from a higher scope, rendered muted in the preview. Optional. */
  inheritedFlags?: string[]
  label?: string
  placeholder?: string
}

// Each row needs a stable identity independent of its string value/position —
// index keys would make React reuse/misplace input DOM nodes (and their focus/
// selection state) across reorders. crypto.randomUUID() gives each row a
// value-independent id, generated once per item and threaded alongside it.
interface FlagRow {
  id: string
  value: string
}

function toFlagRows(values: string[]): FlagRow[] {
  return values.map((value) => ({ id: crypto.randomUUID(), value }))
}

/** Flattens a list of raw flag entries into argv tokens, skipping any entry
 *  that doesn't currently parse (empty or syntactically invalid) — used for
 *  the live preview, which must never crash on an in-progress invalid row. */
function toValidTokens(rawEntries: string[]): string[] {
  return rawEntries.flatMap((raw) => {
    const parsed = parseFlagEntry(raw)
    return isFlagParseError(parsed) ? [] : parsed.tokens
  })
}

const FLAG_INPUT_BASE_CLASS =
  'flex-1 px-3 py-1.5 rounded-md text-xs bg-surface-raised border text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40 font-mono'
const FLAG_INPUT_VALID_CLASS = 'border-border-default'
const FLAG_INPUT_INVALID_CLASS = 'border-red-500/60'

interface CliFlagsPreviewProps {
  inheritedFlags?: string[]
  ownRawEntries: string[]
}

// Live preview line: "claude <inherited tokens muted> <own tokens normal>".
// The overall token SET shown is always the real mergeFlagScopes() result (so
// an inherited flag overridden by a same-named project flag never appears
// twice) — the muted/normal split is a simplified visual approximation
// (inherited-scope's own valid tokens muted, this scope's own valid tokens
// normal) rather than reaching into mergeFlagScopes' internal grouping, which
// isn't exposed. Good enough to make append-vs-override legible at a glance.
function CliFlagsPreview({
  inheritedFlags,
  ownRawEntries
}: CliFlagsPreviewProps): React.JSX.Element | null {
  const ownTokens = toValidTokens(ownRawEntries)
  const inheritedTokens = inheritedFlags ? toValidTokens(inheritedFlags) : []
  const mergedTokens = mergeFlagScopes(inheritedTokens, ownTokens)

  if (mergedTokens.length === 0) {
    return (
      <p className="text-xs font-mono text-text-muted overflow-x-auto whitespace-nowrap">claude</p>
    )
  }

  // Simplified split for display only — see comment above. The muted segment
  // is inherited's own tokens; the normal segment is this scope's own tokens.
  // (At global scope inheritedFlags is undefined, so nothing is muted.)
  const mutedCount = inheritedFlags ? inheritedTokens.length : 0
  const mutedSegment = mergedTokens.slice(0, mutedCount)
  const normalSegment = mergedTokens.slice(mutedCount)

  return (
    <p className="text-xs font-mono overflow-x-auto whitespace-nowrap">
      <span className="text-text-primary">claude </span>
      {mutedSegment.length > 0 && (
        <span className="text-text-muted">{mutedSegment.join(' ')} </span>
      )}
      {normalSegment.length > 0 && (
        <span className="text-text-primary">{normalSegment.join(' ')}</span>
      )}
    </p>
  )
}

interface CliFlagRowProps {
  row: FlagRow
  onUpdate: (text: string) => void
  onCommit: () => void
  onRemove: () => void
  placeholder?: string
}

function CliFlagRow({
  row,
  onUpdate,
  onCommit,
  onRemove,
  placeholder
}: CliFlagRowProps): React.JSX.Element {
  const parsed = row.value.trim() === '' ? null : parseFlagEntry(row.value)
  const isInvalid = parsed !== null && isFlagParseError(parsed)
  const errorId = `cli-flag-error-${row.id}`
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <input
          data-cli-flag-input
          type="text"
          aria-label="CLI flag"
          aria-invalid={isInvalid}
          aria-describedby={isInvalid ? errorId : undefined}
          value={row.value}
          onChange={(e) => onUpdate(e.target.value)}
          onBlur={onCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              ;(e.currentTarget as HTMLInputElement).blur()
            }
            if (e.key === 'Escape') {
              onRemove()
            }
          }}
          placeholder={placeholder ?? '--dangerously-load-development-channels server:loco'}
          className={[
            FLAG_INPUT_BASE_CLASS,
            isInvalid ? FLAG_INPUT_INVALID_CLASS : FLAG_INPUT_VALID_CLASS
          ].join(' ')}
        />
        <button
          type="button"
          onClick={onRemove}
          className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-surface-overlay transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          aria-label="Remove flag"
        >
          <X size={11} weight="bold" />
        </button>
      </div>
      {isInvalid && (
        <p id={errorId} className="text-xs text-red-400 mt-0.5">
          {(parsed as { error: string }).error}
        </p>
      )}
    </div>
  )
}

export function CliFlagsEditor({
  value,
  onChange,
  inheritedFlags,
  label,
  placeholder
}: CliFlagsEditorProps): React.JSX.Element {
  const [localItems, setLocalItems] = useState<FlagRow[]>(() => toFlagRows(value))
  // Container ref — scopes addItem's focus query to THIS editor instance so
  // multiple CliFlagsEditor mounts (global + project) never steal focus
  // across each other.
  const containerRef = useRef<HTMLDivElement>(null)
  // Keep in sync with external changes (e.g. initial load). Render-time sync
  // (not a useEffect) so it never fights an in-progress edit — only syncs
  // when our local values actually diverge from the incoming prop.
  const prevValueRef = useRef(value)
  // eslint-disable-next-line react-hooks/refs -- intentional render-time comparison to avoid a sync effect
  if (prevValueRef.current !== value) {
    // eslint-disable-next-line react-hooks/refs -- intentional render-time ref mutation to track previous value
    prevValueRef.current = value
    if (JSON.stringify(localItems.map((r) => r.value)) !== JSON.stringify(value)) {
      setLocalItems(toFlagRows(value))
    }
  }

  // Only rows that are empty (dropped silently) or syntactically valid are
  // ever propagated — an in-progress invalid row stays in local state (with
  // its error shown) but is excluded from onChange until fixed or removed,
  // so the user is never fighting a revert.
  function commitRows(nextLocal: FlagRow[]): void {
    setLocalItems(nextLocal)
    onChange(
      nextLocal.flatMap((row) => {
        if (row.value.trim() === '') return []
        const parsed = parseFlagEntry(row.value)
        return isFlagParseError(parsed) ? [] : [row.value]
      })
    )
  }

  function commitItem(idx: number): void {
    const trimmed = localItems[idx].value.trim()
    const nextLocal = localItems.flatMap((row, i) => {
      const v = i === idx ? trimmed : row.value
      return v !== '' ? [{ ...row, value: v }] : []
    })
    commitRows(nextLocal)
  }

  function removeItem(idx: number): void {
    commitRows(localItems.filter((_, i) => i !== idx))
  }

  function addItem(): void {
    const next = [...localItems, { id: crypto.randomUUID(), value: '' }]
    setLocalItems(next)
    // Focus the new input on next tick — scoped to this editor's own
    // container so it can never reach into a sibling CliFlagsEditor.
    setTimeout(() => {
      const inputs =
        containerRef.current?.querySelectorAll<HTMLInputElement>('[data-cli-flag-input]')
      const last = inputs?.[inputs.length - 1]
      if (last) last.focus()
    }, 0)
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-2">
      {label && <span className="text-xs font-medium text-text-primary">{label}</span>}
      <CliFlagsPreview
        inheritedFlags={inheritedFlags}
        ownRawEntries={localItems.map((r) => r.value)}
      />
      {localItems.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {localItems.map((row, idx) => (
            <CliFlagRow
              key={row.id}
              row={row}
              onUpdate={(text) => {
                const next = [...localItems]
                next[idx] = { ...next[idx], value: text }
                setLocalItems(next)
              }}
              onCommit={() => commitItem(idx)}
              onRemove={() => removeItem(idx)}
              placeholder={placeholder}
            />
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={addItem}
        aria-label="Add flag"
        className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-primary transition-colors self-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded px-1"
      >
        <Plus size={11} weight="bold" />
        Add flag
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ModelPicker — dropdown select for model with two grouped sections:
//   • "Specific versions" — explicit versioned IDs (unambiguous pricing)
//   • "Always latest" — family aliases that claude resolves at launch
// A separator sentinel (__sep_*) renders the section label between groups.
// A "Custom…" mode falls through to a free-form text input.
// ---------------------------------------------------------------------------

// Build the flat options list with a separator between the two groups.
// The separator value starts with '__sep' so the updated Select renders it as a divider.
const MODEL_PICKER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...CLAUDE_MODEL_OPTIONS.slice(0, CLAUDE_MODEL_ALIAS_START_INDEX),
  { value: '__sep_model', label: '' }, // divider — label unused; Select renders "Always latest"
  ...CLAUDE_MODEL_OPTIONS.slice(CLAUDE_MODEL_ALIAS_START_INDEX),
  { value: 'custom', label: 'Custom…' }
]

export interface ModelPickerProps {
  value: string
  onChange: (v: string) => void
}

export function ModelPicker({ value, onChange }: ModelPickerProps): React.JSX.Element {
  const isKnown = CLAUDE_MODEL_OPTIONS.some((a) => a.value === value)
  const isCustom = !isKnown
  const [showCustom, setShowCustom] = useState(isCustom)
  const [customValue, setCustomValue] = useState(isCustom ? value : '')

  const selectValue = isCustom ? 'custom' : value

  function handleSelect(v: string): void {
    if (v === 'custom') {
      setShowCustom(true)
      return
    }
    setShowCustom(false)
    onChange(v)
  }

  return (
    <div className="flex flex-col gap-1.5 items-end w-56">
      <Select
        options={MODEL_PICKER_OPTIONS}
        value={selectValue}
        onChange={handleSelect}
        ariaLabel="Model"
      />
      {showCustom && (
        <input
          aria-label="Custom model ID"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          onBlur={() => {
            const v = customValue.trim()
            if (v) onChange(v)
          }}
          placeholder="model-id (e.g. claude-opus-4-7)"
          className="w-full px-3 py-1.5 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus:border-accent/50 transition-colors duration-150 font-mono"
        />
      )}
    </div>
  )
}

// SectionTitle — the pixel-accented heading for settings sections / page panels.
export function SectionTitle({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <h2 className={`font-pixel text-base font-semibold text-text-primary ${className}`}>
      {children}
    </h2>
  )
}

// Eyebrow — small uppercase group label; pixel for signature, tracked for legibility.
export function Eyebrow({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <p
      className={`font-pixel text-xs font-medium uppercase tracking-wider text-text-secondary ${className}`}
    >
      {children}
    </p>
  )
}
