/**
 * tui/components/wizard/WizardScreens.tsx — step-to-screen dispatch for
 * NewWorkspaceWizard.tsx, split out for the same reason PickerBody is its
 * own extraction in App.tsx: keeping this branching out of the top-level
 * component's own body is what keeps that component's cognitive complexity
 * under the sonarjs budget (20).
 *
 * Step 1 is a single screen listing EVERY provider's models, always fully
 * expanded — see wizardTypes.ts's STEP MODEL section and
 * `buildModelListRows` (wizardStepMachine.ts) for why the old accordion
 * (one provider expanded at a time, toggled via enter) was replaced: cutting
 * the expand/collapse keystroke entirely. Provider headers still render (as
 * group labels, in their `palette.agentColors` hue) but are not part of the
 * cursor's walk — see `buildModelListRows` below for how they're marked
 * non-interactive.
 *
 * There is no more confirm/create screen. Selecting a mode (or, when Step 2
 * is auto-skipped, selecting a model) creates immediately — see
 * NewWorkspaceWizard.tsx's `submit`. The submit lifecycle that used to live
 * on that dedicated screen (submitting/error/retry) is rendered here inline,
 * under whichever step is currently on screen, via `SubmitStatusLine`.
 *
 * A NOTE ON WHY THE ROW-BUILDING LOGIC LIVES HERE, NOT IN ListStep.tsx OR
 * wizardStepMachine.ts: `buildModelListRows` (wizardStepMachine.ts) only
 * knows about providers/models — it stays react/ink-free. `ListRow`
 * (ListStep.tsx) only knows about generic row content (label, colour,
 * indent, selectability) — it stays provider-agnostic. This file is the
 * translation layer between the two, same role `groupModelsByProvider`
 * plays for the raw `models.list` response.
 *
 * WizardBody is the only export other files need — it fully hides the
 * loading/error/ready branching each async-backed screen (the model list)
 * requires.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { CARD_GUTTER_WIDTH, CARD_PAD_GUTTER } from '../../theme.js'
import type { Palette } from '../../theme.js'
import { ListStep, type ListRow } from './ListStep.js'
import { STEP_MODEL, MODE_KEYS, buildModelListRows } from '../../wizardStepMachine.js'
import type { AsyncSlot, ProviderGroup, WizardState } from '../../wizardTypes.js'

/**
 * Flatten the provider groups into ListStep's generic `ListRow` shape — the
 * one place that knows providers get a colour (and no cursor stop: `kind:
 * 'provider'` rows carry no `key` collision risk with models since provider
 * ids and model ids live in disjoint namespaces, but more importantly are
 * simply never pointed at by `highlightedIndex`, which
 * NewWorkspaceWizard.tsx/wizardStepMachine.ts's `moveModelCursor` guarantees
 * by construction) and models get an indent + the "(unavailable)" suffix.
 * NOT exported (react-refresh/only-export-components forbids a component
 * file exporting a plain function alongside its components) —
 * scripts/verify-tui-wizard.ts instead asserts the row-building behaviour
 * directly against `buildModelListRows` (wizardStepMachine.ts), which is the
 * react/ink-free layer this function only adds cosmetic ListRow fields on
 * top of.
 */
function buildModelListListRows(groups: ProviderGroup[], palette: Palette): ListRow[] {
  return buildModelListRows(groups).map((row) => {
    if (row.kind === 'provider') {
      return {
        key: row.group.providerId,
        label: row.group.providerLabel,
        color: palette.agentColors[row.group.providerId] ?? palette.modelText,
        groupHeader: true
      }
    }
    return {
      key: row.model.id,
      label: row.model.label,
      color: palette.agentColors[row.providerId] ?? palette.modelText,
      disabled: !row.model.available,
      suffix: row.model.available ? '' : ' (unavailable)',
      indent: 1
    }
  })
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

/**
 * The submit lifecycle ConfirmStep.tsx used to own exclusively — now
 * rendered inline under whichever step is last for a given project (the
 * mode screen normally, or the model screen when Step 2 is auto-skipped and
 * a create fails — see NewWorkspaceWizard.tsx's `submit`'s `autoSkipped`
 * handling for why a failure there routes back to the model step rather
 * than stranding the user on a two-option mode picker their project doesn't
 * actually offer). Renders nothing (not even a blank line) in the idle case
 * so it costs zero rows on every other screen.
 */
function SubmitStatusLine({
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

function ModelListScreen({
  models,
  cursor,
  width,
  availableRows,
  palette,
  submitting,
  submitError
}: {
  models: AsyncSlot<ProviderGroup[]>
  cursor: number
  width: number
  availableRows: number
  palette: Palette
  submitting: boolean
  submitError: string | null
}): React.JSX.Element {
  if (models.kind === 'loading') {
    return <LoadingScreen palette={palette} text="loading models…" />
  }
  if (models.kind === 'error') {
    return <ErrorScreen palette={palette} message={models.message} hint="esc cancel" />
  }
  const statusLine = (
    <SubmitStatusLine submitting={submitting} submitError={submitError} palette={palette} />
  )
  return (
    <ListStep
      title="Model"
      rows={buildModelListListRows(models.value, palette)}
      highlightedIndex={cursor}
      width={width}
      availableRows={availableRows}
      palette={palette}
      hint={submitError != null ? 'enter retry   esc cancel' : 'enter select   esc cancel'}
      statusLine={submitting || submitError != null ? statusLine : undefined}
    />
  )
}

function ModeScreen({
  modeIndex,
  width,
  availableRows,
  palette,
  submitting,
  submitError
}: {
  modeIndex: number
  width: number
  availableRows: number
  palette: Palette
  submitting: boolean
  submitError: string | null
}): React.JSX.Element {
  const statusLine = (
    <SubmitStatusLine submitting={submitting} submitError={submitError} palette={palette} />
  )
  return (
    <ListStep
      title="Mode"
      rows={MODE_ROWS}
      highlightedIndex={modeIndex}
      width={width}
      availableRows={availableRows}
      palette={palette}
      hint={submitError != null ? 'enter retry   esc back' : 'enter select   esc back'}
      statusLine={submitting || submitError != null ? statusLine : undefined}
    />
  )
}

export interface WizardBodyProps {
  state: WizardState
  width: number
  availableRows: number
  palette: Palette
}

/**
 * Step-to-screen dispatch. NewWorkspaceWizard.tsx renders only this
 * component for its body; every step-specific concern (which async slot is
 * ready, which list to render, whether a create is in flight) lives here or
 * in the screen components above it.
 */
export function WizardBody({
  state,
  width,
  availableRows,
  palette
}: WizardBodyProps): React.JSX.Element {
  if (state.step === STEP_MODEL) {
    return (
      <ModelListScreen
        models={state.models}
        cursor={state.cursor}
        width={width}
        availableRows={availableRows}
        palette={palette}
        submitting={state.submitting}
        submitError={state.submitError}
      />
    )
  }
  return (
    <ModeScreen
      modeIndex={state.modeIndex}
      width={width}
      availableRows={availableRows}
      palette={palette}
      submitting={state.submitting}
      submitError={state.submitError}
    />
  )
}
