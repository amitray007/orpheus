import { useEffect, useMemo, useRef, useState, memo } from 'react'
import { playSound, setSoundEnabled, setSoundPack } from '../../lib/sound'
import { Sidebar as SidebarBase, type SidebarActiveView } from './Sidebar'
import { TopBar } from './TopBar'
import { MainContent as MainContentBase, type View } from './MainContent'
import { ConfirmModal } from '../ConfirmModal'
import type {
  AppUiState,
  PinnedItem,
  ProjectRecord,
  SessionRecord,
  WorkspaceRecord,
  GitStatus,
  GhPullRequest,
  WorkspaceActivityDetail
} from '@shared/types'

const Sidebar = memo(SidebarBase)
const MainContent = memo(MainContentBase)

interface DashboardProps {
  claudeInstalled: boolean
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- prop forwarded from App.tsx but not yet used in this component
export function Dashboard(_: DashboardProps): React.JSX.Element {
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

  // Activity detail keyed by workspaceId — driven by claude hook events via IPC
  const [workspaceActivities, setWorkspaceActivities] = useState<
    Record<string, WorkspaceActivityDetail>
  >({})

  // Git status per workspace id
  const [gitStatusByWorkspaceId, setGitStatusByWorkspaceId] = useState<
    Record<string, GitStatus | null>
  >({})

  // GitHub PR per workspace id — null means "no PR for this branch" so the
  // map distinguishes "not yet fetched" (undefined) from "fetched, none found"
  // (null). Rides the same 30s cadence as the git-status poll below.
  const [prByWorkspaceId, setPrByWorkspaceId] = useState<Record<string, GhPullRequest | null>>({})

  // Sessions list — fetched at Dashboard level so WorkspacesView can look up
  // session metadata (model, msg count, preview) via workspace.claudeSessionId
  const [allSessions, setAllSessions] = useState<SessionRecord[]>([])

  // Pinned workspaces — fetched on mount and after any pin/unpin toggle
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([])

  // Terminal titles keyed by workspaceId — single hoisted subscription (fix: prevent N listeners)
  const [titleByWorkspaceId, setTitleByWorkspaceId] = useState<Record<string, string>>({})

  // View routing
  const [view, setView] = useState<View>({ kind: 'sessions' })
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
          lastViewKind: 'sessions',
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
          notifyAttention: true,
          notifyStop: true,
          notifyAlways: false,
          notifyMaxAttentionRepeats: 5,
          inProgressWatchdogSec: 120,
          theme: 'midnight',
          accentColor: null,
          uiFontScale: 'default',
          fetchGithubAvatars: true,
          playInteractionSounds: true,
          soundPack: 'core',
          autoCheckUpdates: true,
          statusPollIntervalSec: 1800,
          muteStatusNotifications: false,
          showWorkspaceFooter: true,
          updatedAt: 0
        })
      })
  }, [])

  // Apply appearance data attributes to document root whenever uiState changes.
  // This drives [data-theme], [data-accent], and [data-font-scale] CSS selectors
  // in main.css without any flash because :root carries Midnight defaults.
  useEffect(() => {
    if (!uiState) return
    const root = document.documentElement
    root.dataset.theme = uiState.theme ?? 'midnight'
    if (uiState.accentColor) {
      root.dataset.accent = uiState.accentColor
    } else {
      delete root.dataset.accent
    }
    root.dataset.fontScale = uiState.uiFontScale ?? 'default'
  }, [uiState?.theme, uiState?.accentColor, uiState?.uiFontScale])

  // Bridge the playInteractionSounds uiState flag into the sound module.
  useEffect(() => {
    if (!uiState) return
    setSoundEnabled(uiState.playInteractionSounds ?? true)
  }, [uiState?.playInteractionSounds])

  // Bridge the soundPack uiState field into the sound module.
  useEffect(() => {
    if (!uiState) return
    setSoundPack(uiState.soundPack ?? 'core')
  }, [uiState?.soundPack])

  // Diagnostic: log every native action_cb tag to the console so we can debug
  // the title flow. Tag 37 = SET_TITLE, 38 = SET_TAB_TITLE in the current
  // ghostty.h. Should disappear in a follow-up commit once title flow is verified.
  useEffect(() => {
    return window.api.debug.onActionTrace((e) => {
      console.log('[addon-trace]', e.tagName)
    })
  }, [])

  useEffect(() => {
    return window.api.workspaces.onActivityChanged((e) => {
      setWorkspaceActivities((prev) => {
        const prevDetail = prev[e.workspaceId]
        const next = { ...prev, [e.workspaceId]: e.detail }
        // Play only on TRANSITION into a new state
        if (prevDetail !== e.detail) {
          if (e.detail === 'ready') playSound('ding')
          else if (e.detail === 'attention' || e.detail === 'asking') playSound('notification')
        }
        return next
      })
    })
  }, [])

  // Single hoisted title subscription — replaces per-workspace listeners in WorkspaceCard / PinnedRow / WorkspaceSubRow.
  // Main emits { title: null } on terminal:destroy to clear stale titles, so a
  // null payload deletes the key (not just skips) — otherwise destroyed
  // workspaces would keep showing the last-seen title.
  useEffect(() => {
    return window.api.workspaces.onTitleChanged((e) => {
      setTitleByWorkspaceId((prev) => {
        if (e.title) return { ...prev, [e.workspaceId]: e.title }
        if (!(e.workspaceId in prev)) return prev
        const next = { ...prev }
        delete next[e.workspaceId]
        return next
      })
    })
  }, [])

  // GitHub avatar fetches are async + fire-and-forget on the main side. When
  // they land we patch the local projects state in-place so the sidebar swaps
  // identicon → avatar without waiting for a restart or a full list refetch.
  useEffect(() => {
    return window.api.projects.onGithubDataUpdated((e) => {
      setProjects((arr) =>
        arr.map((p) =>
          p.id === e.projectId
            ? {
                ...p,
                githubOwner: e.githubOwner,
                githubRepo: e.githubRepo,
                githubAvatarUrl: e.githubAvatarUrl,
                githubCheckedAt: e.githubCheckedAt
              }
            : p
        )
      )
    })
  }, [])

  // Derived workspace id — stable across renders when the workspace hasn't actually changed
  const currentlyViewedWorkspaceId = useMemo(
    () => (view.kind === 'workspace' ? view.workspaceId : null),
    [view]
  )

  useEffect(() => {
    window.api.workspaces.setCurrentlyViewed(currentlyViewedWorkspaceId)
  }, [currentlyViewedWorkspaceId])

  // Fetch all sessions on mount and refresh whenever the Workspaces view is opened
  useEffect(() => {
    if (view.kind !== 'sessions') return
    let cancelled = false
    window.api.sessions
      .listAll()
      .then((list) => {
        if (!cancelled) setAllSessions(list)
      })
      .catch((err) => {
        console.error('[dashboard] failed to load sessions', err)
      })
    return () => {
      cancelled = true
    }
    // Re-fetch when navigating to the sessions/workspaces view so data is fresh
  }, [view.kind])

  useEffect(() => {
    return window.api.workspaces.onNavigateTo((workspaceId) => {
      const allWorkspaces = Object.values(workspacesByProject).flat()
      const ws = allWorkspaces.find((w) => w.id === workspaceId)
      if (ws) {
        handleSelectWorkspace(ws.id, ws.projectId)
      } else {
        for (const [projectId, wsList] of Object.entries(workspacesByProject)) {
          const found = wsList.find((w) => w.id === workspaceId)
          if (found) {
            handleSelectWorkspace(found.id, projectId)
            return
          }
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacesByProject])

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
    window.api.pins.listAll().then(setPinnedItems).catch(console.error)
  }

  useEffect(() => {
    refreshPins()
  }, [])

  // Stable key — only changes when workspace ids/cwds actually change, not on every object re-creation
  const workspacesPollKey = useMemo(
    () =>
      Object.values(workspacesByProject)
        .flat()
        .filter((w) => w.archivedAt === null)
        .map((w) => w.id + ':' + w.cwd)
        .join('|'),
    [workspacesByProject]
  )

  // Poll git status for all non-archived workspaces every 30s.
  // 300ms debounce prevents burst spawns when workspacesByProject updates rapidly.
  // Self-scheduling setTimeout chain (not setInterval) so a slow refresh
  // can't overlap with the next tick — gh can take seconds on flaky networks,
  // and concurrent IPC calls produced out-of-order state patches before.
  useEffect(() => {
    const workspaces = Object.values(workspacesByProject)
      .flat()
      .filter((w) => w.archivedAt === null)
    if (workspaces.length === 0) return

    let cancelled = false
    let nextTickId: ReturnType<typeof setTimeout> | null = null

    async function refresh(): Promise<void> {
      const gitResults: Record<string, GitStatus | null> = {}
      const prResults: Record<string, GhPullRequest | null> = {}
      // Sequential to avoid spawning N git processes at once
      for (const ws of workspaces) {
        if (cancelled) return
        try {
          const status = await window.api.git.status(ws.cwd)
          gitResults[ws.id] = status
          // Branch came back — ask gh for the PR. The IPC layer caches with a
          // 2-min TTL so the 30s loop doesn't actually re-shell on every tick.
          if (status?.branch) {
            try {
              prResults[ws.id] = await window.api.github.prForBranch(ws.cwd, status.branch)
            } catch (err) {
              console.error('[dashboard] gh pr lookup failed for', ws.id, err)
              prResults[ws.id] = null
            }
          } else {
            prResults[ws.id] = null
          }
        } catch (err) {
          console.error('[dashboard] git status failed for', ws.id, err)
          gitResults[ws.id] = null
          prResults[ws.id] = null
        }
      }
      if (!cancelled) {
        setGitStatusByWorkspaceId((prev) => ({ ...prev, ...gitResults }))
        setPrByWorkspaceId((prev) => ({ ...prev, ...prResults }))
      }
    }

    function schedule(delay: number): void {
      nextTickId = setTimeout(async () => {
        nextTickId = null
        if (cancelled) return
        await refresh()
        if (!cancelled) schedule(30000)
      }, delay)
    }

    schedule(300) // initial debounce, then every 30s after each completes

    return () => {
      cancelled = true
      if (nextTickId !== null) clearTimeout(nextTickId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacesPollKey])

  // Batch-fetch initial titles for newly seen workspaces so the hoisted title map is seeded.
  // Runs when new workspace ids appear; subsequent updates come via the onTitleChanged subscription.
  useEffect(() => {
    const allWs = Object.values(workspacesByProject).flat()
    if (allWs.length === 0) return
    let cancelled = false
    Promise.all(
      allWs.map((ws) =>
        window.api.workspaces
          .getTitle(ws.id)
          .then((title) => ({ id: ws.id, title }))
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return
      const patch: Record<string, string> = {}
      for (const r of results) {
        if (r && r.title) patch[r.id] = r.title
      }
      if (Object.keys(patch).length > 0) {
        setTitleByWorkspaceId((prev) => ({ ...prev, ...patch }))
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacesPollKey])

  // Hydrate UI state from DB once both projects and uiState are loaded.
  // Uses hydratedRef to avoid re-running on subsequent projects refreshes.
  /* eslint-disable react-hooks/set-state-in-effect -- one-time hydration effect; all setState calls guarded by hydratedRef */
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
    if (uiState.lastViewKind === 'sessions' || (uiState.lastViewKind as string) === 'dashboard') {
      setView({ kind: 'sessions' })
      return
    }
    // default — Workspaces is the fallback landing
    setView({ kind: 'sessions' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiState, projectsLoading, projects])
  /* eslint-enable react-hooks/set-state-in-effect */

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
    playSound(collapsed ? 'drawer-close' : 'drawer-open')
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
      setProjects((arr) =>
        arr.map((p) => (p.id === id ? { ...p, expandedInSidebar: nowExpanded } : p))
      )
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

  function handleSelectNav(nav: 'sessions'): void {
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
    // Persist as 'sessions' — 'settings' is not in the DB enum; so on restore land on Workspaces
    window.api.uiState
      .update({ lastViewKind: 'sessions', lastProjectId: null, lastWorkspaceId: null })
      .catch(console.error)
  }

  async function handleAddProject(): Promise<void> {
    setAddingProject(true)
    try {
      const result = await window.api.projects.pickAndAdd()
      if (result) {
        playSound('success')
        setProjects((arr) => [result, ...arr.filter((p) => p.id !== result.id)])
        // Fetch the auto-created Default workspace directly so we can navigate
        // into it. fetchWorkspacesForProject only writes state and doesn't
        // return the workspaces, hence the inline call here.
        const workspaces = await window.api.workspaces
          .listForProject(result.id, { scope: 'all' })
          .catch(() => [] as WorkspaceRecord[])
        setWorkspacesByProject((prev) => ({ ...prev, [result.id]: workspaces }))

        // Always expand the new project's row in the sidebar so the workspace
        // is visible (regardless of the defaultProjectExpanded preference —
        // we just navigated into it, hiding it would be confusing).
        setExpandedProjectIds((prev) => new Set(prev).add(result.id))
        window.api.projects.setExpandedInSidebar(result.id, true).catch(console.error)

        if (workspaces.length > 0) {
          // Navigate straight into the Default workspace so Claude launches
          // automatically. Skips the project view as an intermediate stop.
          const defaultWs = workspaces[0]
          handleSelectWorkspace(defaultWs.id, result.id)
        } else {
          // Fallback: no workspace was created (shouldn't happen — addProject
          // always creates a Default). Land on the project view.
          setSelectedProjectId(result.id)
          setSelectedWorkspaceId(null)
          setView({ kind: 'project', projectId: result.id })
          window.api.uiState
            .update({ lastViewKind: 'project', lastProjectId: result.id, lastWorkspaceId: null })
            .catch(console.error)
        }
      }
    } catch (err) {
      console.error('[dashboard] pickAndAdd failed', err)
    } finally {
      setAddingProject(false)
    }
  }

  async function handleResumedInWorkspace(workspace: WorkspaceRecord): Promise<void> {
    // sessions:resumeInNewWorkspace already created the row; refresh + navigate.
    await fetchWorkspacesForProject(workspace.projectId)
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      if (!next.has(workspace.projectId)) {
        next.add(workspace.projectId)
        window.api.projects.setExpandedInSidebar(workspace.projectId, true).catch(console.error)
      }
      return next
    })
    handleSelectWorkspace(workspace.id, workspace.projectId)
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
    // Ensure workspaces are loaded for this project
    if (!workspacesByProject[projectId]) {
      fetchWorkspacesForProject(projectId)
    }
    // workspaces.open updates last_opened_at server-side; merge the returned
    // record back into local cache so the project view shows fresh activity.
    window.api.workspaces
      .open(workspaceId)
      .then((updated) => {
        setWorkspacesByProject((prev) => ({
          ...prev,
          [projectId]: (prev[projectId] ?? []).map((w) => (w.id === workspaceId ? updated : w))
        }))
      })
      .catch(console.error)
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
    // Generate a sequential default name like "Workspace 3" so each new
    // workspace is identifiable in the list without forcing the user to rename.
    const existing = workspacesByProject[projectId] ?? []
    const usedNumbers = new Set(
      existing
        .map((w) => /^Workspace\s+(\d+)$/.exec(w.name)?.[1])
        .filter((s): s is string => typeof s === 'string')
        .map((s) => parseInt(s, 10))
    )
    let n = 1
    while (usedNumbers.has(n)) n++
    const defaultName = `Workspace ${n}`
    try {
      const newWs = await window.api.workspaces.create({
        projectId,
        name: defaultName,
        cwd: project.path
      })
      playSound('pop')
      // Append the newly-created workspace directly to local state instead of
      // re-fetching the full list — the create IPC already returned everything
      // we need. Eliminates a redundant DB roundtrip before the user can see
      // the new row in the sidebar.
      setWorkspacesByProject((prev) => {
        const current = prev[projectId] ?? []
        // De-dupe defensively in case a parallel fetch raced.
        if (current.some((w) => w.id === newWs.id)) return prev
        return { ...prev, [projectId]: [...current, newWs] }
      })
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
      // Navigate to the new workspace — fires immediately, mount kicks off in parallel.
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
    // Optimistically drop any cached activity for the workspace — once the
    // backend deletes the row there's nothing for the dot to track.
    setWorkspaceActivities((prev) => {
      if (prev[workspaceId] === undefined) return prev
      const next = { ...prev }
      delete next[workspaceId]
      return next
    })
    try {
      // "Archive" is a hard delete now (v34+). The DB row is gone after this.
      await window.api.workspaces.archive(workspaceId)
      playSound('archive')
      await fetchWorkspacesForProject(projectId)
      // If we were viewing the workspace that just got deleted, route back to
      // the project view — WorkspaceView can't render a row that no longer exists.
      if (selectedWorkspaceId === workspaceId) {
        setSelectedWorkspaceId(null)
        setView({ kind: 'project', projectId })
      }
      refreshPins()
    } catch (err) {
      console.error('[dashboard] workspace archive failed', err)
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
    playSound('delete')
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
      setView({ kind: 'sessions' })
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

  const allWorkspaces = useMemo(
    () => Object.values(workspacesByProject).flat(),
    [workspacesByProject]
  )

  const activeProject =
    view.kind === 'project' || view.kind === 'workspace'
      ? projects.find((p) => p.id === (view.kind === 'project' ? view.projectId : view.projectId))
      : undefined

  const activeProjectForWorkspace =
    view.kind === 'workspace' ? projects.find((p) => p.id === view.projectId) : undefined

  const activeWorkspace =
    view.kind === 'workspace'
      ? (workspacesByProject[view.projectId] ?? []).find((w) => w.id === view.workspaceId)
      : undefined

  const activeView: SidebarActiveView =
    view.kind === 'workspace'
      ? 'workspace'
      : view.kind === 'project'
        ? 'project'
        : view.kind === 'settings'
          ? 'settings'
          : 'sessions'

  return (
    <div className="flex flex-col h-screen">
      <TopBar
        onToggleCollapsed={() => setSidebarCollapsedAndPersist(!sidebarCollapsed)}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={uiState?.sidebarWidth ?? 256}
      />

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
          workspaceActivities={workspaceActivities}
          gitStatusByWorkspaceId={gitStatusByWorkspaceId}
          prByWorkspaceId={prByWorkspaceId}
          titleByWorkspaceId={titleByWorkspaceId}
          workspaceCountInline={uiState?.workspaceCountInline ?? true}
          sidebarWidth={uiState?.sidebarWidth ?? 256}
          fetchGithubAvatars={uiState?.fetchGithubAvatars ?? true}
          pinnedItems={pinnedItems}
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
          onTogglePinWorkspace={handleToggleWorkspacePin}
          onReorderProjects={handleReorderProjects}
          onReorderWorkspaces={handleReorderWorkspaces}
          onRefreshPins={refreshPins}
        />

        <main
          className={
            // body is transparent so the ghostty NSView shows through in
            // workspace view. Every OTHER view needs to paint surface-base
            // explicitly or it would bleed through to a hidden NSView /
            // empty window backing. Workspace view leaves <main> bg-less so
            // WorkspaceView's terminal placeholder div cuts a clean hole.
            view.kind === 'workspace'
              ? 'flex-1 overflow-hidden min-h-0'
              : view.kind === 'settings'
                ? 'flex-1 overflow-hidden min-h-0 bg-surface-base'
                : 'flex-1 overflow-y-auto px-8 py-6 bg-surface-base'
          }
        >
          <MainContent
            view={view}
            project={view.kind === 'project' ? activeProject : activeProjectForWorkspace}
            workspace={activeWorkspace}
            workspacesForProject={
              view.kind === 'project' ? (workspacesByProject[view.projectId] ?? null) : null
            }
            onRequestRemoveProject={handleRequestRemoveProject}
            onSelectWorkspace={handleSelectWorkspace}
            onAddWorkspace={handleAddWorkspace}
            onRenameWorkspace={handleRenameWorkspace}
            onArchiveWorkspace={handleArchiveWorkspaceFromSidebar}
            onToggleWorkspacePin={handleToggleWorkspacePin}
            workspaceActivities={workspaceActivities}
            onResumedInWorkspace={handleResumedInWorkspace}
            projects={projects}
            allWorkspaces={allWorkspaces}
            allSessions={allSessions}
            gitStatusByWorkspaceId={gitStatusByWorkspaceId}
            prByWorkspaceId={prByWorkspaceId}
            titleByWorkspaceId={titleByWorkspaceId}
            fetchGithubAvatars={uiState?.fetchGithubAvatars ?? true}
          />
        </main>
      </div>

      {removeConfirmTarget && (
        <ConfirmModal
          title="Remove?"
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
