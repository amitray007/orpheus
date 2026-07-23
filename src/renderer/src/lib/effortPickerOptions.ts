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

import { EFFORT_LADDER_ORDER, type SelectableModel } from '@shared/types'

/** Exported so DropdownChip.tsx's labelForEffort can share this instead of
 *  duplicating the one-liner. */
export function capitalize(v: string): string {
  return v.charAt(0).toUpperCase() + v.slice(1)
}

/**
 * Build the effort option list from the CURRENT model's real `effortLevels`
 * — never the old hardcoded ['auto','low','medium','high','xhigh','max']
 * offered unconditionally for every model. Options are rendered in ladder
 * order (EFFORT_LADDER_ORDER), with 'none' first when the model reports it
 * (an off-ladder mode, sorted ahead of the ladder itself) and 'auto' always
 * leading (after `leading`, if given) — 'auto' is a CLI-level "reset to
 * model default", never a wire value, so it's offered regardless of what
 * the provider's levels array contains (mirrors today's behavior for
 * Claude).
 *
 * `leading` is an optional first entry BEFORE 'auto' — used by the settings
 * drawers (WorkspaceDrawer/SettingsDrawer/ClaudeGeneralSection) for their
 * `{ value: 'default', label: 'Use global' }` / 'inherit from parent scope'
 * option, a DIFFERENT concept from 'auto' (see resolveEffortLevelsForScope's
 * own doc comment: 'default' means "no override at this scope, defer to the
 * parent", while 'auto' is a real value meaning "let claude choose the
 * effort level"). The footer chip has no `leading` (a workspace's effort is
 * always a concrete stored value, never "inherit"), mirrors
 * buildModelSelectOptions' own `leading` parameter for the model picker.
 */
export function effortOptionsFor(
  effortLevels: string[],
  leading?: { value: string; label: string }
): { value: string; label: string }[] {
  const hasNone = effortLevels.includes('none')
  const onLadder = EFFORT_LADDER_ORDER.filter((level) => effortLevels.includes(level))
  const ordered = hasNone ? ['none', ...onLadder] : onLadder
  return [
    ...(leading ? [leading] : []),
    { value: 'auto', label: 'Auto' },
    ...ordered.map((v) => ({ value: v, label: capitalize(v) }))
  ]
}

/**
 * Pure selector mirroring DropdownChip's early-return condition right
 * before its JSX — the effort chip must be HIDDEN entirely (never rendered
 * disabled) for a model with no reasoning-effort control at all, but must
 * NOT be hidden while that fact is still unknown (see effortLevels' own
 * tri-state doc comment below).
 *
 * `effortLevels` is a TRI-STATE, not a boolean null/non-null (model-routing
 * unit 11 bugfix — the "empty on a cold direct-to-workspace open" bug):
 *   - `null`      -> this model genuinely has no reasoning-effort control
 *                    (e.g. an image model with no thinking.levels at all).
 *                    Returns false — HIDE the chip.
 *   - `undefined` -> not resolved YET (the model list is still loading —
 *                    e.g. right after a cold app launch straight into a
 *                    workspace page, or a routed model whose proxy is still
 *                    starting). Returns true — render the chip in its
 *                    PENDING state (see effortOptionsFor's own doc comment
 *                    for what that renders), never hidden and never a
 *                    fabricated ladder as if it were authoritative.
 *   - `string[]`  -> real, resolved levels. Returns true — render real
 *                    options (effortOptionsFor(effortLevels)), including an
 *                    empty array (which still turns into at least 'auto').
 */
export function shouldRenderEffortChip(effortLevels: string[] | null | undefined): boolean {
  return effortLevels !== null
}

/**
 * THE single "model id -> effort levels" resolver for every effort
 * selector in the app (footer chip, WorkspaceDrawer, SettingsDrawer,
 * ClaudeGeneralSection) — do not add a fifth hardcoded ladder anywhere;
 * import this instead. Returns the same tri-state shouldRenderEffortChip/
 * effortOptionsFor consume: `string[]` (real levels), `null` (genuinely no
 * reasoning-effort control), or `undefined` (not resolved yet / no single
 * model to resolve).
 *
 * @param modelId the scope's effective model id, or undefined when this
 *   scope has NO single resolved model — either because it genuinely
 *   inherits from a parent scope with no override of its own (a project/
 *   global drawer's 'default'/'Use global' selection), or because a
 *   workspace's own model is unset (composeClaudeLaunch skips --model
 *   entirely, so claude picks its own default — see DropdownChip.tsx's own
 *   modelValue === '' doc comment). Both cases are the SAME concept here:
 *   "no single model to resolve real levels against" — the full ladder is
 *   used as the safe, non-fabricated fallback (every Claude/routed model's
 *   real levels are always a subset of it), NEVER `null` (which would
 *   incorrectly hide the control) and never a narrower guess.
 * @param selectableModels the already-resolved server-side model list (from
 *   useSelectableModels) — this function never computes model facts itself.
 * @param loading whether that list is still loading (useSelectableModels'
 *   own `loading` flag) — while true, returns `undefined` (pending) even
 *   for a concrete modelId, since a `.find()` miss during this window does
 *   NOT mean the model has no reasoning control, only that we don't know
 *   yet (the "empty effort chip on a cold direct-to-workspace open" bug).
 */
export function resolveEffortLevelsForScope(
  modelId: string | undefined,
  selectableModels: SelectableModel[],
  loading: boolean
): string[] | null | undefined {
  if (modelId === undefined || modelId === '') return [...EFFORT_LADDER_ORDER]
  if (loading) return undefined
  // Once loaded, buildSelectableModels/claudeFallbackModels guarantee an
  // already-selected model is represented (marked unavailable if its
  // backend is down) rather than silently dropped, PROVIDED the caller
  // passed modelId through as useSelectableModels' own currentModelId — see
  // that hook's doc comment. A genuine .find() miss past the loading window
  // is the residual "truly unresolvable id" case; treated as "unknown"
  // (undefined) rather than "hide" (null), since a miss is not positive
  // evidence the model lacks reasoning control.
  const entry = selectableModels.find((m) => m.id === modelId)
  return entry ? entry.effortLevels : undefined
}
