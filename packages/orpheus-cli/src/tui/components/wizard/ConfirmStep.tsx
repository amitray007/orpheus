/**
 * tui/components/wizard/ConfirmStep.tsx — Step 3 of the new-workspace
 * wizard: a summary of every prior selection, plus the `workspace.create`
 * submit/loading/error flow.
 *
 * NO NAME LINE HERE — the wizard has no name-entry step (see wizardTypes.ts's
 * header for why it was removed). The workspace name is generated fresh
 * inside wizardStepMachine.ts's `buildCreateArgs` at submit time and is
 * never stored back in `WizardState`, so there is nothing meaningful for
 * this screen to preview — only `model` and `mode`, the two things the user
 * actually chose, are summarized below.
 *
 * WHY THE MODE LINE ALWAYS RENDERS, EVEN WHEN STEP 2 WAS SKIPPED
 * -----------------------------------------------------------------------
 * When a project only offers one of local/worktree, Step 2 (the explicit
 * choice) is skipped, but the user should still be able to see what mode is
 * ABOUT to happen before they commit — silently defaulting to whichever mode
 * was offered, with no confirmation-screen trace of it, would make
 * workspace.create's behaviour a surprise. So `mode` is always populated by
 * the time this screen renders (NewWorkspaceWizard.tsx resolves it as soon
 * as offeredModes/step-2 selection settle), and this component always shows
 * it — there is no "was step 2 shown" flag threaded down here, only the
 * resolved mode value.
 *
 * SUBMIT STATE — three renders of the same screen, not three screens
 * -----------------------------------------------------------------------
 * idle (enter arms a submit) / submitting ("creating…", further enter
 * presses are ignored by NewWorkspaceWizard's key handler, not by anything
 * in this component) / error (message shown inline, enter retries, esc goes
 * back). Kept as one component with a small conditional rather than three,
 * since the summary lines above the status line never change across these
 * three states — splitting would just duplicate that block.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { CARD_GUTTER_WIDTH, CARD_PAD_GUTTER } from '../../theme.js'
import type { Palette } from '../../theme.js'
import { buildSummaryLine } from '../../wizardLayout.js'
import type { SelectableModel, WorkspaceMode } from '../../wizardTypes.js'

export interface ConfirmStepProps {
  selectedModel: SelectableModel | null
  mode: WorkspaceMode
  submitting: boolean
  submitError: string | null
  width: number
  palette: Palette
}

/** "opus high" style, or "(none selected)" for the defensive case where the
 *  user somehow reached confirm without a model (shouldn't happen — model
 *  selection is Step 1 and is mandatory — but the summary must never crash
 *  or show `undefined` if it does). */
function modelSummaryText(model: SelectableModel | null): string {
  if (model == null) return '(none selected)'
  return model.label
}

function SummaryLines({
  selectedModel,
  mode,
  width,
  palette
}: {
  selectedModel: SelectableModel | null
  mode: WorkspaceMode
  width: number
  palette: Palette
}): React.JSX.Element {
  const lines = [
    buildSummaryLine('model', modelSummaryText(selectedModel), width),
    buildSummaryLine('mode', mode, width)
  ]
  return (
    <>
      {lines.map((line) => (
        <Text key={line} color={palette.text} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </>
  )
}

function StatusLine({
  submitting,
  submitError,
  palette
}: {
  submitting: boolean
  submitError: string | null
  palette: Palette
}): React.JSX.Element | null {
  if (submitting) {
    return (
      <Text color={palette.awaiting} wrap="truncate-end">
        creating…
      </Text>
    )
  }
  if (submitError != null) {
    return (
      <Text color={palette.attention} wrap="truncate-end">
        {submitError}
      </Text>
    )
  }
  return null
}

export function ConfirmStep({
  selectedModel,
  mode,
  submitting,
  submitError,
  width,
  palette
}: ConfirmStepProps): React.JSX.Element {
  const hint =
    submitError != null
      ? 'enter retry   esc back'
      : submitting
        ? 'creating…'
        : 'enter create   esc back'
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER}>
        <Text bold color={palette.groupLabel} wrap="truncate-end">
          Create workspace
        </Text>
      </Box>
      <Box flexDirection="column" paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER} marginTop={1}>
        <SummaryLines selectedModel={selectedModel} mode={mode} width={width} palette={palette} />
      </Box>
      <Box paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER} marginTop={1}>
        <StatusLine submitting={submitting} submitError={submitError} palette={palette} />
      </Box>
      <Box flexGrow={1} />
      <Text color={palette.secondary} wrap="truncate-end">
        {hint}
      </Text>
    </Box>
  )
}
