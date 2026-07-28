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
  db: DbLike
): (binding: ClaudeRuntimeBinding) => TrustedRuntimeBinding['resourceScope'] {
  return (binding) => {
    const roots = (
      db
        .prepare(
          `SELECT path AS root FROM projects WHERE id = ?
           UNION
           SELECT cwd AS root FROM workspaces WHERE project_id = ?`
        )
        .all(binding.projectId, binding.projectId) as RootRow[]
    ).map((row) => row.root)
    if (roots.length === 0) {
      return { selfOnly: true, layoutIds: [], surfaceIds: [] }
    }

    const panes = db
      .prepare(
        `SELECT layouts.id AS layout_id,
                layouts.dir AS layout_dir,
                terminals.id AS terminal_id
           FROM pane_layouts AS layouts
           LEFT JOIN pane_terminals AS terminals ON terminals.layout_id = layouts.id`
      )
      .all() as PaneRow[]
    const layoutIds = new Set<string>()
    const surfaceIds = new Set<string>()
    for (const pane of panes) {
      if (!roots.some((root) => isWithin(root, pane.layout_dir))) continue
      layoutIds.add(pane.layout_id)
      if (pane.terminal_id != null) {
        surfaceIds.add(`pane:${pane.layout_id}:${pane.terminal_id}`)
      }
    }
    return {
      selfOnly: true,
      layoutIds: Object.freeze([...layoutIds].sort()),
      surfaceIds: Object.freeze([...surfaceIds].sort())
    }
  }
}
