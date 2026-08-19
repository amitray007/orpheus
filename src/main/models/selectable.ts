// ---------------------------------------------------------------------------
// src/main/models/selectable.ts — assembles the single selectable-model list
// a workspace/project picker renders from (model-routing unit 06, part A).
//
// This is the ONE place "what models can a workspace pick from right now?"
// is decided. Two groups:
//
//   1. The BASE catalog for the workspace's own harness. For Claude — ALWAYS
//      present, ALWAYS first, unconditionally `available`. This is the
//      offline guarantee: even with the routing proxy fully disabled/
//      stopped/unreachable, Claude must still be a full, selectable list
//      (see verify-model-picker.ts assertion 1). Sourced from
//      CLAUDE_MODEL_OPTIONS (src/shared/types.ts) — the same enumerable list
//      every existing picker (WorkspaceDrawer/SettingsDrawer/DropdownChip)
//      already renders from, now surfaced through IPC instead of imported
//      directly by renderer code (part B of this unit removes those direct
//      imports). (C3, support-multi-harness) For a NON-Claude harness, the
//      base catalog instead comes from that harness's OWN descriptor —
//      `descriptor.curated?.model?.options`, threaded in by the IPC layer as
//      `input.harnessModelOptions` — never CLAUDE_MODEL_OPTIONS. A harness
//      that declares no `curated.model` yields no models at all (an empty
//      list), never a Claude fallback and never a fabricated one — see
//      harnessEntries()'s own doc comment for exactly which SelectableModel
//      fields are real vs. deliberately left null for a non-Claude harness.
//
//   2. Routed — only offered when ALL of: the proxy is enabled AND running,
//      the owning provider account is connected AND healthy (cross-
//      referenced against the routing-proxy snapshot's authFiles by provider
//      id), AND the model is known to the cliproxy model source's cache
//      (i.e. CLIProxyAPI's own model-definitions endpoint reported it for
//      that provider channel). A model whose provider is disabled/
//      unhealthy/disconnected is simply omitted from the offered list...
//      UNLESS `currentModelId` names it, in which case it is still included
//      with `available: false` — a workspace's stored setting must never be
//      silently dropped from the picker just because its backend went
//      offline (see part A's "never lose the user's setting" requirement).
//      Dead code today (see PHASE0_ROUTING_SEVERED below) — group 1 above is
//      the whole picker until Phase 6.
//
//   2. Routed — only offered when ALL of: the proxy is enabled AND running,
//      the owning provider account is connected AND healthy (cross-
//      referenced against the routing-proxy snapshot's authFiles by provider
//      id), AND the model is known to the cliproxy model source's cache
//      (i.e. CLIProxyAPI's own model-definitions endpoint reported it for
//      that provider channel). A model whose provider is disabled/
//      unhealthy/disconnected is simply omitted from the offered list...
//      UNLESS `currentModelId` names it, in which case it is still included
//      with `available: false` — a workspace's stored setting must never be
//      silently dropped from the picker just because its backend went
//      offline (see part A's "never lose the user's setting" requirement).
//
// Deliberately electron-free/DB-free (mirrors modelRouting.ts's own
// constraint — see that module's header comment) so scripts/verify-model-
// picker.ts can exercise it directly without booting Electron or touching
// SQLite. All main-process-only state (routing-proxy snapshot, stored
// provider configs, the cliproxy model cache) is threaded in as plain
// parameters by the IPC handler (src/main/ipc/models.ts), never imported
// here directly.
// ---------------------------------------------------------------------------

import { CLAUDE_MODEL_OPTIONS, CLAUDE_BUILTIN_EFFORT_LEVELS } from '../../shared/types'
import type { SelectableModel, CuratedFieldOptionsOverlay } from '../../shared/types'
import { resolveCuratedOptions } from '../../shared/harness/curatedOptions'
import { bareClaudeIdFor, isClaudeModelId } from './sources/builtin'
import { listCliProxyModelCacheEntries } from './sources/cliproxy'

export const CLAUDE_PROVIDER_ID = 'claude'
const CLAUDE_PROVIDER_LABEL = 'Claude'

/** Phase 0 of the multi-harness migration severed launch-side CLIProxyAPI
 *  routing, so buildSelectableModels() below must return Claude-only. This
 *  is a `const` (not an inline `true` literal) deliberately: a bare
 *  `if (true) return` or unconditional `return` makes TypeScript stop
 *  flow-narrowing the dormant code that follows, turning its real
 *  `string | undefined` guards into spurious type errors — verified
 *  empirically. Routing through a named const keeps narrowing intact while
 *  still being unconditionally true. Phase 6 re-lands routing by deleting
 *  the `if (PHASE0_ROUTING_SEVERED) return claudeEntries()` guard (and,
 *  optionally, this const) in buildSelectableModels(). */
const PHASE0_ROUTING_SEVERED = true

/** Minimal shape of a routing-proxy snapshot this module needs — a subset of
 *  RoutingProxySnapshot, kept narrow so this stays a plain-data dependency
 *  rather than importing the electron-touching manager module. */
export interface RoutingProxyStatusInput {
  enabled: boolean
  status: string
  authFiles: Array<{ provider: string; health: 'ok' | 'error' | 'unknown' }>
}

/** Minimal shape of a stored provider config this module needs. */
export interface ProviderConfigInput {
  providerId: string
  enabled: boolean
}

/** Minimal shape of a provider descriptor this module needs (for the
 *  provider's display label when grouping routed models). */
export interface ProviderDescriptorInput {
  id: string
  label: string
}

/** One cliproxy-model-cache entry, as returned by
 *  listCliProxyModelCacheEntries() in sources/cliproxy.ts. */
export interface CliProxyCacheEntryInput {
  modelId: string
  providerId?: string
  context: number | null
  effortLevels?: string[] | null
}

/**
 * Resolve a model id's real effortLevels (or null when it has none) —
 * INDEPENDENT of proxy/provider health (unlike buildSelectableModels' output,
 * which is gated on live availability). This exists for the cross-model
 * effort reconciliation (model-routing unit 11, work item 4): reconciling a
 * workspace's stored effort against its NEW model needs to know that model's
 * ladder even if the model itself isn't currently "available" (e.g. the user
 * just switched to it and the proxy hasn't confirmed health yet) — facts,
 * not availability, are what the reconciliation needs.
 *
 * Claude ids (including date-stamped/aliased variants — see
 * bareClaudeIdFor's own doc comment) resolve via the hand-maintained
 * CLAUDE_BUILTIN_EFFORT_LEVELS table; every other id is looked up in the
 * cliproxy model cache. An id known to neither source returns null — never
 * fabricated.
 */
export function resolveEffortLevelsForModelId(
  modelId: string,
  cliProxyModels: CliProxyCacheEntryInput[]
): string[] | null {
  // Direct table hit covers BOTH explicit versioned ids (claude-opus-4-8)
  // AND always-latest aliases (opus/sonnet/haiku/fable) — bareClaudeIdFor
  // deliberately excludes aliases from its own resolution (see its doc
  // comment), so it must not be consulted first or an alias-pinned
  // workspace would wrongly resolve to "no effort control".
  const directHit =
    CLAUDE_BUILTIN_EFFORT_LEVELS[modelId as keyof typeof CLAUDE_BUILTIN_EFFORT_LEVELS]
  if (directHit) return directHit
  // Date-stamped variant (e.g. "claude-opus-4-7-20260416") -> its bare id.
  const bareClaudeId = bareClaudeIdFor(modelId)
  if (bareClaudeId) {
    return (
      CLAUDE_BUILTIN_EFFORT_LEVELS[bareClaudeId as keyof typeof CLAUDE_BUILTIN_EFFORT_LEVELS] ??
      null
    )
  }
  return cliProxyModels.find((m) => m.modelId === modelId)?.effortLevels ?? null
}

/**
 * Cheaply, synchronously resolve which provider owns `modelId` — used by
 * claudeSettings.ts's resolveEffectiveModelAndEffort (itself called on every
 * workspace, every ~1s tree-frame tick by commandServer.ts) to attribute a
 * workspace's effective model to a provider for the TUI card's agent label.
 * Safe to call at that frequency for the same reason
 * resolveEffortLevelsForModelId is: no I/O, no subprocess — Claude ids are a
 * pure in-memory table lookup, and routed ids are a lookup against
 * listCliProxyModelCacheEntries()'s already-populated, synchronous,
 * module-level cache (populated out-of-band by refreshCliProxyModelCache,
 * never fetched here).
 *
 * Returns `undefined` (never a fabricated placeholder like 'unknown') when
 * the model id is neither a recognized Claude id/alias nor present in the
 * cliproxy cache yet — e.g. a routed model the cache hasn't reported a
 * provider for. Callers must treat an undefined providerId as "no
 * attribution", not render a placeholder.
 */
export function resolveProviderIdForModel(modelId: string): string | undefined {
  if (
    CLAUDE_MODEL_OPTIONS.some((o) => o.value === modelId) ||
    isClaudeModelId(modelId) ||
    bareClaudeIdFor(modelId) != null
  ) {
    return CLAUDE_PROVIDER_ID
  }
  return listCliProxyModelCacheEntries().find((m) => m.modelId === modelId)?.providerId
}

export interface BuildSelectableModelsInput {
  routingProxy: RoutingProxyStatusInput
  providerConfigs: ProviderConfigInput[]
  providerDescriptors: ProviderDescriptorInput[]
  cliProxyModels: CliProxyCacheEntryInput[]
  /** The workspace's currently-selected model id, if any — an empty string
   *  or undefined means "no override / claude default", never treated as a
   *  routed id to preserve. */
  currentModelId?: string
  /** Provider ids that were reported healthy ('ok') as of the LAST
   *  successful live authFiles fetch, persisted across app launches
   *  (model-routing unit 09-polish — the startup-window race: on a cold
   *  boot the routing proxy is still 'starting' and authFiles is still
   *  empty, so without this the picker would show Claude-only for the
   *  first several seconds of every launch even for a provider that was
   *  definitely connected last session).
   *
   *  THIS IS A PRE-LIVE-DATA FALLBACK, NEVER A NEW SOURCE OF TRUTH — see
   *  persistedAvailabilityFor's own doc comment for the exact precedence
   *  rule that keeps it from ever lying once live data exists. Optional so
   *  every existing call site (including every verify-model-picker.ts
   *  assertion written before this field existed) keeps compiling/behaving
   *  identically when omitted — an absent/undefined set behaves exactly
   *  like an empty one (no persisted fallback offered). */
  persistedHealthyProviderIds?: Set<string>
  /** User curation of the Claude MODEL list (B4, support-multi-harness) —
   *  already-resolved HarnessSettings.curatedOptions.model for whichever
   *  (harnessId, projectId) scope the caller is asking on behalf of, or
   *  undefined for "no overlay" (no context available, or nothing stored).
   *  Deliberately a plain resolved overlay, NOT a harnessId/projectId pair
   *  this module would look up itself — selectable.ts must stay
   *  electron-free/DB-free (see this file's own header +
   *  scripts/verify-model-picker.ts, which exercises it fully offline); the
   *  IPC handler (src/main/ipc/models.ts) is where resolveHarnessSettings()
   *  actually runs, this module only applies the result via
   *  resolveCuratedOptions. Applied ONLY to the Claude group — routed
   *  models are dead code behind PHASE0_ROUTING_SEVERED, so there is
   *  nothing else to apply it to yet. */
  curatedModelOptions?: CuratedFieldOptionsOverlay
  /** User curation of the EFFORT ladder (B4) — same resolved-overlay
   *  contract as curatedModelOptions, applied per-model to that model's own
   *  CLAUDE_BUILTIN_EFFORT_LEVELS entry (never a single global ladder — a
   *  model with `null` effortLevels must stay `null`, not gain a fabricated
   *  list just because an overlay exists). `currentEffort` is threaded
   *  alongside so the hidden-but-selected invariant holds for effort too:
   *  a hidden level that is the workspace's ACTIVE effort must still
   *  resolve. */
  curatedEffortOptions?: CuratedFieldOptionsOverlay
  /** The workspace's currently-selected effort value, if any — passed
   *  through to resolveCuratedOptions as the selectedValue for the effort
   *  overlay, mirroring currentModelId's role for the model overlay. Never
   *  itself validated against a model's real levels here — this module
   *  only decides what to OFFER, not whether the current value is sane
   *  (see effortPickerOptions.ts's clampEffortToSupportedLevel for that,
   *  which this unit must not touch). */
  currentEffort?: string
  /** (C3, support-multi-harness) The BASE model list for the workspace's
   *  own harness, sourced from that harness's descriptor —
   *  `descriptor.curated?.model?.options` — resolved by the IPC layer
   *  (src/main/ipc/models.ts) and passed in as plain data, same contract as
   *  every other harness-derived field on this input (this module stays
   *  electron-free/DB-free; it never resolves a harness descriptor itself).
   *
   *  UNDEFINED means "resolve the Claude descriptor's own list" — i.e. the
   *  CLAUDE_MODEL_OPTIONS default — so every pre-C3 call site (which never
   *  set this field) keeps behaving byte-identically. This is NOT the same
   *  as an empty array: `[]` means a REAL harness that curates zero models
   *  (declares no `curated.model` at all) and must yield an empty list, not
   *  fall back to Claude's. The IPC layer is responsible for making that
   *  distinction (it passes `undefined` only for the Claude harness itself,
   *  and `[]` for a harness whose descriptor omits `curated.model`). */
  harnessModelOptions?: string[]
  /** (C3) True iff the resolved harness for this call IS the Claude
   *  descriptor. Threaded in (rather than re-derived from
   *  harnessModelOptions' shape) so the Claude-specific per-model
   *  metadata — providerId/providerLabel/isClaude/effortLevels sourced from
   *  CLAUDE_BUILTIN_EFFORT_LEVELS — is only ever applied to entries that
   *  are actually Claude's own catalog, never guessed from "the option list
   *  happens to look like Claude's". Defaults to true (byte-identical to
   *  pre-C3 behavior) when omitted, matching harnessId's own "omitted means
   *  claude" convention in src/main/ipc/models.ts. */
  isClaudeHarness?: boolean
  /** (C3) Display label for a non-Claude harness's provider group, e.g.
   *  "Codex CLI" — the harness descriptor's own `label`. Unused when
   *  isClaudeHarness is true (Claude's own CLAUDE_PROVIDER_LABEL always
   *  wins there). Falls back to `harnessId` itself if omitted, mirroring
   *  providerLabelFor's own descriptor-miss fallback below. */
  harnessLabel?: string
  /** (C3) The resolved harness's id, e.g. 'claude' or 'codex-cli' — used as
   *  SelectableModel.providerId for a non-Claude harness's own models
   *  (grouping the picker by harness, the only axis that exists for a
   *  harness with no provider-routing concept at all). Unused when
   *  isClaudeHarness is true. */
  harnessId?: string
}

function claudeEntries(
  curatedModelOptions?: CuratedFieldOptionsOverlay,
  currentModelId?: string,
  curatedEffortOptions?: CuratedFieldOptionsOverlay,
  currentEffort?: string
): SelectableModel[] {
  // Resolve the MODEL list first (which ids appear at all, hidden/added/
  // reordered) — resolveCuratedOptions is a true no-op (returns the input
  // array by reference) when there is no overlay, so this costs nothing on
  // the common "no curation configured" path.
  const orderedIds = resolveCuratedOptions(
    CLAUDE_MODEL_OPTIONS.map((o) => o.value),
    curatedModelOptions,
    currentModelId
  )
  // Keyed as plain `string` (not the narrow ClaudeModelOption union
  // CLAUDE_MODEL_OPTIONS' own values infer to) — `id` below iterates over
  // orderedIds, which can contain an overlay-added or reinstated-selected
  // custom id resolveCuratedOptions never validates against the descriptor
  // list (CuratedField.allowCustom's contract), so a Map keyed on the
  // narrower type would reject looking those up at all.
  const byId = new Map<string, (typeof CLAUDE_MODEL_OPTIONS)[number]>(
    CLAUDE_MODEL_OPTIONS.map((o) => [o.value, o])
  )

  return orderedIds.map((id) => {
    // A custom (overlay-added or reinstated-selected) id has no descriptor
    // entry — fall back to using the id itself as the label, matching
    // claudeFallbackModels'/buildCuratedOptionRows' own "arbitrary custom
    // value" convention rather than throwing on a .get() miss.
    const option = byId.get(id)
    const rawEffortLevels =
      (CLAUDE_BUILTIN_EFFORT_LEVELS as Record<string, string[] | null>)[id] ?? null
    // Effort overlay applies PER MODEL, and only to a model that actually
    // has real levels — a model with `null` (no reasoning-effort control at
    // all) must stay `null`, never gain a fabricated ladder just because an
    // overlay exists (see this field's own doc comment on
    // BuildSelectableModelsInput).
    const effortLevels =
      rawEffortLevels === null
        ? null
        : resolveCuratedOptions(rawEffortLevels, curatedEffortOptions, currentEffort)
    return {
      id,
      label: option?.label ?? id,
      providerId: CLAUDE_PROVIDER_ID,
      providerLabel: CLAUDE_PROVIDER_LABEL,
      isClaude: true,
      available: true,
      contextWindow: null, // resolved on demand via models:resolveLabels/registry, not duplicated here
      effortLevels,
      provisional: false
    }
  })
}

/**
 * (C3, support-multi-harness) Non-Claude harness entries — the base model
 * list comes from `input.harnessModelOptions` (the harness descriptor's own
 * `curated.model.options`, resolved by the IPC layer), with the SAME
 * add/hide/order overlay and hidden-but-selected invariant claudeEntries
 * already applies, so a non-Claude harness's picker behaves identically in
 * every respect except WHERE its base catalog comes from.
 *
 * Every non-id field is deliberately minimal, never fabricated:
 *   - label: the id itself — a generic harness descriptor's CuratedField is
 *     `options: string[]`, a bare id list with no per-option label/metadata
 *     (unlike CLAUDE_MODEL_OPTIONS' {value,label} pairs), so there is no
 *     richer label to source one from.
 *   - providerId/providerLabel: the harness's own id/label — grouping by
 *     harness, the only axis a harness with no provider-routing concept
 *     has. Falls back to the bare id when no label was threaded in.
 *   - isClaude: always false — see BuildSelectableModelsInput's own doc
 *     comment on why this must never be fabricated true for a foreign
 *     harness's catalog (DropdownChip.tsx's live-`/model`-injection gate
 *     reads this field directly).
 *   - contextWindow: null — unknown, never invented, matching Claude's own
 *     entries above.
 *   - effortLevels: always null. A generic harness descriptor has no
 *     PER-MODEL effort ladder concept at all (curated.effort.options, when
 *     present, is one flat list for the whole harness, not keyed per model
 *     the way CLAUDE_BUILTIN_EFFORT_LEVELS is) — inventing a per-model
 *     ladder by reusing that flat list would misrepresent it as real
 *     per-model data. The effort footer chip already treats a null
 *     effortLevels as "no reasoning-effort control for this model" and
 *     hides itself accordingly (DropdownChip.tsx) — the correct, non-
 *     fabricating outcome for a harness that hasn't declared per-model
 *     levels.
 *   - provisional: always false — this list has no live/health gating at
 *     all (that concept belongs to the dead routed-model code below
 *     PHASE0_ROUTING_SEVERED), so nothing here is ever "provisionally"
 *     available.
 */
function harnessEntries(
  harnessModelOptions: string[],
  harnessId: string,
  harnessLabel: string | undefined,
  curatedModelOptions: CuratedFieldOptionsOverlay | undefined,
  currentModelId: string | undefined
): SelectableModel[] {
  const orderedIds = resolveCuratedOptions(harnessModelOptions, curatedModelOptions, currentModelId)
  const providerLabel = harnessLabel ?? harnessId
  return orderedIds.map((id) => ({
    id,
    label: id,
    providerId: harnessId,
    providerLabel,
    isClaude: false,
    available: true,
    contextWindow: null,
    effortLevels: null,
    provisional: false
  }))
}

/**
 * True iff the routing proxy is in a state where it can actually serve
 * routed traffic right now — enabled AND its process is 'running'. Neither
 * alone is sufficient: `enabled` can be true while still 'starting'/
 * 'error'/'not_installed', and `status` could theoretically be stale.
 *
 * (model-routing unit 09-polish) `status === 'starting'` is DELIBERATELY
 * still excluded here, even for a provider with persisted-healthy history —
 * this function answers "can we trust a LIVE health signal right now", and
 * during 'starting' there simply isn't one yet (authFiles is still empty).
 * The persisted-availability softening happens at a DIFFERENT layer
 * (persistedAvailabilityFor, consulted only when this returns false) so the
 * two concerns stay cleanly separated: this function's contract is
 * unchanged from before this unit, and every existing caller/assertion that
 * depends on "enabled && running" as the live-serving definition keeps
 * working unmodified.
 */
function proxyIsServing(routingProxy: RoutingProxyStatusInput): boolean {
  return routingProxy.enabled && routingProxy.status === 'running'
}

/**
 * True iff the proxy is in the STARTUP WINDOW where a persisted fallback is
 * even worth consulting — enabled and either 'starting' (mid-boot, no live
 * authFiles data could possibly exist yet) or already 'running' but
 * authFiles just hasn't reported this specific provider yet (the fetch is
 * in flight / hasn't completed its first tick). Deliberately EXCLUDES
 * 'error'/'stopped'/'not_installed'/disabled — those are states where we
 * affirmatively know the proxy is NOT going to serve traffic soon, and
 * offering a persisted-available model there would be actively misleading
 * (not a brief startup gap, a real outage).
 */
function inStartupWindow(routingProxy: RoutingProxyStatusInput): boolean {
  if (!routingProxy.enabled) return false
  return routingProxy.status === 'starting' || routingProxy.status === 'running'
}

/** True iff `providerId`'s stored config is enabled AND its connection
 *  (matched by provider id in the snapshot's authFiles) reports health 'ok'.
 *  A provider with no authFiles entry at all (never connected) is not
 *  healthy — absence is not health. */
function providerIsHealthy(
  providerId: string,
  providerConfigs: ProviderConfigInput[],
  routingProxy: RoutingProxyStatusInput
): boolean {
  const cfg = providerConfigs.find((p) => p.providerId === providerId)
  if (!cfg || !cfg.enabled) return false
  const connection = routingProxy.authFiles.find((f) => f.provider === providerId)
  return connection?.health === 'ok'
}

/**
 * The startup-window fallback decision (model-routing unit 09-polish).
 * Returns true ONLY when ALL of:
 *   - proxy is enabled and in the startup window (inStartupWindow) — never
 *     offered once the proxy is affirmatively down/errored/disabled
 *   - the provider's stored config still exists and is enabled — a
 *     provider disabled or removed from config since the persisted payload
 *     was written must never be resurrected by stale data
 *   - `providerId` is in the persisted-healthy set from last session
 *   - CRITICALLY: authFiles has NO entry at all for this provider yet —
 *     the instant a live entry exists (healthy OR unhealthy), THAT is
 *     authoritative and this function must return false. This is the "never
 *     let a stale persisted healthy override a live unhealthy" rule — it is
 *     enforced structurally here (not by the caller remembering to check)
 *     by looking at the SAME authFiles array providerIsHealthy already
 *     consults: once an entry appears, providerIsHealthy's own real
 *     ok/error answer is what must decide, and this function steps aside.
 */
function persistedAvailabilityFor(
  providerId: string,
  providerConfigs: ProviderConfigInput[],
  routingProxy: RoutingProxyStatusInput,
  persistedHealthyProviderIds: Set<string> | undefined
): boolean {
  if (!persistedHealthyProviderIds || !persistedHealthyProviderIds.has(providerId)) return false
  if (!inStartupWindow(routingProxy)) return false
  const cfg = providerConfigs.find((p) => p.providerId === providerId)
  if (!cfg || !cfg.enabled) return false
  const hasLiveEntry = routingProxy.authFiles.some((f) => f.provider === providerId)
  if (hasLiveEntry) return false // live data has arrived — it alone decides now, never the persisted fallback
  return true
}

function providerLabelFor(providerId: string, descriptors: ProviderDescriptorInput[]): string {
  return descriptors.find((d) => d.id === providerId)?.label ?? providerId
}

/**
 * (C3, support-multi-harness) Resolves the BASE catalog entries — before the
 * dead routed-model code below ever runs — for whichever harness this call
 * is scoped to. `input.isClaudeHarness` defaults to true (undefined means
 * "the pre-C3 caller, always Claude"), so every existing call site that
 * never set the new C3 fields gets claudeEntries() exactly as before: this
 * function is a pure dispatch, not a behavior change for Claude.
 *
 * For a non-Claude harness, `input.harnessModelOptions` is REQUIRED to be an
 * array (never undefined) by the time it reaches here — the IPC layer
 * resolves "this harness's descriptor declares no curated.model" to `[]`,
 * not `undefined` (see BuildSelectableModelsInput's own doc comment on that
 * field). An empty array here correctly yields an empty picker rather than
 * falling back to Claude's list.
 */
function baseEntries(input: BuildSelectableModelsInput): SelectableModel[] {
  if (input.isClaudeHarness === false) {
    return harnessEntries(
      input.harnessModelOptions ?? [],
      input.harnessId ?? 'unknown',
      input.harnessLabel,
      input.curatedModelOptions,
      input.currentModelId
    )
  }
  return claudeEntries(
    input.curatedModelOptions,
    input.currentModelId,
    input.curatedEffortOptions,
    input.currentEffort
  )
}

/**
 * Assemble the full selectable-model list. As of Phase 0 of the multi-harness
 * migration, this is the workspace's own harness's BASE catalog only — see
 * baseEntries() for the Claude-vs-non-Claude dispatch, unconditionally
 * available. Phase 0 severed launch-side CLIProxyAPI routing, so a routed
 * model can no longer be launched even if the proxy reports it as healthy;
 * offering it in the picker would be a broken affordance. The routed-model
 * assembly (proxy-running + provider-healthy gating, the unit-09-polish
 * persisted-availability startup fallback, and "never drop a workspace's
 * stored selection" preservation) still exists below, verbatim, but is dead
 * code — unreachable behind the early return, and Claude-only in shape (it
 * was never extended for a non-Claude base catalog — that is Phase 6's
 * concern, alongside re-landing routing itself). It is the intended re-land
 * site for Phase 6, which restores routing harness-aware by deleting that
 * early return.
 */
export function buildSelectableModels(input: BuildSelectableModelsInput): SelectableModel[] {
  // Phase 0 (multi-harness migration): launch-side CLIProxyAPI routing is
  // severed, so routed models must not be selectable — the launch path can
  // no longer route to them. Everything below this branch is the Phase 6
  // re-land site, preserved byte-identical; Phase 6 restores it by deleting
  // this guard (do not delete, rewrite, or "clean up" the dormant code
  // below). Written as `if (const-true) return` rather than a bare `return`
  // so TypeScript keeps flow-narrowing the dormant block below (a bare early
  // `return` makes TS stop narrowing unreachable code, turning real
  // `string | undefined` guards below into spurious type errors — verified
  // empirically).
  if (PHASE0_ROUTING_SEVERED) {
    return baseEntries(input)
  }

  const result: SelectableModel[] = baseEntries(input)

  const serving = proxyIsServing(input.routingProxy)
  const seenRoutedIds = new Set<string>()

  for (const entry of input.cliProxyModels) {
    if (!entry.providerId) continue // no provider attribution — can't gate or group it safely

    const liveHealthy =
      serving && providerIsHealthy(entry.providerId, input.providerConfigs, input.routingProxy)
    const provisional =
      !liveHealthy &&
      persistedAvailabilityFor(
        entry.providerId,
        input.providerConfigs,
        input.routingProxy,
        input.persistedHealthyProviderIds
      )

    if (!liveHealthy && !provisional) continue // omitted unless it's the current selection — handled below

    seenRoutedIds.add(entry.modelId)
    result.push({
      id: entry.modelId,
      label: entry.modelId,
      providerId: entry.providerId,
      providerLabel: providerLabelFor(entry.providerId, input.providerDescriptors),
      isClaude: false,
      available: true,
      contextWindow: entry.context,
      effortLevels: entry.effortLevels ?? null,
      provisional
    })
  }

  // Preserve an already-selected routed model that didn't make the cut above
  // (proxy down, provider disconnected/unhealthy, or the model itself is no
  // longer reported) — never silently drop a workspace's stored setting.
  const current = input.currentModelId
  if (
    current &&
    !seenRoutedIds.has(current) &&
    !CLAUDE_MODEL_OPTIONS.some((o) => o.value === current)
  ) {
    const cached = input.cliProxyModels.find((m) => m.modelId === current)
    const providerId = cached?.providerId
    result.push({
      id: current,
      label: current,
      providerId: providerId ?? 'unknown',
      providerLabel: providerId
        ? providerLabelFor(providerId, input.providerDescriptors)
        : 'Unavailable',
      isClaude: false,
      available: false,
      contextWindow: cached?.context ?? null,
      effortLevels: cached?.effortLevels ?? null,
      provisional: false
    })
  }

  return result
}
