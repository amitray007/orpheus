import { useState } from 'react'
import type React from 'react'
import type { OverlayKindProps } from '../registry'

/**
 * Dev-only test kind (U6 harness). Exercises: props round-trip, click events,
 * text-input focus/IME, and (for centered placement) a scrim that emits
 * `cancel` on click. Ships inert in production — nothing registers it as a
 * live surface outside the dev harness trigger.
 */
export function DevTest({ descriptor, props, emit }: OverlayKindProps): React.JSX.Element {
  const [text, setText] = useState('')
  const isCentered = descriptor.placement.mode === 'centered'

  const card = (
    <div className="min-w-[260px] max-w-[360px] rounded-lg border border-border-default bg-surface-raised p-3 font-[family-name:var(--font-sans)] shadow-lg">
      <p className="text-sm font-medium text-text-primary">devTest overlay</p>
      <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-surface-overlay p-2 text-[11px] leading-snug text-text-secondary">
        {JSON.stringify(props, null, 2)}
      </pre>
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="focus / IME test"
        className="mt-2 w-full rounded-md border border-border-default bg-surface-base px-2 py-1 text-xs text-text-primary outline-none focus:border-border-focus"
      />
      <button
        type="button"
        onClick={() => emit('clicked', { text })}
        className="mt-2 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-on hover:bg-accent-hover"
      >
        Emit clicked
      </button>
    </div>
  )

  if (!isCentered) return card

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div
        className="absolute inset-0"
        onClick={() => emit('cancel')}
        aria-hidden="true"
        style={{ background: 'color-mix(in srgb, black 45%, transparent)' }}
      />
      <div className="relative">{card}</div>
    </div>
  )
}
