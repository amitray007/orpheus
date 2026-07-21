// ---------------------------------------------------------------------------
// selectableModelsStore — the single shared source for the selectable-model
// list (Claude + gated routed models) that every picker
// (DropdownChip/WorkspaceDrawer/SettingsDrawer) renders from.
//
// This module exists to fix two regressions introduced by model-routing unit
// 06:
//
//   BUG A — the picker rendered EMPTY on first paint (useState<[]>) and on
//   any IPC failure (.catch(() => setModels([]))), discarding the offline
//   guarantee src/main/models/selectable.ts implements (Claude must ALWAYS
//   be listed). Fixed here by claudeFallbackModels() — a pure, synchronous
//   function derived from the CLAUDE_MODEL_OPTIONS constant (never from
//   proxy/IPC state) — which seeds the store's initial value AND is what the
//   store falls back to on any fetch failure. Routed models layer in
//   ADDITIVELY on top of this fallback once/if the async fetch resolves.
//
//   BUG B — every DropdownChip instance (model, effort, and any custom
//   dropdown chips) called useSelectableModels() unconditionally, so a
//   workspace mount fired N redundant models:listSelectable IPC round-trips
//   (one per chip), even for chips that never touch the model list. Fixed by
//   (1) gating the fetch behind an explicit `enabled` flag in the hook
//   (src/renderer/src/lib/useSelectableModels.ts) so only the actual model
//   chip/drawer callers ever trigger a fetch, and (2) coalescing concurrent
//   requests for the SAME currentModelId here so WorkspaceDrawer/
//   SettingsDrawer/DropdownChip mounted at once still produce one IPC call.
//
// Cache key is `currentModelId ?? ''` — the server-side gating result only
// depends on (a) proxy/provider health, which is process-global and doesn't
// vary per caller, and (b) currentModelId, which is threaded through solely
// to keep an already-selected-but-now-unavailable model represented (see
// models:listSelectable's own doc comment). Invalidated on every
// routingProxy:onSnapshot push (proxy/provider health changed) rather than
// polled, reusing the existing push mechanism from src/main/routingProxy/manager.ts.
// ---------------------------------------------------------------------------

import { useCallback, useSyncExternalStore } from 'react'
import { CLAUDE_MODEL_OPTIONS, type SelectableModel } from '@shared/types'

const CLAUDE_PROVIDER_ID = 'claude'
const CLAUDE_PROVIDER_LABEL = 'Claude'

/**
 * Pure, synchronous, zero-IPC fallback: the full built-in Claude model list,
 * always available. This is what the picker renders on first paint (before
 * any async fetch resolves) and what it falls back to if the IPC call fails
 * outright — i.e. exactly what the picker looked like before unit 06. Never
 * derived from proxy/provider state; a caller passing an already-selected
 * routed model id gets it appended, marked unavailable, so a stored setting
 * is never silently dropped even while the routed list itself is unreachable
 * (mirrors buildSelectableModels' own "never lose the user's setting" rule).
 */
export function claudeFallbackModels(currentModelId?: string): SelectableModel[] {
  const claude: SelectableModel[] = CLAUDE_MODEL_OPTIONS.map((o) => ({
    id: o.value,
    label: o.label,
    providerId: CLAUDE_PROVIDER_ID,
    providerLabel: CLAUDE_PROVIDER_LABEL,
    isClaude: true,
    available: true,
    contextWindow: null,
    effortLevels: null,
    provisional: false
  }))
  if (currentModelId && !CLAUDE_MODEL_OPTIONS.some((o) => o.value === currentModelId)) {
    claude.push({
      id: currentModelId,
      label: currentModelId,
      providerId: 'unknown',
      providerLabel: 'Unavailable',
      isClaude: false,
      available: false,
      contextWindow: null,
      effortLevels: null,
      provisional: false
    })
  }
  return claude
}

export interface Entry {
  models: SelectableModel[]
  loading: boolean
}

const cacheKey = (currentModelId?: string): string => currentModelId ?? ''

const store = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()
// One in-flight IPC promise per key so concurrent mounts (DropdownChip +
// WorkspaceDrawer + SettingsDrawer all asking for the same currentModelId)
// coalesce into a single models:listSelectable round-trip.
const inFlight = new Map<string, Promise<void>>()

// Memoized disabled-path snapshot per key — useSyncExternalStore requires
// getSnapshot to return a STABLE reference when nothing changed, or it loops
// re-rendering forever. Kept separate from `store` (the enabled/fetched
// cache) so a disabled caller never seeds/triggers the real fetch machinery.
//
// IMPORTANT — this is strictly a first-paint/never-fetched placeholder. It
// must never be allowed to SHADOW a real (enabled, fetched) entry that
// exists for the same key: resolveDisabledSnapshot() below always checks
// `store` first and returns the live entry when one is present, only falling
// back to (and memoizing) the synchronous Claude-only snapshot when nothing
// live exists yet. invalidateAll() clears this map on every proxy/health
// push so a stale placeholder can never survive a state change either — it
// is re-derived (and re-checked against `store`) the next time it's read.
const disabledSnapshots = new Map<string, Entry>()

/**
 * Pure decision logic for the disabled-path cache, factored out of module
 * state so it's independently testable (scripts/verify-model-picker.ts)
 * without React/useSyncExternalStore: given the two caches, a key, and an
 * optional currentModelId, decide what a disabled caller should render.
 *
 *   1. If `live` (the enabled/fetched cache) already has an entry for this
 *      key, return it — live data always wins, a memoized fallback can never
 *      shadow it.
 *   2. Otherwise return the memoized fallback for this key, creating
 *      (and caching) one via claudeFallbackModels() if this is the first
 *      read for this key since the last invalidation.
 */
export function resolveDisabledSnapshot(
  live: Map<string, Entry>,
  fallbackCache: Map<string, Entry>,
  key: string,
  currentModelId?: string
): Entry {
  const liveEntry = live.get(key)
  if (liveEntry) return liveEntry
  let entry = fallbackCache.get(key)
  if (!entry) {
    entry = { models: claudeFallbackModels(currentModelId), loading: false }
    fallbackCache.set(key, entry)
  }
  return entry
}

function disabledSnapshot(key: string, currentModelId?: string): Entry {
  return resolveDisabledSnapshot(store, disabledSnapshots, key, currentModelId)
}

function notify(key: string): void {
  listeners.get(key)?.forEach((fn) => fn())
}

function subscribe(key: string, fn: () => void): () => void {
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(key)
  }
}

function getEntry(key: string, currentModelId?: string): Entry {
  const existing = store.get(key)
  if (existing) return existing
  const seeded: Entry = { models: claudeFallbackModels(currentModelId), loading: true }
  store.set(key, seeded)
  return seeded
}

function setEntry(key: string, entry: Entry): void {
  const prev = store.get(key)
  if (prev && prev.models === entry.models && prev.loading === entry.loading) return
  store.set(key, entry)
  notify(key)
}

function fetchKey(key: string, currentModelId?: string): void {
  if (inFlight.has(key)) return
  const request = window.api.models
    .listSelectable(currentModelId)
    .then((list) => {
      setEntry(key, { models: list, loading: false })
    })
    .catch((err) => {
      console.error('[selectableModelsStore] models:listSelectable failed', err)
      // Never fall back to empty — preserve the Claude-only, fully
      // functional picker unit 06 must not regress.
      setEntry(key, { models: claudeFallbackModels(currentModelId), loading: false })
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, request)
}

/** Invalidate every cached entry and refetch the ones with active
 *  subscribers — called on every routingProxy:onSnapshot push (proxy
 *  started/stopped, provider connected/disconnected) instead of polling.
 *  Also clears disabledSnapshots: a memoized disabled-path placeholder must
 *  not be able to outlive a proxy/health change any more than a real entry
 *  can — the next read re-derives it (and, per disabledSnapshot()'s own
 *  live-data check, immediately prefers a fresh `store` entry once one
 *  exists for that key). */
function invalidateAll(): void {
  for (const key of store.keys()) {
    if ((listeners.get(key)?.size ?? 0) > 0) {
      fetchKey(key, key === '' ? undefined : key)
    } else {
      store.delete(key)
    }
  }
  disabledSnapshots.clear()
}

let pushSubscribed = false
function ensurePushSubscribed(): void {
  if (pushSubscribed) return
  pushSubscribed = true
  window.api.routingProxy.onSnapshot(() => invalidateAll())
}

export interface UseSelectableModelsResult {
  models: SelectableModel[]
  loading: boolean
}

/**
 * Subscribe to the shared selectable-model list for `currentModelId`. When
 * `enabled` is false (default true), this is a pure no-op: no IPC, no
 * subscription, and the return value is the synchronous Claude-only fallback
 * — for callers that don't render a model picker at all (e.g. non-model
 * footer chips), avoiding BUG B's redundant per-mount fetch entirely while
 * still respecting the Rules of Hooks (the hook itself is always called;
 * only its internal effect/IPC is gated).
 */
export function useSelectableModelsStore(
  currentModelId: string | undefined,
  enabled: boolean
): UseSelectableModelsResult {
  const key = cacheKey(currentModelId)

  // Stable across renders (only changes identity when key/enabled actually
  // change) so useSyncExternalStore doesn't tear down + resubscribe on every
  // render — it only calls `subscribe` again when this callback's identity
  // changes.
  const subscribeFn = useCallback(
    (fn: () => void): (() => void) => {
      if (!enabled) return () => {}
      ensurePushSubscribed()
      fetchKey(key, currentModelId)
      return subscribe(key, fn)
    },
    [enabled, key, currentModelId]
  )
  const getSnapshot = useCallback((): Entry => {
    if (!enabled) return disabledSnapshot(key, currentModelId)
    return getEntry(key, currentModelId)
  }, [enabled, key, currentModelId])

  const entry = useSyncExternalStore(subscribeFn, getSnapshot, getSnapshot)
  return { models: entry.models, loading: entry.loading }
}
