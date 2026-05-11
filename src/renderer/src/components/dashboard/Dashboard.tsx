import { useEffect, useState } from 'react'
import { Topbar } from './Topbar'
import { Sidebar, type SidebarActiveView } from './Sidebar'
import { Footer } from './Footer'
import { MainContent, type View } from './MainContent'
import { ConfirmModal } from '../ConfirmModal'
import type { ProjectRecord, WorkspaceRecord, PinnedItem } from '@shared/types'

interface DashboardProps {
  claudeInstalled: boolean
}

export function Dashboard({ claudeInstalled }: DashboardProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [version, setVersion] = useState<string>('')

  // Projects state
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [addingProject, setAddingProject] = useState(false)

  // Workspace state: lazy-loaded per project, keyed by projectId
  const [workspacesByProject, setWorkspacesByProject] = useState<Record<string, WorkspaceRecord[]>>(
    {}
  )

  // Which project rows are expanded in the sidebar
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set())

  // Pinned items
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([])
  const [pinnedLoading, setPinnedLoading] = useState(true)

  // View routing
  const [view, setView] = useState<View>({ kind: 'dashboard' })
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)

  // Remove confirm dialog
  const [removeConfirmTarget, setRemoveConfirmTarget] = useState<ProjectRecord | null>(null)

  useEffect(() => {
    window.api.app
      .getVersion()
      .then(setVersion)
      .catch(() => setVersion('0.0.0'))
  }, [])

  useEffect(() => {
    window.api.projects
      .list()
      .then((list) => {
        setProjects(list)
        setProjectsLoading(false)
      })
      .catch((err) => {
        console.error('[dashboard] failed to load projects', err)
        setProjectsLoading(false)
      })
  }, [])

  function refreshPins(): void {
    window.api.pins
      .listAll()
      .then((items) => {
        setPinnedItems(items)
        setPinnedLoading(false)
      })
      .catch((err) => {
        console.error('[dashboard] failed to load pins', err)
        setPinnedLoading(false)
      })
  }

  useEffect(() => {
    refreshPins()
  }, [])

  async function fetchWorkspacesForProject(projectId: string): Promise<void> {
    try {
      const workspaces = await window.api.workspaces.listForProject(projectId)
      setWorkspacesByProject((prev) => ({ ...prev, [projectId]: workspaces }))
    } catch (err) {
      console.error('[dashboard] failed to load workspaces for', projectId, err)
      setWorkspacesByProject((prev) => ({ ...prev, [projectId]: [] }))
    }
  }

  function handleToggleProjectExpand(id: string): void {
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
        // Lazy-load workspaces if not yet fetched
        if (!workspacesByProject[id]) {
          fetchWorkspacesForProject(id)
        }
      }
      return next
    })
  }

  function handleSelectProject(id: string): void {
    setSelectedProjectId(id)
    setSelectedWorkspaceId(null)
    setView({ kind: 'project', projectId: id })
    window.api.projects.open(id).catch(console.error)
  }

  function handleSelectNav(nav: 'dashboard' | 'sessions'): void {
    setView({ kind: nav })
    setSelectedProjectId(null)
    setSelectedWorkspaceId(null)
  }

  async function handleAddProject(): Promise<void> {
    setAddingProject(true)
    try {
      const result = await window.api.projects.pickAndAdd()
      if (result) {
        setProjects((arr) => [result, ...arr.filter((p) => p.id !== result.id)])
        setSelectedProjectId(result.id)
        setSelectedWorkspaceId(null)
        setView({ kind: 'project', projectId: result.id })
        // Fetch the auto-created Default workspace
        await fetchWorkspacesForProject(result.id)
      }
    } catch (err) {
      console.error('[dashboard] pickAndAdd failed', err)
    } finally {
      setAddingProject(false)
    }
  }

  function handleNavigateToProject(id: string): void {
    setSelectedProjectId(id)
    setSelectedWorkspaceId(null)
    setView({ kind: 'project', projectId: id })
    window.api.projects.open(id).catch(console.error)
  }

  function handleSelectWorkspace(workspaceId: string, projectId: string): void {
    setSelectedProjectId(projectId)
    setSelectedWorkspaceId(workspaceId)
    setView({ kind: 'workspace', workspaceId, projectId })
    // Keep the project expanded so the workspace stays visible
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      next.add(projectId)
      return next
    })
    // Ensure workspaces are loaded for this project
    if (!workspacesByProject[projectId]) {
      fetchWorkspacesForProject(projectId)
    }
    window.api.workspaces.open(workspaceId).catch(console.error)
  }

  function handleWorkspaceArchived(projectId: string): void {
    // Refresh workspaces for the project, then navigate back to project view
    fetchWorkspacesForProject(projectId)
    setSelectedWorkspaceId(null)
    setView({ kind: 'project', projectId })
    refreshPins()
  }

  async function handleToggleProjectPin(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    const pinned = project.pinnedAt === null
    try {
      const updated = await window.api.projects.setPinned(projectId, pinned)
      setProjects((arr) => arr.map((p) => (p.id === projectId ? updated : p)))
      refreshPins()
    } catch (err) {
      console.error('[dashboard] setPinned failed', err)
    }
  }

  async function handleToggleWorkspacePin(workspaceId: string, projectId: string): Promise<void> {
    const workspaces = workspacesByProject[projectId] ?? []
    const ws = workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const pinned = ws.pinnedAt === null
    try {
      const updated = await window.api.workspaces.setPinned(workspaceId, pinned)
      setWorkspacesByProject((prev) => ({
        ...prev,
        [projectId]: (prev[projectId] ?? []).map((w) => (w.id === workspaceId ? updated : w))
      }))
      refreshPins()
    } catch (err) {
      console.error('[dashboard] workspace setPinned failed', err)
    }
  }

  async function handleAddWorkspace(projectId: string): Promise<void> {
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    try {
      const newWs = await window.api.workspaces.create({
        projectId,
        name: 'New Workspace',
        cwd: project.path
      })
      // Refresh workspace list for this project
      await fetchWorkspacesForProject(projectId)
      // Expand the project row so the new workspace is visible
      setExpandedProjectIds((prev) => {
        const next = new Set(prev)
        next.add(projectId)
        return next
      })
      // Navigate to the new workspace
      handleSelectWorkspace(newWs.id, projectId)
    } catch (err) {
      console.error('[dashboard] add workspace failed', err)
    }
  }

  async function handleRenameWorkspace(
    workspaceId: string,
    projectId: string,
    newName: string
  ): Promise<void> {
    const trimmed = newName.trim()
    if (!trimmed) return
    // Optimistic update
    setWorkspacesByProject((prev) => ({
      ...prev,
      [projectId]: (prev[projectId] ?? []).map((w) =>
        w.id === workspaceId ? { ...w, name: trimmed, nameIsAuto: false } : w
      )
    }))
    try {
      await window.api.workspaces.rename(workspaceId, trimmed)
      refreshPins()
    } catch (err) {
      console.error('[dashboard] workspace rename failed', err)
      await fetchWorkspacesForProject(projectId)
    }
  }

  async function handleArchiveWorkspaceFromSidebar(
    workspaceId: string,
    projectId: string
  ): Promise<void> {
    try {
      await window.api.workspaces.archive(workspaceId)
      await fetchWorkspacesForProject(projectId)
      // If the archived workspace was active, route back to its project view
      if (selectedWorkspaceId === workspaceId) {
        setSelectedWorkspaceId(null)
        setView({ kind: 'project', projectId })
      }
      refreshPins()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('last active')) {
        alert('Cannot archive the last active workspace in this project.')
      } else {
        console.error('[dashboard] workspace archive failed', err)
      }
    }
  }

  async function handleUnarchiveWorkspace(workspaceId: string, projectId: string): Promise<void> {
    try {
      await window.api.workspaces.unarchive(workspaceId)
      await fetchWorkspacesForProject(projectId)
      refreshPins()
    } catch (err) {
      console.error('[dashboard] workspace unarchive failed', err)
    }
  }

  async function handleRenameProject(id: string, newName: string): Promise<void> {
    // Optimistic update
    setProjects((arr) => arr.map((p) => (p.id === id ? { ...p, name: newName } : p)))
    try {
      await window.api.projects.rename(id, newName)
      // Refresh pins in case the project appears in the pinned section
      refreshPins()
    } catch (err) {
      console.error('[dashboard] project rename failed', err)
      // Revert by re-fetching
      window.api.projects.list().then(setProjects).catch(console.error)
    }
  }

  function handleRequestRemoveProject(project: ProjectRecord): void {
    setRemoveConfirmTarget(project)
  }

  async function handleConfirmRemove(): Promise<void> {
    if (!removeConfirmTarget) return
    const target = removeConfirmTarget
    await window.api.projects.remove(target.id)
    setRemoveConfirmTarget(null)
    setProjects((arr) => arr.filter((p) => p.id !== target.id))
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      next.delete(target.id)
      return next
    })
    if (selectedProjectId === target.id) {
      setSelectedProjectId(null)
      setSelectedWorkspaceId(null)
      setView({ kind: 'dashboard' })
    }
    refreshPins()
  }

  function handleCancelRemove(): void {
    setRemoveConfirmTarget(null)
  }

  const activeProject =
    view.kind === 'project' || view.kind === 'workspace'
      ? projects.find((p) => p.id === (view.kind === 'project' ? view.projectId : view.projectId))
      : undefined

  const activeProjectForWorkspace =
    view.kind === 'workspace'
      ? projects.find((p) => p.id === view.projectId)
      : undefined

  const activeWorkspace =
    view.kind === 'workspace'
      ? (workspacesByProject[view.projectId] ?? []).find((w) => w.id === view.workspaceId)
      : undefined

  const activeView: SidebarActiveView =
    view.kind === 'workspace'
      ? 'workspace'
      : view.kind === 'project'
        ? 'project'
        : view.kind === 'sessions'
          ? 'sessions'
          : 'dashboard'

  return (
    <div className="flex flex-col h-full">
      <Topbar onToggleSidebar={() => setSidebarCollapsed((v) => !v)} />

      <div className="flex flex-1 min-h-0">
        <Sidebar
          collapsed={sidebarCollapsed}
          projects={projects}
          projectsLoading={projectsLoading}
          selectedProjectId={selectedProjectId}
          selectedWorkspaceId={selectedWorkspaceId}
          activeView={activeView}
          currentViewKind={view.kind}
          expandedProjectIds={expandedProjectIds}
          workspacesByProject={workspacesByProject}
          pinnedItems={pinnedItems}
          pinnedLoading={pinnedLoading}
          onSelectProject={handleSelectProject}
          onSelectNav={handleSelectNav}
          onAddProject={handleAddProject}
          addingProject={addingProject}
          onToggleProjectExpand={handleToggleProjectExpand}
          onSelectWorkspace={handleSelectWorkspace}
          onToggleProjectPin={handleToggleProjectPin}
          onToggleWorkspacePin={handleToggleWorkspacePin}
          onRenameProject={handleRenameProject}
          onRequestRemoveProject={handleRequestRemoveProject}
          onAddWorkspace={handleAddWorkspace}
          onRenameWorkspace={handleRenameWorkspace}
          onArchiveWorkspace={handleArchiveWorkspaceFromSidebar}
        />

        {/* Right column: main content + footer */}
        <div className="flex flex-1 flex-col min-w-0">
          <main className="flex-1 overflow-y-auto px-8 py-6">
            <MainContent
              view={view}
              project={view.kind === 'project' ? activeProject : activeProjectForWorkspace}
              workspace={activeWorkspace}
              onRequestRemoveProject={handleRequestRemoveProject}
              onNavigateToProject={handleNavigateToProject}
              onSelectWorkspace={handleSelectWorkspace}
              onWorkspaceArchived={handleWorkspaceArchived}
              onAddWorkspace={handleAddWorkspace}
              onRenameWorkspace={handleRenameWorkspace}
              onArchiveWorkspace={handleArchiveWorkspaceFromSidebar}
              onUnarchiveWorkspace={handleUnarchiveWorkspace}
              onToggleWorkspacePin={handleToggleWorkspacePin}
            />
          </main>

          <Footer version={version} connected={claudeInstalled} />
        </div>
      </div>

      {removeConfirmTarget && (
        <ConfirmModal
          title="Remove from Orpheus?"
          body={
            <>
              <p className="mb-2">
                <span className="font-medium text-text-primary">{removeConfirmTarget.name}</span>{' '}
                will be removed from Orpheus along with its workspaces and sessions.
              </p>
              <p className="text-text-muted">
                Files on disk are untouched. You can re-add the folder later.
              </p>
            </>
          }
          confirmLabel="Remove"
          destructive
          onConfirm={handleConfirmRemove}
          onCancel={handleCancelRemove}
        />
      )}
    </div>
  )
}
