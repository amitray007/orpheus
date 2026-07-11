// ---------------------------------------------------------------------------
// useLiveAgents — U4 (final Phase-1 unit). Replaces sampleData's
// SAMPLE_AGENT_ROWS with real rows joined from three already-existing
// sources, with ZERO new IPC:
//
//   1. Workspaces + Projects — fetched here directly via
//      `window.api.projects.list()` + `window.api.workspaces.listForProject`
//      (one call per project, `scope: 'all'`). Dashboard.tsx's own
//      `allWorkspaces` is intentionally NOT reused — it's a lazy,
//      only-visited-projects accumulation (see fetchWorkspacesForProject in
//      Dashboard.tsx), not a guaranteed full set. A live-agents table needs
//      every workspace across every project, so this hook does its own
//      complete fetch.
//   2. `sessions:listAll()` — for `model` / `lastUserMessagePreview`, joined
//      to a workspace via `workspace.claudeSessionId === session.id`.
//   3. `activityStore` (app-wide, `getActivitySnapshot()`) — for live state.
//      Re-renders follow the same pattern Sidebar.tsx uses for its grouped
//      sections: `useActiveIdsKey(workspaceIds)` subscribes to the whole id
//      list and returns a joined string of the currently-"active" subset, so
//      this hook re-renders whenever ANY workspace's activity changes into
//      or out of the working/attention/ready set — exactly the set this
//      table cares about.
//
// Elapsed/since: uses activityTimeStore (fed by `workspace:activityBatch`,
// see Dashboard.tsx's bumpActivityTime call) — option (a) from the unit
// spec, the "PREFERRED if sufficient" no-new-IPC path. It's a coarse
// relative "3m ago" label, not a precise running stopwatch; that's judged
// sufficient here, so option (b) (exposing sessionState.getWorkspaceFileInfo
// over IPC) was NOT added.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import type { ProjectRecord, SessionRecord, WorkspaceRecord } from '@shared/types'
import { getActivitySnapshot, useActiveIdsKey } from '@/lib/activityStore'
import { getActivityTimeSnapshot } from '@/lib/activityTimeStore'
import { buildLiveAgentRows, type LiveAgentRow } from './liveAgents.helpers'

export interface LiveAgentsData {
  loading: boolean
  error: string | null
  rows: LiveAgentRow[]
  /** Live count of workspaces currently in the 'attention' state — reused by
   *  the "Agents waiting" triage tile so the two stay in sync by construction. */
  waitingCount: number
  /** Live count of workspaces currently in the 'ready' (recently-finished)
   *  state — reused by the "Finished runs" triage tile. */
  finishedCount: number
}

const EMPTY: LiveAgentsData = {
  loading: true,
  error: null,
  rows: [],
  waitingCount: 0,
  finishedCount: 0
}

export function useLiveAgents(): LiveAgentsData {
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[] | null>(null)
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Fetch once on mount. No polling interval — the activity SET subscription
  // below (useActiveIdsKey) already drives re-renders on live state changes;
  // the workspace/session/project LISTS themselves change far less often
  // (new workspace created, project added) and a full re-fetch on every such
  // edit isn't needed for a dashboard glance surface. Add a refetch trigger
  // here (e.g. a manual "refresh" button) if that gap is ever felt.
  useEffect(() => {
    let cancelled = false

    async function load(): Promise<void> {
      try {
        const projectList = await window.api.projects.list()
        if (cancelled) return

        const workspaceLists = await Promise.all(
          projectList.map((p) => window.api.workspaces.listForProject(p.id, { scope: 'all' }))
        )
        if (cancelled) return

        const sessionList = await window.api.sessions.listAll()
        if (cancelled) return

        setProjects(projectList)
        setWorkspaces(workspaceLists.flat())
        setSessions(sessionList)
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load live agents')
          setProjects([])
          setWorkspaces([])
          setSessions([])
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const workspaceIds = useMemo(() => workspaces?.map((w) => w.id) ?? [], [workspaces])

  // Subscribe to the activity SET for exactly the workspaces we know about —
  // re-renders whenever a workspace transitions into/out of the
  // working/attention/ready set (see activityStore.ts's ACTIVE_DETAILS,
  // which matches this table's own live-agent filter).
  useActiveIdsKey(workspaceIds)

  return useMemo(() => {
    if (projects === null || workspaces === null || sessions === null) {
      return { ...EMPTY, error }
    }

    const projectNameById = new Map(projects.map((p) => [p.id, p.name]))
    const sessionById = new Map(sessions.map((s) => [s.id, s]))
    const activitySnapshot = getActivitySnapshot()
    const liveActivityTimes = getActivityTimeSnapshot()

    const rows = buildLiveAgentRows(
      workspaces,
      projectNameById,
      sessionById,
      activitySnapshot,
      liveActivityTimes
    )

    let waitingCount = 0
    let finishedCount = 0
    for (const row of rows) {
      if (row.state === 'attention') waitingCount++
      else if (row.state === 'ready') finishedCount++
    }

    return { loading: false, error, rows, waitingCount, finishedCount }
  }, [projects, workspaces, sessions, error])
}
