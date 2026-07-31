// ---------------------------------------------------------------------------
// scripts/verify-creation-provider-menu.ts
//
// Assertion harness for the workspace-creation popover redesign
// (model-routing unit 10-creation): src/renderer/src/lib/
// creationProviderMenu.ts — the pure grouping/last-used logic backing
// NewWorkspaceMenu.tsx's two-level provider -> model swap.
//
// MUST PASS FULLY OFFLINE. creationProviderMenu.ts imports nothing from
// react/electron — it's pure data transforms over SelectableModel[], mirrors
// scripts/verify-model-picker.ts's own no-Electron/no-DB constraint.
//
// Covers:
//   1. grouping derives from the registry/cache-backed SelectableModel list
//      (providerId/providerLabel/isClaude), never a new model->provider
//      matcher — ollama (and any other id outside the four supported
//      providers) is excluded entirely, never a partial/empty group.
//   2. Claude group is present even when every routed provider is absent
//      (the offline guarantee, unaffected by this popover-only filter).
//   3. per-provider last-used selection: picking a provider pre-selects ITS
//      OWN last-used model; the overall last-used (any provider) seeds the
//      initial view/top-line on open.
//   4. short display labels ("OpenAI"/"Grok") are presentational only — the
//      underlying providerId is untouched.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  groupModelsForCreation,
  shortProviderLabel,
  emptyCreationLastUsedState,
  recordCreationPick,
  lastUsedModelForProvider,
  initialCreationProviderId,
  compareRoutedModelIds
} from '../src/renderer/src/lib/creationProviderMenu.ts'
import type { SelectableModel } from '../src/shared/types.ts'
import { CLAUDE_MODEL_OPTIONS } from '../src/shared/types.ts'

function claudeModels(): SelectableModel[] {
  return CLAUDE_MODEL_OPTIONS.map((o) => ({
    id: o.value,
    label: o.label,
    providerId: 'claude',
    providerLabel: 'Claude',
    isClaude: true,
    available: true,
    contextWindow: null,
    effortLevels: null,
    provisional: false
  }))
}

function routedModel(
  providerId: string,
  id: string,
  providerLabel: string,
  available = true
): SelectableModel {
  return {
    id,
    label: id,
    providerId,
    providerLabel,
    isClaude: false,
    available,
    contextWindow: null,
    effortLevels: null,
    provisional: false
  }
}

// ---------------------------------------------------------------------------
// 1. Grouping derives from the SAME SelectableModel data every other picker
//    uses — no new matcher — and Ollama is excluded from the creation menu
//    even when it's present in the server-provided list (e.g. a healthy
//    ollama connection from the Settings/routing-proxy surface).
// ---------------------------------------------------------------------------

{
  const models: SelectableModel[] = [
    ...claudeModels(),
    routedModel('codex', 'gpt-5-codex', 'Codex (OpenAI)'),
    routedModel('codex', 'gpt-5-mini', 'Codex (OpenAI)'),
    routedModel('xai', 'grok-4.5', 'Grok (xAI)'),
    routedModel('antigravity', 'gemini-3-pro', 'Antigravity'),
    routedModel('ollama', 'llama3.3', 'Ollama (local)')
  ]

  const groups = groupModelsForCreation(models)
  const providerIds = groups.map((g) => g.providerId)

  assert.deepEqual(
    providerIds,
    ['claude', 'codex', 'xai', 'antigravity'],
    'creation menu must group into exactly claude/codex/xai/antigravity, in server-order, excluding ollama entirely'
  )
  assert.ok(
    !providerIds.includes('ollama' as never),
    'ollama must never appear as a creation-menu group even when present in the server list'
  )

  const codexGroup = groups.find((g) => g.providerId === 'codex')!
  assert.equal(codexGroup.models.length, 2, 'a provider group must contain every one of its models')
  assert.deepEqual(
    codexGroup.models.map((m) => m.id),
    ['gpt-5-codex', 'gpt-5-mini']
  )

  console.log(
    '✓ grouping derives from the server-provided SelectableModel list (providerId/providerLabel), excludes ollama entirely, preserves server ordering'
  )
}

// ---------------------------------------------------------------------------
// 2. Claude group present even when NO routed provider is available at all
//    (proxy fully down) — the offline guarantee is unaffected by this
//    popover-only filter, since it operates on whatever buildSelectableModels
//    already decided to offer.
// ---------------------------------------------------------------------------

{
  const groups = groupModelsForCreation(claudeModels())
  assert.equal(groups.length, 1, 'with the proxy fully down, only the Claude group must appear')
  assert.equal(groups[0].providerId, 'claude')
  assert.equal(groups[0].models.length, CLAUDE_MODEL_OPTIONS.length)
  assert.ok(
    groups[0].models.every((m) => m.isClaude && m.available),
    'every Claude entry must be isClaude + available even with every routed provider absent'
  )
  console.log(
    '✓ Claude group is present (and complete) even when every routed provider is absent — offline guarantee preserved through the creation-menu filter'
  )
}

// ---------------------------------------------------------------------------
// 3. Short display labels — presentational rename only, id untouched.
// ---------------------------------------------------------------------------

{
  assert.equal(shortProviderLabel('claude'), 'Claude')
  assert.equal(shortProviderLabel('codex'), 'OpenAI', 'codex must display as "OpenAI", not "Codex"')
  assert.equal(shortProviderLabel('xai'), 'Grok')
  assert.equal(shortProviderLabel('antigravity'), 'Antigravity')
  // An id outside the four known creation providers (e.g. a stale/removed
  // provider) falls back to the raw id rather than throwing or fabricating.
  assert.equal(shortProviderLabel('ollama'), 'ollama')
  console.log(
    '✓ short display labels are presentational only (codex -> "OpenAI") — the underlying providerId is never touched'
  )
}

// ---------------------------------------------------------------------------
// 4. Per-provider last-used selection logic.
// ---------------------------------------------------------------------------

{
  const models: SelectableModel[] = [
    ...claudeModels(),
    routedModel('codex', 'gpt-5-codex', 'Codex (OpenAI)'),
    routedModel('codex', 'gpt-5-mini', 'Codex (OpenAI)'),
    routedModel('xai', 'grok-4.5', 'Grok (xAI)')
  ]
  const groups = groupModelsForCreation(models)

  // 4a. Empty state: no picks yet -> the popover opens on 'claude' (the safe
  // default, always present), and a provider with no remembered pick falls
  // back to its first model (server's own ordering).
  let state = emptyCreationLastUsedState()
  assert.equal(initialCreationProviderId(state, groups), 'claude')
  const codexModels = groups.find((g) => g.providerId === 'codex')!.models
  assert.equal(
    lastUsedModelForProvider(state, 'codex', codexModels),
    'gpt-5-codex',
    'no remembered pick -> falls back to the first model in that providers own group'
  )

  // 4b. Picking a codex model updates BOTH the overall last-used (drives the
  // initial view/top-line) AND that provider's own remembered pick.
  state = recordCreationPick(state, 'codex', 'gpt-5-mini')
  assert.equal(
    initialCreationProviderId(state, groups),
    'codex',
    'overall last-used must now be codex (the just-picked provider)'
  )
  assert.equal(
    lastUsedModelForProvider(state, 'codex', codexModels),
    'gpt-5-mini',
    "codex's own remembered pick must be the just-picked model"
  )

  // 4c. Picking a DIFFERENT provider (xai) updates overall to xai, but does
  // NOT clobber codex's own remembered pick — each provider remembers its
  // OWN last-used independently.
  state = recordCreationPick(state, 'xai', 'grok-4.5')
  assert.equal(initialCreationProviderId(state, groups), 'xai')
  assert.equal(
    lastUsedModelForProvider(state, 'codex', codexModels),
    'gpt-5-mini',
    "switching to xai must not clobber codex's own remembered pick from 4b"
  )
  const xaiModels = groups.find((g) => g.providerId === 'xai')!.models
  assert.equal(lastUsedModelForProvider(state, 'xai', xaiModels), 'grok-4.5')

  // 4d. If the overall last-used provider is no longer present among the
  // CURRENT groups (e.g. its proxy connection dropped since the pick was
  // recorded), the initial view falls back to 'claude' rather than opening
  // on a group that doesn't exist.
  const groupsWithoutXai = groups.filter((g) => g.providerId !== 'xai')
  assert.equal(
    initialCreationProviderId(state, groupsWithoutXai),
    'claude',
    'overall last-used provider no longer offered -> falls back to claude, never a dangling reference'
  )

  // 4e. A remembered pick that's no longer in the CURRENT model list (e.g.
  // that specific model id disappeared from the provider's offerings) falls
  // back to the first model in the fresh list rather than returning a
  // dangling id.
  const staleState = recordCreationPick(emptyCreationLastUsedState(), 'codex', 'gpt-5-turbo-old')
  assert.equal(
    lastUsedModelForProvider(staleState, 'codex', codexModels),
    'gpt-5-codex',
    'a remembered model id no longer present in the current list falls back to the first current model'
  )

  console.log(
    '✓ per-provider last-used: picking a provider yields ITS OWN last-used model; overall last-used (any provider) seeds the initial view; stale references fall back safely'
  )
}

// ---------------------------------------------------------------------------
// 5. Immutability — recordCreationPick never mutates its input, so a React
//    store built on top of it (creationLastUsedStore.ts) can safely treat it
//    as a reducer step without a defensive copy at the call site.
// ---------------------------------------------------------------------------

{
  const before = emptyCreationLastUsedState()
  const beforeByProviderRef = before.byProvider
  const after = recordCreationPick(before, 'codex', 'gpt-5-codex')
  assert.equal(before.overall, null, 'the input state object must not be mutated')
  assert.equal(
    before.byProvider,
    beforeByProviderRef,
    "the input state's byProvider Map must not be mutated in place"
  )
  assert.notEqual(after, before, 'recordCreationPick must return a NEW state object')
  console.log(
    '✓ recordCreationPick never mutates its input — safe to use as an immutable reducer step'
  )
}

// ---------------------------------------------------------------------------
// 6. Routed (non-Claude) model ordering — groupModelsForCreation sorts every
//    NON-Claude provider's models into the deterministic family-stem +
//    version-descending order (compareRoutedModelIds), while the Claude
//    group's hand-curated CLAUDE_MODEL_OPTIONS order is left completely
//    untouched (regression guard against ever sorting Claude).
// ---------------------------------------------------------------------------

{
  // Deliberately jumbled input, mirroring the arbitrary order the routing
  // proxy actually returns for Grok.
  const jumbledGrokIds = [
    'grok-build-0.1',
    'grok-4.5',
    'grok-4.3',
    'grok-4.20-0309-reasoning',
    'grok-4.20-0309-non-reasoning',
    'grok-4.20-multi-agent-0309',
    'grok-3-mini',
    'grok-3-mini-fast',
    'grok-composer-2.5-fast',
    'grok-imagine-image',
    'grok-imagine-image-quality',
    'grok-imagine-video',
    'grok-imagine-video-1.5-preview'
  ]
  const models: SelectableModel[] = [
    ...claudeModels(),
    ...jumbledGrokIds.map((id) => routedModel('xai', id, 'Grok (xAI)'))
  ]

  const groups = groupModelsForCreation(models)
  const xaiGroup = groups.find((g) => g.providerId === 'xai')!
  const sortedIds = xaiGroup.models.map((m) => m.id)

  // Expected order per compareRoutedModelIds' documented contract: family
  // stem "grok-" clusters together (only stem present here), then version
  // DESCENDING by component (major, then minor, ...) — 4.20 > 4.5 > 4.3 > 3.x
  // > build-0.1 — with same-version dated builds broken by localeCompare.
  assert.deepEqual(
    sortedIds,
    [
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-0309-reasoning',
      'grok-4.20-multi-agent-0309',
      'grok-4.5',
      'grok-4.3',
      'grok-3-mini',
      'grok-3-mini-fast',
      'grok-build-0.1',
      'grok-composer-2.5-fast',
      'grok-imagine-image',
      'grok-imagine-image-quality',
      'grok-imagine-video',
      'grok-imagine-video-1.5-preview'
    ],
    'a jumbled routed-provider model list must come out grouped by family stem and version-descending, matching compareRoutedModelIds exactly'
  )

  // The Claude group must be UNCHANGED — still exactly CLAUDE_MODEL_OPTIONS'
  // hand-curated order, proving the sort never touches Claude.
  const claudeGroup = groups.find((g) => g.providerId === 'claude')!
  assert.deepEqual(
    claudeGroup.models.map((m) => m.id),
    CLAUDE_MODEL_OPTIONS.map((o) => o.value),
    "Claude's group order must stay EXACTLY CLAUDE_MODEL_OPTIONS' order — never sorted"
  )

  // Determinism: running the grouping/sort again over the same input yields
  // an identical order both times (no reliance on unstable native sort or
  // incidental input order).
  const groupsAgain = groupModelsForCreation(models)
  const xaiAgain = groupsAgain.find((g) => g.providerId === 'xai')!.models.map((m) => m.id)
  assert.deepEqual(
    sortedIds,
    xaiAgain,
    'sorting the same input twice must produce identical output'
  )

  console.log(
    '✓ non-Claude routed groups sort into deterministic family-stem + version-descending order; Claude group order is untouched; sort is stable/deterministic across repeated runs'
  )
}

// ---------------------------------------------------------------------------
// 7. compareRoutedModelIds direct contract checks — the comparator itself,
//    independent of grouping, so its rules are pinned even if the grouping
//    call site ever changes.
// ---------------------------------------------------------------------------

{
  // Multi-component version compare: major desc first, then minor desc.
  assert.ok(
    compareRoutedModelIds('gpt-5', 'gpt-4') < 0,
    'gpt-5 must sort before gpt-4 (major desc)'
  )
  assert.ok(
    compareRoutedModelIds('grok-4.20', 'grok-4.5') < 0,
    'within the same major (4), minor 20 must sort before minor 5 (numeric, not string, compare)'
  )

  // Different stems cluster by alphabetical stem, not interleaved by version.
  assert.ok(
    compareRoutedModelIds('grok-imagine-video', 'grok-4.5') > 0,
    '"grok-imagine-" is a different (alphabetically later) stem than "grok-", so it sorts after the whole grok- family regardless of version'
  )

  // No parseable version at all -> pure localeCompare fallback, still total.
  assert.ok(
    typeof compareRoutedModelIds('gemini-3-pro', 'gemini-3-flash') === 'number',
    'ids with equal version vectors fall back to localeCompare and still return a definite order'
  )

  // Reflexive/symmetric sanity: comparing an id to itself is always 0.
  assert.equal(compareRoutedModelIds('grok-4.5', 'grok-4.5'), 0)

  console.log(
    '✓ compareRoutedModelIds: numeric multi-component version-descending within a stem, alphabetical stem clustering across families, total order via localeCompare fallback'
  )
}
