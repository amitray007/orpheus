import type React from 'react'
import { Question } from '@phosphor-icons/react'
import type { HarnessSummary } from '@shared/types'
import { ProviderIcon, isKnownProviderIconId } from './ProviderIcon'

// ---------------------------------------------------------------------------
// HarnessPicker — a command list, not a special-cased single-harness UI.
// Extracted from settings/HarnessSection.tsx (support-multi-harness C1) so
// the workspace-creation menu can reuse the exact same picker instead of a
// second implementation (check:dup sits close to its 2.4% ceiling). Renders
// every harness from harness:list, each with its resolved command preview
// (binary + its own harness-provided default args, at descriptor defaults —
// this previews what a FRESH install of this harness would run, not any
// currently-edited scope's settings) so the row reads as "[icon] [Name]
// ............ [the actual command it runs]," matching CliFlagsPreview's
// "claude <flags>" convention in settings/primitives.tsx.
// ---------------------------------------------------------------------------

/** Builds the resolved command preview for a harness's OWN shipped defaults
 *  — binary followed by its enabled default args, flag+value pairs in
 *  order. Pure string assembly, no dependency on any edited settings. */
function harnessCommandPreview(harness: HarnessSummary): string {
  const tokens: string[] = [harness.binary]
  for (const arg of harness.defaultArgs ?? []) {
    if (!arg.enabled) continue
    tokens.push(arg.key)
    if (arg.value) tokens.push(arg.value)
  }
  return tokens.join(' ')
}

export interface HarnessPickerProps {
  harnesses: HarnessSummary[]
  selectedId: string
  onSelect: (id: string) => void
}

export function HarnessPicker({
  harnesses,
  selectedId,
  onSelect
}: HarnessPickerProps): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="Harness"
      className="bg-surface-raised border border-border-default rounded-lg divide-y divide-border-default/60 overflow-hidden"
    >
      {harnesses.map((harness) => {
        const selected = harness.id === selectedId
        return (
          <button
            key={harness.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onSelect(harness.id)}
            className={[
              'w-full flex items-center gap-3 px-4 py-3 text-left transition-colors duration-150 cursor-pointer',
              selected ? 'bg-accent/10' : 'hover:bg-surface-overlay'
            ].join(' ')}
          >
            <span
              className={[
                'flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0',
                selected ? 'bg-accent/20 text-accent' : 'bg-surface-overlay text-text-muted'
              ].join(' ')}
            >
              {harness.icon && isKnownProviderIconId(harness.icon) ? (
                <ProviderIcon providerId={harness.icon} size={14} />
              ) : (
                <Question size={14} />
              )}
            </span>
            <span
              className={[
                'text-sm font-medium flex-shrink-0',
                selected ? 'text-text-primary' : 'text-text-secondary'
              ].join(' ')}
            >
              {harness.label}
            </span>
            <span className="flex-1 min-w-0 border-b border-dotted border-border-default/50 mx-1" />
            <span className="text-xs font-mono text-text-muted overflow-x-auto whitespace-nowrap flex-shrink-0">
              {harnessCommandPreview(harness)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
