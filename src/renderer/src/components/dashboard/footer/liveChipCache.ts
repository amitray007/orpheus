// ---------------------------------------------------------------------------
// Module-level value cache for LiveChip — keyed by `${actionId}:${workspaceId}`.
// On workspace switch-back the chip immediately renders the stale value
// (no null → value flash) while the subscription / poll catches up.
//
// Lives in its own module (not LiveChip.tsx) because react-refresh's
// only-export-components rule forbids a component file from also exporting
// plain functions/constants.
// ---------------------------------------------------------------------------

const chipValueCache = new Map<string, unknown>()

export function getCachedChipValue(key: string): unknown {
  return chipValueCache.get(key)
}

export function setCachedChipValue(key: string, value: unknown): void {
  chipValueCache.set(key, value)
}

/**
 * Evicts every cached chip value for a workspace that has been archived or
 * removed. Keys are `${actionId}:${workspaceId}` (composite, one entry per
 * footer action shown for that workspace) so this scans for the `:${id}`
 * suffix rather than a single delete — mirrors clearFooterActionsCache /
 * clearContextBudgetCache, called alongside them on archive.
 */
export function clearLiveChipCache(workspaceId: string): void {
  const suffix = `:${workspaceId}`
  for (const key of chipValueCache.keys()) {
    if (key.endsWith(suffix)) chipValueCache.delete(key)
  }
}
