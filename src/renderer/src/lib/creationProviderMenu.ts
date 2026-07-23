// ---------------------------------------------------------------------------
// src/renderer/src/lib/creationProviderMenu.ts
//
// Pure helpers backing the workspace-creation popover's two-level
// provider -> model swap (NewWorkspaceMenu.tsx). Kept free of React/Electron
// so scripts/verify-creation-provider-menu.ts can exercise every decision
// offline, mirroring the existing pattern (selectable.ts / modelRouting.ts /
// modelPickerOptions.ts).
//
// Group derivation reuses the SAME data every other picker already reads
// (SelectableModel.providerId/providerLabel/isClaude from
// models:listSelectable) — this module does not invent a new provider
// matcher; it only groups/orders/filters the server-provided list for the
// creation popover's specific display rules:
//
//   - Claude is its own group (present even when the proxy is fully down —
//     the offline guarantee already lives in buildSelectableModels; this
//     module just doesn't second-guess it).
//   - Routed groups appear in the SAME order selectable.ts emits them
//     (cliProxyModels insertion order, which mirrors registry.ts's PROVIDERS
//     array order: codex, xai, antigravity).
//   - Ollama is deliberately excluded from the creation menu (per the
//     approved design — Claude/OpenAI/Grok/Antigravity only), even though
//     registry.ts still declares it for the routing-proxy/Settings surfaces.
//     This is a creation-menu-only display filter, not a registry change —
//     an existing ollama connection/config is untouched.
// ---------------------------------------------------------------------------

import type { SelectableModel } from '@shared/types'

/** Provider ids the creation popover ever offers as a top-level group.
 *  'ollama' is deliberately absent — see this module's header comment. */
export type CreationProviderId = 'claude' | 'codex' | 'xai' | 'antigravity'

const CREATION_PROVIDER_IDS: readonly CreationProviderId[] = [
  'claude',
  'codex',
  'xai',
  'antigravity'
]

function isCreationProviderId(id: string): id is CreationProviderId {
  return (CREATION_PROVIDER_IDS as readonly string[]).includes(id)
}

/** Short, human-facing group label for the creation popover/sidebar prefix —
 *  DISPLAY ONLY. The underlying provider id ('codex') and the Settings-UI
 *  canonical label (registry.ts's 'Codex (OpenAI)', still used everywhere
 *  else — Settings connect cards, the footer model chip's sublabel, the
 *  Aliases picker) are both untouched; this is a presentational rename
 *  scoped to these two new surfaces only, not a model/provider fact. */
const SHORT_PROVIDER_LABEL: Record<CreationProviderId, string> = {
  claude: 'Claude',
  codex: 'OpenAI',
  xai: 'Grok',
  antigravity: 'Antigravity'
}

export function shortProviderLabel(providerId: string): string {
  return isCreationProviderId(providerId) ? SHORT_PROVIDER_LABEL[providerId] : providerId
}

export interface CreationProviderGroup {
  providerId: CreationProviderId
  label: string
  models: SelectableModel[]
}

/**
 * Group the server-provided selectable-model list into the creation
 * popover's provider rows, in first-seen order (Claude first by
 * construction of buildSelectableModels), EXCLUDING ollama (and any other
 * provider id outside CREATION_PROVIDER_IDS) entirely — never partially
 * shown, never an empty group.
 */
export function groupModelsForCreation(models: SelectableModel[]): CreationProviderGroup[] {
  const order: CreationProviderId[] = []
  const byProvider = new Map<CreationProviderId, SelectableModel[]>()
  for (const m of models) {
    if (!isCreationProviderId(m.providerId)) continue
    let list = byProvider.get(m.providerId)
    if (!list) {
      list = []
      byProvider.set(m.providerId, list)
      order.push(m.providerId)
    }
    list.push(m)
  }
  return order.map((providerId) => ({
    providerId,
    label: shortProviderLabel(providerId),
    models: byProvider.get(providerId)!
  }))
}

// ---------------------------------------------------------------------------
// Per-provider "last used" selection — session-scoped (in-memory), not
// persisted to the DB. Picking a provider pre-selects ITS OWN last-used
// model (marked with a leading dot in the UI); the overall last-used
// (whichever model was picked most recently, any provider) decides which
// provider/model the popover opens on. Both are plain pure-data decisions
// here so they're assertable without React.
// ---------------------------------------------------------------------------

export interface CreationLastUsedState {
  /** The single most-recently-picked model overall, across every provider —
   *  what the popover's top line + initial view should reflect on open. */
  overall: { providerId: string; modelId: string } | null
  /** Each provider's own most-recently-picked model, independent of what's
   *  currently "overall". */
  byProvider: Map<string, string>
}

export function emptyCreationLastUsedState(): CreationLastUsedState {
  return { overall: null, byProvider: new Map() }
}

/** Record a pick — returns a NEW state (never mutates the input), so a
 *  React store can treat this as an immutable reducer step. */
export function recordCreationPick(
  state: CreationLastUsedState,
  providerId: string,
  modelId: string
): CreationLastUsedState {
  const byProvider = new Map(state.byProvider)
  byProvider.set(providerId, modelId)
  return { overall: { providerId, modelId }, byProvider }
}

/** The model id a provider's row should pre-select when the popover swaps
 *  into that provider's model list (marked `●` in the UI) — that provider's
 *  own last-used pick if one exists and is still present in `models`,
 *  otherwise the first model in the group (server's own ordering). */
export function lastUsedModelForProvider(
  state: CreationLastUsedState,
  providerId: string,
  models: SelectableModel[]
): string | null {
  const remembered = state.byProvider.get(providerId)
  if (remembered && models.some((m) => m.id === remembered)) return remembered
  return models[0]?.id ?? null
}

/** Which provider group the popover should open into — the overall
 *  last-used provider if it's still present among `groups`, otherwise
 *  'claude' (always present — the offline guarantee) as the safe default. */
export function initialCreationProviderId(
  state: CreationLastUsedState,
  groups: CreationProviderGroup[]
): CreationProviderId {
  const overallProviderId = state.overall?.providerId
  if (overallProviderId && isCreationProviderId(overallProviderId)) {
    if (groups.some((g) => g.providerId === overallProviderId)) return overallProviderId
  }
  return 'claude'
}
