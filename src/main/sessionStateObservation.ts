export type WorkspaceSessionIdRow = Readonly<{
  id: string
  claude_session_id: string | null
}>

export type RuntimeObservationSession = Readonly<{
  pid: number
  status: string | null
  waitingFor?: string
  version: string
  cwd: string
  statusUpdatedAt: number
}>

export type RuntimeObservation = Readonly<{
  workspaceId: string
  claudeConversationId: string | null
  session: RuntimeObservationSession | null
}>

export function buildWorkspaceSessionIds(
  workspaces: readonly WorkspaceSessionIdRow[]
): Map<string, string> {
  const result = new Map<string, string>()
  for (const workspace of workspaces) {
    if (workspace.claude_session_id != null) {
      result.set(workspace.id, workspace.claude_session_id)
    }
  }
  return result
}

/** One keyed lookup and one shallow clone; never clones or iterates the registry. */
export function getLiveSessionSnapshot<T extends object>(
  sessions: ReadonlyMap<string, T>,
  sessionId: string
): T | null {
  const session = sessions.get(sessionId)
  return session == null ? null : { ...session }
}

function fingerprint(observation: RuntimeObservation): string {
  const session = observation.session
  return JSON.stringify([
    observation.claudeConversationId,
    session?.pid ?? null,
    session?.status ?? null,
    session?.waitingFor ?? null,
    session?.version ?? null,
    session?.cwd ?? null,
    session?.statusUpdatedAt ?? null
  ])
}

export class RuntimeObservationDeduper {
  private readonly fingerprints = new Map<string, string>()

  shouldEmit(observation: RuntimeObservation): boolean {
    const next = fingerprint(observation)
    if (this.fingerprints.get(observation.workspaceId) === next) return false
    this.fingerprints.set(observation.workspaceId, next)
    return true
  }

  prune(activeWorkspaceIds: ReadonlySet<string>): void {
    for (const workspaceId of this.fingerprints.keys()) {
      if (!activeWorkspaceIds.has(workspaceId)) this.fingerprints.delete(workspaceId)
    }
  }

  clear(): void {
    this.fingerprints.clear()
  }

  size(): number {
    return this.fingerprints.size
  }
}
