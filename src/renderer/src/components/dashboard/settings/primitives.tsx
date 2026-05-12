import { useState } from 'react'
import type React from 'react'

// ---------------------------------------------------------------------------
// Shared form primitives for Settings sections
// ---------------------------------------------------------------------------

export interface SettingRowProps {
  label: string
  description?: string
  children: React.ReactNode
}
export function SettingRow({ label, description, children }: SettingRowProps): React.JSX.Element {
  // Two-column row: label+description on the left, control on the right.
  // On narrow widths it stacks; min 480px wide it goes side-by-side.
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6 py-4 border-b border-border-default/40 last:border-b-0">
      <div className="flex flex-col gap-0.5 min-w-0 sm:max-w-sm">
        <label className="text-sm font-medium text-text-primary">{label}</label>
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
      onClick={() => onChange(!value)}
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

export interface ModelPickerProps {
  value: string
  onChange: (v: string) => void
}
export function ModelPicker({ value, onChange }: ModelPickerProps): React.JSX.Element {
  // Pre-defined aliases + a "Custom..." option that reveals a text input
  const aliases = [
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'haiku', label: 'Haiku' }
  ]
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
            isCustom ? 'bg-accent/15 text-text-primary' : 'text-text-muted hover:text-text-primary hover:bg-surface-raised'
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
