/**
 * sessionStatusMap.ts — pure session-file status → WorkspaceStatus mapping.
 *
 * Deliberately dependency-free (no electron/db imports) so it can be
 * imported directly by both sessionState.ts and the dev-only
 * scripts/verify-session-status.ts harness under plain `bun run` (importing
 * sessionState.ts itself pulls in electron transitively and fails outside
 * the Electron runtime).
 */

import type { WorkspaceStatus } from '../shared/types'

export type RawSessionStatus = 'busy' | 'idle' | 'waiting' | 'shell'

export interface MappableSession {
  status: RawSessionStatus | null
  waitingFor?: string
}

/**
 * Maps a live session's raw file status to the WorkspaceStatus driven into
 * the UI. Caller handles the `status === null` (starting) case before
 * calling this — null falls through here to the safe 'in_progress' default,
 * matching pre-existing behavior for unrecognized/absent values.
 */
export function _mapFileStatus(session: MappableSession): WorkspaceStatus {
  const { status, waitingFor } = session
  if (status === 'busy' || status === 'shell') return 'in_progress'
  if (status === 'waiting') {
    if (waitingFor === 'permission prompt') return 'attention'
    return 'awaiting_input'
  }
  if (status === 'idle') return 'idle'
  // null handled by caller; unknown values → safe default
  return 'in_progress'
}
