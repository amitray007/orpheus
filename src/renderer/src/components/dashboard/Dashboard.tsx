import { useEffect, useMemo, useRef, useState, memo } from 'react'
import { playSound, setSoundEnabled, setSoundPack } from '../../lib/sound'
import { Sidebar as SidebarBase, type SidebarActiveView } from './Sidebar'
import { TopBar } from './TopBar'
import { MainContent as MainContentBase, type View } from './MainContent'
import { ConfirmModal } from '../ConfirmModal'
import { setActivityBatch, deleteActivity, getActivitySnapshot } from '@/lib/activityStore'
import type {
  AppUiState,
  PinnedItem,
  ProjectRecord,
  SessionRecord,
  WorkspaceRecord,
  GitStatus,
  GhPullRequest
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

  // Refs kept in sync with state so event handlers with empty dep arrays can
  // read the current value without becoming stale (avoid re-subscribing each render).
  const selectedWorkspaceIdRef = useRef<string | null>(null)
  const selectedProjectIdRef = useRef<string | null>(null)
  selectedWorkspaceIdRef.current = selectedWorkspaceId
  selectedProjectIdRef.current = selectedProjectId

  // Tracks workspace ids for which we've already issued an imperative git fetch
  // so a stale-closure read of gitStatusByWorkspaceId can't trigger duplicate
  // IPC calls when the effect re-runs because workspacesPollKey changed.
  const hasFetchedRef = useRef<Set<string>>(new Set())

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

  // NOTE: depends on main-layer onActivityBatch — wired via frozen contract:
  // channel `workspace:activityBatch`, payload Array<{workspaceId,status,detail}>,
  // preload window.api.workspaces.onActivityBatch.
  // Falls back to onActivityChanged if the batched API isn't available yet.
  useEffect(() => {
    const api = window.api.workspaces as typeof window.api.workspaces & {
      onActivityBatch?: (
        cb: (
          batch: Array<{
            workspaceId: string
            status: import('@shared/types').WorkspaceStatus
            detail: import('@shared/types').WorkspaceActivityDetail
          }>
        ) => void
      ) => () => void
    }

    if (typeof api.onActivityBatch === 'function') {
      return api.onActivityBatch((batch) => {
        // Sound effects: play on first status transition per batch
        for (const { workspaceId, detail } of batch) {
          const prevDetail = getActivitySnapshot().get(workspaceId)
          if (prevDetail !== detail) {
            if (detail === 'ready') playSound('ding')
            else if (detail === 'attention' || detail === 'asking') playSound('notification')
          }
        }
        setActivityBatch(batch.map(({ workspaceId, detail }) => ({ workspaceId, detail })))
      })
    }

    // Fallback: legacy per-event channel (used until main-layer lands onActivityBatch)
    return window.api.workspaces.onActivityChanged((e) => {
      const prevDetail = getActivitySnapshot().get(e.workspaceId)
      if (prevDetail !== e.detail) {
        if (e.detail === 'ready') playSound('ding')
        else if (e.detail === 'attention' || e.detail === 'asking') playSound('notification')
      }
      setActivityBatch([{ workspaceId: e.workspaceId, detail: e.detail }])
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

  // Subscribe to workspaces:created so renderer state stays in sync with main's
  // DB writes across ALL creation paths (normal create, fork, duplicate,
  // session-resume). Without this, fork navigation lands before
  // workspacesByProject includes the new row → "Not Found" in WorkspaceView.
  useEffect(() => {
    return window.api.workspaces.onCreated((workspace) => {
      setWorkspacesByProject((prev) => {
        const current = prev[workspace.projectId] ?? []
        // De-dupe defensively in case a parallel fetch raced.
        if (current.some((w) => w.id === workspace.id)) return prev
        return { ...prev, [workspace.projectId]: [workspace, ...current] }
      })
      // Ensure the project row is expanded so the new workspace is visible.
      setExpandedProjectIds((prev) => {
        if (prev.has(workspace.projectId)) return prev
        const next = new Set(prev)
        next.add(workspace.projectId)
        window.api.projects.setExpandedInSidebar(workspace.projectId, true).catch(console.error)
        return next
      })
    })
  }, [])

  // Subscribe to workspaces:archived so the sidebar and view routing stay
  // consistent after a workspace.archive action (footer chip or sidebar button).
  // Uses refs to read current selectedWorkspaceId / selectedProjectId without
  // requiring this effect to re-subscribe on every render.
  useEffect(() => {
    return window.api.workspaces.onArchived(({ workspaceId, projectId }) => {
      // Remove the workspace from local cache.
      setWorkspacesByProject((prev) => {
        const list = prev[projectId]
        if (!list) return prev
        const next = list.filter((w) => w.id !== workspaceId)
        return { ...prev, [projectId]: next }
      })
      // If this was the active workspace, navigate to a fallback.
      if (selectedWorkspaceIdRef.current === workspaceId) {
        setWorkspacesByProject((prev) => {
          const remaining = (prev[projectId] ?? []).filter((w) => w.id !== workspaceId)
          if (remaining.length > 0) {
            // Navigate to the first remaining workspace in the project.
            const next = remaining[0]
            setSelectedProjectId(projectId)
            setSelectedWorkspaceId(next.id)
            setView({ kind: 'workspace', workspaceId: next.id, projectId })
            window.api.uiState
              .update({
                lastViewKind: 'workspace',
                lastProjectId: projectId,
                lastWorkspaceId: next.id
              })
              .catch(console.error)
          } else {
            // No workspaces left — go to the project view.
            setSelectedProjectId(projectId)
            setSelectedWorkspaceId(null)
            setView({ kind: 'project', projectId })
            window.api.uiState
              .update({ lastViewKind: 'project', lastProjectId: projectId, lastWorkspaceId: null })
              .catch(console.error)
          }
          return prev // no change — already updated above
        })
      }
      // Clear any stale activity entry for the deleted workspace from the store.
      deleteActivity(workspaceId)
    })
  }, [])

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

  // Subscribe to git status and PR push updates emitted by main's fs.watch watcher.
  // NOTE: depends on arch-main channels:
  //   git:statusChanged  → { workspaceId: string; status: GitStatus }
  //   github:prChanged   → { workspaceId: string; pr: GhPullRequest | null }
  // Preload methods: window.api.git.onStatusChanged / window.api.github.onPrChanged
  // each returning an unsubscribe fn.
  //
  // Renderer-local ambient types until the preload types are reconciled.
  type GitApiWithPush = typeof window.api.git & {
    onStatusChanged?: (cb: (e: { workspaceId: string; status: GitStatus }) => void) => () => void
  }
  type GithubApiWithPush = typeof window.api.github & {
    onPrChanged?: (cb: (e: { workspaceId: string; pr: GhPullRequest | null }) => void) => () => void
  }

  useEffect(() => {
    const gitApi = window.api.git as GitApiWithPush
    const githubApi = window.api.github as GithubApiWithPush

    const unsubGit =
      typeof gitApi.onStatusChanged === 'function'
        ? gitApi.onStatusChanged((e) => {
            setGitStatusByWorkspaceId((prev) => ({ ...prev, [e.workspaceId]: e.status }))
          })
        : undefined

    const unsubPr =
      typeof githubApi.onPrChanged === 'function'
        ? githubApi.onPrChanged((e) => {
            setPrByWorkspaceId((prev) => ({ ...prev, [e.workspaceId]: e.pr }))
          })
        : undefined

    return () => {
      unsubGit?.()
      unsubPr?.()
    }
  }, [])

  // Belt-and-suspenders: one-time imperative fetch for workspaces visible at
  // mount / when new workspace ids appear, in case the push subscription
  // attaches after main has already emitted the initial statusChanged events.
  // Subsequent updates come via the push channels above.
  useEffect(() => {
    const workspaces = Object.values(workspacesByProject)
      .flat()
      .filter((w) => w.archivedAt === null)
    if (workspaces.length === 0) return
    let cancelled = false

    async function fetchMissing(): Promise<void> {
      const gitResults: Record<string, GitStatus | null> = {}
      const prResults: Record<string, GhPullRequest | null> = {}
      // Only fetch for workspaces we haven't already fetched — use a ref-based
      // set so we don't read stale state from the closure, which would trigger
      // duplicate IPC calls when workspacesPollKey re-runs.
      const missing = workspaces.filter((w) => !hasFetchedRef.current.has(w.id))
      for (const ws of missing) {
        hasFetchedRef.current.add(ws.id)
        if (cancelled) return
        try {
          const status = await window.api.git.status(ws.cwd)
          gitResults[ws.id] = status
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
        if (Object.keys(gitResults).length > 0)
          setGitStatusByWorkspaceId((prev) => ({ ...prev, ...gitResults }))
        if (Object.keys(prResults).length > 0)
          setPrByWorkspaceId((prev) => ({ ...prev, ...prResults }))
      }
    }

    fetchMissing().catch((err) => console.error('[dashboard] initial git fetch failed', err))
    return () => {
      cancelled = true
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
    // workspaces.open and uiState.update are independent DB writes — issue them
    // concurrently so they don't serialize on the ipcMain queue ahead of terminal:mount.
    Promise.all([
      window.api.workspaces.open(workspaceId).then((updated) => {
        setWorkspacesByProject((prev) => ({
          ...prev,
          [projectId]: (prev[projectId] ?? []).map((w) => (w.id === workspaceId ? updated : w))
        }))
      }),
      window.api.uiState.update({
        lastViewKind: 'workspace',
        lastProjectId: projectId,
        lastWorkspaceId: workspaceId
      })
    ]).catch(console.error)
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
        return { ...prev, [projectId]: [newWs, ...current] }
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
    // Optimistically drop any cached activity for the workspace from the store —
    // once the backend deletes the row there's nothing for the dot to track.
    deleteActivity(workspaceId)
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
    // Serialised with a microtask yield between each destroy so AppKit can drain
    // main-queue work (ghostty_surface_free stalls ~200ms-2s per surface) without
    // blocking the event loop for the full N-surface burst.
    const projectWorkspaces = workspacesByProject[target.id] ?? []
    for (const ws of projectWorkspaces) {
      await window.api.terminal
        .destroy(ws.id)
        .catch((e) =>
          console.error('[dashboard] terminal.destroy before project remove failed:', ws.id, e)
        )
      // Yield to the event loop between each destroy so AppKit can drain between frees.
      await new Promise<void>((r) => setTimeout(r, 0))
    }
    await window.api.projects.remove(target.id)
    playSound('delete')
    setRemoveConfirmTarget(null)
    // Drop cached activity for all removed workspaces — mirrors the pattern in
    // handleArchiveWorkspaceFromSidebar. Must run before the setProjects filter
    // so we still have the workspace IDs available.
    for (const ws of projectWorkspaces) {
      deleteActivity(ws.id)
    }
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
                : view.kind === 'sessions'
                  ? // Workspaces kanban: tight padding so the board sits close to the app edges
                    'flex-1 overflow-y-auto px-3 py-3 bg-surface-base'
                  : 'flex-1 overflow-y-auto px-6 py-5 bg-surface-base'
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
