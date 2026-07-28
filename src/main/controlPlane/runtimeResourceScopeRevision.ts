let revision = 0

/**
 * Marks a persisted mutation that can change the project roots or pane surface
 * membership used by runtime authorization. Keeping this revision independent
 * from SQLite's global change counter prevents status, audit, and automation
 * writes from invalidating every cached project scope.
 */
export function markRuntimeResourceScopeChanged(): void {
  revision = revision >= Number.MAX_SAFE_INTEGER ? 1 : revision + 1
}

export function getRuntimeResourceScopeRevision(): number {
  return revision
}
