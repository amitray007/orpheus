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
 * into whichever of the five step screens should show). The split mirrors
 * layout.ts/blocks.ts vs. App.tsx's own component-vs-pure-logic boundary
 * elsewhere in this package, and exists because the combined file, before
 * being split, was pushing well past this codebase's usual ~100-250
 * line-per-file granularity.
 *
 * ESC ASYMMETRY (do not "fix" this into one uniform rule)
 * -----------------------------------------------------------------------
 * esc at 'model-provider' (the FIRST screen) cancels the whole wizard — model
 * selection is mandatory and there is nothing "before" it to go back to. esc
 * at every later step goes back exactly one step, preserving every field
 * already filled in (nothing is ever reset on a backward navigation — only
 * `onCancel` at the very first step discards state, by virtue of App.tsx
 * setting `wizardProject` back to null and this whole component unmounting).
 * 'model-detail' (drilled into a provider's own model list) is NOT "later"
 * for this purpose even though it comes chronologically after
 * 'model-provider' — esc there returns to 'model-provider', not to the
 * picker, because it's the SAME logical step (Step 1) — 'model-detail' going
 * back to 'model-provider' IS one step back within Step 1.
 *
 * The wizard is a 3-step flow — model (Step 1, two screens) -> mode (Step 2,
 * conditionally skipped) -> confirm (Step 3). It used to have a fourth,
 * name-entry step between model-detail and mode; that step was removed (see
 * wizardTypes.ts's header for why) and every esc/confirm-skip target that
 * used to point at 'name' now points at 'model-detail' instead, since that's
 * the step immediately before mode in the shortened chain.
 *
 * WHY BOTH ASYNC CALLS FIRE IMMEDIATELY ON OPEN, NOT LAZILY PER STEP
 * -----------------------------------------------------------------------
 * `models.list` is needed for Step 1 (immediately), `project.offeredModes`
 * only by Step 3 — but both are cheap, independent, and neither depends on
 * anything the user enters, so firing them together at mount time means
 * `offeredModes` has almost always already resolved by the time the user
 * reaches Step 3 (after picking a model and typing a name), with no visible
 * loading flicker on that step in the common case. Firing lazily would only
 * save a request in the case where the user cancels before reaching Step 3 —
 * not worth the extra state-machine complexity of tracking "have I kicked
 * this off yet" per step.
 */

import * as React from 'react'
import { useEffect, useState } from 'react'
import { Box, useInput } from 'ink'
import { sendCommand } from '../../socket-client.js'
import type { Palette } from '../theme.js'
import { WizardBody } from './wizard/WizardScreens.js'
import {
  buildCreateArgs,
  groupModelsByProvider,
  handleModelStepKey,
  handleModeStepKey,
  initialWizardState,
  modeStepNeeded,
  resolveDefaultMode,
  STEP_MODEL_PROVIDER
} from '../wizardStepMachine.js'
import type { OfferedModes, SelectableModel, WizardProject, WizardState } from '../wizardTypes.js'

export interface NewWorkspaceWizardProps {
  project: WizardProject
  width: number
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
        setState((s) => ({ ...s, models: { kind: 'ready', value: models } }))
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

/**
 * Resolve the confirm screen's esc target: 'mode' if Step 2 was actually
 * shown (both modes offered), else 'model-detail' — mirrors the auto-skip
 * effect's own "was mode really a choice" check so backing out of confirm
 * always lands on whichever step the user actually saw. 'model-detail' (not
 * 'model-provider') is the fallback because it's the step immediately before
 * mode in the current chain — going back further would skip past the user's
 * already-drilled-in model list.
 */
function confirmEscapeTarget(state: WizardState): 'mode' | 'model-detail' {
  return state.offeredModes.kind === 'ready' && modeStepNeeded(state.offeredModes.value)
    ? 'mode'
    : 'model-detail'
}

export function NewWorkspaceWizard({
  project,
  width,
  palette,
  onDone
}: NewWorkspaceWizardProps): React.JSX.Element {
  const [state, setState] = useState<WizardState>(() => initialWizardState(project))
  useWizardData(project, setState)

  // AUTO-SKIP STEP 2 — once offeredModes resolves (or errors) and the
  // wizard has reached 'mode', immediately resolve which mode to use and
  // jump straight to 'confirm' if the project doesn't offer a real choice.
  // Lives in an effect (not inline in the key handler) because it must also
  // fire if offeredModes finishes loading WHILE the user is already sitting
  // on the model-detail step and then presses enter — the transition into
  // 'mode' can happen before or after the data resolves, and either ordering
  // must reach the same outcome.
  useEffect(() => {
    if (state.step !== 'mode') return
    if (state.offeredModes.kind === 'loading') return
    if (state.offeredModes.kind === 'ready' && modeStepNeeded(state.offeredModes.value)) return
    setState((s) => ({ ...s, mode: resolveDefaultMode(s.offeredModes), step: 'confirm' }))
  }, [state.step, state.offeredModes])

  async function submit(): Promise<void> {
    setState((s) => ({ ...s, submitting: true, submitError: null }))
    try {
      const result = await sendCommand('workspace.create', buildCreateArgs(state))
      onDone(createdWorkspaceIdFrom(result))
    } catch (err) {
      setState((s) => ({ ...s, submitting: false, submitError: errorMessage(err) }))
    }
  }

  useInput((input, key) => {
    if (state.step === STEP_MODEL_PROVIDER || state.step === 'model-detail') {
      // Cancel path only — the model step can never CREATE anything, so it
      // always reports "no workspace" rather than forwarding onDone's
      // create-id argument (which handleModelStepKey has no way to supply).
      handleModelStepKey(input, key, state, setState, () => onDone(null))
      return
    }
    if (state.step === 'mode') {
      handleModeStepKey(key, input, setState)
      return
    }
    // 'confirm'
    if (state.submitting) return // ignore further presses mid-request — no double-submit
    if (key.escape) {
      setState((s) => ({ ...s, step: confirmEscapeTarget(s), submitError: null }))
      return
    }
    if (key.return) {
      void submit()
    }
  })

  return (
    <Box flexDirection="column" flexGrow={1}>
      <WizardBody state={state} width={width} palette={palette} />
    </Box>
  )
}
