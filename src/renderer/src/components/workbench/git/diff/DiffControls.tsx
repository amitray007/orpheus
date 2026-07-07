// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/git/diff/DiffControls.tsx
//
// GitTab's diff-view toggles — extracted verbatim from GitTab.tsx (Wave 3
// Phase A structural extraction). Both are pure, prop-driven segmented
// controls; no state of their own.
//
// DiffStyleToggle — the unified/split icon toggle (DiffStyle).
// DiffModeToggle — the [Working tree | PR diff] segmented control
// (Phase 4-pre's DiffMode), shown only once a PR exists for the branch.
// ---------------------------------------------------------------------------

import type React from 'react'
import { Rows, Columns } from '@phosphor-icons/react'
import type { DiffStyle, DiffMode } from '../../GitTab'

interface DiffStyleToggleProps {
  value: DiffStyle
  onChange: (style: DiffStyle) => void
}

/** Unified/split icon toggle — Rows (stacked horizontal lines) for unified,
 *  Columns (two vertical columns) for split, matching the requirements doc's
 *  "SVG icon toggle, not text" cross-cutting rule. */
export function DiffStyleToggle({ value, onChange }: DiffStyleToggleProps): React.JSX.Element {
  const btnClass = (active: boolean): string =>
    [
      'p-1 rounded',
      active
        ? 'bg-surface-raised text-text-primary'
        : 'text-text-muted hover:bg-surface-raised hover:text-text-primary'
    ].join(' ')
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onChange('unified')}
        aria-pressed={value === 'unified'}
        title="Unified diff"
        className={btnClass(value === 'unified')}
      >
        <Rows size={14} />
      </button>
      <button
        type="button"
        onClick={() => onChange('split')}
        aria-pressed={value === 'split'}
        title="Split diff"
        className={btnClass(value === 'split')}
      >
        <Columns size={14} />
      </button>
    </div>
  )
}

interface DiffModeToggleProps {
  value: DiffMode
  onChange: (mode: DiffMode) => void
}

/** [Working tree | PR diff] segmented control — only rendered by GitTab while
 *  a PR exists for the current branch (see GitTab's module header's Phase
 *  4-pre note: PR review comments anchor to the PR diff, not the working-tree
 *  diff, so this toggle is the prerequisite for Phase 4a's inline comments).
 *  Matches SubTabStrip's compact pill-segment visual language rather than
 *  DiffStyleToggle's icon-only style — this needs readable labels, not icons,
 *  since "working tree" vs "PR diff" isn't obviously representable as a
 *  glyph pair. */
export function DiffModeToggle({ value, onChange }: DiffModeToggleProps): React.JSX.Element {
  const seg = (mode: DiffMode, label: string): React.JSX.Element => (
    <button
      key={mode}
      type="button"
      onClick={() => onChange(mode)}
      aria-pressed={value === mode}
      className={[
        'px-2 py-0.5 rounded text-[11px] font-medium transition-colors duration-100',
        value === mode
          ? 'bg-surface-raised text-text-primary'
          : 'text-text-muted hover:text-text-secondary'
      ].join(' ')}
    >
      {label}
    </button>
  )
  return (
    <div className="flex items-center gap-0.5 p-0.5 rounded-md bg-surface-overlay/60 border border-border-default/60">
      {seg('working', 'Working tree')}
      {seg('pr', 'PR diff')}
    </div>
  )
}
