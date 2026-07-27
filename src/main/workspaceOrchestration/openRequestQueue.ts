export type WorkspaceOpenRequest = Readonly<{ workspaceId: string; focus: boolean }>

/**
 * Coalesces open requests until the renderer has finished loading. A later
 * focus request upgrades an existing background mount request.
 */
export class WorkspaceOpenRequestQueue {
  private readonly pending = new Map<string, boolean>()

  request(
    workspaceId: string,
    focus: boolean,
    deliver: (request: WorkspaceOpenRequest) => boolean
  ): void {
    const requestedFocus = focus || (this.pending.get(workspaceId) ?? false)
    if (deliver({ workspaceId, focus: requestedFocus })) {
      this.pending.delete(workspaceId)
      return
    }
    this.pending.set(workspaceId, requestedFocus)
  }

  flush(deliver: (request: WorkspaceOpenRequest) => boolean): number {
    let delivered = 0
    for (const [workspaceId, focus] of [...this.pending]) {
      if (!deliver({ workspaceId, focus })) continue
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
