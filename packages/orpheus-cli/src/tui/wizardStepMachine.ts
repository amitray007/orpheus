/**
 * tui/wizardStepMachine.ts — pure state-transition logic for the
 * new-workspace wizard, split out of components/NewWorkspaceWizard.tsx so
 * that component stays a thin useInput+render host (mirrors this codebase's
 * existing granularity: layout.ts/blocks.ts hold the PURE transforms,
 * App.tsx/its components hold only the Ink rendering + wiring).
 *
 * Nothing here imports react/ink — every function is a plain
 * `(state, ...) -> state-shaped result` transform, which is what lets
 * NewWorkspaceWizard.tsx's own useInput callback stay a short dispatch table
 * (state.step -> the matching handleXStepKey call) rather than a single
 * giant branchy function, and is what keeps sonarjs/cognitive-complexity
 * under budget on both files.
 *
 * STEP KEY HANDLERS RETURN VOID (mutate via setState), NOT A NEW STATE
 * -----------------------------------------------------------------------
 * Each handleXStepKey takes the CURRENT setState dispatcher and calls it
 * itself, rather than returning a next-state value for the caller to apply.
 * This matches React's own "functional updater" idiom (`setState(s => ...)`)
 * and lets each handler branch into MULTIPLE distinct updates (e.g. moving
 * the highlight vs. transitioning steps) without the caller needing to know
 * which one happened — the caller (NewWorkspaceWizard.tsx's useInput) only
 * needs to route the keypress to the right handler for the CURRENT step.
 */

import type { Key } from 'ink'
import { truncate } from './layout.js'
import type {
  AsyncSlot,
  OfferedModes,
  ProviderGroup,
  SelectableModel,
  WizardProject,
  WizardState,
  WorkspaceMode
} from './wizardTypes.js'

/** Hoisted per sonarjs/no-duplicate-string (threshold 5) — this literal is
 *  the wizard's Step 1 step id, compared/assigned across the step machine
 *  (initial state, the model-step key handler dispatch in
 *  NewWorkspaceWizard.tsx) and WizardScreens.tsx's own screen dispatch. */
export const STEP_MODEL = 'model' as const

/**
 * Group the flat `models.list` response by providerId, preserving first-seen
 * order (server already returns a sensibly ordered list — this must not
 * re-sort it, only bucket it). Each group's label is taken from its first
 * member's `providerLabel` — the task brief states every member of a group
 * should agree on this value, so there is no need to reconcile disagreement.
 */
export function groupModelsByProvider(models: SelectableModel[]): ProviderGroup[] {
  const order: string[] = []
  const byProvider = new Map<string, SelectableModel[]>()
  for (const model of models) {
    if (!byProvider.has(model.providerId)) {
      order.push(model.providerId)
      byProvider.set(model.providerId, [])
    }
    byProvider.get(model.providerId)?.push(model)
  }
  return order.map((providerId) => {
    const groupModels = byProvider.get(providerId) ?? []
    return {
      providerId,
      providerLabel: groupModels[0]?.providerLabel ?? providerId,
      models: groupModels
    }
  })
}

// ---------------------------------------------------------------------------
// Model list flattening — Step 1's single screen: every provider is always
// fully expanded (no accordion, no toggle state), see wizardTypes.ts's STEP
// MODEL section for why the old collapse/expand machinery was removed.
// ---------------------------------------------------------------------------

/** One row of the flattened model list — either a provider header (always
 *  present, one per group, non-interactive — the cursor skips it) or one of
 *  that provider's models (always present, every provider is always
 *  expanded). `kind` lets callers (WizardScreens.tsx) build the right
 *  `ListRow` shape — headers get the group colour, model rows get the
 *  indent + availability suffix — without re-deriving which is which from
 *  index arithmetic. */
export type ModelListRow =
  | { kind: 'provider'; group: ProviderGroup }
  | { kind: 'model'; providerId: string; model: SelectableModel }

/**
 * Flatten the provider groups into Step 1's row list: every provider
 * contributes exactly one header row followed by every one of its models,
 * in order — ALL providers, always (no expand/collapse state to consult).
 * This is the function the harness's "every provider's header + every one of
 * its models, nothing collapsed" assertion exercises directly.
 */
export function buildModelListRows(groups: ProviderGroup[]): ModelListRow[] {
  const rows: ModelListRow[] = []
  for (const group of groups) {
    rows.push({ kind: 'provider', group })
    for (const model of group.models) {
      rows.push({ kind: 'model', providerId: group.providerId, model })
    }
  }
  return rows
}

/**
 * The cursor only ever lands on a SELECTABLE row: a model with
 * `available: true`. Header rows are structural labels now the accordion is
 * gone (nothing to toggle), and an unavailable model is a dead end if
 * selected — both are skipped by `moveModelCursor` below, so this predicate
 * is the one place "is this row a valid cursor stop" is decided.
 */
function isSelectableRow(row: ModelListRow): boolean {
  return row.kind === 'model' && row.model.available
}

/**
 * Move the model-step cursor by `delta` (+1/-1), skipping header rows and
 * unavailable models so the cursor only ever rests on a selectable model —
 * crossing a provider boundary reads as if the header in between weren't
 * there. Wraps neither direction (clamps at the first/last selectable row,
 * matching `moveIndex`'s own clamp-not-wrap contract) and returns the
 * CURRENT index unchanged if no selectable row exists in the requested
 * direction (e.g. already on the last available model and pressing down) or
 * if the list has no selectable rows at all (defensive — shouldn't happen
 * since a provider only ever lists a model when `models.list` says the
 * project has one, but a screen full of unavailable models must not crash
 * navigation).
 */
export function moveModelCursor(rows: ModelListRow[], current: number, delta: number): number {
  let next = current
  for (let steps = 0; steps < rows.length; steps++) {
    next += delta
    if (next < 0 || next >= rows.length) return current
    if (isSelectableRow(rows[next]!)) return next
  }
  return current
}

/** The first selectable row's index, or -1 if the list has none — used to
 *  seed the cursor when the model step's data first resolves (see
 *  `initialWizardState`'s cursor:0 default, which this corrects once
 *  `models` moves from loading to ready: row 0 is always a provider header,
 *  never a valid cursor rest). */
export function firstSelectableModelIndex(rows: ModelListRow[]): number {
  return rows.findIndex((row) => isSelectableRow(row))
}

/**
 * Whether Step 2 (mode choice) should actually be shown: only when BOTH
 * local and worktree are offered. A slot that's still loading is treated as
 * "not yet decided" (callers must not call this before checking
 * `offeredModes.kind === 'ready'`); a slot that errored degrades to
 * "skip the step, default to local" (see resolveDefaultMode below) — this
 * function only answers the ready case.
 */
export function modeStepNeeded(offeredModes: OfferedModes): boolean {
  return offeredModes.local && offeredModes.worktree
}

/**
 * The mode to use when Step 2 is skipped (either because the project only
 * offers one mode, or because `project.offeredModes` itself failed — degrade
 * to "treat like only one mode offered, default to local").
 * Prefers whichever single mode IS offered over a bare 'local' guess, so a
 * worktree-only project (if that combination is ever possible) still gets
 * the right default instead of one the server would reject.
 */
export function resolveDefaultMode(offeredModes: AsyncSlot<OfferedModes>): WorkspaceMode {
  if (offeredModes.kind !== 'ready') return 'local'
  if (offeredModes.value.worktree && !offeredModes.value.local) return 'worktree'
  return 'local'
}

export function initialWizardState(project: WizardProject): WizardState {
  return {
    step: STEP_MODEL,
    project,
    models: { kind: 'loading' },
    offeredModes: { kind: 'loading' },
    cursor: 0,
    selectedModel: null,
    modeIndex: 0,
    mode: null,
    submitting: false,
    submitError: null
  }
}

export const MODE_KEYS: WorkspaceMode[] = ['local', 'worktree']

/**
 * Move a list highlight index by `delta`, clamped to [0, length). Used by
 * the mode list, whose every row is selectable — the model list uses
 * `moveModelCursor` instead, since it must additionally skip header/
 * unavailable rows.
 */
export function moveIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0
  const next = current + delta
  if (next < 0) return 0
  if (next >= length) return length - 1
  return next
}

type SetWizardState = (updater: (s: WizardState) => WizardState) => void

/**
 * Step 1 key handling — the single, always-fully-expanded model list.
 * Kept as its own function (rather than inlined into
 * NewWorkspaceWizard.tsx's useInput) to keep BOTH that callback's and this
 * function's own cognitive-complexity under the sonarjs budget (20) — see
 * App.tsx's own handleViewKey for the precedent this follows.
 *
 * `submitting` is checked here (not just at the mode step) because
 * selecting a model now creates IMMEDIATELY when Step 2 is auto-skipped —
 * see `handleModelStepEnter` below — so this screen can itself be "the last
 * screen" with a request in flight, and further enter presses while that
 * request is outstanding must not double-submit (mirrors the identical
 * guard this wizard already had at the old confirm step).
 */
export function handleModelStepKey(
  input: string,
  key: Key,
  state: WizardState,
  setState: SetWizardState,
  onCancel: () => void
): void {
  if (key.escape) {
    // esc at Step 1 always cancels the whole wizard — there is no sub-screen
    // to back out of any more (see wizardTypes.ts's STEP MODEL section and
    // NewWorkspaceWizard.tsx's ESC ASYMMETRY note).
    onCancel()
    return
  }
  if (state.submitting) return // no double-submit while a create is in flight
  if (state.models.kind !== 'ready') return // nothing to navigate yet
  const rows = buildModelListRows(state.models.value)
  if (key.downArrow || input === 'j') {
    setState((s) => ({ ...s, cursor: moveModelCursor(rows, s.cursor, 1) }))
    return
  }
  if (key.upArrow || input === 'k') {
    setState((s) => ({ ...s, cursor: moveModelCursor(rows, s.cursor, -1) }))
    return
  }
  if (key.return) {
    handleModelStepEnter(rows, state.cursor, setState)
  }
}

/**
 * `enter` on the model list: selects the highlighted model (if available —
 * see `moveModelCursor`'s skip logic, though this guard is kept defensively
 * since the cursor's starting position at row 0 is a header before the first
 * navigation) and advances to Step 2. Split out of `handleModelStepKey`
 * purely to keep that function's own branch count under the sonarjs
 * cognitive-complexity budget.
 *
 * This no longer decides whether to submit — that decision (mode step
 * shown vs. auto-skipped) depends on `offeredModes`, an async slot this
 * pure function has no access to. NewWorkspaceWizard.tsx's mode-auto-skip
 * effect already resolves that once `step` flips to 'mode' and immediately
 * calls `submit()` when the project only offers one mode — so selecting a
 * model always transitions to 'mode' here, and the effect (or the user, at
 * the mode step) decides what happens next.
 */
function handleModelStepEnter(
  rows: ModelListRow[],
  cursor: number,
  setState: SetWizardState
): void {
  const row = rows[cursor]
  if (row == null || row.kind !== 'model' || !row.model.available) return
  // Clear any stale submitError from a previous failed auto-skip attempt
  // (see NewWorkspaceWizard.tsx's `submit`'s `autoSkipped` handling) — a
  // fresh selection is a fresh attempt, not a retry of the old one.
  setState((s) => ({ ...s, selectedModel: row.model, step: 'mode', submitError: null }))
}

/**
 * Step 2 (mode) key handling. Selecting a mode used to advance to a
 * 'confirm' screen; that screen is gone — selecting a mode now creates
 * immediately, via `onSelect`, and this function does not touch
 * `submitting`/`submitError` itself (see NewWorkspaceWizard.tsx's `submit`,
 * which owns that lifecycle end to end).
 */
export function handleModeStepKey(
  key: Key,
  input: string,
  state: WizardState,
  setState: SetWizardState,
  onSelect: (mode: WorkspaceMode) => void
): void {
  if (state.submitting) return // no double-submit while a create is in flight
  if (key.escape) {
    // Always back to the model list, clearing any stale error from a failed
    // attempt — matches the old confirm screen's "esc back" affordance.
    setState((s) => ({ ...s, step: STEP_MODEL, submitError: null }))
    return
  }
  if (key.downArrow || input === 'j') {
    setState((s) => ({ ...s, modeIndex: moveIndex(s.modeIndex, 1, MODE_KEYS.length) }))
    return
  }
  if (key.upArrow || input === 'k') {
    setState((s) => ({ ...s, modeIndex: moveIndex(s.modeIndex, -1, MODE_KEYS.length) }))
    return
  }
  if (key.return) {
    const mode = MODE_KEYS[state.modeIndex] ?? 'local'
    setState((s) => ({ ...s, mode }))
    onSelect(mode)
  }
}

/** Cap on the project-name portion of a generated workspace name — see
 *  `generateDefaultName` below. Chosen defensively: project names are
 *  user-controlled and unbounded, but `<name> HH:MM` must stay well under
 *  the wizard's 38-column phone-width budget wherever it's later displayed
 *  (the picker list), so the project-name portion alone is capped here well
 *  short of that. */
const GENERATED_NAME_PROJECT_CAP = 24

/**
 * Generate the default workspace name: `<project name> HH:MM`, local
 * 24-hour time, e.g. `orpheus 14:32`. Called once per `buildCreateArgs`
 * invocation (itself called once, at submit time) — never in a render path,
 * so there's no need to memoize or store the result back in `WizardState`.
 * Uses `truncate` from layout.ts (the same "..." ellipsis convention used
 * throughout this package, never the banned U+2026 character) so a long
 * project name degrades the same way every other truncated string in this
 * UI does, rather than inventing a second convention.
 */
function generateDefaultName(projectName: string, now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const project = truncate(projectName, GENERATED_NAME_PROJECT_CAP)
  return `${project} ${hh}:${mm}`
}

/** Build the `workspace.create` args object from the wizard's collected
 *  state. `name` is ALWAYS set to a generated value (project name + local
 *  HH:MM time — see `generateDefaultName`), never omitted: the wizard has no
 *  name-entry step, and if `name` were left out entirely the server would
 *  default every workspace to the literal string 'New workspace', making
 *  several workspaces created back to back indistinguishable in the picker
 *  until Claude emits its own terminal title. `branch` is still omitted
 *  entirely rather than sent as an empty string, matching commandServer.ts's
 *  own `typeof === 'string' && !== ''` gate: this flow has no branch-entry
 *  step, so worktree mode always auto-derives the branch server-side. */
export function buildCreateArgs(state: WizardState): Record<string, unknown> {
  const args: Record<string, unknown> = {
    projectId: state.project.id,
    cwd: state.project.cwd,
    mode: state.mode ?? 'local',
    name: generateDefaultName(state.project.name, new Date()),
    // focus:false — workspace.create defaults `focus` to TRUE, which makes
    // the DESKTOP app raise and foreground the new workspace
    // (activateLegacyCreatedWorkspace -> requestOpenWorkspace(id, focus) in
    // commandServer.ts). That's right for the GUI's own create flow and
    // wrong for this one: the TUI's primary client is a phone over SSH, and
    // creating a workspace from there must not yank the user's Mac to the
    // front of whatever they were doing on it. The TUI attaches to the new
    // workspace itself (see the wizard's onDone(workspaceId) -> App's
    // onOpen -> entry.ts's hostAndAttach), so it needs no help from the
    // desktop to get there.
    focus: false
  }
  if (state.selectedModel != null) args.model = state.selectedModel.id
  return args
}
