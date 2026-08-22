// ---------------------------------------------------------------------------
// modelPickerOptions — turns the server-assembled SelectableModel[] (from
// useSelectableModels/models:listSelectable) into the flat
// {value,label}[] shape the Select primitive renders. Also builds the
// DropdownChip-flavored ChipDropdownItem[] shape (which supports a real
// `sublabel` instead of a synthetic separator row).
//
// FLAT, NOT GROUPED BY PROVIDER (support-multi-harness, model/effort picker
// harness-scoping unit). This used to group by providerId with a divider
// row between groups (Claude-vs-each-routed-provider). Two things changed
// that: (1) a workspace's catalog now comes from ITS OWN harness only
// (selectable.ts's harnessEntries/claudeEntries split) — never more than
// one provider's models at a time while routing stays severed (Phase 0,
// selectable.ts's PHASE0_ROUTING_SEVERED), so a "group" was already
// degenerate; (2) the user curates/reorders this exact list by drag
// (curatedOptions.order, HarnessSection.tsx) specifically because they want
// THEIR chosen order to be the picker's order — imposing provider grouping
// on top would silently re-sort a list the user deliberately arranged.
// Server order (curated order) is preserved as-is; no client-side re-sort.
//
// The renderer must not compute model FACTS here (label/context/availability
// are already resolved server-side) — this module only reshapes an
// already-resolved list for two different picker widgets, and appends the
// 'Custom…' escape hatch (unit 01) shared by every picker.
// ---------------------------------------------------------------------------

import type { ChipDropdownItem, SelectableModel } from '@shared/types'

export const MODEL_CUSTOM_VALUE = 'custom'

export interface SelectOption {
  value: string
  label: string
}

/** Exported so the creation popover (NewWorkspaceMenu.tsx) can render the
 *  same "(unavailable)" suffix convention for its model rows without
 *  duplicating this formatting rule. */
export function labelFor(m: SelectableModel): string {
  return m.available ? m.label : `${m.label} (unavailable)`
}

/**
 * Build the flat option list for the `Select` primitive, in the server's
 * own order (the workspace's harness-curated order — see this file's
 * header for why no provider grouping is imposed on top). `leading` is an
 * optional first entry (e.g. { value: 'default', label: 'Use global' }).
 */
export function buildModelSelectOptions(
  models: SelectableModel[],
  leading?: SelectOption
): SelectOption[] {
  const options: SelectOption[] = leading ? [leading] : []
  for (const m of models) {
    options.push({ value: m.id, label: labelFor(m) })
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
    // The ICON id, not the harness id. A harness-sourced model's providerId
    // is its HARNESS id ('codex-cli'), which ProviderIcon does not know — so
    // rows rendered no icon for Codex. Only what the icon component receives
    // changes here. See SelectableModel.providerIconId.
    providerId: m.providerIconId ?? m.providerId
  }))
}
