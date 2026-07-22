// ---------------------------------------------------------------------------
// scripts/verify-model-refresh.ts
//
// Assertion harness for the cold-boot model-picker-staleness fix (user-
// reported: "if I open a workspace quickly when the app loads ... I cannot
// see the other providers for some time"). Mirrors the existing
// scripts/verify-*.ts convention: a script run directly via `bun run` (the
// `test:model-refresh` package.json script), no test framework.
//
// Root cause (routingProxy/manager.ts's refreshAuthFiles): the automatic
// catalog-refresh path broadcast routingProxy:onSnapshot BEFORE
// refreshCliProxyModelCache populated the cliproxy model cache, and never
// again once it did — so a picker mounted in that window (the cold-boot
// case) kept rendering the empty-cache (Claude-only) result until an
// unrelated remount forced a fresh fetch against the by-then-warm cache. The
// fix adds a SECOND, content-guarded broadcast right after the cache
// populates, so the picker updates live without the user needing to
// navigate away and back — but the guard must not fire on every steady-state
// 30s tick once the cache is warm (that would be a refetch storm across
// every mounted picker every 30s).
//
// This harness exercises the PURE decision the fix hinges on —
// cliProxyModelCacheSignature / didCliProxyModelCacheChange
// (src/main/models/sources/cliproxy.ts), which is electron-free and DB-free
// by construction, same constraint every other verify-*.ts harness in this
// repo depends on. The actual wiring (refreshAuthFiles calling setSnapshot a
// second time, gated by this decision) lives in
// src/main/routingProxy/manager.ts, which imports `electron` transitively
// and cannot be exercised directly by an offline harness — see this file's
// own honest-coverage note at the bottom.
//
// Covers exactly the four cases the fix must get right:
//   1. empty -> populated: must broadcast (true) — the cold-boot case itself
//   2. populated -> identical: must NOT broadcast (false) — the churn-loop
//      guard that keeps the steady-state 30s tick quiet
//   3. populated -> a different model id set: must broadcast (true) — a
//      model appearing/disappearing between ticks
//   4. populated -> same id set but different availability/facts (provider,
//      context, effort levels): must broadcast (true) — a provider becoming
//      healthy, or a model's reported facts changing, between ticks
//
// Plus a signature-stability check: two calls with the SAME entries in a
// DIFFERENT order produce the SAME signature (order-independence is load-
// bearing — Map iteration order across two separate fetches is unspecified).
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import {
  cliProxyModelCacheSignature,
  didCliProxyModelCacheChange
} from '../src/main/models/sources/cliproxy.ts'

type Entry = {
  modelId: string
  context: number | null
  supportsReasoning: boolean
  providerId?: string
  effortLevels?: string[] | null
}

const grok: Entry = {
  modelId: 'grok-4.5',
  context: 256_000,
  supportsReasoning: true,
  providerId: 'xai',
  effortLevels: ['low', 'medium', 'high']
}
const gpt: Entry = {
  modelId: 'gpt-5.5',
  context: 400_000,
  supportsReasoning: true,
  providerId: 'codex',
  effortLevels: ['low', 'medium', 'high', 'xhigh']
}
const populated: Entry[] = [grok, gpt]

// ---------------------------------------------------------------------------
// 1. empty -> populated: the cold-boot case itself. A picker mounted while
//    the cache was still empty must be told to refetch once it populates.
// ---------------------------------------------------------------------------

{
  const emptySignature = cliProxyModelCacheSignature([])
  assert.equal(
    didCliProxyModelCacheChange(emptySignature, populated),
    true,
    'empty -> populated must report a change (broadcast) — the cold-boot picker-staleness case'
  )
  console.log('✓ empty -> populated reports a change (broadcast)')
}

// ---------------------------------------------------------------------------
// 2. populated -> identical: the churn-loop guard. The steady-state 30s tick
//    must NOT re-broadcast (and refetch every mounted picker) when the
//    catalog genuinely didn't change.
// ---------------------------------------------------------------------------

{
  const signature = cliProxyModelCacheSignature(populated)
  const identicalNextTick: Entry[] = [{ ...grok }, { ...gpt, effortLevels: [...gpt.effortLevels!] }]
  assert.equal(
    didCliProxyModelCacheChange(signature, identicalNextTick),
    false,
    'populated -> identical must NOT report a change — the steady-state 30s tick must stay quiet'
  )
  console.log('✓ populated -> identical reports no change (quiet, churn-loop guard holds)')
}

// ---------------------------------------------------------------------------
// 3. populated -> a different model id set: a model appeared or disappeared
//    between ticks — must broadcast.
// ---------------------------------------------------------------------------

{
  const signature = cliProxyModelCacheSignature(populated)
  const differentIdSet: Entry[] = [grok] // gpt-5.5 disappeared
  assert.equal(
    didCliProxyModelCacheChange(signature, differentIdSet),
    true,
    'populated -> a different id set must report a change — a model appearing/disappearing'
  )
  const idAppeared: Entry[] = [
    ...populated,
    { modelId: 'gemini-3', context: 128_000, supportsReasoning: false, providerId: 'antigravity' }
  ]
  assert.equal(
    didCliProxyModelCacheChange(signature, idAppeared),
    true,
    'populated -> an id set with a NEW model must report a change'
  )
  console.log('✓ populated -> a different id set reports a change (broadcast)')
}

// ---------------------------------------------------------------------------
// 4. populated -> same id set, different availability/facts: a provider
//    becoming healthy again (providerId reappearing on the same model id) or
//    a model's reported facts changing (context/effortLevels) between ticks
//    — must broadcast. This is the "real time based on background changes"
//    half of the user's report, not just the cold-boot half.
// ---------------------------------------------------------------------------

{
  const signature = cliProxyModelCacheSignature(populated)

  const differentProvider: Entry[] = [{ ...grok, providerId: 'xai-fallback' }, gpt]
  assert.equal(
    didCliProxyModelCacheChange(signature, differentProvider),
    true,
    'same id set, different providerId must report a change'
  )

  const differentContext: Entry[] = [{ ...grok, context: 512_000 }, gpt]
  assert.equal(
    didCliProxyModelCacheChange(signature, differentContext),
    true,
    'same id set, different context must report a change'
  )

  const differentEffortLevels: Entry[] = [{ ...grok, effortLevels: ['low', 'high'] }, gpt]
  assert.equal(
    didCliProxyModelCacheChange(signature, differentEffortLevels),
    true,
    'same id set, different effortLevels must report a change — e.g. a provider now reporting a ' +
      'richer/narrower thinking ladder for an already-known model'
  )

  console.log(
    '✓ populated -> same id set with different provider/context/effortLevels each report a change'
  )
}

// ---------------------------------------------------------------------------
// 5. Order-independence: two refreshes returning the SAME entries in a
//    DIFFERENT iteration order (Map insertion order across two separate
//    fetches is unspecified) must produce the SAME signature — otherwise the
//    guard would false-positive on every tick even when nothing changed.
// ---------------------------------------------------------------------------

{
  const forward = cliProxyModelCacheSignature([grok, gpt])
  const reversed = cliProxyModelCacheSignature([gpt, grok])
  assert.equal(
    forward,
    reversed,
    'cliProxyModelCacheSignature must be order-independent — Map iteration order across two ' +
      'separate fetches is unspecified and must never itself trigger a false-positive broadcast'
  )
  console.log('✓ cliProxyModelCacheSignature is order-independent')
}

// ---------------------------------------------------------------------------
// HONEST COVERAGE NOTE — what this harness does NOT prove:
//
// This file proves the pure DECISION (cliProxyModelCacheSignature /
// didCliProxyModelCacheChange) is correct in isolation. It does NOT exercise
// routingProxy/manager.ts's refreshAuthFiles wiring itself — that module
// imports `electron` (BrowserWindow, shell) transitively and cannot be
// booted by an offline script, the same constraint every other verify-*.ts
// harness in this repo is under (see e.g. verify-routing.ts's own header).
// Manually confirmed by reading manager.ts: refreshAuthFiles calls this
// decision function with `lastBroadcastCliProxyModelSignature` (module-level,
// persisted across ticks) immediately after `refreshCliProxyModelCache` +
// `persistCliProxyModelCache`, and only calls `setSnapshot({})` (the actual
// renderer-facing broadcast) when it returns true — updating the tracked
// signature in the same branch so the guard actually holds across ticks.
// startModelCacheRefresh's on-demand path (the picker-open case) updates the
// SAME module-level signature on its own successful broadcast, so the two
// paths can't immediately double-broadcast the same content on the very next
// 30s tick after an on-demand refresh. The end-to-end cold-boot TIMING itself
// (does a picker opened within the first ~30s of a real app launch actually
// see the live update) cannot be driven in this environment — there is no UI
// automation for the native Electron window, and CLAUDE.md forbids
// foregrounding the dev build during a build/test loop (open -g only) — so
// that remains verified by code-reading, not by a live run.
// ---------------------------------------------------------------------------

console.log('\nAll model-refresh assertions passed.')
