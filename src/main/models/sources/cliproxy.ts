// ---------------------------------------------------------------------------
// src/main/models/sources/cliproxy.ts — CLIProxyAPI-backed model source
// (unit 05, provider framework, part D)
//
// Sources live routed-provider model facts (context_length, thinking levels)
// from the managed CLIProxyAPI process's own management API:
//   GET /v0/management/model-definitions/:channel
// where :channel is a provider id from providers/registry.ts (codex, xai,
// gemini, openrouter, ...). Appended to registry.ts's SOURCES AFTER
// modelsDevSource — builtinClaudeSource stays index 0, unchanged; this source
// is consulted last, so it can only ever fill in facts about ids neither the
// builtin Claude source nor models.dev already resolved.
//
// MUST DEGRADE GRACEFULLY: ModelSource.resolve() must be synchronous and
// perform no I/O (see models/types.ts's own doc comment on the interface) —
// exactly like modelsDevSource, this source populates an in-memory cache
// out-of-band via refreshCliProxyModelCache(), and resolve() only ever reads
// that cache. When the proxy is stopped/unreachable, refreshCliProxyModelCache
// fails silently and resolve() keeps returning null for everything (never
// throws, never blocks) — third-party routed models simply degrade to
// "known id, unknown context/pricing" exactly like an unresolved models.dev
// id, which downstream consumers already render as an explicit unknown
// state, never a fabricated number.
// ---------------------------------------------------------------------------

import type { ModelInfo, ModelSource } from '../types'
import { PROVIDERS } from '../../routingProxy/providers/registry'

// ---------------------------------------------------------------------------
// CLIProxyAPI's GET /v0/management/model-definitions/:channel response shape.
// Verified against the unit spec's documented fields: context_length,
// thinking.{min,max,levels}. Exact response envelope (bare array vs
// {models:[...]}) is defensively handled the same way authFiles.ts already
// does for auth-files.
// ---------------------------------------------------------------------------

type CliProxyModelDefinition = {
  name?: string
  id?: string
  context_length?: number
  thinking?: { levels?: string[] }
}

/** Read-only accessor for the current cache, so other main-process modules
 *  (the model-picker IPC handler, unit 06) can enumerate every routed model
 *  CLIProxyAPI currently reports, grouped by provider — without duplicating
 *  the fetch/refresh logic. Returns a shallow copy of entries keyed by
 *  model id; never mutates the live cache. */
export function listCliProxyModelCacheEntries(): Array<{ modelId: string } & CachedEntry> {
  return Array.from(cache.entries()).map(([modelId, entry]) => ({ modelId, ...entry }))
}

type CachedEntry = {
  context: number | null
  supportsReasoning: boolean
  /** Which provider channel (registry.ts id, e.g. 'codex'/'xai') this model
   *  was fetched from — populated by refreshCliProxyModelCache, used by the
   *  model-picker IPC (unit 06) to group selectable models by provider.
   *  Optional so existing setCliProxyModelCacheForTests(...) call sites that
   *  predate this field keep compiling unchanged. */
  providerId?: string
  /** Real thinking/effort levels reported by CLIProxyAPI's model-definitions
   *  endpoint (thinking.levels), e.g. ['low','medium','high']. Null/undefined
   *  when the model has no thinking levels — the picker must never fabricate
   *  a generic effort list for a model that doesn't report one. */
  effortLevels?: string[] | null
}

// modelId -> entry, flattened across every provider channel queried so far.
// Populated by refreshCliProxyModelCache(); empty (not null) until the first
// successful fetch — an empty cache and a "proxy unreachable" cache look
// identical to resolve(), which is correct: both mean "nothing known yet".
let cache = new Map<string, CachedEntry>()

export interface CliProxyModelSourceDeps {
  fetchJson: (url: string, headers: Record<string, string>) => Promise<unknown>
}

async function realFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return res.json()
}

export function defaultCliProxyModelSourceDeps(): CliProxyModelSourceDeps {
  return { fetchJson: realFetchJson }
}

function extractDefinitions(data: unknown): CliProxyModelDefinition[] {
  if (Array.isArray(data)) return data as CliProxyModelDefinition[]
  const models = (data as { models?: unknown[] } | null)?.models
  if (Array.isArray(models)) return models as CliProxyModelDefinition[]
  return []
}

/**
 * Refresh the in-memory cache by querying model-definitions for every known
 * provider channel. Never throws — each channel is fetched independently and
 * a failure on one channel (including "proxy not running at all") just
 * leaves that channel's entries stale/absent; the whole call resolves either
 * way. Fire-and-forget, mirrors refreshModelsDevCache's contract exactly.
 *
 * `onProviderDone` (model-routing unit 12) is an OPTIONAL step-progress hook
 * — called once per provider channel, after that channel's attempt settles
 * (success OR failure; a failed/unreachable channel still counts as "this
 * step is done", never leaves the caller's progress stuck waiting on a step
 * that will never report). Only routingProxy/manager.ts's MANUAL refresh
 * path (refreshAuthFilesNow, behind the pinned "Refresh models" button)
 * supplies a real callback here; the automatic 30s tick calls this with no
 * callback at all, so it can never become a second source of progress-push
 * churn — see that module's own doc comment.
 */
export async function refreshCliProxyModelCache(
  baseUrl: string,
  managementSecret: string | null,
  deps: CliProxyModelSourceDeps = defaultCliProxyModelSourceDeps(),
  onProviderDone?: () => void
): Promise<void> {
  if (!managementSecret) return // no secret yet (proxy never started this run) — nothing to fetch

  const next = new Map<string, CachedEntry>()
  let anySucceeded = false

  for (const provider of PROVIDERS) {
    try {
      const url = new URL(`/v0/management/model-definitions/${provider.id}`, baseUrl).toString()
      const data = await deps.fetchJson(url, { Authorization: `Bearer ${managementSecret}` })
      const definitions = extractDefinitions(data)
      for (const def of definitions) {
        const id = def.name ?? def.id
        if (!id) continue
        const levels =
          Array.isArray(def.thinking?.levels) && def.thinking.levels.length > 0
            ? def.thinking.levels
            : null
        next.set(id, {
          context: typeof def.context_length === 'number' ? def.context_length : null,
          supportsReasoning: levels !== null,
          providerId: provider.id,
          effortLevels: levels
        })
      }
      anySucceeded = true
    } catch {
      // This channel is unreachable/unsupported/not configured — skip it.
      // Never throws out of the loop; other channels still get a chance.
    } finally {
      onProviderDone?.()
    }
  }

  // Only replace the cache if at least one channel actually answered — a
  // proxy that's fully down (every channel throws) must leave the previous
  // cache intact rather than wiping known facts just because this refresh
  // cycle couldn't reach anything.
  if (anySucceeded) cache = next
}

// ---------------------------------------------------------------------------
// shouldRefreshCliProxyModelCache — pure gating decision for the on-demand
// refresh (issue-2 fix in routingProxy/manager.ts's ensureCliProxyModelCacheFresh).
// Factored out as a pure function (no cache/timer state, everything passed
// in) so it's independently assertable by an offline harness without
// booting Electron — manager.ts imports `electron` transitively and can't be
// exercised by scripts/verify-*.ts directly.
//
// Refresh only fires when ALL of:
//   - the cache is currently empty (cacheSize === 0) — a populated cache
//     never needs an on-demand kick; the existing 30s interval keeps it warm
//   - the proxy is actually running (isProxyRunning) — nothing to query otherwise
//   - a management secret exists (hasManagementSecret) — refreshCliProxyModelCache
//     itself no-ops without one, but checking here avoids even attempting
//     the network call
//   - no refresh is already in flight (isRefreshInFlight) — one attempt at a
//     time is enough
//   - at least minIntervalMs has elapsed since lastAttemptAt — bounds retry
//     frequency so a picker opened repeatedly against a genuinely-down proxy
//     can't hammer it
// ---------------------------------------------------------------------------

export interface ShouldRefreshCliProxyModelCacheInput {
  cacheSize: number
  isProxyRunning: boolean
  hasManagementSecret: boolean
  isRefreshInFlight: boolean
  lastAttemptAt: number
  now: number
  minIntervalMs: number
}

export function shouldRefreshCliProxyModelCache(
  input: ShouldRefreshCliProxyModelCacheInput
): boolean {
  if (input.cacheSize > 0) return false
  if (!input.isProxyRunning) return false
  if (!input.hasManagementSecret) return false
  if (input.isRefreshInFlight) return false
  if (input.now - input.lastAttemptAt < input.minIntervalMs) return false
  return true
}

/** Test-only: replace the cache directly, bypassing the network fetch. */
export function setCliProxyModelCacheForTests(entries: Record<string, CachedEntry> | null): void {
  const next = new Map<string, CachedEntry>()
  if (entries) {
    for (const [id, entry] of Object.entries(entries)) {
      next.set(id, entry)
    }
  }
  cache = next
}

// ---------------------------------------------------------------------------
// cliProxyModelCacheSignature / didCliProxyModelCacheChange — the cold-boot
// picker-staleness fix (routingProxy/manager.ts's refreshAuthFiles). That
// function's automatic 30s-tick path used to broadcast routingProxy:onSnapshot
// BEFORE refreshCliProxyModelCache populated the cache, and never again once
// it did — so a picker mounted before the first tick's fetch resolved stayed
// on the empty-cache (Claude-only) result forever, until an unrelated remount
// forced a fresh fetch against the now-warm cache. The fix is a SECOND,
// content-guarded broadcast fired right after the cache populates — guarded
// so the steady-state 30s tick doesn't re-broadcast (and refetch every
// mounted picker) when nothing actually changed.
//
// cliProxyModelCacheSignature is the pure, stable, order-independent digest
// of "everything a picker's SelectableModel rendering could depend on" for
// the current cache contents — modelId, providerId, context, supportsReasoning,
// effortLevels. didCliProxyModelCacheChange wraps the obvious comparison
// (previous signature vs. a fresh one) as its own named decision so
// manager.ts's call site reads as intent, not string-diffing, and so it's
// independently assertable by scripts/verify-model-refresh.ts without
// booting Electron (this module has no electron/DB import).
// ---------------------------------------------------------------------------

/** Order-independent so two refreshes that return the same entries in a
 *  different iteration order (Map insertion order, unspecified across
 *  fetches) still produce an identical signature. */
export function cliProxyModelCacheSignature(
  entries: ReturnType<typeof listCliProxyModelCacheEntries>
): string {
  return entries
    .map(
      (e) =>
        `${e.modelId}|${e.providerId ?? ''}|${e.context ?? ''}|${e.supportsReasoning}|${(e.effortLevels ?? []).join(',')}`
    )
    .sort()
    .join(';')
}

/** True when `nextEntries`' content differs from `previousSignature` — the
 *  broadcast-worthy cases: cold-boot empty->populated, a model id appearing
 *  or disappearing, or an existing id's provider/context/reasoning/effort
 *  facts changing (a provider becoming healthy, a model's reported levels
 *  changing between ticks). False when nothing changed (steady-state tick),
 *  which is the churn-loop guard — refreshAuthFiles' 30s timer calls this on
 *  every tick once the proxy is running, and once the cache is warm the
 *  signature stops changing. */
export function didCliProxyModelCacheChange(
  previousSignature: string | null,
  nextEntries: ReturnType<typeof listCliProxyModelCacheEntries>
): boolean {
  return cliProxyModelCacheSignature(nextEntries) !== previousSignature
}

/** Snapshot the current cache as a plain object, keyed by model id — the
 *  shape routingProxy/manager.ts persists to disk after a successful
 *  refresh (see models/cliProxyModelCachePersistence.ts). Kept separate from
 *  listCliProxyModelCacheEntries (which returns an array shape tailored to
 *  buildSelectableModels' input) so the persistence wire shape can evolve
 *  independently of that consumer. */
export function snapshotCliProxyModelCache(): Record<string, CachedEntry> {
  return Object.fromEntries(cache.entries())
}

/**
 * Hydrate the in-memory cache from a persisted payload (boot-time only —
 * see routingProxy/manager.ts's hydrateSnapshotAtBoot). Only fills in
 * entries; never called once a real network refresh has happened this run,
 * so there's no merge/precedence question — it's a one-shot cold-start seed.
 * A no-op on empty/undefined input.
 */
export function hydrateCliProxyModelCacheFromPersisted(
  entries: Record<string, CachedEntry> | null | undefined
): void {
  if (!entries) return
  const next = new Map<string, CachedEntry>()
  for (const [id, entry] of Object.entries(entries)) {
    next.set(id, entry)
  }
  if (next.size > 0) cache = next
}

function labelFromId(id: string): string {
  // Same one canonical rule as modelsDevSource.labelFromId — kept in sync
  // deliberately (both sources produce ids drawn from the same "third-party
  // model id" universe), duplicated rather than shared to keep each source
  // module independently deletable per the ModelSource contract.
  return id
    .split('-')
    .map((part) => (/^[a-z]/i.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}

function familyFromId(id: string): string | null {
  const match = /^[a-z]+/i.exec(id)
  return match ? match[0].toLowerCase() : null
}

function resolve(modelId: string): ModelInfo | null {
  const entry = cache.get(modelId)
  if (!entry) return null

  return {
    id: modelId,
    label: labelFromId(modelId),
    family: familyFromId(modelId),
    isClaude: false,
    context: entry.context,
    // CLIProxyAPI's model-definitions endpoint doesn't publish pricing —
    // that's models.dev's job, and it's consulted before this source (see
    // registry.ts's SOURCES order), so a real price already won if
    // available. Never fabricate one here.
    pricing: null,
    supportsReasoning: entry.supportsReasoning
  }
}

export const cliProxyModelSource: ModelSource = {
  name: 'cliproxy',
  resolve
}
