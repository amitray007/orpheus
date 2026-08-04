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
import type {
  AsyncSlot,
  OfferedModes,
  ProviderGroup,
  SelectableModel,
  WizardProject,
  WizardState,
  WizardStep,
  WorkspaceMode
} from './wizardTypes.js'

/** Hoisted per sonarjs/no-duplicate-string (threshold 5) — this literal is
 *  compared/assigned at 5+ call sites across the step machine (initial
 *  state, the model-step key handler, both the model-provider and
 *  model-detail screen dispatches in components/wizard/WizardScreens.tsx). */
export const STEP_MODEL_PROVIDER: WizardStep = 'model-provider'

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

/**
 * Whether Step 3 (mode choice) should actually be shown, per the task
 * brief: only when BOTH local and worktree are offered. A slot that's still
 * loading is treated as "not yet decided" (callers must not call this before
 * checking `offeredModes.kind === 'ready'`); a slot that errored degrades to
 * "skip the step, default to local" (see resolveDefaultMode below) — this
 * function only answers the ready case.
 */
export function modeStepNeeded(offeredModes: OfferedModes): boolean {
  return offeredModes.local && offeredModes.worktree
}

/**
 * The mode to use when Step 3 is skipped (either because the project only
 * offers one mode, or because `project.offeredModes` itself failed — see the
 * task brief's "treat like only one mode offered, degrade to local" note).
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
    step: STEP_MODEL_PROVIDER,
    project,
    models: { kind: 'loading' },
    offeredModes: { kind: 'loading' },
    providerIndex: 0,
    modelIndex: 0,
    selectedModel: null,
    name: '',
    namePos: 0,
    modeIndex: 0,
    mode: null,
    submitting: false,
    submitError: null
  }
}

export const MODE_KEYS: WorkspaceMode[] = ['local', 'worktree']

/**
 * Move a list highlight index by `delta`, clamped to [0, length). Shared by
 * every list-shaped step (provider/model/mode) so the clamping logic isn't
 * repeated three times.
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
 * Step 1 key handling (both 'model-provider' and 'model-detail' screens) —
 * kept as its own function (rather than inlined into NewWorkspaceWizard.tsx's
 * useInput) to keep BOTH that callback's and this function's own
 * cognitive-complexity under the sonarjs budget (20) — see App.tsx's own
 * handleViewKey for the precedent this follows.
 */
export function handleModelStepKey(
  input: string,
  key: Key,
  state: WizardState,
  setState: SetWizardState,
  onCancel: () => void
): void {
  if (state.models.kind !== 'ready') {
    // Nothing to navigate yet (still loading, or errored) — only esc is
    // live, and only at the provider screen (there's no drilled-in screen
    // to have reached without a ready list).
    if (key.escape) onCancel()
    return
  }
  const groups = state.models.value
  if (state.step === STEP_MODEL_PROVIDER) {
    handleProviderListKey(input, key, groups.length, setState, onCancel)
    return
  }
  handleModelListKey(input, key, state, groups, setState)
}

function handleProviderListKey(
  input: string,
  key: Key,
  groupCount: number,
  setState: SetWizardState,
  onCancel: () => void
): void {
  if (key.escape) {
    onCancel()
    return
  }
  if (key.downArrow || input === 'j') {
    setState((s) => ({ ...s, providerIndex: moveIndex(s.providerIndex, 1, groupCount) }))
    return
  }
  if (key.upArrow || input === 'k') {
    setState((s) => ({ ...s, providerIndex: moveIndex(s.providerIndex, -1, groupCount) }))
    return
  }
  if (key.return && groupCount > 0) {
    setState((s) => ({ ...s, step: 'model-detail', modelIndex: 0 }))
  }
}

function handleModelListKey(
  input: string,
  key: Key,
  state: WizardState,
  groups: ProviderGroup[],
  setState: SetWizardState
): void {
  const group = groups[state.providerIndex]
  const models = group?.models ?? []
  if (key.escape) {
    setState((s) => ({ ...s, step: STEP_MODEL_PROVIDER }))
    return
  }
  if (key.downArrow || input === 'j') {
    setState((s) => ({ ...s, modelIndex: moveIndex(s.modelIndex, 1, models.length) }))
    return
  }
  if (key.upArrow || input === 'k') {
    setState((s) => ({ ...s, modelIndex: moveIndex(s.modelIndex, -1, models.length) }))
    return
  }
  if (key.return) {
    const model = models[state.modelIndex]
    // Unavailable models are a no-op on enter, never a selectable pick —
    // per the task brief. No transient notice here (unlike the picker's
    // Footer.notice pattern) since the row's own dimmed/marked rendering
    // already explains why nothing happened.
    if (model != null && model.available) {
      setState((s) => ({ ...s, selectedModel: model, step: 'name' }))
    }
  }
}

/** Step 2 (name) key handling — a hand-rolled text buffer, see
 *  components/wizard/NameStep.tsx. */
export function handleNameStepKey(input: string, key: Key, setState: SetWizardState): void {
  if (key.escape) {
    setState((s) => ({ ...s, step: 'model-detail' }))
    return
  }
  if (key.return) {
    setState((s) => ({ ...s, step: 'mode' }))
    return
  }
  if (key.leftArrow) {
    setState((s) => ({ ...s, namePos: Math.max(0, s.namePos - 1) }))
    return
  }
  if (key.rightArrow) {
    setState((s) => ({ ...s, namePos: Math.min(s.name.length, s.namePos + 1) }))
    return
  }
  if (key.backspace || key.delete) {
    setState((s) => {
      if (s.namePos === 0) return s
      const name = s.name.slice(0, s.namePos - 1) + s.name.slice(s.namePos)
      return { ...s, name, namePos: s.namePos - 1 }
    })
    return
  }
  // Printable character — Ink reports control/navigation keys via the `key`
  // object with `input` either empty or a non-printable escape sequence, so
  // gating on `input.length > 0` (after the above control-key checks have
  // all already returned) is the same discipline App.tsx's own useInput
  // relies on implicitly by only checking specific `input === 'x'` values.
  if (input.length > 0) {
    setState((s) => {
      const name = s.name.slice(0, s.namePos) + input + s.name.slice(s.namePos)
      return { ...s, name, namePos: s.namePos + input.length }
    })
  }
}

/** Step 3 (mode) key handling. */
export function handleModeStepKey(key: Key, input: string, setState: SetWizardState): void {
  if (key.escape) {
    setState((s) => ({ ...s, step: 'name' }))
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
    setState((s) => ({
      ...s,
      mode: MODE_KEYS[s.modeIndex] ?? 'local',
      step: 'confirm'
    }))
  }
}

/** Build the `workspace.create` args object from the wizard's collected
 *  state — omits `name`/`branch` entirely rather than sending an empty
 *  string, matching commandServer.ts's own `typeof === 'string' && !== ''`
 *  gate (an omitted key and an empty string are equivalent there, but
 *  omitting is the cleaner signal — see the task brief). No `branch` is ever
 *  sent: the 4-step flow deliberately has no branch-entry step, so worktree
 *  mode always auto-derives the branch server-side. */
export function buildCreateArgs(state: WizardState): Record<string, unknown> {
  const args: Record<string, unknown> = {
    projectId: state.project.id,
    cwd: state.project.cwd,
    mode: state.mode ?? 'local',
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
  if (state.name.length > 0) args.name = state.name
  if (state.selectedModel != null) args.model = state.selectedModel.id
  return args
}
