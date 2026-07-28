import type { WorkspaceOpenRequest } from '../../shared/types'

export type { WorkspaceOpenRequest } from '../../shared/types'

/**
 * Coalesces open requests until the renderer has finished loading. A later
 * focus request upgrades an existing background mount request. Orchestration
 * mount metadata remains sticky unless a focused renderer open supersedes it.
 */
export class WorkspaceOpenRequestQueue {
  private readonly pending = new Map<string, WorkspaceOpenRequest>()

  request(
    request: WorkspaceOpenRequest,
    deliver: (request: WorkspaceOpenRequest) => boolean
  ): void {
    const pending = this.pending.get(request.workspaceId)
    const merged = mergeWorkspaceOpenRequests(pending, request)
    if (deliver(merged)) {
      this.pending.delete(request.workspaceId)
      return
    }
    this.pending.set(request.workspaceId, merged)
  }

  flush(deliver: (request: WorkspaceOpenRequest) => boolean): number {
    let delivered = 0
    for (const [workspaceId, request] of [...this.pending]) {
      if (!deliver(request)) continue
      this.pending.delete(workspaceId)
      delivered++
    }
    return delivered
  }

  cancel(workspaceId: string): boolean {
    return this.pending.delete(workspaceId)
  }

  get size(): number {
    return this.pending.size
  }
}

function mergeWorkspaceOpenRequests(
  pending: WorkspaceOpenRequest | undefined,
  requested: WorkspaceOpenRequest
): WorkspaceOpenRequest {
  if (pending == null) return requested
  if (pending.focus || requested.focus) {
    return {
      kind: 'renderer-open',
      workspaceId: requested.workspaceId,
      focus: true
    }
  }
  if (requested.kind === 'orchestration-mount') return requested
  if (pending.kind === 'orchestration-mount') return pending
  return requested
}
