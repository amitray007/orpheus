import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type { ClaudeProjectSettings, ProjectRecord, WorkspaceRecord } from '@shared/types'
import { ProjectHeader } from './project/ProjectHeader'
import { WorkspacesTab } from './project/WorkspacesTab'
import { SettingsDrawer } from './project/SettingsDrawer'

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
  onAddWorkspace: (projectId: string) => void | Promise<void>
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
  const [projectSettings, setProjectSettings] = useState<ClaudeProjectSettings | null>(null)

  // Project-scope override count (for header chip).
  useEffect(() => {
    let cancelled = false
    window.api.claudeProjectSettings
      .get(project.id)
      .then((s) => {
        if (!cancelled) setProjectSettings(s)
      })
      .catch((err) => console.error('[project-view] failed to load project settings', err))
    return () => {
      cancelled = true
    }
    // Re-pull when the drawer closes so the header chip reflects fresh edits.
  }, [project.id, settingsOpen])

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

  const overrideCount = projectSettings ? Object.keys(projectSettings.overrides).length : 0

  return (
    <div className="flex flex-col gap-6">
      <ProjectHeader
        project={project}
        workspaceCount={workspaceCount}
        lastActivityAt={lastActivityAt}
        overrideCount={overrideCount}
        onNewWorkspace={() => onAddWorkspace(project.id)}
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
      />
    </div>
  )
}
