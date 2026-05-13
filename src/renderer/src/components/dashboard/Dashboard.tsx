import { useEffect, useRef, useState } from 'react'
import { Sidebar, type SidebarActiveView } from './Sidebar'
import { TopBar } from './TopBar'
import { MainContent, type View } from './MainContent'
import { ConfirmModal } from '../ConfirmModal'
import type { AppUiState, ProjectRecord, WorkspaceRecord, GitStatus } from '@shared/types'

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

  // Track which workspace surfaces are alive this session (mounted via terminal.mount)
  const [activeWorkspaceIds, setActiveWorkspaceIds] = useState<Set<string>>(new Set())

  // Git status per workspace id
  const [gitStatusByWorkspaceId, setGitStatusByWorkspaceId] = useState<Record<string, GitStatus | null>>({})

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
          restoreGeometry: true,
          closeHides: true,
          openAtLastView: true,
          pinnedSectionVisible: true,
          workspaceCountInline: true,
          sidebarWidth: 256,
          defaultProjectExpanded: false,
          launchAtLogin: false,
          globalHotkey: '',
          archivedWorkspaceLimit: 20,
          updatedAt: 0
        })
      })
  }, [])

  // Diagnostic: log every native action_cb tag to the console so we can debug
  // the title flow. Tag 37 = SET_TITLE, 38 = SET_TAB_TITLE in the current
  // ghostty.h. Should disappear in a follow-up commit once title flow is verified.
  useEffect(() => {
    return window.api.debug.onActionTrace((e) => {
      console.log('[addon-trace]', e.tagName)
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

  // refreshPins is kept as a no-op: the pins IPC still exists for back-compat
  // but the Sidebar no longer renders a Pinned section.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  function refreshPins(): void {}

  // Poll git status for all non-archived workspaces every 30s
  useEffect(() => {
    const allWorkspaces = Object.values(workspacesByProject)
      .flat()
      .filter((w) => w.archivedAt === null)
    if (allWorkspaces.length === 0) return

    let cancelled = false

    async function refresh(): Promise<void> {
      const results: Record<string, GitStatus | null> = {}
      // Sequential to avoid spawning N git processes at once
      for (const ws of allWorkspaces) {
        if (cancelled) return
        try {
          const status = await window.api.git.status(ws.cwd)
          results[ws.id] = status
        } catch (err) {
          console.error('[dashboard] git status failed for', ws.id, err)
          results[ws.id] = null
        }
      }
      if (!cancelled) {
        setGitStatusByWorkspaceId((prev) => ({ ...prev, ...results }))
      }
    }

    refresh()
    const interval = setInterval(refresh, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [workspacesByProject])

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
    // Sub-rows are gated on workspaces being loaded — kick off fetches so the
    // visual state matches the restored expanded state on the very first render.
    for (const projectId of expanded) fetchWorkspacesForProject(projectId)

    // Honor openAtLastView toggle — when false, ignore the saved view and start at dashboard
    if (!uiState.openAtLastView) return

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
      const nowExpanded = next.has(id)
      window.api.projects.setExpandedInSidebar(id, nowExpanded).catch(console.error)
      // Keep local projects state in sync so any subsequent setProjects() call
      // (e.g. from handleRenameProject revert) doesn't clobber the expandedInSidebar field.
      setProjects((arr) => arr.map((p) => (p.id === id ? { ...p, expandedInSidebar: nowExpanded } : p)))
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
        // Auto-expand if defaultProjectExpanded is on
        if (uiState?.defaultProjectExpanded) {
          setExpandedProjectIds((prev) => new Set(prev).add(result.id))
          window.api.projects.setExpandedInSidebar(result.id, true).catch(console.error)
        }
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
    // Keep the project expanded so the workspace stays visible.
    // Also persist the expanded state to DB so it survives a relaunch.
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      if (!next.has(projectId)) {
        next.add(projectId)
        window.api.projects.setExpandedInSidebar(projectId, true).catch(console.error)
      }
      return next
    })
    // Mark this workspace's terminal surface as active (mount succeeds)
    setActiveWorkspaceIds((prev) => {
      const next = new Set(prev)
      next.add(workspaceId)
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
      // Expand the project row so the new workspace is visible.
      // Persist the expanded state so it survives a relaunch.
      setExpandedProjectIds((prev) => {
        const next = new Set(prev)
        if (!next.has(projectId)) {
          next.add(projectId)
          window.api.projects.setExpandedInSidebar(projectId, true).catch(console.error)
        }
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
    // Remove from active set — surface is being destroyed
    setActiveWorkspaceIds((prev) => {
      const next = new Set(prev)
      next.delete(workspaceId)
      return next
    })
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

  function handleWorkspaceStatusChanged(workspaceId: string): void {
    // Find the project that owns this workspace and refetch so the status
    // flows back through props into WorkspaceView.
    const projectId = Object.entries(workspacesByProject).find(([, ws]) =>
      ws.some((w) => w.id === workspaceId)
    )?.[0]
    if (projectId) {
      fetchWorkspacesForProject(projectId).catch(console.error)
      refreshPins()
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
    // Remove all project workspace surfaces from the active set
    setActiveWorkspaceIds((prev) => {
      const next = new Set(prev)
      for (const ws of projectWorkspaces) {
        next.delete(ws.id)
      }
      return next
    })
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

  function handleReorderProjects(orderedIds: string[]): void {
    // Optimistic reorder — update local state immediately
    const byId = new Map(projects.map((p) => [p.id, p]))
    const reordered = orderedIds.map((id) => byId.get(id)).filter((p): p is ProjectRecord => !!p)
    setProjects(reordered)
    window.api.projects.reorder(orderedIds).catch((err) => {
      console.error('[dashboard] reorder failed; refetching', err)
      window.api.projects.list().then(setProjects).catch(console.error)
    })
  }

  function handleReorderWorkspaces(projectId: string, orderedIds: string[]): void {
    // Optimistic: reorder the local workspacesByProject[projectId] immediately
    setWorkspacesByProject((prev) => {
      const list = prev[projectId] ?? []
      const byId = new Map(list.map((w) => [w.id, w]))
      const reordered = orderedIds
        .map((id) => byId.get(id))
        .filter((w): w is WorkspaceRecord => !!w)
      // Append any workspaces missing from orderedIds (e.g. archived ones not in the visible group)
      const seen = new Set(orderedIds)
      const tail = list.filter((w) => !seen.has(w.id))
      return { ...prev, [projectId]: [...reordered, ...tail] }
    })
    window.api.workspaces.reorder(projectId, orderedIds).catch((err) => {
      console.error('[dashboard] workspace reorder failed; refetching', err)
      fetchWorkspacesForProject(projectId).catch(console.error)
    })
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
    <div className="flex flex-col h-screen">
      {view.kind !== 'workspace' && (
        <TopBar
          onToggleCollapsed={() => setSidebarCollapsedAndPersist(!sidebarCollapsed)}
        />
      )}

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
          activeWorkspaceIds={activeWorkspaceIds}
          gitStatusByWorkspaceId={gitStatusByWorkspaceId}
          workspaceCountInline={uiState?.workspaceCountInline ?? true}
          sidebarWidth={uiState?.sidebarWidth ?? 256}
          onSelectProject={handleSelectProject}
          onSelectNav={handleSelectNav}
          onSelectSettings={handleSelectSettings}
          onAddProject={handleAddProject}
          addingProject={addingProject}
          onToggleProjectExpand={handleToggleProjectExpand}
          onSelectWorkspace={handleSelectWorkspace}
          onRenameProject={handleRenameProject}
          onRequestRemoveProject={handleRequestRemoveProject}
          onAddWorkspace={handleAddWorkspace}
          onRenameWorkspace={handleRenameWorkspace}
          onArchiveWorkspace={handleArchiveWorkspaceFromSidebar}
          onReorderProjects={handleReorderProjects}
          onReorderWorkspaces={handleReorderWorkspaces}
        />

        <main
          className={
            view.kind === 'workspace' || view.kind === 'settings'
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
            onWorkspaceStatusChanged={handleWorkspaceStatusChanged}
          />
        </main>
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
