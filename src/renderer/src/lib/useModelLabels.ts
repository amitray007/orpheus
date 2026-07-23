// ---------------------------------------------------------------------------
// useModelLabels — resolves model ids to the registry's one canonical label
// (src/main/models/registry.ts) via the models:resolveLabels IPC channel.
//
// The renderer must never compute model facts itself (label parsing,
// family/version guessing, etc.) — that used to live in THREE independently
// drifting parsers (modelLabel in WorkspaceTitleBar.tsx, prettifyModelLabel
// in liveAgents.helpers.ts, shortModel in sessions-tab-helpers.ts). This
// hook is the one place renderer code that only has a bare model id (joined
// from SessionRecord.model) asks main for a display label.
//
// A module-level cache is used because a given model id's label is stable
// for the lifetime of the app session (the registry's builtin Claude data
// never changes at runtime, and models.dev's cache only grows more entries,
// never changes an existing label mid-session) — so once resolved, an id
// never needs to be re-fetched even across component remounts.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from 'react'

const labelCache = new Map<string, string>()
// Coalesces concurrent callers requesting overlapping id sets into a single
// in-flight IPC call per not-yet-cached id, so mounting many rows at once
// (e.g. a live-agents table) doesn't fire one round-trip per row.
let inFlight: Promise<void> | null = null
let pendingIds = new Set<string>()

async function resolveMissing(): Promise<void> {
  while (pendingIds.size > 0) {
    const batch = Array.from(pendingIds)
    pendingIds = new Set()
    try {
      const labels = await window.api.models.resolveLabels(batch)
      for (const [id, label] of Object.entries(labels)) {
        labelCache.set(id, label)
      }
    } catch {
      // Leave uncached — callers fall back to the em-dash/raw-id default
      // until a future call (e.g. remount) retries.
    }
  }
  inFlight = null
}

function ensureResolved(ids: readonly string[]): void {
  let queued = false
  for (const id of ids) {
    if (!labelCache.has(id) && !pendingIds.has(id)) {
      pendingIds.add(id)
      queued = true
    }
  }
  if (queued && !inFlight) {
    inFlight = resolveMissing()
  }
}

/** Resolve a batch of model ids at once — for tables that render many rows
 *  sharing a small set of distinct model ids (e.g. the sessions tab or
 *  live-agents table). Returns a lookup function; ids not yet resolved
 *  return '—' until the batch IPC call lands, then the table re-renders. */
export function useModelLabels(
  modelIds: readonly (string | null)[]
): (modelId: string | null | undefined) => string {
  // Join to a stable string key first (a plain variable, not a method-call
  // expression) so the useMemo dependency below is keyed by content rather
  // than array identity, without tripping the React Compiler's "dependency
  // list must be simple expressions" rule.
  const idsKey = modelIds.join(' ')
  const distinctIds = useMemo(
    () => Array.from(new Set(modelIds.filter((id): id is string => !!id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by idsKey (content), not array identity
    [idsKey]
  )

  const [, forceRender] = useState(0)

  useEffect(() => {
    const missing = distinctIds.filter((id) => !labelCache.has(id))
    if (missing.length === 0) return
    ensureResolved(missing)
    let cancelled = false
    void inFlight?.then(() => {
      if (!cancelled) forceRender((n) => n + 1)
    })
    return () => {
      cancelled = true
    }
  }, [distinctIds])

  // Reads the module-level cache directly; the useEffect above (keyed on
  // distinctIds) is what triggers the re-render that makes newly-resolved
  // labels visible, so this callback has no reactive deps of its own.
  return useCallback((modelId: string | null | undefined): string => {
    if (!modelId) return '—'
    return labelCache.get(modelId) ?? '—'
  }, [])
}
