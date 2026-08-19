// ---------------------------------------------------------------------------
// src/renderer/src/lib/harnessStore.ts
//
// Renderer-side cache of the harness descriptor list (`harness:list` IPC —
// already delivered, unchanged by this file) plus a resolver from a
// workspace's `harnessId` to its `HarnessSummary`. B1 of the multi-harness
// migration: before this, the renderer read harness capabilities in ZERO
// places and never read `WorkspaceRecord.harnessId` anywhere — every footer
// chip silently assumed Claude. No new IPC needed: `harness:list` already
// carries `capabilities`/`curated` for every registered harness (see
// src/main/ipc/harnessSettings.ts's toSummary).
//
// One shared fetch-once-and-cache, mirroring selectableModelsStore.ts's
// shape (a module-level cache + listener set behind useSyncExternalStore)
// rather than createPerKeyStore: the harness LIST is one global value with
// no per-workspace key, so there's nothing to key a PerKeyStore by here —
// the per-workspace resolution (useHarnessForWorkspace below) is a plain
// derived lookup over that one cached list, not a second store.
// ---------------------------------------------------------------------------

import { useMemo, useSyncExternalStore } from 'react'
import type { HarnessSummary } from '@shared/types'
import type { HarnessId } from '@shared/harness/types'

// Synchronous, zero-IPC fallback used whenever a real descriptor cannot be
// resolved — mirrors src/main/harness/registry.ts's resolveHarness()'s
// NEVER-THROWS contract: an unknown/stale harnessId (or the list not having
// loaded yet) must resolve to something a chip can safely render against,
// not undefined. The renderer cannot import the real CLAUDE_DESCRIPTOR
// (main-process-only — check:arch forbids it), so this is a minimal
// structural stand-in carrying only the fields HarnessSummary declares.
//
// CAPABILITIES ARE ALL-FALSE, DELIBERATELY (C4, support-multi-harness) — an
// earlier revision hardcoded this to Claude's real capabilities (all-true),
// on the theory that "we don't know yet, so assume the common case." That
// was wrong: id/label/binary/icon are cosmetic (a chip can safely show
// "Claude Code" as a placeholder label), but `capabilities` gates real
// affordances (live activity dots, transcript-derived titles, usage
// hover-card fetches) — claiming a capability the app cannot actually back
// is the exact failure mode HarnessCapabilities exists to prevent (see
// ./types.ts's file-header rule). A harness whose capabilities are not yet
// known (list still loading) or durably unknown (id not found in a loaded
// list) must grant NOTHING, matching the "hide the affordance rather than
// show it broken" rule stated on HarnessCapabilities itself. Cosmetic
// fields keep their Claude-shaped defaults only because nothing gates
// behavior on them; do not treat that as license to add another
// behavior-gating field here without the same all-false discipline.
const UNKNOWN_CAPABILITIES_SUMMARY: HarnessSummary = {
  id: 'claude',
  label: 'Claude Code',
  binary: 'claude',
  capabilities: {
    structuredStatus: false,
    transcript: false,
    resume: false,
    fork: false,
    usage: false,
    hooks: false,
    inlineSettingsJson: false,
    modelRouting: false
  },
  icon: 'claude'
  // defaultArgs/curated intentionally omitted (both optional on
  // HarnessSummary) — a caller resolving against this fallback only for
  // capabilities/id/label never needed them, and fabricating curated
  // model/effort fields here would risk a chip rendering a live-apply
  // affordance for a fallback that isn't backed by a real descriptor.
}

interface State {
  harnesses: HarnessSummary[]
  loading: boolean
}

let state: State = { harnesses: [], loading: true }
const listeners = new Set<() => void>()
let fetchStarted = false

function setState(next: State): void {
  state = next
  listeners.forEach((fn) => fn())
}

function ensureFetched(): void {
  if (fetchStarted) return
  fetchStarted = true
  window.api.harness
    .list()
    .then((harnesses) => setState({ harnesses, loading: false }))
    .catch((e) => {
      console.error('[harnessStore] harness:list failed', e)
      // Degrade to "loaded, empty list" rather than looping/retrying —
      // resolveHarnessSummary's fallback-to-Claude below still makes every
      // caller usable even with an empty list.
      setState({ harnesses: [], loading: false })
    })
}

function subscribe(fn: () => void): () => void {
  ensureFetched()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function getSnapshot(): State {
  return state
}

/**
 * Whether `harnessId` names a REGISTERED harness within an already-fetched
 * `harnesses` list — i.e. whether resolveHarnessSummary below would return a
 * real descriptor rather than the unknown-capabilities fallback. Exported so
 * a caller that needs to tell "durably unknown id" apart from "list still
 * loading" can check this directly instead of comparing summaries by
 * reference/identity. Note: an empty `harnesses` list (fetch still pending,
 * or harness:list failed) makes every id resolve to `false` here too — see
 * useHarnessLoading below for the loading-vs-durably-unknown distinction.
 */
export function isHarnessIdKnown(
  harnesses: HarnessSummary[],
  harnessId: HarnessId | string | null | undefined
): boolean {
  if (!harnessId) return false
  return harnesses.some((h) => h.id === harnessId)
}

/**
 * Resolves `harnessId` to its `HarnessSummary` within an already-fetched
 * list — or the unknown-capabilities fallback (see
 * UNKNOWN_CAPABILITIES_SUMMARY above) when the id is unknown/absent,
 * mirroring main's resolveHarness()'s never-throws contract (but NOT its
 * capability values — main's resolveHarness falls back to the real Claude
 * descriptor because main-process code always has the real registry
 * in-process; the renderer, by contrast, may be calling this BEFORE the
 * list has loaded or WITH a stale id the list never contained, so it must
 * not claim any capability it cannot actually back — see this module's
 * header comment on the fallback constant). Exported standalone (not just
 * via the hook) so non-component callers (or future non-React code, or a
 * pure verifier) can reuse the same fallback semantics without duplicating
 * them.
 */
export function resolveHarnessSummary(
  harnesses: HarnessSummary[],
  harnessId: HarnessId | string | null | undefined
): HarnessSummary {
  if (!harnessId) return UNKNOWN_CAPABILITIES_SUMMARY
  return harnesses.find((h) => h.id === harnessId) ?? UNKNOWN_CAPABILITIES_SUMMARY
}

/** Subscribe to the full harness list + loading flag. Triggers the
 *  fetch-once on first subscriber; every later caller shares the same
 *  cached result until the app reloads (harness descriptors are static
 *  build-time data — no push channel invalidates this, unlike
 *  selectableModelsStore's proxy-health-driven refetching). */
export function useHarnessList(): State {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Reactive `loading` flag alone, for callers that need to distinguish "the
 * list hasn't resolved yet, capabilities are transiently unknown — hide the
 * affordance for a few hundred ms rather than render a hard false" from "the
 * list resolved and this id just isn't in it, capabilities are durably
 * unknown for this id." Both situations make resolveHarnessSummary return
 * the same all-false fallback (correct: neither should grant a capability),
 * but a caller like Sidebar's activity dot may want to suppress a flash of
 * "no activity" during the boot window specifically, which requires telling
 * the two apart.
 */
export function useHarnessListLoading(): boolean {
  return useHarnessList().loading
}

/**
 * Resolves a single workspace's harness descriptor summary, reactive to the
 * list still loading. Returns the unknown-capabilities fallback (never
 * undefined) while loading or for an unknown id — callers never need a
 * null-check dance before reading `.capabilities`/`.curated`, but MUST NOT
 * assume a truthy return means the capabilities are real; pair with
 * useHarnessListLoading (and/or isHarnessIdKnown) when that distinction
 * matters for the affordance being gated.
 */
export function useHarnessForWorkspace(
  harnessId: HarnessId | string | null | undefined
): HarnessSummary {
  const { harnesses } = useHarnessList()
  return useMemo(() => resolveHarnessSummary(harnesses, harnessId), [harnesses, harnessId])
}
