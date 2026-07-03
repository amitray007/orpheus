// ---------------------------------------------------------------------------
// src/main/ipc/orpheusConfig.ts
//
// Orpheus project config IPC (.orpheus/config.yml) — moved verbatim out of
// index.ts (STR-1). Needs a project lookup, passed in via deps.getProject
// to avoid importing index.ts.
// ---------------------------------------------------------------------------

import type { ProjectRecord } from '../../shared/types'
import { resolveWorkspacesConfig, writeProjectOverride } from '../orpheusConfig'
import { handle } from './handle'

export interface OrpheusConfigIpcDeps {
  getProject: (id: string) => ProjectRecord | null
}

export function registerOrpheusConfigIpc(deps: OrpheusConfigIpcDeps): void {
  handle('orpheusConfig:get', async (_e, { projectId }) => {
    const project = deps.getProject(projectId)
    if (!project) throw new Error(`orpheusConfig:get: project not found: ${projectId}`)
    return resolveWorkspacesConfig(project.path)
  })

  handle('orpheusConfig:setOverride', async (_e, { projectId, patch }) => {
    const project = deps.getProject(projectId)
    if (!project) throw new Error(`orpheusConfig:setOverride: project not found: ${projectId}`)
    await writeProjectOverride(project.path, patch)
    return resolveWorkspacesConfig(project.path)
  })
}
