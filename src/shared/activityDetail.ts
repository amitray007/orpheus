// ---------------------------------------------------------------------------
// src/shared/activityDetail.ts
//
// Single source of truth for the WorkspaceStatus -> WorkspaceActivityDetail
// mapping. Both the main process (orpheusNotify.ts's computeDetail, which
// drives the live 'workspace:activityBatch' push) and the renderer (the
// boot-time fallback used before a live push has ever arrived for a
// workspace) need the EXACT same status->detail semantics — this function is
// the one place that mapping lives, so the two cannot drift.
//
// Pure and DOM/Electron-free so it is directly importable, and directly
// assertable, from scripts/verify-codex-status.ts per this repo's
// "assert behaviour, not source text" discipline.
// ---------------------------------------------------------------------------

import type { WorkspaceStatus, WorkspaceActivityDetail } from './types'

/**
 * Maps a persisted/observed WorkspaceStatus to the WorkspaceActivityDetail
 * shown in the UI. Anything other than the four named statuses (i.e.
 * 'archived') maps to 'archived'.
 */
export function statusToActivityDetail(status: WorkspaceStatus): WorkspaceActivityDetail {
  if (status === 'attention') return 'attention'
  if (status === 'in_progress') return 'working'
  if (status === 'awaiting_input') return 'ready'
  if (status === 'idle') return 'idle'
  return 'archived'
}

/**
 * Renderer-side (and testable, DOM-free) fallback resolver: a live activity
 * detail always wins the instant it is present — even if it differs from
 * what the fallback status would produce. Only when the live value is
 * genuinely absent (undefined — no push has landed yet for this workspace,
 * e.g. right after an app restart) does this fall back to mapping the
 * workspace's own persisted status. With neither, returns undefined.
 *
 * This must NOT special-case any particular detail value (e.g. 'idle' or
 * 'archived') as "as good as absent" — presence of the live entry is the
 * only thing that matters, not its content.
 */
export function resolveActivityDetail(
  liveDetail: WorkspaceActivityDetail | undefined,
  fallbackStatus: WorkspaceStatus | undefined
): WorkspaceActivityDetail | undefined {
  if (liveDetail !== undefined) return liveDetail
  if (fallbackStatus !== undefined) return statusToActivityDetail(fallbackStatus)
  return undefined
}
