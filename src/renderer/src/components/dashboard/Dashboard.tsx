import { useEffect, useRef, useState } from 'react'
import { Sidebar, type SidebarActiveView } from './Sidebar'
import { MainContent, type View } from './MainContent'
import { ConfirmModal } from '../ConfirmModal'
import type { AppUiState, ProjectRecord, WorkspaceRecord, PinnedItem } from '@shared/types'

interface DashboardProps {
  claudeInstalled: boolean
}

export function Dashboard({ claudeInstalled: _claudeInstalled }: DashboardProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // UI state hydration
  const [uiState, setUiState] = useState<AppUiState | null>(null)
  const hydratedRef = useRef(false)

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
    window.api.uiState
      .get()
      .then(setUiState)
      .catch((err) => {
        console.error('[dashboard] failed to load ui state', err)
        setUiState({
          sidebarCollapsed: false,
          lastViewKind: 'dashboard',
          lastProjectId: null,
          lastWorkspaceId: null,
          windowX: null,
          windowY: null,
          windowWidth: null,
          windowHeight: null,
          windowFullscreen: false,
          updatedAt: 0
        })
      })
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

  // Hydrate UI state from DB once both projects and uiState are loaded.
  // Uses hydratedRef to avoid re-running on subsequent projects refreshes.
  useEffect(() => {
    if (!uiState || projectsLoading) return
    if (hydratedRef.current) return
    hydratedRef.current = true

    setSidebarCollapsed(uiState.sidebarCollapsed)

    // Restore expanded project rows from the projects list itself
    const expanded = new Set(projects.filter((p) => p.expandedInSidebar).map((p) => p.id))
    setExpandedProjectIds(expanded)

    // Restore view: workspace > project > sessions > dashboard
    if (uiState.lastViewKind === 'workspace' && uiState.lastWorkspaceId && uiState.lastProjectId) {
      const proj = projects.find((p) => p.id === uiState.lastProjectId)
      if (proj) {
        handleSelectWorkspace(uiState.lastWorkspaceId, uiState.lastProjectId)
        return
      }
    }
    if (uiState.lastViewKind === 'project' && uiState.lastProjectId) {
      const proj = projects.find((p) => p.id === uiState.lastProjectId)
      if (proj) {
        handleSelectProject(uiState.lastProjectId)
        return
      }
    }
    if (uiState.lastViewKind === 'sessions') {
      setView({ kind: 'sessions' })
      return
    }
    // default — dashboard, initial state already handles this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState, projectsLoading, projects])

  // Stores all workspaces (active + archived) per project. Callers filter by
  // archivedAt at render time. One source of truth — keeps ProjectView in
  // sync when the sidebar mutates workspace state.
  async function fetchWorkspacesForProject(projectId: string): Promise<void> {
    try {
      const workspaces = await window.api.workspaces.listForProject(projectId, { scope: 'all' })
      setWorkspacesByProject((prev) => ({ ...prev, [projectId]: workspaces }))
    } catch (err) {
      console.error('[dashboard] failed to load workspaces for', projectId, err)
      setWorkspacesByProject((prev) => ({ ...prev, [projectId]: [] }))
    }
  }

  function setSidebarCollapsedAndPersist(collapsed: boolean): void {
    setSidebarCollapsed(collapsed)
    window.api.uiState.update({ sidebarCollapsed: collapsed }).catch(console.error)
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
      window.api.projects.setExpandedInSidebar(id, next.has(id)).catch(console.error)
      return next
    })
  }

  function handleSelectProject(id: string): void {
    setSelectedProjectId(id)
    setSelectedWorkspaceId(null)
    setView({ kind: 'project', projectId: id })
    if (!workspacesByProject[id]) {
      fetchWorkspacesForProject(id)
    }
    window.api.projects.open(id).catch(console.error)
    window.api.uiState
      .update({ lastViewKind: 'project', lastProjectId: id, lastWorkspaceId: null })
      .catch(console.error)
  }

  function handleSelectNav(nav: 'dashboard' | 'sessions'): void {
    setView({ kind: nav })
    setSelectedProjectId(null)
    setSelectedWorkspaceId(null)
    window.api.uiState
      .update({ lastViewKind: nav, lastProjectId: null, lastWorkspaceId: null })
      .catch(console.error)
  }

  function handleSelectSettings(): void {
    setView({ kind: 'settings' })
    setSelectedProjectId(null)
    setSelectedWorkspaceId(null)
    // Persist as 'dashboard' — 'settings' is not in the DB enum
    window.api.uiState
      .update({ lastViewKind: 'dashboard', lastProjectId: null, lastWorkspaceId: null })
      .catch(console.error)
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
        window.api.uiState
          .update({ lastViewKind: 'project', lastProjectId: result.id, lastWorkspaceId: null })
          .catch(console.error)
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
    if (!workspacesByProject[id]) {
      fetchWorkspacesForProject(id)
    }
    window.api.projects.open(id).catch(console.error)
    window.api.uiState
      .update({ lastViewKind: 'project', lastProjectId: id, lastWorkspaceId: null })
      .catch(console.error)
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
    window.api.uiState
      .update({ lastViewKind: 'workspace', lastProjectId: projectId, lastWorkspaceId: workspaceId })
      .catch(console.error)
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
    // Destroy the terminal surface before archiving so the shell process is cleaned up.
    // Don't block on failure — the DB archive can proceed regardless.
    window.api.terminal
      .destroy(workspaceId)
      .catch((e) => console.error('[dashboard] terminal.destroy before archive failed:', e))
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
    // Destroy all terminal surfaces for this project's workspaces before the
    // DB cascade-delete removes the workspace rows.
    const projectWorkspaces = workspacesByProject[target.id] ?? []
    for (const ws of projectWorkspaces) {
      window.api.terminal
        .destroy(ws.id)
        .catch((e) =>
          console.error('[dashboard] terminal.destroy before project remove failed:', ws.id, e)
        )
    }
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
          : view.kind === 'settings'
            ? 'settings'
            : 'dashboard'

  return (
    <div className="flex flex-1 h-full min-h-0">
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
        onToggleCollapsed={() => setSidebarCollapsedAndPersist(!sidebarCollapsed)}
        onSelectSettings={handleSelectSettings}
        onSelectProject={handleSelectProject}
        onSelectNav={handleSelectNav}
        onAddProject={handleAddProject}
        addingProject={addingProject}
        onToggleProjectExpand={handleToggleProjectExpand}
        onSelectWorkspace={handleSelectWorkspace}
        onToggleWorkspacePin={handleToggleWorkspacePin}
        onRenameProject={handleRenameProject}
        onRequestRemoveProject={handleRequestRemoveProject}
        onAddWorkspace={handleAddWorkspace}
        onRenameWorkspace={handleRenameWorkspace}
        onArchiveWorkspace={handleArchiveWorkspaceFromSidebar}
      />

      <main
        className={
          view.kind === 'workspace'
            ? 'flex-1 overflow-hidden min-h-0'
            : 'flex-1 overflow-y-auto px-8 py-6'
        }
      >
        <MainContent
          view={view}
          project={view.kind === 'project' ? activeProject : activeProjectForWorkspace}
          workspace={activeWorkspace}
          workspacesForProject={
            view.kind === 'project'
              ? (workspacesByProject[view.projectId] ?? null)
              : null
          }
          onRequestRemoveProject={handleRequestRemoveProject}
          onNavigateToProject={handleNavigateToProject}
          onSelectWorkspace={handleSelectWorkspace}
          onAddWorkspace={handleAddWorkspace}
          onRenameWorkspace={handleRenameWorkspace}
          onArchiveWorkspace={handleArchiveWorkspaceFromSidebar}
          onUnarchiveWorkspace={handleUnarchiveWorkspace}
          onToggleWorkspacePin={handleToggleWorkspacePin}
        />
      </main>

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
