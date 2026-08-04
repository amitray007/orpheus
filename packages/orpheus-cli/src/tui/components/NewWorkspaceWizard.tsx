/**
 * tui/components/NewWorkspaceWizard.tsx — phone-first, full-screen,
 * sequential new-workspace creation flow, opened by `n` in the picker
 * (App.tsx). Designed to be usable at ~38 columns (an iPhone-portrait
 * Termius session) — see wizardLayout.ts's header for why the width math is
 * split out into its own pure module.
 *
 * WHY ONE SCREEN AT A TIME, NEVER SIDE-BY-SIDE
 * -----------------------------------------------------------------------
 * The picker's own card design (App.tsx) already reflows continuously with
 * width; this wizard doesn't reflow at all — it's ONE decision per screen,
 * always full-width, at every breakpoint. That's deliberate: a
 * model-provider list + model-detail list side by side might fit at 120
 * columns, but building two layouts (stacked at narrow, split at wide) for a
 * flow whose entire reason to exist is phone-width usage would be solving a
 * problem nobody using this flow actually has. Simplicity over
 * width-adaptiveness here, unlike the picker.
 *
 * THIS FILE VS. wizardStepMachine.ts VS. wizard/WizardScreens.tsx
 * -----------------------------------------------------------------------
 * This component owns the state machine's OWNERSHIP (the `useState`
 * itself, the two data-loading effects, the useInput wiring) but not its
 * TRANSITION LOGIC (wizardStepMachine.ts's pure handleXStepKey functions,
 * which this component only dispatches to by current step) or its SCREEN
 * RENDERING (wizard/WizardScreens.tsx's WizardBody, which turns `state`
 * into whichever of the two step screens should show). The split mirrors
 * layout.ts/blocks.ts vs. App.tsx's own component-vs-pure-logic boundary
 * elsewhere in this package, and exists because the combined file, before
 * being split, was pushing well past this codebase's usual ~100-250
 * line-per-file granularity.
 *
 * ESC ASYMMETRY (do not "fix" this into one uniform rule)
 * -----------------------------------------------------------------------
 * esc at 'model' (the FIRST screen, Step 1's full model list) cancels the
 * whole wizard — model selection is mandatory and there is nothing "before"
 * it to go back to. esc at 'mode' (Step 2) goes back to 'model', preserving
 * every field already filled in (nothing is ever reset on a backward
 * navigation — only `onCancel` at the very first step discards state, by
 * virtue of App.tsx setting `wizardProject` back to null and this whole
 * component unmounting).
 *
 * The wizard is a 2-step flow — model (Step 1, one always-expanded list) ->
 * mode (Step 2, conditionally skipped). There is no separate confirm/create
 * step any more: selecting a mode at Step 2 creates immediately, and when
 * Step 2 is auto-skipped (the project only offers one mode), selecting the
 * MODEL at Step 1 creates immediately instead (see the mode-auto-skip effect
 * below). The submit lifecycle (submitting/error/retry) that used to live on
 * a dedicated confirm screen now renders on whichever step is last for a
 * given project — see wizard/WizardScreens.tsx's `SubmitStatusLine`.
 *
 * WHY BOTH ASYNC CALLS FIRE IMMEDIATELY ON OPEN, NOT LAZILY PER STEP
 * -----------------------------------------------------------------------
 * `models.list` is needed for Step 1 (immediately), `project.offeredModes`
 * only to decide whether Step 2 is shown — but both are cheap, independent,
 * and neither depends on anything the user enters, so firing them together
 * at mount time means `offeredModes` has almost always already resolved by
 * the time the user picks a model, with no visible loading flicker in the
 * common case. Firing lazily would only save a request in the case where the
 * user cancels before picking a model — not worth the extra state-machine
 * complexity of tracking "have I kicked this off yet" per step.
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, useInput } from 'ink'
import { sendCommand } from '../../socket-client.js'
import type { Palette } from '../theme.js'
import { WizardBody } from './wizard/WizardScreens.js'
import {
  buildCreateArgs,
  buildModelListRows,
  firstSelectableModelIndex,
  groupModelsByProvider,
  handleModelStepKey,
  handleModeStepKey,
  initialWizardState,
  modeStepNeeded,
  resolveDefaultMode,
  STEP_MODEL
} from '../wizardStepMachine.js'
import type {
  OfferedModes,
  SelectableModel,
  WizardProject,
  WizardState,
  WorkspaceMode
} from '../wizardTypes.js'

export interface NewWorkspaceWizardProps {
  project: WizardProject
  width: number
  /** Row budget for the wizard's own body, mirroring App.tsx's own
   *  `availableRows` (terminal rows minus the title bar and footer chrome)
   *  — threaded down to WizardBody -> ListStep so the Step 1 model list can
   *  window itself instead of silently overflowing a short terminal (see
   *  wizardLayout.ts's `windowListRows` and ListStep.tsx's WINDOWING note).
   *  Both the model and mode screens consume it; it's threaded through
   *  every screen anyway so WizardBody's dispatch doesn't need a
   *  step-by-step "does this one need it" branch. */
  availableRows: number
  palette: Palette
  /** Called once the wizard is done, one way or another.
   *
   *  On CANCEL: `null` — just close the wizard, nothing else happened.
   *
   *  On SUCCESS: the new workspace's id, so App.tsx can hand it straight to
   *  `onOpen` and attach to it (entry.ts's runTui loop -> hostAndAttach).
   *  Creating a workspace is intent to work in it; bouncing back to the
   *  list and making the user find and select the thing they just named is
   *  busywork, and worse on a phone. The id comes from workspace.create's
   *  own `{ workspace, seedWarning }` response rather than from waiting for
   *  the row to show up in a tree frame — that response is authoritative
   *  and immediate, whereas the frame is asynchronous and would race.
   *
   *  Null-on-success is tolerated (see submit()): if the response ever
   *  arrives in an unexpected shape, the wizard still closes cleanly and
   *  falls back to the old behaviour rather than throwing away a workspace
   *  that WAS created. */
  onDone: (createdWorkspaceId: string | null) => void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Dig the new workspace's id out of workspace.create's `{ workspace,
 * seedWarning }` response. Written defensively (every hop re-checked) rather
 * than cast: sendCommand returns untyped JSON off a socket, and the failure
 * we care about is silent — a shape change here must degrade to "close the
 * wizard, stay in the list", never throw away a workspace that was actually
 * created on the server. Returning null is the caller's documented
 * fall-back path, not an error.
 */
function createdWorkspaceIdFrom(result: unknown): string | null {
  if (result == null || typeof result !== 'object') return null
  const workspace = (result as { workspace?: unknown }).workspace
  if (workspace == null || typeof workspace !== 'object') return null
  const id = (workspace as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * Kick off both async calls once, on mount — see this file's header for why
 * they fire together rather than lazily. `cancelled` guards against setting
 * state after the component (or just this effect, on a StrictMode-style
 * double-invoke) has gone away; there is no AbortController plumbed through
 * sendCommand, so this flag is the whole guard.
 */
function useWizardData(
  project: WizardProject,
  setState: React.Dispatch<React.SetStateAction<WizardState>>
): void {
  useEffect(() => {
    let cancelled = false
    sendCommand('models.list', {})
      .then((data) => {
        if (cancelled) return
        const models = groupModelsByProvider(data as SelectableModel[])
        // Seed the cursor to the first SELECTABLE row: row 0 of the
        // flattened list is always a provider header now every provider is
        // expanded up front (see wizardStepMachine.ts's `buildModelListRows`),
        // never a valid cursor rest — falls back to 0 only in the
        // pathological case of no selectable model at all (every provider
        // returned zero available models), so navigation still has SOME
        // starting index rather than an out-of-range one.
        const firstRow = firstSelectableModelIndex(buildModelListRows(models))
        setState((s) => ({
          ...s,
          models: { kind: 'ready', value: models },
          cursor: firstRow >= 0 ? firstRow : 0
        }))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setState((s) => ({ ...s, models: { kind: 'error', message: errorMessage(err) } }))
      })
    sendCommand('project.offeredModes', { projectId: project.id })
      .then((data) => {
        if (cancelled) return
        setState((s) => ({ ...s, offeredModes: { kind: 'ready', value: data as OfferedModes } }))
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Degrade rather than error-block: offeredModes only gates Step 3,
        // and the task brief says a failure there should behave like "only
        // one mode offered" (default to local), not surface a dead end.
        setState((s) => ({ ...s, offeredModes: { kind: 'error', message: errorMessage(err) } }))
      })
    return () => {
      cancelled = true
    }
    // project.id is the only input this effect depends on; `project` itself
    // is a fresh object identity from App.tsx's memo every render, which
    // would otherwise refire this on every keystroke elsewhere in the
    // wizard. setState's identity is stable (useState setter).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])
}

export function NewWorkspaceWizard({
  project,
  width,
  availableRows,
  palette,
  onDone
}: NewWorkspaceWizardProps): React.JSX.Element {
  const [state, setState] = useState<WizardState>(() => initialWizardState(project))
  useWizardData(project, setState)

  // `submit` is called from two places (the mode-auto-skip effect below, and
  // the mode step's own enter handler) with the mode value the CALLER just
  // resolved, never read back off `state.mode` — `setState` calls made
  // moments earlier in the same tick (setting `mode`) have not necessarily
  // been applied to this closure's `state` yet, and `buildCreateArgs` needs
  // an authoritative mode to send. Passing it explicitly sidesteps that
  // stale-closure race entirely rather than relying on effect ordering.
  //
  // `autoSkipped` marks a submit that was triggered WITHOUT the user ever
  // seeing the mode screen (the project only offers one mode) — on failure,
  // that case must land back on 'model' (not stay on 'mode', which would
  // render a two-option mode picker for a project that doesn't actually
  // offer a choice) so the error/retry affordance shows on a screen the
  // list-rows actually make sense for. See `handleModelStepKey`'s own
  // `submitting` guard for how a retry from there re-triggers this same
  // path via the auto-skip effect below.
  async function submit(mode: WorkspaceMode, autoSkipped: boolean): Promise<void> {
    setState((s) => ({ ...s, mode, submitting: true, submitError: null }))
    try {
      const result = await sendCommand('workspace.create', buildCreateArgs({ ...state, mode }))
      onDone(createdWorkspaceIdFrom(result))
    } catch (err) {
      setState((s) => ({
        ...s,
        step: autoSkipped ? STEP_MODEL : s.step,
        submitting: false,
        submitError: errorMessage(err)
      }))
    }
  }

  // AUTO-SKIP STEP 2 — once offeredModes resolves (or errors) and the
  // wizard has reached 'mode', immediately resolve which mode to use and
  // submit right away if the project doesn't offer a real choice (there is
  // no more 'confirm' screen to land on first — selecting/resolving the mode
  // IS the create trigger now). Lives in an effect (not inline in the key
  // handler) because it must also fire if offeredModes finishes loading
  // WHILE the user is already sitting on the model list and then presses
  // enter on a model — the transition into 'mode' can happen before or
  // after the data resolves, and either ordering must reach the same
  // outcome. Guarded on `submitting` (no re-fire mid-request) AND
  // `submitError == null` (a failed auto-skip submit routes step back to
  // 'model' — see `submit` above — specifically so this effect's own guards
  // stop matching and it does NOT immediately retry in a loop; the user
  // retries explicitly via enter on the model screen instead).
  useEffect(() => {
    if (state.step !== 'mode' || state.submitting || state.submitError != null) return
    if (state.offeredModes.kind === 'loading') return
    if (state.offeredModes.kind === 'ready' && modeStepNeeded(state.offeredModes.value)) return
    void submit(resolveDefaultMode(state.offeredModes), true)
    // submit/state intentionally excluded: this effect's job is "notice the
    // step/offeredModes transition and react once", not resubscribe to the
    // whole state object it also writes to (which would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step, state.offeredModes, state.submitting, state.submitError])

  useInput((input, key) => {
    if (state.step === STEP_MODEL) {
      // Cancel path only — the model step can never CREATE anything on its
      // own (only the mode-auto-skip effect above can, once a model
      // selection lands it on 'mode' with only one mode offered), so it
      // always reports "no workspace" rather than forwarding onDone's
      // create-id argument (which handleModelStepKey has no way to supply).
      handleModelStepKey(input, key, state, setState, () => onDone(null))
      return
    }
    // 'mode' — selecting a mode here creates immediately (onSelect ->
    // submit), no separate confirm step to advance to. Not auto-skipped: the
    // user is looking at this screen and chose a mode themselves.
    handleModeStepKey(key, input, state, setState, (mode) => void submit(mode, false))
  })

  return (
    <Box flexDirection="column" flexGrow={1}>
      <WizardBody state={state} width={width} availableRows={availableRows} palette={palette} />
    </Box>
  )
}
