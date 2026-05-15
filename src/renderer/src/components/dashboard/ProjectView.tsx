import { useEffect, useMemo, useState } from 'react'
import type React from 'react'
import type {
  ClaudeProjectSettings,
  ProjectRecord,
  WorkspaceActivityDetail,
  WorkspaceRecord
} from '@shared/types'
import { Tabs } from '../Tabs'
import { ProjectHeader } from './project/ProjectHeader'
import { WorkspacesTab } from './project/WorkspacesTab'
import { SessionsTab } from './project/SessionsTab'
import { CommitsTab } from './project/CommitsTab'
import { SettingsDrawer } from './project/SettingsDrawer'

// ---------------------------------------------------------------------------
// ProjectView — orchestrates header + tabs (Workspaces / Sessions / Commits)
// ---------------------------------------------------------------------------

type TabId = 'workspaces' | 'sessions' | 'commits'

interface ProjectViewProps {
  project: ProjectRecord
  workspaces: WorkspaceRecord[] | null
  workspaceActivities?: Record<string, WorkspaceActivityDetail>
  onRequestRemove: () => void
  onSelectWorkspace: (workspaceId: string) => void
  onAddWorkspace: (projectId: string) => void | Promise<void>
  onRenameWorkspace: (
    workspaceId: string,
    projectId: string,
    newName: string
  ) => void | Promise<void>
  onArchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onUnarchiveWorkspace: (workspaceId: string, projectId: string) => void | Promise<void>
  onToggleWorkspacePin: (workspaceId: string, projectId: string) => void | Promise<void>
  /** Called after a Sessions row click spawns a new workspace via --resume. */
  onResumedInWorkspace: (workspace: WorkspaceRecord) => void
}

export function ProjectView({
  project,
  workspaces,
  workspaceActivities = {},
  onRequestRemove,
  onSelectWorkspace,
  onAddWorkspace,
  onRenameWorkspace,
  onArchiveWorkspace,
  onUnarchiveWorkspace,
  onToggleWorkspacePin,
  onResumedInWorkspace
}: ProjectViewProps): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('workspaces')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionCount, setSessionCount] = useState(-1)
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

  const activeWorkspaces = (workspaces ?? []).filter((w) => w.archivedAt === null)
  const workspaceCount = activeWorkspaces.length

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
      />

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'workspaces', label: 'Workspaces', count: workspaceCount },
          {
            value: 'sessions',
            label: 'Sessions',
            count: sessionCount < 0 ? undefined : sessionCount
          },
          { value: 'commits', label: 'Commits' }
        ]}
      />

      {tab === 'workspaces' && (
        <WorkspacesTab
          projectId={project.id}
          workspaces={workspaces}
          workspaceActivities={workspaceActivities}
          onSelectWorkspace={onSelectWorkspace}
          onRenameWorkspace={onRenameWorkspace}
          onArchiveWorkspace={onArchiveWorkspace}
          onUnarchiveWorkspace={onUnarchiveWorkspace}
          onToggleWorkspacePin={onToggleWorkspacePin}
        />
      )}

      {tab === 'sessions' && (
        <SessionsTab
          projectId={project.id}
          onSessionCountChange={setSessionCount}
          onResumedInWorkspace={onResumedInWorkspace}
        />
      )}

      {tab === 'commits' && <CommitsTab cwd={project.path} />}

      <SettingsDrawer
        projectId={project.id}
        projectName={project.name}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}
