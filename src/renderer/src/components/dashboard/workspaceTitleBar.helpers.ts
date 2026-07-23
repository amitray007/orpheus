// ---------------------------------------------------------------------------
// Context-budget cache — shared between WorkspaceTitleBar and Dashboard
// (Dashboard needs clearContextBudgetCache to evict on workspace removal).
// ---------------------------------------------------------------------------

// contextBudget is null when the model's pricing/context window is unknown —
// consumers must render an explicit "unknown" state (em-dash), never a
// fabricated number. modelLabel is the registry's one canonical label
// (src/main/models/registry.ts) — resolved in main, never re-derived here.
// See ContextBudgetResult in src/main/sessions.ts.
export type ContextBudgetInfo = {
  contextBudget: number | null
  modelId: string
  modelLabel: string
}

// Keyed by `${workspaceId}:${claudeSessionId}` so the cache is automatically
// invalidated when the session changes (new conversation in same workspace).
export const contextBudgetCache = new Map<string, ContextBudgetInfo>()

/**
 * Evicts all context-budget cache entries for a workspace that has been
 * archived or removed. Prefix-matches `${workspaceId}:` to cover every
 * session key that belongs to that workspace.
 */
export function clearContextBudgetCache(workspaceId: string): void {
  const prefix = `${workspaceId}:`
  for (const key of contextBudgetCache.keys()) {
    if (key.startsWith(prefix)) contextBudgetCache.delete(key)
  }
}
