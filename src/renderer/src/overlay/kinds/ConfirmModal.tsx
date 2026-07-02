import type React from 'react'
import { useState } from 'react'
import type { ConfirmModalProps } from '@shared/types'
import type { OverlayKindProps } from '../registry'

// ---------------------------------------------------------------------------
// ConfirmModal — centered confirm/danger modal. Hierarchy: title, body,
// optional checkbox, right-aligned button row with default/primary/danger
// styles. Width target ~360px. takesFocus: true — OverlayRoot's global
// Escape handler already emits 'cancel' for takesFocus descriptors; the
// scrim below independently emits 'cancel' on backdrop click (OverlayRoot
// centers this kind full-bleed via placement.mode === 'centered').
//
// Result contract: overlayClient.showConfirmModalReact resolves
// { buttonId, checkboxChecked } for every settle path (button click, Escape,
// scrim click) — this component never resolves anything itself, it only
// emits events; overlayClient owns turning events into the promise result.
// ---------------------------------------------------------------------------

export function ConfirmModal({ props, emit }: OverlayKindProps): React.JSX.Element {
  const data = props as unknown as ConfirmModalProps
  const { title, body, buttons, checkbox } = data
  const [checked, setChecked] = useState(checkbox?.checked ?? false)

  function handleButtonClick(buttonId: string): void {
    emit('button', { buttonId, checkboxChecked: checked })
  }

  function handleCheckboxToggle(): void {
    const next = !checked
    setChecked(next)
    if (checkbox) emit('checkbox', { id: checkbox.id, checked: next })
  }

  function handleScrimClick(): void {
    emit('cancel')
  }

  const buttonClass = (style: 'default' | 'primary' | 'danger' | undefined): string => {
    switch (style) {
      case 'primary':
        return 'bg-accent text-accent-on hover:bg-accent-hover'
      case 'danger':
        return 'bg-red-500 text-white hover:bg-red-600'
      default:
        return 'bg-surface-overlay/60 border border-border-default text-text-primary hover:bg-surface-overlay'
    }
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div
        className="absolute inset-0"
        onClick={handleScrimClick}
        aria-hidden="true"
        style={{ background: 'color-mix(in srgb, black 45%, transparent)' }}
      />
      <div
        className="relative w-[360px] max-w-[calc(100vw-32px)] rounded-lg border border-border-default bg-surface-raised shadow-lg font-[family-name:var(--font-sans)] px-4 pt-[18px] pb-4"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <p className="text-sm font-medium text-text-primary leading-snug">{title}</p>}
        {body && (
          <p className="mt-2 text-xs text-text-secondary leading-relaxed whitespace-pre-line">
            {body}
          </p>
        )}

        {checkbox && (
          <label className="mt-3.5 flex items-center gap-2 text-xs text-text-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={checked}
              onChange={handleCheckboxToggle}
              className="h-3.5 w-3.5 rounded border-border-default accent-accent"
            />
            {checkbox.label}
          </label>
        )}

        {buttons.length > 0 && (
          <div className="mt-4 flex items-center justify-end gap-2">
            {buttons.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => handleButtonClick(b.id)}
                className={`min-w-[64px] rounded-md px-3.5 py-1.5 text-xs font-medium transition-colors ${buttonClass(b.style)}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
