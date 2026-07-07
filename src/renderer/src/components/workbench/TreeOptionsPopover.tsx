// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/TreeOptionsPopover.tsx
//
// The ⚙ tree-options popover for the Workbench Files tab (design:
// docs/learnings/pierre-libraries.md §11; mockup at http://localhost:4610).
//
// A small SlidersHorizontal icon button sitting beside the hamburger tree
// toggle in FilesTab's header. Clicking opens a compact popover (reusing the
// NewWorkspaceMenu/DropdownChip anchoring recipe: captured anchor rect + a
// portaled interactive Overlay that owns outside-click/Escape dismiss, now
// hoisted to ./useAnchoredPopover.ts — Fix #16, Workbench audit — and shared
// with GitDiffOptionsPopover.tsx) with a quiet "View" group header over
// toggle rows — "Show hidden files", "Dim gitignored", "Wrap lines" — plus a
// "Tree" group with "Sort order" (a compact segmented [Default | Name]
// control) and "Flatten empty dirs" (a toggle). All five settings are
// persisted per-workspace in filesTabStore's `TreeOptionsState` (see
// filesTabStore.ts's DEFAULT_FILES_TAB_ENTRY + the per-key store `equals`)
// — see §11.
// ---------------------------------------------------------------------------

import type React from 'react'
import { SlidersHorizontal } from '@phosphor-icons/react'
import { Overlay } from '../ui/Overlay'
import { Toggle } from '../dashboard/settings/primitives'
import { useAnchoredPopover } from './useAnchoredPopover'

/** Sort applied to the tree's visible rows. `'default'` is Pierre's built-in
 *  dirs-first/alpha ordering (@pierre/trees' own `sort: 'default'`); `'name'`
 *  is pure alphabetical A→Z ignoring directory-vs-file type (a custom
 *  comparator — see nameSortComparator in FilesTab.tsx). Both `sort` and
 *  `flattenEmptyDirectories` are CONSTRUCTION-ONLY options on `useFileTree` —
 *  verified against node_modules/@pierre/trees/dist/model/FileTreeController.js:
 *  the controller captures `#baseOptions` (which includes `sort` and
 *  `flattenEmptyDirectories`) once in its constructor and every `resetPaths`
 *  call rebuilds its internal store by re-spreading that SAME captured
 *  `#baseOptions` — there is no post-construction reconfigure path. So
 *  changing either of these two settings remounts the tree host (see
 *  FilesTab.tsx's `treeKey`), which is why they're kept out of the panes that
 *  merely re-filter cached entries (showHidden/dimGitignored) — see the
 *  module header there for how selection/expansion survive that remount. */
export type TreeSortOrder = 'default' | 'name'

export interface TreeOptionsState {
  /** Reveal denylisted (noisy machine dir/file) rows. Default OFF. */
  showHidden: boolean
  /** Dim gitignored rows to ~50% opacity. Default ON. */
  dimGitignored: boolean
  /** Word-wrap long lines in BOTH the read-only viewer (Pierre <File>'s
   *  `overflow: 'wrap'`) and the CodeMirror editor (a `lineWrapping`
   *  Compartment). Default ON. */
  wrapLines: boolean
  /** Tree row ordering — see TreeSortOrder above. Default 'default'. */
  sortOrder: TreeSortOrder
  /** Collapse directory chains with a single child into one flattened row
   *  (`a/b/c/` → one row) via @pierre/trees' `flattenEmptyDirectories`.
   *  Default OFF. */
  flattenEmptyDirs: boolean
}

const SORT_OPTIONS: ReadonlyArray<{ value: TreeSortOrder; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'name', label: 'Name' }
]

interface TreeOptionsPopoverProps {
  options: TreeOptionsState
  onChange: (next: TreeOptionsState) => void
}

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

/** A compact inline segmented control for Sort order — sized for the popover
 *  (text-[11px], tight padding), unlike settings/primitives.tsx's full-size
 *  `SegmentedControl` (px-3 py-1.5, built for the Settings panel's roomier
 *  rows). Two options only (Default/Name — see TreeSortOrder), so a small
 *  bespoke control reads better here than reusing the larger primitive. */
function SortOrderRow({
  value,
  onChange
}: {
  value: TreeSortOrder
  onChange: (v: TreeSortOrder) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6 py-1.5">
      <span className="text-xs text-text-primary select-none">Sort order</span>
      <div
        role="radiogroup"
        aria-label="Sort order"
        className="inline-flex bg-surface-base border border-border-default rounded p-0.5"
      >
        {SORT_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={value === opt.value}
            onClick={() => onChange(opt.value)}
            className={[
              'px-2 py-0.5 text-[11px] font-medium rounded transition-colors duration-100',
              value === opt.value
                ? 'bg-accent/15 text-text-primary'
                : 'text-text-muted hover:text-text-primary'
            ].join(' ')}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function TreeOptionsPopover({
  options,
  onChange
}: TreeOptionsPopoverProps): React.JSX.Element {
  const { open, setOpen, anchorPos, buttonRef, handleTriggerClick } = useAnchoredPopover()

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
          <PopoverRow
            label="Wrap lines"
            value={options.wrapLines}
            onChange={(v) => onChange({ ...options, wrapLines: v })}
          />
          <p className="px-0.5 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted select-none">
            Tree
          </p>
          <SortOrderRow
            value={options.sortOrder}
            onChange={(v) => onChange({ ...options, sortOrder: v })}
          />
          <PopoverRow
            label="Flatten empty dirs"
            value={options.flattenEmptyDirs}
            onChange={(v) => onChange({ ...options, flattenEmptyDirs: v })}
          />
        </div>
      </Overlay>
    </>
  )
}
