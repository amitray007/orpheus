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

// Synchronous, zero-IPC fallback describing Claude — mirrors
// src/main/harness/registry.ts's resolveHarness()'s NEVER-THROWS contract:
// an unknown/stale harnessId (or the list not having loaded yet) must
// resolve to something a chip can safely render against, not undefined. The
// renderer cannot import the real CLAUDE_DESCRIPTOR (main-process-only —
// check:arch forbids it), so this is a minimal structural stand-in carrying
// only the fields HarnessSummary declares.
const CLAUDE_FALLBACK_SUMMARY: HarnessSummary = {
  id: 'claude',
  label: 'Claude Code',
  binary: 'claude',
  capabilities: {
    structuredStatus: true,
    transcript: true,
    resume: true,
    fork: true,
    usage: true,
    hooks: true,
    inlineSettingsJson: true,
    modelRouting: true
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
 * Resolves `harnessId` to its `HarnessSummary` within an already-fetched
 * list — or the Claude fallback when the id is unknown/absent, mirroring
 * main's resolveHarness(). Exported standalone (not just via the hook) so
 * non-component callers (or future non-React code) can reuse the same
 * fallback semantics without duplicating them.
 */
export function resolveHarnessSummary(
  harnesses: HarnessSummary[],
  harnessId: HarnessId | string | null | undefined
): HarnessSummary {
  if (!harnessId) return CLAUDE_FALLBACK_SUMMARY
  return harnesses.find((h) => h.id === harnessId) ?? CLAUDE_FALLBACK_SUMMARY
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
 * Resolves a single workspace's harness descriptor summary, reactive to the
 * list still loading. Returns the Claude fallback (never undefined) while
 * loading or for an unknown id — callers never need a null-check dance
 * before reading `.capabilities`/`.curated`.
 */
export function useHarnessForWorkspace(
  harnessId: HarnessId | string | null | undefined
): HarnessSummary {
  const { harnesses } = useHarnessList()
  return useMemo(() => resolveHarnessSummary(harnesses, harnessId), [harnesses, harnessId])
}
