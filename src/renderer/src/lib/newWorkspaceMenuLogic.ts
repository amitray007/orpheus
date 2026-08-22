// ---------------------------------------------------------------------------
// src/renderer/src/lib/newWorkspaceMenuLogic.ts
//
// Pure logic backing the "+ new workspace" popover's native-overlay port —
// kept free of React/Electron so scripts/verify-new-workspace-menu.ts can
// exercise every decision offline. One decision remains:
//
//   The create-payload decision (harness-selector rebuild): given the
//   current isolation mode + the harness that was just clicked + branch
//   text, what does that click actually do? ('local' create with that
//   harness, or 'worktree' create with branch+harness, or disabled).
//   Clicking a harness chip IS the create action now — there is no
//   separate top-line/Enter step (see decideHarnessCreateAction below).
//
// REMOVED in the harness-selector rebuild (support-multi-harness): the old
// decideCreateAction (isolation + selectedModelId + branch -> create
// payload, keyed off a top-line "click the summary row" create action) and
// decideProviderRowIntent/decideModelPickAction (hover-vs-pick semantics for
// the now-deleted provider list and its model flyout). This popover no
// longer has a provider/model list at all — see NewWorkspaceMenu.tsx (both
// the overlay kind and its host component)'s own header comments for why:
// the user picks a HARNESS here (Claude Code, Codex, ...), one click both
// selects and creates, and the launched workspace's actual model comes from
// composeClaudeLaunch's normal settings layering, not a per-creation pick.
//
// REMOVED (dead-code cleanup, same branch): the submenu flip/clamp
// placement decision and the phantom-hover / row-hover / hover-intent-timer
// machinery (decideHoverIntentAction, computeSubmenuSide, reduceHoverGate,
// isGenuineHover, reduceRowHover, and the useGenuineHoverGate.ts hook that
// wrapped them). All of it existed to support a provider -> model flyout
// submenu that no longer exists anywhere: this popover replaced it with a
// flat harness list, and the footer Model chip's own flyout
// (ChipGroupedDropdown.tsx) that used to reuse this machinery was removed
// outright. Confirmed dead via grep — zero real imports anywhere, only
// prose mentions — before deletion.
// ---------------------------------------------------------------------------

export type NewWorkspaceMenuIsolation = 'local' | 'worktree'

export type HarnessCreateDecision =
  | { kind: 'local'; harnessId: string }
  | { kind: 'worktree'; harnessId: string; branch: string }
  | { kind: 'disabled' }

/**
 * What clicking a harness chip actually does, given the current isolation
 * mode + the clicked harness id + branch text. One click both selects the
 * harness AND creates (the approved redesign — "As soon as I click on any
 * harness, it should open the terminal directly"):
 *   - 'local' isolation always creates immediately with the clicked harness.
 *   - 'worktree' isolation creates ONLY when the branch field has non-blank
 *     text (matches the branch field's own inline validation) — an
 *     empty/whitespace-only branch resolves to 'disabled' rather than
 *     silently creating with a garbage branch name. The chosen isolation
 *     mode still applies to the create either way.
 */
export function decideHarnessCreateAction(
  isolation: NewWorkspaceMenuIsolation,
  harnessId: string,
  branchValue: string
): HarnessCreateDecision {
  if (isolation === 'local') return { kind: 'local', harnessId }
  const trimmed = branchValue.trim()
  if (!trimmed) return { kind: 'disabled' }
  return { kind: 'worktree', harnessId, branch: trimmed }
}

/**
 * Whether every harness chip should render disabled — the SAME gate
 * decideHarnessCreateAction's 'disabled' branch encodes (worktree isolation
 * selected but the branch field is blank), extracted as its own pure
 * predicate so the overlay kind (NewWorkspaceMenu.tsx) can compute a chip's
 * `disabled` prop from the identical logic a click would be evaluated
 * against, rather than a second hand-written copy of the same condition
 * that could silently drift from decideHarnessCreateAction's real gate.
 */
export function isHarnessRowDisabled(
  isolation: NewWorkspaceMenuIsolation,
  branchValue: string
): boolean {
  return isolation === 'worktree' && !branchValue.trim()
}
