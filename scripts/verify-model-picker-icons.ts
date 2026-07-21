// ---------------------------------------------------------------------------
// scripts/verify-model-picker-icons.ts
//
// Assertion harness for unit 10-creation's follow-up: provider icons in
// model-selection surfaces (sidebar row + footer Model chip + its dropdown).
//
// MUST PASS FULLY OFFLINE. Covers two pure, no-React pieces:
//
//   1. src/renderer/src/lib/modelPickerOptions.ts's buildModelDropdownItems —
//      the DropdownChip-flavored item builder now carries `providerId`
//      straight through from each SelectableModel (never re-derived/guessed)
//      so ChipDropdown.tsx can render a ProviderIcon per row, including for
//      Claude entries (this picker shows what you're selecting, so Claude
//      gets an icon too — unlike the sidebar's "only mark exceptions" rule).
//   2. The same provider-for-model resolution shape
//      useWorkspaceProviderIcon.ts uses for the sidebar row (models.find(id
//      -> providerId) ?? null) — verified here as a standalone lookup so the
//      "unknown model id -> no provider, never throws" contract is asserted
//      without needing React/useSyncExternalStore.
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import { buildModelDropdownItems } from '../src/renderer/src/lib/modelPickerOptions.ts'
import type { SelectableModel } from '../src/shared/types.ts'

function model(partial: Partial<SelectableModel> & { id: string }): SelectableModel {
  return {
    label: partial.id,
    providerId: 'claude',
    providerLabel: 'Claude',
    isClaude: true,
    available: true,
    contextWindow: null,
    effortLevels: null,
    provisional: false,
    ...partial
  }
}

// ---------------------------------------------------------------------------
// 1. buildModelDropdownItems carries providerId through unchanged, for every
//    provider including Claude — no re-derivation, no dropped field.
// ---------------------------------------------------------------------------

{
  const models: SelectableModel[] = [
    model({ id: 'claude-sonnet-4-5', providerId: 'claude', providerLabel: 'Claude' }),
    model({
      id: 'gpt-5-codex',
      providerId: 'codex',
      providerLabel: 'OpenAI',
      isClaude: false
    }),
    model({
      id: 'grok-4.5',
      providerId: 'xai',
      providerLabel: 'Grok (xAI)',
      isClaude: false
    })
  ]

  const items = buildModelDropdownItems(models)
  assert.equal(items.length, 3)
  assert.equal(items[0].providerId, 'claude', 'Claude rows must carry providerId, not skip it')
  assert.equal(items[1].providerId, 'codex')
  assert.equal(items[2].providerId, 'xai')
  assert.deepEqual(
    items.map((i) => i.value),
    ['claude-sonnet-4-5', 'gpt-5-codex', 'grok-4.5'],
    'value/order must be untouched by adding providerId'
  )
  console.log(
    '✓ buildModelDropdownItems passes providerId through for every row, including Claude (picker consistency, not the sidebar exception rule)'
  )
}

// ---------------------------------------------------------------------------
// 2. An unavailable/unavailable-provider model still carries its providerId
//    (icon rendering must not depend on `available`).
// ---------------------------------------------------------------------------

{
  const models: SelectableModel[] = [
    model({
      id: 'gpt-5-codex',
      providerId: 'codex',
      providerLabel: 'OpenAI',
      isClaude: false,
      available: false
    })
  ]
  const items = buildModelDropdownItems(models)
  assert.equal(items[0].providerId, 'codex')
  assert.ok(items[0].label.includes('(unavailable)'))
  console.log(
    '✓ an unavailable routed model still carries providerId — icon rendering is independent of availability'
  )
}

// ---------------------------------------------------------------------------
// 3. Provider-for-model resolution shape (mirrors
//    useWorkspaceProviderIcon.ts's models.find(...)?.providerId ?? null):
//    an unknown/never-seen model id resolves to null, never throws, never
//    fabricates a guess.
// ---------------------------------------------------------------------------

function resolveProviderId(modelId: string | null, models: SelectableModel[]): string | null {
  if (!modelId) return null
  const match = models.find((m) => m.id === modelId)
  return match?.providerId ?? null
}

{
  const models: SelectableModel[] = [
    model({ id: 'claude-sonnet-4-5', providerId: 'claude' }),
    model({ id: 'gpt-5-codex', providerId: 'codex', isClaude: false })
  ]

  assert.equal(resolveProviderId('claude-sonnet-4-5', models), 'claude')
  assert.equal(resolveProviderId('gpt-5-codex', models), 'codex')
  assert.equal(
    resolveProviderId('some-removed-or-never-fetched-model', models),
    null,
    'unknown model id must resolve to null, not throw or guess'
  )
  assert.equal(
    resolveProviderId(null, models),
    null,
    'null modelId (never fetched yet) resolves to null'
  )
  assert.doesNotThrow(() => resolveProviderId('anything', []), 'empty model list must not throw')
  console.log(
    '✓ provider-for-model resolution: known ids resolve correctly, unknown/null ids resolve to null without throwing (never a fabricated guess)'
  )
}

console.log('\nAll model-picker-icon assertions passed.')
