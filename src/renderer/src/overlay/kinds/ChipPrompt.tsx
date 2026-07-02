import type React from 'react'
import { useRef, useState } from 'react'
import type { ChipPromptProps } from '@shared/types'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// ChipPrompt — U9 React migration of the footer ActionChip's interactive
// `PromptPopover` (chassis-free component in ActionChip.tsx), which opened
// bottom-full (upward into the terminal rect) and was occluded by the live
// terminal. Same fields/labels/order, app tokens, ~current width (w-52).
// Interactive: acceptsClicks: true, takesFocus: true — Escape is handled
// globally by OverlayRoot for takesFocus descriptors (emits 'cancel'); this
// component also emits 'cancel' directly from the input's own Escape
// keydown for immediate same-frame dismissal, matching the original
// onKeyDown contract. Enter submits with the latest local values.
// autoFocus on the first input reproduces the original's post-render focus
// call (setTimeout(() => promptInputRef.current?.focus(), 0)).
// ---------------------------------------------------------------------------

export function ChipPrompt({ props, emit }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as ChipPromptProps
  const { prompts, values: initialValues } = data
  const [values, setValues] = useState<Record<string, string>>(initialValues)
  const firstInputRef = useRef<HTMLInputElement>(null)

  function handleChange(key: string, value: string): void {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  function handleSubmit(): void {
    emit('submit', { values })
  }

  function handleCancel(): void {
    emit('cancel')
  }

  return (
    <div className="w-52 bg-surface-overlay border border-border-default rounded-lg shadow-lg p-2 flex flex-col gap-2 font-[family-name:var(--font-sans)]">
      {prompts.map((p, idx) => (
        <div key={p.key} className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
            {p.label}
          </span>
          <input
            ref={idx === 0 ? firstInputRef : null}
            autoFocus={idx === 0}
            type="text"
            aria-label={p.label}
            value={values[p.key] ?? ''}
            placeholder={p.placeholder ?? ''}
            onChange={(e) => handleChange(p.key, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSubmit()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                handleCancel()
              }
            }}
            className="w-full px-2 py-1 rounded-md text-xs bg-surface-raised border border-border-default text-text-primary placeholder-text-muted outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
          />
        </div>
      ))}
      <div className="flex justify-end gap-1.5 pt-0.5">
        <button
          type="button"
          onClick={handleCancel}
          className="text-xs text-text-muted hover:text-text-primary px-2 py-0.5 rounded hover:bg-surface-raised transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="text-xs font-medium text-white bg-accent hover:bg-accent/90 px-2 py-0.5 rounded transition-colors cursor-pointer"
        >
          Apply
        </button>
      </div>
    </div>
  )
}
