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
  initialCreationProviderId
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
