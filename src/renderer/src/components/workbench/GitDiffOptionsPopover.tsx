// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/GitDiffOptionsPopover.tsx
//
// The ⚙ diff-options popover for the Workbench Git tab (Fix 2) — shares
// TreeOptionsPopover.tsx's anchoring/overlay recipe (captured anchor rect + a
// portaled interactive Overlay owning outside-click/Escape dismiss) via the
// hoisted ./useAnchoredPopover.ts hook (Fix #16, Workbench audit) rather than
// each file keeping its own copy of that state/handler.
// Two toggles today:
//   - "Wrap lines" — drives @pierre/diffs' <PatchDiff> `overflow: 'wrap' |
//     'scroll'` option (same knob FilesTab's viewer already exposes for its
//     <File> component).
//   - "Flatten empty folders" (live-QA fix) — the changed-files TREE's
//     `flattenEmptyDirectories` construction option. This is a SHARED
//     Files+Git setting: it reads/writes the SAME AppUiState value the Files
//     tab's TreeOptionsPopover already owns (`filesFlattenEmptyDirs` /
//     `files_flatten_empty_dirs` — see uiStateDefaults.ts/schema.ts). Toggling
//     it in either tab's popover follows through to the other; the column
//     name stays `files_*` to avoid a migration even though the setting is no
//     longer Files-only — think of it as "the shared tree flatten setting"
//     rather than a Files-tab-specific one. Default OFF (each folder its own
//     expandable row, rather than collapsing dir chains into a breadcrumb).
//   - "Token hover" — gates the Pierre Batch 3 token-hover popover (hover a
//     syntax token → a floating card w/ token text + line:col + copy) on the
//     diff. Was always-on and intrusive while just reading, so it's now
//     opt-in — reads/writes AppUiState.tokenHoverEnabled, the SAME value the
//     Files tab's TreeOptionsPopover exposes for its editor/viewer. Default
//     OFF.
// The unified/split `diffStyle` toggle stays in GitTab's header strip
// (already a dedicated icon toggle, DiffStyleToggle) rather than folding
// into this popover — it's a primary, frequently-used control, unlike Wrap/
// Flatten which are genuinely secondary.
// ---------------------------------------------------------------------------

import type React from 'react'
import { SlidersHorizontal } from '@phosphor-icons/react'
import { Overlay } from '../ui/Overlay'
import { Toggle } from '../dashboard/settings/primitives'
import { useAnchoredPopover } from './useAnchoredPopover'

interface GitDiffOptionsState {
  /** Word-wrap long lines in the diff viewer (PatchDiff's `overflow: 'wrap'`
   *  vs `'scroll'`). Default true (on) — mirrors Files tab's wrapLines. */
  wrapLines: boolean
  /** Collapse single-child directory chains in the changed-files tree into
   *  one flattened row. SHARED with the Files tab (AppUiState.
   *  filesFlattenEmptyDirs) — see module header. Default false (off). */
  flattenEmptyDirs: boolean
  /** Token-hover popover on the diff (AppUiState.tokenHoverEnabled) — SHARED
   *  with the Files tab (TreeOptionsPopover's own "Token hover" toggle). See
   *  module header. Default false (off). */
  tokenHoverEnabled: boolean
}

interface GitDiffOptionsPopoverProps {
  options: GitDiffOptionsState
  onChange: (next: GitDiffOptionsState) => void
}

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

export function GitDiffOptionsPopover({
  options,
  onChange
}: GitDiffOptionsPopoverProps): React.JSX.Element {
  const { open, setOpen, anchorPos, buttonRef, handleTriggerClick } = useAnchoredPopover()

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleTriggerClick}
        onMouseDown={(e) => e.stopPropagation()}
        aria-pressed={open}
        aria-label="Diff view options"
        title="Diff view options"
        className="p-1 rounded text-text-muted hover:bg-surface-raised hover:text-text-primary"
      >
        <SlidersHorizontal size={16} />
      </button>
      <Overlay
        open={open}
        interactive
        onDismiss={() => setOpen(false)}
        portal
        className="fixed z-50 w-52 rounded-md border border-border-default bg-surface-overlay shadow-lg p-2"
        style={anchorPos ?? undefined}
      >
        <div role="dialog" aria-label="Diff view options">
          <p className="px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted select-none">
            View
          </p>
          <PopoverRow
            label="Wrap lines"
            value={options.wrapLines}
            onChange={(v) => onChange({ ...options, wrapLines: v })}
          />
          <PopoverRow
            label="Flatten empty folders"
            value={options.flattenEmptyDirs}
            onChange={(v) => onChange({ ...options, flattenEmptyDirs: v })}
          />
          <PopoverRow
            label="Token hover"
            value={options.tokenHoverEnabled}
            onChange={(v) => onChange({ ...options, tokenHoverEnabled: v })}
          />
        </div>
      </Overlay>
    </>
  )
}
