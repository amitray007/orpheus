// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/TreeOptionsPopover.tsx
//
// The ⚙ tree-options popover for the Workbench Files tab (design:
// docs/learnings/pierre-libraries.md §11; mockup at http://localhost:4610).
//
// A small SlidersHorizontal icon button sitting beside the hamburger tree
// toggle in FilesTab's header. Clicking opens a compact popover (reusing the
// NewWorkspaceMenu/DropdownChip anchoring recipe: captured anchor rect + a
// portaled interactive Overlay that owns outside-click/Escape dismiss) with a
// quiet "View" group header over two toggle rows — "Show hidden files" and
// "Dim gitignored" — built from the settings SettingRow/Toggle primitives at
// popover density. Two GHOSTED placeholder rows ("Sort order", "Flatten empty
// dirs") sit below to prove the format grows to ~4-6 options without
// restructuring. These two settings are ephemeral per-FilesTab UI state (not
// persisted, no composeClaudeLaunch mapping) — see §11.
// ---------------------------------------------------------------------------

import { useRef, useState } from 'react'
import type React from 'react'
import { SlidersHorizontal } from '@phosphor-icons/react'
import { Overlay } from '../ui/Overlay'
import { Toggle } from '../dashboard/settings/primitives'

export interface TreeOptionsState {
  /** Reveal denylisted (noisy machine dir/file) rows. Default OFF. */
  showHidden: boolean
  /** Dim gitignored rows to ~50% opacity. Default ON. */
  dimGitignored: boolean
}

interface TreeOptionsPopoverProps {
  options: TreeOptionsState
  onChange: (next: TreeOptionsState) => void
}

// Anchor position captured on click so the overlay can position via `fixed`
// without reading a ref during render (mirrors NewWorkspaceMenu).
type AnchorPos = { top: number; left: number }

/** A single compact toggle row: label left, Toggle right (popover density —
 *  no per-row border/description, just `py-1.5`, matching §11). */
function PopoverRow({
  label,
  value,
  onChange
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-1.5">
      <span className="text-xs text-text-primary select-none">{label}</span>
      <Toggle value={value} onChange={onChange} ariaLabel={label} />
    </div>
  )
}

/** A ghosted (disabled, dimmed) placeholder row proving the popover format
 *  grows to more options without restructuring — these toggles don't exist
 *  yet (§11). */
function GhostRow({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-1.5 opacity-40 pointer-events-none">
      <span className="text-xs text-text-primary select-none">{label}</span>
      <div className="w-9 h-5 rounded-full bg-surface-overlay" aria-hidden="true" />
    </div>
  )
}

export function TreeOptionsPopover({
  options,
  onChange
}: TreeOptionsPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [anchorPos, setAnchorPos] = useState<AnchorPos | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  function handleTriggerClick(e: React.MouseEvent): void {
    e.stopPropagation()
    if (open) {
      setOpen(false)
      return
    }
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) setAnchorPos({ top: rect.bottom + 4, left: rect.left })
    setOpen(true)
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleTriggerClick}
        onMouseDown={(e) => e.stopPropagation()}
        aria-pressed={open}
        aria-label="Tree view options"
        title="Tree view options"
        className="p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary"
      >
        <SlidersHorizontal size={16} />
      </button>
      <Overlay
        open={open}
        interactive
        onDismiss={() => setOpen(false)}
        portal
        className="fixed z-50 w-56 rounded-md border border-border-default bg-surface-overlay shadow-lg p-2"
        style={anchorPos ?? undefined}
      >
        <div role="dialog" aria-label="Tree view options">
          <p className="px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted select-none">
            View
          </p>
          <PopoverRow
            label="Show hidden files"
            value={options.showHidden}
            onChange={(v) => onChange({ ...options, showHidden: v })}
          />
          <PopoverRow
            label="Dim gitignored"
            value={options.dimGitignored}
            onChange={(v) => onChange({ ...options, dimGitignored: v })}
          />
          <GhostRow label="Sort order" />
          <GhostRow label="Flatten empty dirs" />
        </div>
      </Overlay>
    </>
  )
}
