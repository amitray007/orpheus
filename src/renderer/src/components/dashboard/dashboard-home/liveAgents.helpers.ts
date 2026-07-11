// ---------------------------------------------------------------------------
// liveAgents.helpers — pure (non-React) helpers for useLiveAgents.ts. Kept in
// its own file (mirrors pulseData.helpers.ts) so the join/filter/sort/display
// logic is independently readable and testable, separate from the fetch +
// subscription plumbing in the hook itself.
// ---------------------------------------------------------------------------

import type { SessionRecord, WorkspaceActivityDetail, WorkspaceRecord } from '@shared/types'

// ---------------------------------------------------------------------------
// State → display mapping
//
// `WorkspaceActivityDetail` (src/shared/types.ts) is the renderer-facing
// activity enum: 'working' | 'attention' | 'ready' | 'idle' | 'archived'.
// It's produced in main by `toActivityDetail()` in src/main/orpheusNotify.ts,
// which maps the persisted `WorkspaceStatus` as:
//   'attention'      -> 'attention'  (permission prompt / needs input)
//   'in_progress'    -> 'working'    (claude actively running)
//   'awaiting_input' -> 'ready'      (claude just finished, idle < staleAfterMinutes)
//   'idle'           -> 'idle'       (dormant — no live/recent activity)
//   (workspace archived) -> 'archived'
//
// The Live-agents table only cares about the three "meaningful" states — a
// dashboard table should show what's ACTIVE or just finished, not every
// dormant workspace. 'idle' and 'archived' are filtered out entirely (see
// isLiveAgentDetail below).
// ---------------------------------------------------------------------------

export type LiveAgentDisplayState = 'attention' | 'working' | 'ready'

/** The three activity details worth showing in the Live-agents table. */
const LIVE_AGENT_DETAILS = new Set<WorkspaceActivityDetail>(['attention', 'working', 'ready'])

export function isLiveAgentDetail(detail: WorkspaceActivityDetail | undefined): boolean {
  return detail !== undefined && LIVE_AGENT_DETAILS.has(detail)
}

/** Badge copy shown for each display state — kept distinct from the raw
 *  WorkspaceActivityDetail strings since the table uses human labels
 *  ("Permission" reads better than "attention" for a waiting-on-you agent). */
export const LIVE_AGENT_STATE_LABEL: Record<LiveAgentDisplayState, string> = {
  attention: 'Permission',
  working: 'Working',
  ready: 'Finished'
}

/** Sort priority — waiting-on-you first (most actionable), then actively
 *  working, then recently-finished last. Matches the spec's requested order:
 *  "waiting(attention) first, then working, then recently-finished(ready)". */
const STATE_SORT_RANK: Record<LiveAgentDisplayState, number> = {
  attention: 0,
  working: 1,
  ready: 2
}

// ---------------------------------------------------------------------------
// Row shape + join
// ---------------------------------------------------------------------------

export interface LiveAgentRow {
  workspaceId: string
  projectId: string
  /** Workspace display name (resolved, e.g. auto-named branch slug) — kept
   *  as the line-2 fallback identity, no longer the primary line-1 label
   *  (see taskTitle). */
  agentName: string
  projectName: string
  state: LiveAgentDisplayState
  /** Current task text — SessionRecord.lastUserMessagePreview when a joined
   *  session exists, else workspace.lastTitle, else null (renders 1-line). */
  doing: string | null
  /** The agent's real current task, resolved for line-1 display (see
   *  resolveTaskTitle). Always non-empty — falls back to the workspace name
   *  so a brand-new workspace with no session yet still shows something. */
  taskTitle: string
  model: string | null
  /** Human-prettified model label for display (e.g. "Opus 4.8"), or "—"
   *  when no model is known yet (see prettifyModelLabel). */
  modelLabel: string
  /** Epoch ms of most-recent known activity for this workspace, used both
   *  for the "since" label and as the sort tiebreaker within a state. Falls
   *  back to workspace.lastOpenedAt/createdAt when no live timestamp exists
   *  yet (e.g. app just launched, no activityTimeStore entry recorded). */
  sinceMs: number
}

/**
 * Resolve the display title for line 1 of a Live-agents row — the agent's
 * REAL current task, not the generic workspace name. Precedence:
 *   1. session.lastUserMessagePreview (the user's latest prompt — usually
 *      the truest "what it's doing now")
 *   2. session.title (a generated session title)
 *   3. workspace.lastTitle (workspace-level last title)
 *   4. workspace.name (final fallback — always present, so a brand-new
 *      workspace with no session yet still shows something).
 */
export function resolveTaskTitle(
  session: SessionRecord | undefined,
  workspace: WorkspaceRecord
): string {
  return (
    session?.lastUserMessagePreview?.trim() ||
    session?.title?.trim() ||
    workspace.lastTitle?.trim() ||
    workspace.name
  )
}

// ---------------------------------------------------------------------------
// Model label prettifying — parses the raw model id (e.g. "claude-opus-4-8",
// "claude-haiku-4-5-20251001") into a short human label ("Opus 4.8",
// "Haiku 4.5") rather than a hardcoded id->label map, so future model ids
// (new families/versions) render sensibly without a code change. Shape:
// "claude-<family>-<major>-<minor>[-<trailing date>]".
// ---------------------------------------------------------------------------

const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d+)?$/

export function prettifyModelLabel(model: string | null): string {
  if (!model) return '—'
  const match = MODEL_ID_PATTERN.exec(model)
  if (!match) return model
  const [, family, major, minor] = match
  const familyLabel = family.charAt(0).toUpperCase() + family.slice(1)
  return `${familyLabel} ${major}.${minor}`
}

/**
 * Join workspaces + sessions + the activity snapshot into live-agent rows.
 * `liveActivityTimes` is a lookup of workspaceId -> epoch ms sourced from
 * activityTimeStore (see useLiveAgents.ts) — the "(a) preferred" elapsed
 * source per the unit spec, avoiding a new IPC surface.
 */
export function buildLiveAgentRows(
  workspaces: WorkspaceRecord[],
  projectNameById: ReadonlyMap<string, string>,
  sessionById: ReadonlyMap<string, SessionRecord>,
  activityByWorkspace: ReadonlyMap<string, WorkspaceActivityDetail>,
  liveActivityTimes: ReadonlyMap<string, number>
): LiveAgentRow[] {
  const rows: LiveAgentRow[] = []

  for (const ws of workspaces) {
    if (ws.archivedAt !== null) continue

    const detail = activityByWorkspace.get(ws.id)
    if (!isLiveAgentDetail(detail)) continue
    // isLiveAgentDetail already narrowed away undefined/'idle'/'archived'.
    const state = detail as LiveAgentDisplayState

    const session = ws.claudeSessionId ? sessionById.get(ws.claudeSessionId) : undefined
    const doing = session?.lastUserMessagePreview?.trim() || ws.lastTitle?.trim() || null
    const model = session?.model ?? null

    const liveSince = liveActivityTimes.get(ws.id)
    const sinceMs = liveSince ?? ws.lastOpenedAt ?? ws.createdAt

    rows.push({
      workspaceId: ws.id,
      projectId: ws.projectId,
      agentName: ws.name,
      projectName: projectNameById.get(ws.projectId) ?? ws.projectId,
      state,
      doing,
      taskTitle: resolveTaskTitle(session, ws),
      model,
      modelLabel: prettifyModelLabel(model),
      sinceMs
    })
  }

  // Sort: state rank first (attention < working < ready), then most-recent
  // activity first within each state bucket.
  rows.sort((a, b) => {
    const rankDiff = STATE_SORT_RANK[a.state] - STATE_SORT_RANK[b.state]
    if (rankDiff !== 0) return rankDiff
    return b.sinceMs - a.sinceMs
  })

  return rows
}

// ---------------------------------------------------------------------------
// "Since" relative label — coarse, calm, matches the elapsed strings already
// shown elsewhere in the app (Sidebar/WorkspacesView use a similar ladder).
// ---------------------------------------------------------------------------

export function formatSinceLabel(sinceMs: number, nowMs: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((nowMs - sinceMs) / 1000))
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHour = Math.floor(diffMin / 60)
  if (diffHour < 24) return `${diffHour}h ago`
  const diffDay = Math.floor(diffHour / 24)
  return `${diffDay}d ago`
}
