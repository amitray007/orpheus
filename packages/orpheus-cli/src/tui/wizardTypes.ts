/**
 * tui/wizardTypes.ts — shared types for the new-workspace wizard
 * (components/NewWorkspaceWizard.tsx and components/wizard/*.tsx).
 *
 * DELIBERATELY LOCAL, NOT src/shared/types.ts — same rationale as
 * tui/types.ts's own file header: this CLI package stays loosely coupled to
 * the main process's types, mirroring only the wire shapes it actually
 * consumes (SelectableModel's fields, OfferedModes' two booleans). If the
 * server's shape drifts, only this file (plus tui/types.ts) needs to change.
 *
 * STEP MODEL
 * -----------------------------------------------------------------------
 * The wizard is a single piece of state, `WizardState | null` in App.tsx —
 * null means closed. `WizardState.step` is the step MACHINE: 'model-provider'
 * and 'model-detail' are two sub-screens of "Step 1" (a provider list
 * drilling into a model list), 'mode' is Step 2 (conditionally skipped — see
 * NewWorkspaceWizard.tsx's `modeStepNeeded`), and 'confirm' is Step 3. Every
 * other field (selectedModel, mode, projectId/cwd) persists across step
 * changes so `esc` going backward never loses what the user already chose —
 * see "esc on later steps goes back ONE step, preserving state" below.
 *
 * A NAME STEP EXISTED HERE AND WAS DELIBERATELY REMOVED — DO NOT RE-ADD IT
 * -----------------------------------------------------------------------
 * This wizard used to have a fourth step, 'name', between 'model-detail' and
 * 'mode' — a hand-rolled text input for the workspace name. It was removed
 * because the typed value was thrown away almost immediately:
 * `displayTitleFor()` in layout.ts prefers Claude's own terminal title
 * (`lastTitle`, set once Claude starts) over `name`, so whatever the user
 * typed was overwritten within seconds of the workspace opening. That made
 * it the only text-entry step in a UI whose primary client is a phone
 * keyboard — pure cost, no benefit. The wizard still always sends a name
 * (never omits it — an omitted name would make every workspace created back
 * to back default to the literal string 'New workspace', indistinguishable
 * in the picker until Claude emits a title); it's just generated instead of
 * typed. See `buildCreateArgs` in wizardStepMachine.ts for that logic.
 */

export type WizardStep = 'model-provider' | 'model-detail' | 'mode' | 'confirm'

/**
 * Mirrors src/shared/types.ts's `SelectableModel` (see this file's header on
 * why it's re-declared here rather than imported). Field order/comments
 * match the source of truth as of the backend commit this wizard builds on
 * (28db36b6, "expose models, offered modes, and worktree create to the
 * socket") — re-check that file if `models.list`'s wire shape ever changes.
 */
export interface SelectableModel {
  id: string
  label: string
  /** 'claude' for the built-in Claude group, otherwise a provider id
   *  ('codex' | 'xai' | 'antigravity' etc) — matches theme.ts's
   *  `agentColors` keys. */
  providerId: string
  /** Human-readable group label, e.g. "Claude" or "Grok (xAI)". Every
   *  member of a provider group is expected to agree on this value (see
   *  NewWorkspaceWizard.tsx's `groupModelsByProvider`, which just takes it
   *  from the first member). */
  providerLabel: string
  isClaude: boolean
  /** false = must render visually distinct + non-selectable (see
   *  components/wizard/ListStep.tsx). */
  available: boolean
  contextWindow: number | null
  effortLevels: string[] | null
  /** True when `available: true` is a startup-window optimisation rather
   *  than a live-confirmed signal — see src/shared/types.ts's own doc
   *  comment on this field. Not currently rendered distinctly by the
   *  wizard (it's an availability NUANCE, not a blocking state); kept on
   *  the type so a future pass can surface it without another server
   *  round-trip. */
  provisional: boolean
}

export type WorkspaceMode = 'local' | 'worktree'

/** One provider's models, grouped client-side from the flat `models.list`
 *  response — see NewWorkspaceWizard.tsx's `groupModelsByProvider`. */
export interface ProviderGroup {
  providerId: string
  providerLabel: string
  models: SelectableModel[]
}

/** `project.offeredModes` response, unchanged shape from the backend. */
export interface OfferedModes {
  local: boolean
  worktree: boolean
}

/** The project the wizard was opened for — inferred from the picker's
 *  currently-highlighted row (see App.tsx's `selectedProject` memo), never
 *  chosen via a picker step of its own (see the task brief). */
export interface WizardProject {
  id: string
  name: string
  cwd: string
}

/**
 * Async-load state for the two calls kicked off when the wizard opens
 * (models.list, project.offeredModes) — see NewWorkspaceWizard.tsx's
 * "LOADING/ERROR STATE" section. Modeled as a plain union rather than
 * separate booleans so a component can exhaustively switch on `.kind`
 * without an invalid combination (e.g. both loading AND errored) being
 * representable.
 */
export type AsyncSlot<T> =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; value: T }

export interface WizardState {
  step: WizardStep
  project: WizardProject
  models: AsyncSlot<ProviderGroup[]>
  offeredModes: AsyncSlot<OfferedModes>
  /** Index into the provider-group list (model-provider step) or, once
   *  drilled in, index into `models[providerIndex].models` (model-detail
   *  step) — kept as two separate cursors rather than one shared index so
   *  drilling in/backing out never has to remember-and-restore a stale
   *  position in the OTHER list. */
  providerIndex: number
  modelIndex: number
  selectedModel: SelectableModel | null
  modeIndex: number
  mode: WorkspaceMode | null
  /** Set once `workspace.create` is in flight, to disable double-submission
   *  (see the task brief's confirm-step requirement). */
  submitting: boolean
  /** Set when a `workspace.create` attempt failed — surfaced inline on the
   *  confirm screen with a retry (enter) / back (esc) affordance, per the
   *  task brief. Cleared on the next submit attempt. */
  submitError: string | null
}
