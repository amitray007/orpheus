/**
 * tui/components/wizard/WizardScreens.tsx — step-to-screen dispatch for
 * NewWorkspaceWizard.tsx, split out for the same reason PickerBody is its
 * own extraction in App.tsx: keeping this branching out of the top-level
 * component's own body is what keeps that component's cognitive complexity
 * under the sonarjs budget (20).
 *
 * Step 1 used to be two distinct screens (a provider list drilling into a
 * per-provider model list); it's now ONE accordion screen — see
 * wizardTypes.ts's STEP MODEL section for why, and
 * `buildModelAccordionListRows` below for how the two-level hierarchy is
 * flattened into the single row list ListStep.tsx renders.
 * (A separate name-entry screen also existed here and was deliberately
 * removed — see wizardTypes.ts's header for why.)
 *
 * A NOTE ON WHY THE ROW-BUILDING LOGIC LIVES HERE, NOT IN ListStep.tsx OR
 * wizardStepMachine.ts: `buildModelAccordionRows` (wizardStepMachine.ts)
 * only knows about providers/models/expansion — it stays react/ink-free.
 * `ListRow` (ListStep.tsx) only knows about generic row content (label,
 * colour, indent, trailing marker) — it stays provider-agnostic. This file
 * is the translation layer between the two, same role
 * `groupModelsByProvider` plays for the raw `models.list` response.
 *
 * WizardBody is the only export other files need — it fully hides the
 * loading/error/ready branching each async-backed screen (the model
 * accordion) requires.
 */

import * as React from 'react'
import { Box, Text } from 'ink'
import { CARD_GUTTER_WIDTH, CARD_PAD_GUTTER } from '../../theme.js'
import type { Palette } from '../../theme.js'
import { ListStep, type ListRow } from './ListStep.js'
import { ConfirmStep } from './ConfirmStep.js'
import { STEP_MODEL, MODE_KEYS, buildModelAccordionRows } from '../../wizardStepMachine.js'
import type { AsyncSlot, ProviderGroup, WizardState } from '../../wizardTypes.js'

/** Collapsed-provider trailing marker: model count, right-padded from the
 *  `>` glyph by one space so it doesn't read as glued to the count digit.
 *  Both `>` and `v` are plain ASCII (East_Asian_Width=Na, Narrow) — safe
 *  inside a padded row text at any terminal's East Asian width setting; see
 *  this package's house rule against Ambiguous-width glyphs like `▸`/`▾` in
 *  that same position (theme.ts's header). */
function providerTrailingMarker(modelCount: number, expanded: boolean): string {
  return ` ${modelCount}  ${expanded ? 'v' : '>'}`
}

/**
 * Flatten the accordion's provider groups + expansion state into ListStep's
 * generic `ListRow` shape — the one place that knows providers get a colour
 * + trailing count/marker and models get an indent + the "(unavailable)"
 * suffix. NOT exported (react-refresh/only-export-components forbids a
 * component file exporting a plain function alongside its components) —
 * scripts/verify-tui-wizard.ts instead asserts the accordion's row-count
 * behaviour directly against `buildModelAccordionRows`
 * (wizardStepMachine.ts), which is the react/ink-free layer this function
 * only adds cosmetic ListRow fields on top of.
 */
function buildModelAccordionListRows(
  groups: ProviderGroup[],
  expandedProviderId: string | null,
  palette: Palette
): ListRow[] {
  return buildModelAccordionRows(groups, expandedProviderId).map((row) => {
    if (row.kind === 'provider') {
      return {
        key: row.group.providerId,
        label: row.group.providerLabel,
        color: palette.agentColors[row.group.providerId] ?? palette.modelText,
        trailingMarker: providerTrailingMarker(row.group.models.length, row.expanded)
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

function ModelAccordionScreen({
  models,
  expandedProviderId,
  cursor,
  width,
  availableRows,
  palette
}: {
  models: AsyncSlot<ProviderGroup[]>
  expandedProviderId: string | null
  cursor: number
  width: number
  availableRows: number
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
      rows={buildModelAccordionListRows(models.value, expandedProviderId, palette)}
      highlightedIndex={cursor}
      width={width}
      availableRows={availableRows}
      palette={palette}
      hint="enter select   esc cancel"
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
 * ready, which list to render, what the confirm summary says) lives here or
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
      <ModelAccordionScreen
        models={state.models}
        expandedProviderId={state.expandedProviderId}
        cursor={state.cursor}
        width={width}
        availableRows={availableRows}
        palette={palette}
      />
    )
  }
  if (state.step === 'mode') {
    return (
      <ListStep
        title="Mode"
        rows={MODE_ROWS}
        highlightedIndex={state.modeIndex}
        width={width}
        availableRows={availableRows}
        palette={palette}
        hint="enter select   esc back"
      />
    )
  }
  return (
    <ConfirmStep
      selectedModel={state.selectedModel}
      mode={state.mode ?? 'local'}
      submitting={state.submitting}
      submitError={state.submitError}
      width={width}
      palette={palette}
    />
  )
}
