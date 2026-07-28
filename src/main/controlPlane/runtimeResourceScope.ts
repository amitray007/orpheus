import path from 'node:path'
import type { DbLike } from '../db/types'
import type { ClaudeRuntimeBinding } from './runtimeLeases'
import type { TrustedRuntimeBinding } from './types'

type RootRow = { root: string }
type PaneRow = {
  layout_id: string
  layout_dir: string
  terminal_id: string | null
}

const MAX_CACHED_PROJECT_SCOPES = 128

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')
}

/**
 * Derives pane authorization from live persisted state. A runtime can control
 * layouts rooted in its registered project or one of that project's
 * workspaces (including managed worktrees), never arbitrary cross-project
 * pane folders. Deletions and moves disappear from scope on the next check.
 */
export function createRuntimeResourceScopeSource(
  db: DbLike,
  options: { maxCachedProjects?: number } = {}
): (binding: ClaudeRuntimeBinding) => TrustedRuntimeBinding['resourceScope'] {
  const maxCachedProjects = Math.max(
    1,
    Math.floor(options.maxCachedProjects ?? MAX_CACHED_PROJECT_SCOPES)
  )
  const rootsStatement = db.prepare(
    `SELECT path AS root FROM projects WHERE id = ?
     UNION
     SELECT cwd AS root FROM workspaces WHERE project_id = ?`
  )
  const panesStatement = db.prepare(
    `SELECT layouts.id AS layout_id,
            layouts.dir AS layout_dir,
            terminals.id AS terminal_id
       FROM pane_layouts AS layouts
       LEFT JOIN pane_terminals AS terminals ON terminals.layout_id = layouts.id`
  )
  const totalChangesStatement = db.prepare('SELECT total_changes() AS revision')
  const dataVersionStatement = db.prepare('PRAGMA data_version')
  const cache = new Map<
    string,
    {
      revision: string
      scope: NonNullable<TrustedRuntimeBinding['resourceScope']>
    }
  >()

  const databaseRevision = (): string => {
    const changes = totalChangesStatement.get() as { revision?: number } | undefined
    const dataVersion = dataVersionStatement.get() as
      | { data_version?: number; dataVersion?: number }
      | undefined
    return `${changes?.revision ?? -1}:${dataVersion?.data_version ?? dataVersion?.dataVersion ?? -1}`
  }
  const remember = (
    projectId: string,
    revision: string,
    scope: NonNullable<TrustedRuntimeBinding['resourceScope']>
  ): void => {
    while (cache.size >= maxCachedProjects) {
      const oldestProjectId = cache.keys().next().value
      if (oldestProjectId == null) break
      cache.delete(oldestProjectId)
    }
    cache.set(projectId, { revision, scope })
  }

  return (binding) => {
    const revision = databaseRevision()
    const cached = cache.get(binding.projectId)
    if (cached?.revision === revision) {
      cache.delete(binding.projectId)
      cache.set(binding.projectId, cached)
      return cached.scope
    }
    if (cached != null) cache.delete(binding.projectId)

    const roots = (rootsStatement.all(binding.projectId, binding.projectId) as RootRow[]).map(
      (row) => row.root
    )
    if (roots.length === 0) {
      const scope = Object.freeze({
        selfOnly: true as const,
        layoutIds: Object.freeze([]),
        surfaceIds: Object.freeze([])
      })
      remember(binding.projectId, revision, scope)
      return scope
    }

    const panes = panesStatement.all() as PaneRow[]
    const layoutIds = new Set<string>()
    const surfaceIds = new Set<string>()
    for (const pane of panes) {
      if (!roots.some((root) => isWithin(root, pane.layout_dir))) continue
      layoutIds.add(pane.layout_id)
      if (pane.terminal_id != null) {
        surfaceIds.add(`pane:${pane.layout_id}:${pane.terminal_id}`)
      }
    }
    const scope = Object.freeze({
      selfOnly: true,
      layoutIds: Object.freeze([...layoutIds].sort()),
      surfaceIds: Object.freeze([...surfaceIds].sort())
    } as const)
    remember(binding.projectId, revision, scope)
    return scope
  }
}
