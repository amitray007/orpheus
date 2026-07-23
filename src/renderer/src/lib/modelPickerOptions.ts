// ---------------------------------------------------------------------------
// modelPickerOptions — turns the server-assembled SelectableModel[] (from
// useSelectableModels/models:listSelectable) into the flat
// {value,label}[] shape the Select primitive renders, grouped by provider
// with a divider row between groups (mirrors the existing MODEL_SEP pattern
// WorkspaceDrawer/SettingsDrawer/ModelPicker already used for Claude's
// versioned-vs-aliases split, now generalized to Claude-vs-each-routed-
// provider). Also builds the DropdownChip-flavored ChipDropdownItem[] shape
// (which supports a real `sublabel` instead of a synthetic separator row).
//
// The renderer must not compute model FACTS here (label/context/availability
// are already resolved server-side) — this module only reshapes an
// already-resolved list for two different picker widgets, and appends the
// 'Custom…' escape hatch (unit 01) shared by every picker.
// ---------------------------------------------------------------------------

import type { ChipDropdownGroup, ChipDropdownItem, SelectableModel } from '@shared/types'

export const MODEL_SEP_PREFIX = '__sep_'
export const MODEL_CUSTOM_VALUE = 'custom'

export interface SelectOption {
  value: string
  label: string
}

/** Group models by providerId, preserving the server's own ordering within
 *  each group (Claude first, by construction of models:listSelectable). */
function groupByProvider(models: SelectableModel[]): Map<string, SelectableModel[]> {
  const groups = new Map<string, SelectableModel[]>()
  for (const m of models) {
    const list = groups.get(m.providerId)
    if (list) list.push(m)
    else groups.set(m.providerId, [m])
  }
  return groups
}

/** Exported so the creation popover (NewWorkspaceMenu.tsx) can render the
 *  same "(unavailable)" suffix convention for its model rows without
 *  duplicating this formatting rule. */
export function labelFor(m: SelectableModel): string {
  return m.available ? m.label : `${m.label} (unavailable)`
}

/**
 * Build the flat, divider-separated option list for the `Select` primitive.
 * `leading` is an optional first entry (e.g. { value: 'default', label:
 * 'Default' } / 'Use global') that isn't part of any provider group.
 */
export function buildModelSelectOptions(
  models: SelectableModel[],
  leading?: SelectOption
): SelectOption[] {
  const groups = groupByProvider(models)
  const options: SelectOption[] = leading ? [leading] : []
  let sepIndex = 0
  for (const [providerId, group] of groups) {
    if (options.length > (leading ? 1 : 0)) {
      options.push({
        value: `${MODEL_SEP_PREFIX}${sepIndex++}`,
        label: group[0]?.providerLabel ?? providerId
      })
    }
    for (const m of group) {
      options.push({ value: m.id, label: labelFor(m) })
    }
  }
  options.push({ value: MODEL_CUSTOM_VALUE, label: 'Custom…' })
  return options
}

/** Build the DropdownChip-flavored item list — one row per model, with the
 *  provider name as `sublabel` (DropdownChip's popover renders a real
 *  sublabel, so no synthetic separator row is needed there, unlike Select). */
export function buildModelDropdownItems(models: SelectableModel[]): ChipDropdownItem[] {
  return models.map((m) => ({
    value: m.id,
    label: labelFor(m),
    sublabel: m.providerLabel,
    providerId: m.providerId
  }))
}

/**
 * Build the footer Model chip's provider -> model FLYOUT groups (the
 * ChipGroupedDropdown overlay kind's data source). Unlike
 * creationProviderMenu.ts's groupModelsForCreation, this groups EVERY
 * provider the server returned — the footer chip is the general-purpose
 * model switcher for an already-running workspace and must keep offering
 * whatever a workspace could already be routed to, not the curated
 * creation-time subset. Group order is first-seen order from
 * `models` (server's own ordering, Claude first by construction of
 * buildSelectableModels); labels come straight from providerLabel, never a
 * second hardcoded short-label table like the creation menu's
 * SHORT_PROVIDER_LABEL — this surface reuses the SAME canonical label the
 * flat dropdown's sublabel already showed, so switching to the grouped view
 * doesn't rename any provider the user already recognizes.
 */
export function buildModelDropdownGroups(models: SelectableModel[]): ChipDropdownGroup[] {
  const order: string[] = []
  const byProvider = new Map<string, SelectableModel[]>()
  for (const m of models) {
    let list = byProvider.get(m.providerId)
    if (!list) {
      list = []
      byProvider.set(m.providerId, list)
      order.push(m.providerId)
    }
    list.push(m)
  }
  return order.map((providerId) => {
    const group = byProvider.get(providerId)!
    return {
      providerId,
      label: group[0]?.providerLabel ?? providerId,
      models: buildModelDropdownItems(group)
    }
  })
}
