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
//   BUG C — the cold-boot picker-staleness bug (user-reported: opening a
//   workspace quickly on app launch showed Claude-only until switching away
//   and back). The main-process half was fixed by making
//   routingProxy/manager.ts's refreshAuthFiles broadcast a SECOND time once
//   the cliproxy model catalog actually populates. That alone wasn't enough:
//   fetchKey's coalescing used to `if (inFlight.has(key)) return` —
//   unconditionally DROPPING a later request (including the invalidation
//   that push carries) whenever a fetch for the same key was already in
//   flight. On a fast cold boot, DropdownChip's own mount-time fetch (reading
//   the still-empty cache) and the catalog-populate push landed close enough
//   together that the push's invalidation got dropped into the in-flight
//   mount fetch — which then resolved with the STALE empty-cache result and
//   was treated as final. Fixed by shouldStartFetchNow/shouldRefetchAfterSettle
//   below: a request arriving while one is in flight is remembered
//   (pendingRefetch) and re-issued the instant the in-flight one settles, so
//   the LAST request always wins instead of being silently swallowed.
//
//   BUG D — the "Refresh models" button's flyout looked like it was "stuck
//   in a loop and keeps going" (user-reported, model-routing unit 12
//   follow-up). Root cause: setEntry's own no-op guard compared array
//   REFERENCES (`prev.models === entry.models`) — but `entry.models` is a
//   brand-new array returned by every models:listSelectable IPC call, so
//   that comparison was ALWAYS false and the guard never actually fired.
//   Every routingProxy:onSnapshot push (which fires at least once every 30s
//   regardless of whether anything changed — authFilesCheckedAt alone always
//   ticks) triggered invalidateAll -> fetchKey -> setEntry -> an UNCONDITIONAL
//   notify(), even when the resolved model list was byte-for-byte identical
//   to what was already showing. That churn was invisible before this unit
//   (nothing was listening for it), but DropdownChip.tsx's new "keep the
//   open flyout in sync" effect (added alongside this button) DOES react to
//   it — pushing a redundant overlay:update into the open popover on every
//   30s tick, which read as the flyout perpetually "still refreshing."
//   Fixed by comparing CONTENT (selectableModelsSignature/
//   didSelectableModelsChange below), not array identity — notify() now only
//   fires when the model list (or the loading flag) actually changed.
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
import {
  CLAUDE_MODEL_OPTIONS,
  CLAUDE_BUILTIN_EFFORT_LEVELS,
  type SelectableModel
} from '@shared/types'

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
    // Real per-model levels (model-routing unit 11) — mirrors
    // selectable.ts's claudeEntries() so the zero-IPC fallback never regresses
    // to offering effort levels a model doesn't actually support.
    effortLevels: CLAUDE_BUILTIN_EFFORT_LEVELS[o.value] ?? null,
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
// Keys that got a SECOND fetchKey() call while their first was still in
// flight — see shouldStartFetchNow/shouldRefetchAfterSettle below for why
// this exists (the cold-boot picker-staleness bug's renderer-side half).
const pendingRefetch = new Set<string>()

// ---------------------------------------------------------------------------
// shouldStartFetchNow / shouldRefetchAfterSettle — the coalescing decision
// fetchKey makes, pulled out as pure functions so
// scripts/verify-model-picker.ts can assert it without React/IPC.
//
// THE BUG this fixes: fetchKey used to unconditionally `return` when a fetch
// for the same key was already in flight — dropping ANY later request
// outright, including one triggered by invalidateAll() (a real
// routingProxy:onSnapshot push telling the store fresh data exists). On a
// fast cold boot the mount-time fetch (reading a still-empty cliproxy model
// cache) and the catalog-populate push can land close enough together that
// the push's invalidation arrives WHILE the stale mount fetch is still in
// flight — the old code silently dropped that invalidation, the stale fetch
// then resolved and was treated as final, and the picker was stuck
// Claude-only until an unrelated remount forced a fresh read.
//
// Fixed by never dropping a request: one requested while another is in
// flight is remembered (pendingRefetch) instead, and re-issued the instant
// the in-flight one settles — so the LAST request always wins, while
// concurrent callers for the same key still coalesce into one round-trip at
// a time (never two fetches racing in parallel for the same key).
// ---------------------------------------------------------------------------

/** True when a fetch for this key should start immediately — false when one
 *  is already in flight (the caller must instead mark the key pending). */
export function shouldStartFetchNow(isInFlight: boolean): boolean {
  return !isInFlight
}

/** True when an in-flight fetch's settlement should immediately trigger one
 *  more fetch for the same key — exactly when a request arrived while it was
 *  running (wasPending). Consuming the flag (the caller clears it via
 *  Set.delete, which doubles as this input) guarantees at most ONE queued
 *  re-fetch regardless of how many requests arrived in the meantime — a
 *  flag, not a counter — so steady state can't loop. */
export function shouldRefetchAfterSettle(wasPending: boolean): boolean {
  return wasPending
}

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

// ---------------------------------------------------------------------------
// selectableModelsSignature / didSelectableModelsChange — the content-based
// no-op guard for setEntry, fixing BUG D (this file's own header comment).
// Order-sensitive (never sorted): the server's own group/model ordering is
// stable for a given input (buildSelectableModels never shuffles), so two
// resolutions of an UNCHANGED list always produce lists in the same order —
// no sort needed, and sorting would hide a genuine reordering as "no
// change" when the caller's rendered list actually did reorder.
// ---------------------------------------------------------------------------

/** Cheap, stable digest of everything a picker's render actually depends on
 *  for a given model — id/providerId/available/contextWindow/effortLevels.
 *  Deliberately omits `label`/`providerLabel`/`isClaude`/`provisional`: the
 *  first two are derived 1:1 from id/providerId server-side and never vary
 *  independently, and provisional/isClaude are structural facts about an id
 *  that also never change independently of the fields already included —
 *  including them would only make the signature more expensive to compute
 *  without ever catching a change these fields alone wouldn't already. */
export function selectableModelsSignature(models: SelectableModel[]): string {
  return models
    .map(
      (m) =>
        `${m.id}|${m.providerId}|${m.available}|${m.contextWindow ?? ''}|${(m.effortLevels ?? []).join(',')}`
    )
    .join(';')
}

/** True when `next` represents a real change from `prev` — either the
 *  loading flag flipped, or the resolved model list's content differs. False
 *  when nothing meaningful changed, even though `next.models` is (as it
 *  always is, from a fresh IPC response) a DIFFERENT array reference than
 *  `prev.models` — see this file's own BUG D writeup for why comparing
 *  those references directly was the actual defect. */
export function didSelectableModelsChange(prev: Entry | undefined, next: Entry): boolean {
  if (!prev) return true
  if (prev.loading !== next.loading) return true
  return selectableModelsSignature(prev.models) !== selectableModelsSignature(next.models)
}

function setEntry(key: string, entry: Entry): void {
  const prev = store.get(key)
  if (!didSelectableModelsChange(prev, entry)) return
  store.set(key, entry)
  notify(key)
}

function fetchKey(key: string, currentModelId?: string): void {
  if (!shouldStartFetchNow(inFlight.has(key))) {
    // A fetch for this key is already in flight and started against
    // whatever state existed at THAT moment — this newer request knows
    // something may have changed since, so it can't just be dropped (see
    // this file's header comment on the bug this fixes). Record it instead;
    // the .finally() below re-issues it once the in-flight one settles.
    pendingRefetch.add(key)
    return
  }
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
      // Set.delete returns whether the key was present — doubles as
      // "wasPending" AND clears the flag in one call, so a steady state with
      // no further requests can't loop.
      const wasPending = pendingRefetch.delete(key)
      if (shouldRefetchAfterSettle(wasPending)) {
        fetchKey(key, currentModelId)
      }
    })
  inFlight.set(key, request)
}

/**
 * Imperative refetch for `currentModelId`'s cache entry — defense-in-depth
 * for the cold-boot/background-refresh picker-staleness bug: even if a
 * routingProxy:onSnapshot push is ever missed for some reason, the moment a
 * caller actually needs fresh data (DropdownChip's open handler) it can ask
 * directly instead of relying purely on push timing. Reuses fetchKey
 * verbatim — same coalescing, not a parallel fetch path — so a concurrent
 * push-triggered invalidation and this call for the same key still produce
 * at most one round-trip at a time.
 */
export function refetchSelectableModels(currentModelId?: string): void {
  fetchKey(cacheKey(currentModelId), currentModelId)
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
