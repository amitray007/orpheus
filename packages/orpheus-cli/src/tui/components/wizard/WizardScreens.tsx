/**
 * tui/components/wizard/WizardScreens.tsx — step-to-screen dispatch for
 * NewWorkspaceWizard.tsx, split out for the same reason PickerBody is its
 * own extraction in App.tsx: keeping this branching out of the top-level
 * component's own body is what keeps that component's cognitive complexity
 * under the sonarjs budget (20) once the wizard grew five distinct step
 * screens (two for Step 1 alone: provider list + drilled-in model list).
 *
 * WizardBody is the only export other files need — it fully hides the
 * loading/error/ready branching each async-backed screen (model-provider,
 * model-detail) requires.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { CARD_GUTTER_WIDTH, CARD_PAD_GUTTER } from '../../theme.js'
import type { Palette } from '../../theme.js'
import { ListStep, type ListRow } from './ListStep.js'
import { NameStep } from './NameStep.js'
import { ConfirmStep } from './ConfirmStep.js'
import { STEP_MODEL_PROVIDER, MODE_KEYS } from '../../wizardStepMachine.js'
import type { AsyncSlot, ProviderGroup, WizardState } from '../../wizardTypes.js'

/** Build the provider-list rows for Step 1's first screen. */
function buildProviderRows(groups: ProviderGroup[], palette: Palette): ListRow[] {
  return groups.map((group) => ({
    key: group.providerId,
    label: group.providerLabel,
    color: palette.agentColors[group.providerId] ?? palette.modelText
  }))
}

/** Build the model-list rows for Step 1's drilled-in screen. Unavailable
 *  models are dimmed and marked, per the task brief — never omitted, since
 *  seeing WHY a model can't be picked is more useful than a shorter list. */
function buildModelRows(group: ProviderGroup, palette: Palette): ListRow[] {
  return group.models.map((model) => ({
    key: model.id,
    label: model.label,
    color: palette.agentColors[group.providerId] ?? palette.modelText,
    disabled: !model.available,
    suffix: model.available ? '' : ' (unavailable)'
  }))
}

const MODE_ROWS: ListRow[] = MODE_KEYS.map((mode) => ({ key: mode, label: mode }))

function LoadingScreen({ palette, text }: { palette: Palette; text: string }): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER}>
      <Text color={palette.secondary}>{text}</Text>
    </Box>
  )
}

function ErrorScreen({
  palette,
  message,
  hint
}: {
  palette: Palette
  message: string
  hint: string
}): React.JSX.Element {
  return (
    <Box flexDirection="column" flexGrow={1} paddingLeft={CARD_GUTTER_WIDTH + CARD_PAD_GUTTER}>
      <Text color={palette.attention} wrap="truncate-end">
        {message}
      </Text>
      <Box flexGrow={1} />
      <Text color={palette.secondary}>{hint}</Text>
    </Box>
  )
}

function ModelProviderScreen({
  models,
  providerIndex,
  width,
  palette
}: {
  models: AsyncSlot<ProviderGroup[]>
  providerIndex: number
  width: number
  palette: Palette
}): React.JSX.Element {
  if (models.kind === 'loading') {
    return <LoadingScreen palette={palette} text="loading models…" />
  }
  if (models.kind === 'error') {
    return <ErrorScreen palette={palette} message={models.message} hint="esc cancel" />
  }
  return (
    <ListStep
      title="Model"
      rows={buildProviderRows(models.value, palette)}
      highlightedIndex={providerIndex}
      width={width}
      palette={palette}
      hint="enter select   esc cancel"
    />
  )
}

function ModelDetailScreen({
  models,
  providerIndex,
  modelIndex,
  width,
  palette
}: {
  models: AsyncSlot<ProviderGroup[]>
  providerIndex: number
  modelIndex: number
  width: number
  palette: Palette
}): React.JSX.Element {
  // Can't reach 'model-detail' without a ready list (see
  // wizardStepMachine.ts's handleModelStepKey — enter only transitions here
  // when groups.length > 0), but keep the defensive branches so a future
  // refactor can't silently crash this render.
  if (models.kind !== 'ready') {
    return <LoadingScreen palette={palette} text="loading models…" />
  }
  const group = models.value[providerIndex]
  return (
    <ListStep
      title={group?.providerLabel ?? 'Model'}
      rows={group != null ? buildModelRows(group, palette) : []}
      highlightedIndex={modelIndex}
      width={width}
      palette={palette}
      hint="enter select   esc back"
    />
  )
}

export interface WizardBodyProps {
  state: WizardState
  width: number
  palette: Palette
}

/**
 * Step-to-screen dispatch. NewWorkspaceWizard.tsx renders only this
 * component for its body; every step-specific concern (which async slot is
 * ready, which list to render, what the confirm summary says) lives here or
 * in the screen components above it.
 */
export function WizardBody({ state, width, palette }: WizardBodyProps): React.JSX.Element {
  if (state.step === STEP_MODEL_PROVIDER) {
    return (
      <ModelProviderScreen
        models={state.models}
        width={width}
        palette={palette}
        providerIndex={state.providerIndex}
      />
    )
  }
  if (state.step === 'model-detail') {
    return (
      <ModelDetailScreen
        models={state.models}
        providerIndex={state.providerIndex}
        modelIndex={state.modelIndex}
        width={width}
        palette={palette}
      />
    )
  }
  if (state.step === 'name') {
    return <NameStep name={state.name} namePos={state.namePos} width={width} palette={palette} />
  }
  if (state.step === 'mode') {
    return (
      <ListStep
        title="Mode"
        rows={MODE_ROWS}
        highlightedIndex={state.modeIndex}
        width={width}
        palette={palette}
        hint="enter select   esc back"
      />
    )
  }
  return (
    <ConfirmStep
      selectedModel={state.selectedModel}
      name={state.name}
      mode={state.mode ?? 'local'}
      submitting={state.submitting}
      submitError={state.submitError}
      width={width}
      palette={palette}
    />
  )
}
