// ---------------------------------------------------------------------------
// Context-budget cache — shared between WorkspaceTitleBar and Dashboard
// (Dashboard needs clearContextBudgetCache to evict on workspace removal).
// ---------------------------------------------------------------------------

export type ContextBudgetInfo = { contextBudget: number; modelId: string }

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
