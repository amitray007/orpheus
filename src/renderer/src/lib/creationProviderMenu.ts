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
  return order.map((providerId) => {
    const groupModels = byProvider.get(providerId)!
    // Claude's group is NEVER re-sorted — it must keep the exact hand-curated
    // CLAUDE_MODEL_OPTIONS order (aliases-first) it arrives in. Every OTHER
    // (routed) provider's models arrive in whatever order the routing proxy
    // happened to return them, which reads as arbitrary/jumbled in the UI —
    // sort those into the deterministic family+version order below. Gate on
    // providerId !== 'claude' (equivalent to `!isClaude` on the member
    // models — 'claude' is the one CreationProviderId whose group is 100%
    // isClaude by construction) so this can never touch Claude.
    const sorted =
      providerId === 'claude'
        ? groupModels
        : [...groupModels].sort((x, y) => compareRoutedModelIds(x.id, y.id))
    return {
      providerId,
      label: shortProviderLabel(providerId),
      models: sorted
    }
  })
}

// ---------------------------------------------------------------------------
// Routed (non-Claude) model ordering.
//
// The routing proxy returns each provider's models in an arbitrary order
// (whatever its upstream API happens to emit) — e.g. Grok comes back as
// `grok-build-0.1, grok-4.5, grok-4.3, grok-4.20-..., grok-3-mini, ...`, which
// reads as jumbled in the picker. This is NOT an attempt to detect the
// "true latest" model — that's unknowable from an id string alone. It is a
// deterministic, explainable SORT so the list is scannable:
//
//   1. Split the id into a family STEM (the leading non-numeric run, e.g.
//      "grok", "grok-imagine", "gpt") and a numeric VERSION tail.
//   2. Group by stem, stems ordered alphabetically — same-family models
//      cluster together instead of scattering through the list.
//   3. Within a stem, sort by version DESCENDING, comparing each dot-
//      separated numeric component in turn (major, then minor, then patch,
//      ...) — e.g. for "grok-4.20" vs "grok-4.5" vs "grok-4.3": all share
//      major=4, so it falls to minor: 20 > 5 > 3, giving 4.20, 4.5, 4.3.
//      This is a plain numeric compare (20 is NOT less than 5), not a
//      string compare — the rule is intentionally simple: major desc, then
//      minor desc, then next component desc, and so on. No attempt is made
//      to guess whether a dated build like "4.20-0309" is "newer" than a
//      dotted release like "4.5" in a product sense.
//   4. Anything left over (equal version numbers, or either id has no
//      parseable version at all) falls back to a plain localeCompare on the
//      FULL id, so the order is always total, deterministic, and stable
//      across runs.
// ---------------------------------------------------------------------------

/** A model id split into its alphabetic family stem and numeric version
 *  components, e.g. "grok-4.20-0309-reasoning" -> stem "grok-", version
 *  [4, 20, 0309]. The stem retains its trailing separator so "grok-" and
 *  "grok-imagine-" sort as distinct families rather than colliding. */
interface ParsedModelId {
  stem: string
  version: number[]
}

/** Extract the leading family stem (non-numeric run) and the dot/dash
 *  -separated numeric version that follows it. Numeric-looking path segments
 *  embedded deeper in the id (e.g. a trailing "-2.5-" in
 *  "grok-composer-2.5-fast") are treated as part of the version once the
 *  first digit is hit — everything before the first digit is the stem. */
function parseFamilyAndVersion(id: string): ParsedModelId {
  const firstDigitIndex = id.search(/\d/)
  if (firstDigitIndex === -1) {
    return { stem: id, version: [] }
  }
  const stem = id.slice(0, firstDigitIndex)
  // Pull every run of digits after the stem, in order, as the version
  // vector — covers "4.20", "4-20", "2.5-fast" (stops naturally at "fast"
  // since it has no more digit runs to contribute).
  const versionMatches = id.slice(firstDigitIndex).match(/\d+/g)
  const version = versionMatches ? versionMatches.map(Number) : []
  return { stem, version }
}

/** Compare two numeric version vectors component-by-component, DESCENDING
 *  (higher version first). A shorter vector is treated as having trailing
 *  zeros (so [4] == [4, 0] for comparison purposes) — only an actual digit
 *  difference breaks the tie; equal vectors return 0 and fall through to the
 *  caller's tiebreak. */
function compareVersionsDescending(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Total, deterministic order for a single routed provider's model ids. See
 * the block comment above for the full contract: family stem alphabetical,
 * then version numeric-descending, then a full-id localeCompare tiebreak so
 * two calls over the same input always produce the identical order.
 */
export function compareRoutedModelIds(a: string, b: string): number {
  const parsedA = parseFamilyAndVersion(a)
  const parsedB = parseFamilyAndVersion(b)
  if (parsedA.stem !== parsedB.stem) {
    return parsedA.stem.localeCompare(parsedB.stem)
  }
  const versionDiff = compareVersionsDescending(parsedA.version, parsedB.version)
  if (versionDiff !== 0) return versionDiff
  return a.localeCompare(b)
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
