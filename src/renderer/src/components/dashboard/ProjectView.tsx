import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type { HarnessSummary, ProjectRecord, WorkspaceRecord } from '@shared/types'
import { ProjectHeader } from './project/ProjectHeader'
import { WorkspacesTab } from './project/WorkspacesTab'
import { SettingsDrawer } from './project/SettingsDrawer'
import { nextWorkspaceName } from './dashboard.helpers'
import {
  harnessesPresentInProject,
  countProjectHarnessOverrides,
  projectOverrideChipInfo
} from '@shared/harness/projectDrawerSettings'
import { CLAUDE_PERMISSION_MODE_ARG_KEY } from './project/claudePermissionModeArgKey'

// ---------------------------------------------------------------------------
// ProjectView — header + project body (workspaces, sessions, commits)
//
// Post-v34: the top-level Workspaces/Sessions tabs are gone. Sessions live
// next to the workspaces table inside WorkspacesTab. "Archive" is a hard
// delete now — old conversations resurface only through the Sessions panel
// because Claude's transcripts on disk stay intact.
// ---------------------------------------------------------------------------

interface ProjectViewProps {
  project: ProjectRecord
  workspaces: WorkspaceRecord[] | null
  onRequestRemove: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onAddWorkspace: (projectId: string, modelId?: string, harnessId?: string) => void | Promise<void>
  onRenameWorkspace: (
    workspaceId: string,
    projectId: string,
    newName: string
  ) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void | Promise<void>
  /** Called after a Sessions row click spawns a new workspace via --resume. */
  onResumedInWorkspace: (workspace: WorkspaceRecord) => void
  // Privacy (v37)
  fetchGithubAvatars?: boolean
}

export function ProjectView({
  project,
  workspaces,
  onRequestRemove,
  onSelectWorkspace,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onToggleWorkspacePin,
  onResumedInWorkspace,
  fetchGithubAvatars = true
}: ProjectViewProps): React.JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  // H1 (support-multi-harness) — the header override chip now counts
  // harness_settings (project scope) rather than claude_project_settings:
  // that is the storage the live launch emitter actually reads, and
  // claude_project_settings' model/permissionMode/effort keys no longer
  // reflect what the drawer edits (see SettingsDrawer.tsx's own header).
  // `harnessOverrideCounts` maps harness id -> its own count, one fetch per
  // harness actually present in the project (harnessesInProject below) —
  // NOT one fetch per registered harness, so a project with zero workspaces
  // on a harness shows no chip contribution from settings nobody's
  // workspace would ever read.
  const [harnesses, setHarnesses] = useState<HarnessSummary[]>([])
  const [harnessOverrideCounts, setHarnessOverrideCounts] = useState<Record<string, number>>({})

  const harnessesInProject = useMemo(() => harnessesPresentInProject(workspaces), [workspaces])

  useEffect(() => {
    let cancelled = false
    window.api.harness
      .list()
      .then((list) => {
        if (!cancelled) setHarnesses(list)
      })
      .catch((err) => console.error('[project-view] failed to load harnesses', err))
    return () => {
      cancelled = true
    }
  }, [])

  // Re-pull when the drawer closes so the header chip reflects fresh edits,
  // and whenever project membership (which harnesses are present) changes.
  // The empty-membership case is routed through the SAME async-callback
  // shape as the fetch branch (a resolved-microtask setState, not a direct
  // call in the effect body) — mirrors HarnessSection.tsx's own project-scope
  // reset for the identical react-hooks/set-state-in-effect reason.
  useEffect(() => {
    let cancelled = false
    const fetchOrReset =
      harnessesInProject.length === 0
        ? Promise.resolve({})
        : Promise.all(
            harnessesInProject.map((harnessId) =>
              window.api.harness
                .getSettings(harnessId, 'project', project.id)
                .then(
                  (s) =>
                    [
                      harnessId,
                      countProjectHarnessOverrides(s, CLAUDE_PERMISSION_MODE_ARG_KEY)
                    ] as const
                )
            )
          ).then((entries) => Object.fromEntries(entries))
    fetchOrReset
      .then((counts) => {
        if (!cancelled) setHarnessOverrideCounts(counts)
      })
      .catch((err) => console.error('[project-view] failed to load harness settings', err))
    return () => {
      cancelled = true
    }
  }, [project.id, settingsOpen, harnessesInProject])

  // Background GitHub refresh on mount. Two cadences based on prior result:
  //  - Never checked → always refresh
  //  - Last check found NO GitHub remote → recheck every hour, so projects that
  //    later gain a remote (push to GitHub, add origin manually) pick it up
  //    without waiting 30 days.
  //  - Last check found a GitHub remote → recheck every 30 days; URL is stable.
  useEffect(() => {
    const HOUR_MS = 60 * 60 * 1000
    const THIRTY_DAYS_MS = 30 * 24 * HOUR_MS
    const checkedAt = project.githubCheckedAt
    let stale: boolean
    if (checkedAt === null) {
      stale = true
    } else if (project.githubOwner === null) {
      stale = Date.now() - checkedAt > HOUR_MS
    } else {
      stale = Date.now() - checkedAt > THIRTY_DAYS_MS
    }
    if (stale) {
      void window.api.projects
        .refreshGithub(project.id)
        .catch((err) => console.warn('[project-view] github refresh failed', err))
    }
  }, [project.id, project.githubCheckedAt, project.githubOwner])

  // archivedAt is unused post-v34 (rows are deleted, never soft-archived),
  // but the field still exists in the type. Filter defensively just in case
  // a stale row sneaks through before the migration runs.
  const activeWorkspaces = (workspaces ?? []).filter((w) => w.archivedAt === null)
  // null = still loading; lets ProjectHeader render a skeleton chip instead
  // of "0 workspaces" → real count on first paint.
  const workspaceCount: number | null = workspaces === null ? null : activeWorkspaces.length

  const lastActivityAt = useMemo(() => {
    if (!workspaces || workspaces.length === 0) return null
    let max: number | null = null
    for (const ws of workspaces) {
      if (ws.lastOpenedAt !== null && (max === null || ws.lastOpenedAt > max)) {
        max = ws.lastOpenedAt
      }
    }
    return max
  }, [workspaces])

  // Sum of every harness's OWN override count. With only Claude registered,
  // harnessesInProject is at most ['claude'], so this is always exactly
  // countProjectHarnessOverrides for Claude — unchanged in effect from the
  // pre-H1 count, just sourced from the storage that is actually live.
  const overrideCount = Object.values(harnessOverrideCounts).reduce((sum, n) => sum + n, 0)

  // Honesty check (H1) — does this chip's count apply to every workspace in
  // the project, or only to one harness among several present? See
  // projectOverrideChipInfo's own doc comment. Evaluated per harness that
  // HAS overrides (not just the first in the project) — if more than one
  // harness contributes, there is no single harness name that would be
  // accurate, so the chip falls back to no qualifier rather than naming an
  // arbitrary one; that case cannot arise with only Claude registered.
  const harnessesWithOverrides = harnessesInProject.filter(
    (id) => (harnessOverrideCounts[id] ?? 0) > 0
  )
  const soleOverrideHarnessId =
    harnessesWithOverrides.length === 1 ? harnessesWithOverrides[0] : undefined
  const chipInfo = soleOverrideHarnessId
    ? projectOverrideChipInfo(soleOverrideHarnessId, overrideCount, harnessesInProject)
    : null
  const overrideHarnessLabel =
    chipInfo && !chipInfo.appliesToEveryWorkspace
      ? (harnesses.find((h) => h.id === soleOverrideHarnessId)?.label ?? soleOverrideHarnessId)
      : null

  return (
    <div className="flex flex-col gap-6">
      <ProjectHeader
        project={project}
        workspaceCount={workspaceCount}
        lastActivityAt={lastActivityAt}
        overrideCount={overrideCount}
        overrideHarnessLabel={overrideHarnessLabel}
        workspaceDefaultName={nextWorkspaceName(activeWorkspaces)}
        onNewWorkspace={(modelId, harnessId) => onAddWorkspace(project.id, modelId, harnessId)}
        onWorktreeCreated={(ws) => onSelectWorkspace(ws.id)}
        onOpenSettings={() => setSettingsOpen(true)}
        onRequestRemove={onRequestRemove}
        fetchGithubAvatars={fetchGithubAvatars}
      />

      <WorkspacesTab
        projectId={project.id}
        projectPath={project.path}
        workspaces={workspaces}
        onSelectWorkspace={onSelectWorkspace}
        onRenameWorkspace={onRenameWorkspace}
        onArchiveWorkspace={onArchiveWorkspace}
        onToggleWorkspacePin={onToggleWorkspacePin}
        onResumedInWorkspace={onResumedInWorkspace}
      />

      <SettingsDrawer
        projectId={project.id}
        projectName={project.name}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        workspaces={workspaces}
      />
    </div>
  )
}
