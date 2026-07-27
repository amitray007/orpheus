import type { WorkspaceOpenRequest, WorkspaceRecord } from '@shared/types'

export type BackgroundWorkspaceMountPorts = {
  acknowledgeOpen: (workspaceId: string) => Promise<WorkspaceRecord>
  mount: (workspaceId: string, cwd: string) => Promise<unknown>
  hide: (workspaceId: string) => Promise<unknown>
}

/**
 * Mounts a workspace without presenting it.
 *
 * A renderer-open request must acknowledge the mutation before touching the
 * native surface, so an archive that wins the race prevents a stale mount.
 * An orchestration mount is different: main already holds the mutation lease,
 * so re-entering the acknowledgement would deadlock. Its cwd is carried in the
 * request from the authoritative workspace snapshot.
 */
export async function mountWorkspaceInBackground(
  request: WorkspaceOpenRequest,
  ports: BackgroundWorkspaceMountPorts
): Promise<WorkspaceRecord | null> {
  let opened: WorkspaceRecord | null = null
  let cwd: string
  if (request.kind === 'orchestration-mount') {
    cwd = request.cwd
  } else {
    opened = await ports.acknowledgeOpen(request.workspaceId)
    cwd = opened.cwd
  }
  await ports.mount(request.workspaceId, cwd)
  await ports.hide(request.workspaceId).catch(() => {})
  return opened
}
