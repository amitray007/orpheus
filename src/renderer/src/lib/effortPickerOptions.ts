// ---------------------------------------------------------------------------
// effortPickerOptions — pure helpers turning a model's real `effortLevels`
// (model-routing unit 11) into the footer Effort chip's option list and
// visibility decision. Mirrors modelPickerOptions.ts's own role (reshaping
// already-resolved server data for a picker widget) but for the effort
// dimension rather than the model dimension.
//
// Factored out of DropdownChip.tsx into their own file (rather than exported
// from the component file directly) because react-refresh/only-export-
// components forbids a component file from exporting anything but
// components — and, more importantly, this is what makes the logic
// independently assertable by scripts/verify-effort-levels.ts without
// needing React/a full component render. This is the one piece of the
// model-routing unit 11 bugfix (the effort chip not reacting to a model
// change made by a DIFFERENT DropdownChip instance — see workspaceModelStore
// .ts/workspaceEffortStore.ts's own doc comments for the store-level fix)
// that IS a pure function; the store/push wiring itself is not independently
// testable outside a live UI (see verify-effort-levels.ts's own note on this).
// ---------------------------------------------------------------------------

import { EFFORT_LADDER_ORDER } from '@shared/types'

/** Exported so DropdownChip.tsx's labelForEffort can share this instead of
 *  duplicating the one-liner. */
export function capitalize(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1)
}

/**
 * Build the effort chip's option list from the CURRENT model's real
 * `effortLevels` — never the old hardcoded ['auto','low','medium','high',
 * 'xhigh','max'] offered unconditionally for every model. Options are
 * rendered in ladder order (EFFORT_LADDER_ORDER), with 'none' first when the
 * model reports it (an off-ladder mode, sorted ahead of the ladder itself)
 * and 'auto' always leading — 'auto' is a CLI-level "reset to model
 * default", never a wire value, so it's offered regardless of what the
 * provider's levels array contains (mirrors today's behavior for Claude).
 */
export function effortOptionsFor(effortLevels: string[]): { value: string; label: string }[] {
  const hasNone = effortLevels.includes('none')
  const onLadder = EFFORT_LADDER_ORDER.filter((level) => effortLevels.includes(level))
  const ordered = hasNone ? ['none', ...onLadder] : onLadder
  return [
    { value: 'auto', label: 'Auto' },
    ...ordered.map((v) => ({ value: v, label: capitalize(v) }))
  ]
}

/**
 * Pure selector mirroring DropdownChip's early-return condition right
 * before its JSX (`if (isEffortSelect && currentModelEffortLevels === null)
 * return <></>`) — the effort chip must be HIDDEN entirely (never rendered
 * disabled) for a model with no reasoning-effort control at all. Returns
 * false (hide) exactly when `effortLevels` is null; true otherwise,
 * including an empty array (which effortOptionsFor still turns into at
 * least the 'auto' entry).
 */
export function shouldRenderEffortChip(effortLevels: string[] | null): boolean {
  return effortLevels !== null
}
