import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import { playSound, setSoundEnabled, setSoundPack } from '../../lib/sound'
import { Sidebar as SidebarBase, type SidebarActiveView } from './Sidebar'
import { TopBar } from './TopBar'
import { MainContent as MainContentBase, type View } from './MainContent'
import { ConfirmModal } from '../ConfirmModal'
import { setActivityBatch, deleteActivity, getActivitySnapshot } from '@/lib/activityStore'
import { setAuthoritativeActiveWorkspace } from '@/lib/freezeWatchdog'
import { bumpActivityTime, deleteActivityTime } from '@/lib/activityTimeStore'
import { setTitle, deleteTitle } from '@/lib/titleStore'
import { setGitStatus, deleteGitStatus } from '@/lib/gitStore'
import { setPr, deletePr } from '@/lib/prStore'
import { clearFooterActionsCache } from './footer/useFooterActions'
import { clearContextBudgetCache } from './WorkspaceTitleBar'
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

  // Sessions list — fetched at Dashboard level so WorkspacesView can look up
  // session metadata (model, msg count, preview) via workspace.claudeSessionId
  const [allSessions, setAllSessions] = useState<SessionRecord[]>([])

  // Pinned workspaces — fetched on mount and after any pin/unpin toggle
  const [pinnedItems, setPinnedItems] = useState<PinnedItem[]>([])

  // View routing
  const [view, setView] = useState<View>({ kind: 'sessions' })
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)

  // Refs kept in sync with state so event handlers with empty dep arrays can
  // read the current value without becoming stale (avoid re-subscribing each render).
  const selectedWorkspaceIdRef = useRef<string | null>(null)
  const selectedProjectIdRef = useRef<string | null>(null)
  const workspacesByProjectRef = useRef<Record<string, WorkspaceRecord[]>>({})
  const projectsRef = useRef<ProjectRecord[]>([])
  // Stable callback ref — lets the zero-dep onNavigateTo effect always call
  // the latest handleSelectWorkspace without re-subscribing on every render.
  const handleSelectWorkspaceRef = useRef<(workspaceId: string, projectId: string) => void>(
    () => {}
  )
  // Keep refs in sync with state synchronously after every commit so event
  // handlers with [] deps can read the current value without becoming stale.
  // useLayoutEffect (rather than render-time assignment) satisfies the
  // react-hooks/refs lint rule while preserving the same-tick-as-commit semantics.
  useLayoutEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId
    selectedProjectIdRef.current = selectedProjectId
    workspacesByProjectRef.current = workspacesByProject
    projectsRef.current = projects
  })

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
          hooksIntegrationEnabled: false,
          notifyAttention: true,
          notifyStop: true,
          notifyAlways: false,
          notifyRichSummary: true,
          notifySuppressWhenFocused: false,
          notifyMaxAttentionRepeats: 5,
          inProgressWatchdogSec: 120,
          staleAfterMinutes: 60,
          autoCloseAfterMinutes: 120,
          diagError: true,
          diagLifecycle: false,
          diagPerf: false,
          diagAnomaly: false,
          diagTrace: false,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- field-level deps are intentional; depending on the whole uiState object would re-run this effect on unrelated uiState changes
  }, [uiState?.theme, uiState?.accentColor, uiState?.uiFontScale])

  // Bridge the playInteractionSounds uiState flag into the sound module.
  useEffect(() => {
    if (!uiState) return
    setSoundEnabled(uiState.playInteractionSounds ?? true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- field-level deps are intentional; depending on the whole uiState object would re-run this effect on unrelated uiState changes
  }, [uiState?.playInteractionSounds])

  // Bridge the soundPack uiState field into the sound module.
  useEffect(() => {
    if (!uiState) return
    setSoundPack(uiState.soundPack ?? 'core')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- field-level deps are intentional; depending on the whole uiState object would re-run this effect on unrelated uiState changes
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
            else if (detail === 'attention') playSound('notification')
          }
        }
        setActivityBatch(batch.map(({ workspaceId, detail }) => ({ workspaceId, detail })))
        const now = Date.now()
        for (const { workspaceId } of batch) bumpActivityTime(workspaceId, now)
      })
    }

    // Fallback: legacy per-event channel (used until main-layer lands onActivityBatch)
    return window.api.workspaces.onActivityChanged((e) => {
      const prevDetail = getActivitySnapshot().get(e.workspaceId)
      if (prevDetail !== e.detail) {
        if (e.detail === 'ready') playSound('ding')
        else if (e.detail === 'attention') playSound('notification')
      }
      setActivityBatch([{ workspaceId: e.workspaceId, detail: e.detail }])
      bumpActivityTime(e.workspaceId, Date.now())
    })
  }, [])

  // Single hoisted title subscription — writes to titleStore instead of local state.
  // Main emits { title: null } on terminal:destroy to clear stale titles, so a
  // null payload deletes the key (not just skips) — otherwise destroyed
  // workspaces would keep showing the last-seen title.
  useEffect(() => {
    return window.api.workspaces.onTitleChanged((e) => {
      if (e.title) {
        setTitle(e.workspaceId, e.title)
      } else {
        deleteTitle(e.workspaceId)
      }
    })
  }, [])

  useEffect(() => {
    return window.api.workspaces.onActiveWorkspaceChanged(({ workspaceId }) => {
      setAuthoritativeActiveWorkspace(workspaceId)
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
      // Clear any stale entries for the deleted workspace from all stores.
      deleteActivity(workspaceId)
      deleteActivityTime(workspaceId)
      deleteTitle(workspaceId)
      deleteGitStatus(workspaceId)
      deletePr(workspaceId)
      hasFetchedRef.current.delete(workspaceId)
      clearFooterActionsCache(workspaceId)
      clearContextBudgetCache(workspaceId)
    })
  }, [])

  useEffect(() => {
    return window.api.workspaces.onChanged(({ workspace }) => {
      setWorkspacesByProject((prev) => {
        const list = prev[workspace.projectId]
        if (!list) return prev
        return {
          ...prev,
          [workspace.projectId]: list.map((w) => (w.id === workspace.id ? workspace : w))
        }
      })
    })
  }, [])

  // ---------------------------------------------------------------------------
  // Core callbacks — declared before effects so effects can reference them
  // without forward-declaration lint errors.
  // ---------------------------------------------------------------------------

  // refreshPins is declared first so all handlers below can reference it in deps.
  const refreshPins = useCallback((): void => {
    window.api.pins.listAll().then(setPinnedItems).catch(console.error)
  }, [])

  // Stores all workspaces (active + archived) per project. Callers filter by
  // archivedAt at render time. One source of truth — keeps ProjectView in
  // sync when the sidebar mutates workspace state.
  const fetchWorkspacesForProject = useCallback(async (projectId: string): Promise<void> => {
    try {
      const workspaces = await window.api.workspaces.listForProject(projectId, { scope: 'all' })
      setWorkspacesByProject((prev) => ({ ...prev, [projectId]: workspaces }))
    } catch (err) {
      console.error('[dashboard] failed to load workspaces for', projectId, err)
      setWorkspacesByProject((prev) => ({ ...prev, [projectId]: [] }))
    }
  }, [])

  // Stable sidebar toggle handler — uses functional setState to avoid capturing
  // sidebarCollapsed in closure (keeps this stable with empty deps).
  const handleToggleSidebarCollapsed = useCallback((): void => {
    // Uses functional form to avoid capturing sidebarCollapsed in closure
    setSidebarCollapsed((prev) => {
      const next = !prev
      playSound(next ? 'drawer-close' : 'drawer-open')
      window.api.uiState.update({ sidebarCollapsed: next }).catch(console.error)
      return next
    })
  }, [])

  const handleSelectWorkspace = useCallback(
    (workspaceId: string, projectId: string): void => {
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
      // Ensure workspaces are loaded for this project — reads ref to avoid
      // capturing workspacesByProject in closure (would create new fn each render).
      if (!workspacesByProjectRef.current[projectId]) {
        fetchWorkspacesForProject(projectId)
      }
      void (async (): Promise<void> => {
        // If the workspace is closed, reopen it before mounting the terminal.
        const ws = workspacesByProjectRef.current[projectId]?.find((w) => w.id === workspaceId)
        if (ws && ws.closedAt !== null) {
          await window.api.workspaces.reopen(workspaceId).catch(console.error)
        }
        // workspaces.open and uiState.update are independent DB writes — issue them
        // concurrently so they don't serialize on the ipcMain queue ahead of terminal:mount.
        await Promise.all([
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
      })()
    },
    [fetchWorkspacesForProject]
  )
  // Sync the handleSelectWorkspace ref after the callback is defined — placed
  // here (after declaration) so the linter can confirm no forward-reference
  // ambiguity. Same no-dep pattern as the other ref syncs above.
  useLayoutEffect(() => {
    handleSelectWorkspaceRef.current = handleSelectWorkspace
  })

  const handleToggleProjectExpand = useCallback(
    (id: string): void => {
      setExpandedProjectIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) {
          next.delete(id)
        } else {
          next.add(id)
          // Lazy-load workspaces if not yet fetched — reads ref to avoid
          // stale closure over workspacesByProject.
          if (!workspacesByProjectRef.current[id]) {
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
    },
    [fetchWorkspacesForProject]
  )

  const handleSelectProject = useCallback(
    (id: string): void => {
      setSelectedProjectId(id)
      setSelectedWorkspaceId(null)
      setView({ kind: 'project', projectId: id })
      if (!workspacesByProjectRef.current[id]) {
        fetchWorkspacesForProject(id)
      }
      window.api.projects.open(id).catch(console.error)
      window.api.uiState
        .update({ lastViewKind: 'project', lastProjectId: id, lastWorkspaceId: null })
        .catch(console.error)
    },
    [fetchWorkspacesForProject]
  )

  const handleSelectNav = useCallback((nav: 'sessions'): void => {
    setView({ kind: nav })
    setSelectedProjectId(null)
    setSelectedWorkspaceId(null)
    window.api.uiState
      .update({ lastViewKind: nav, lastProjectId: null, lastWorkspaceId: null })
      .catch(console.error)
  }, [])

  // ---------------------------------------------------------------------------
  // Effects that use the above callbacks — must come after
  // ---------------------------------------------------------------------------

  // onNavigateTo: uses refs so the effect never re-subscribes on state/callback
  // changes — avoids dropped events mid-churn and stops the N re-subscription
  // pattern on every workspace list mutation. handleSelectWorkspaceRef keeps
  // the callback current without requiring it in the dep array; the ref is
  // updated by the no-dep useLayoutEffect placed after handleSelectWorkspace.
  useEffect(() => {
    return window.api.workspaces.onNavigateTo((workspaceId) => {
      const byProject = workspacesByProjectRef.current
      for (const [projectId, wsList] of Object.entries(byProject)) {
        const found = wsList.find((w) => w.id === workspaceId)
        if (found) {
          handleSelectWorkspaceRef.current(found.id, projectId)
          return
        }
      }
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

  // refreshPins is defined below as useCallback — called on mount via a separate effect

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
            setGitStatus(e.workspaceId, e.status)
          })
        : undefined

    const unsubPr =
      typeof githubApi.onPrChanged === 'function'
        ? githubApi.onPrChanged((e) => {
            setPr(e.workspaceId, e.pr)
          })
        : undefined

    return () => {
      unsubGit?.()
      unsubPr?.()
    }
  }, [])

  // Belt-and-suspenders: concurrent imperative fetch for workspaces visible at
  // mount / when new workspace ids appear, in case the push subscription
  // attaches after main has already emitted the initial statusChanged events.
  // Also seeds initial titles for newly seen workspaces.
  // Subsequent updates come via the push channels above and onTitleChanged.
  useEffect(() => {
    const workspaces = Object.values(workspacesByProject)
      .flat()
      .filter((w) => w.archivedAt === null)
    if (workspaces.length === 0) return
    let cancelled = false

    // Only fetch for workspaces we haven't already fetched — use a ref-based
    // set so we don't read stale state from the closure, which would trigger
    // duplicate IPC calls when workspacesPollKey re-runs.
    // NOTE: we do NOT pre-mark ids as fetched here — we mark them only on
    // success so a cancelled mid-flight fetch retries on re-mount.
    const missing = workspaces.filter((w) => !hasFetchedRef.current.has(w.id))

    // Git + PR: concurrent per-workspace using Promise.allSettled
    if (missing.length > 0) {
      Promise.allSettled(
        missing.map(async (ws) => {
          let status: GitStatus | null = null
          try {
            status = await window.api.git.status(ws.cwd)
            if (!cancelled) {
              // Mark as fetched only after a successful response so a
              // cancelled mid-flight fetch retries on re-mount.
              hasFetchedRef.current.add(ws.id)
              setGitStatus(ws.id, status)
            }
          } catch (err) {
            console.error('[dashboard] git status failed for', ws.id, err)
            if (!cancelled) {
              hasFetchedRef.current.add(ws.id)
              setGitStatus(ws.id, null)
            }
          }
          if (status?.branch) {
            try {
              const pr = await window.api.github.prForBranch(ws.cwd, status.branch)
              if (!cancelled) setPr(ws.id, pr)
            } catch (err) {
              console.error('[dashboard] gh pr lookup failed for', ws.id, err)
              if (!cancelled) setPr(ws.id, null)
            }
          } else {
            if (!cancelled) setPr(ws.id, null)
          }
        })
      ).catch((err) => console.error('[dashboard] fetchMissing allSettled failed', err))
    }

    // Titles: seed from getTitle for all workspaces in this poll key
    Promise.all(
      workspaces.map((ws) =>
        window.api.workspaces
          .getTitle(ws.id)
          .then((title) => ({ id: ws.id, title }))
          .catch(() => null)
      )
    ).then((results) => {
      if (cancelled) return
      for (const r of results) {
        if (r && r.title) setTitle(r.id, r.title)
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

  const handleSelectSettings = useCallback((): void => {
    setView({ kind: 'settings' })
    setSelectedProjectId(null)
    setSelectedWorkspaceId(null)
    // Persist as 'sessions' — 'settings' is not in the DB enum; so on restore land on Workspaces
    window.api.uiState
      .update({ lastViewKind: 'sessions', lastProjectId: null, lastWorkspaceId: null })
      .catch(console.error)
  }, [])

  const handleAddProject = useCallback(async (): Promise<void> => {
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
  }, [handleSelectWorkspace])

  const handleResumedInWorkspace = useCallback(
    async (workspace: WorkspaceRecord): Promise<void> => {
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
    },
    [fetchWorkspacesForProject, handleSelectWorkspace]
  )

  const handleToggleWorkspacePin = useCallback(
    async (workspaceId: string, projectId: string): Promise<void> => {
      // Read synchronously from ref — setState updaters are not guaranteed to
      // run synchronously in React 18+ createRoot, so reading state via a
      // functional updater callback is unreliable here.
      const ws = workspacesByProjectRef.current[projectId]?.find((w) => w.id === workspaceId)
      // pinnedAt === null means currently unpinned → we want to pin it (pass true)
      // pinnedAt !== null means currently pinned → we want to unpin it (pass false)
      const pinned = ws?.pinnedAt === null
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
    },
    [refreshPins]
  )

  const handleAddWorkspace = useCallback(
    async (projectId: string): Promise<void> => {
      // Read synchronously from refs — setState updaters are not guaranteed to
      // run synchronously in React 18+ createRoot, so reading state via a
      // functional updater callback is unreliable here.
      const project = projectsRef.current.find((p) => p.id === projectId)
      const projectPath = project?.path ?? null
      if (!projectPath) return

      const existing = workspacesByProjectRef.current[projectId] ?? []
      const usedNumbers = new Set(
        existing
          .map((w) => /^Workspace\s+(\d+)$/.exec(w.name)?.[1])
          .filter((s): s is string => typeof s === 'string')
          .map((s) => parseInt(s, 10))
      )
      let n = 1
      while (usedNumbers.has(n)) n++
      const defaultName = `Workspace ${n}`

      const finalPath = projectPath
      try {
        const newWs = await window.api.workspaces.create({
          projectId,
          name: defaultName,
          cwd: finalPath
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
    },
    [handleSelectWorkspace]
  )

  const handleRenameWorkspace = useCallback(
    async (workspaceId: string, projectId: string, newName: string): Promise<void> => {
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
    },
    [fetchWorkspacesForProject, refreshPins]
  )

  const handleArchiveWorkspaceFromSidebar = useCallback(
    async (workspaceId: string, projectId: string): Promise<void> => {
      // Destroy the terminal surface before archiving so the shell process is cleaned up.
      // Don't block on failure — the DB archive can proceed regardless.
      window.api.terminal
        .destroy(workspaceId)
        .catch((e) => console.error('[dashboard] terminal.destroy before archive failed:', e))
      // Optimistically drop any cached data for the workspace from all stores —
      // once the backend deletes the row there's nothing for these to track.
      deleteActivity(workspaceId)
      deleteActivityTime(workspaceId)
      deleteTitle(workspaceId)
      deleteGitStatus(workspaceId)
      deletePr(workspaceId)
      hasFetchedRef.current.delete(workspaceId)
      clearFooterActionsCache(workspaceId)
      clearContextBudgetCache(workspaceId)
      try {
        // "Archive" is a hard delete now (v34+). The DB row is gone after this.
        await window.api.workspaces.archive(workspaceId)
        playSound('archive')
        await fetchWorkspacesForProject(projectId)
        // If we were viewing the workspace that just got deleted, route back to
        // the project view — WorkspaceView can't render a row that no longer exists.
        // Read via ref to avoid capturing selectedWorkspaceId in closure.
        if (selectedWorkspaceIdRef.current === workspaceId) {
          setSelectedWorkspaceId(null)
          setView({ kind: 'project', projectId })
        }
        refreshPins()
      } catch (err) {
        console.error('[dashboard] workspace archive failed', err)
      }
    },
    [fetchWorkspacesForProject, refreshPins]
  )

  const handleCloseWorkspace = useCallback((workspaceId: string): void => {
    void window.api.workspaces.close(workspaceId).catch(console.error)
  }, [])

  const handleRenameProject = useCallback(
    async (id: string, newName: string): Promise<void> => {
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
    },
    [refreshPins]
  )

  const handleRequestRemoveProject = useCallback((project: ProjectRecord): void => {
    setRemoveConfirmTarget(project)
  }, [])

  const handleConfirmRemove = useCallback(async (): Promise<void> => {
    if (!removeConfirmTarget) return
    const target = removeConfirmTarget
    // Destroy all terminal surfaces for this project's workspaces before the
    // DB cascade-delete removes the workspace rows.
    // Serialised with a microtask yield between each destroy so AppKit can drain
    // main-queue work (ghostty_surface_free stalls ~200ms-2s per surface) without
    // blocking the event loop for the full N-surface burst.
    const projectWorkspaces = workspacesByProjectRef.current[target.id] ?? []
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
    // Drop cached data for all removed workspaces from all stores.
    for (const ws of projectWorkspaces) {
      deleteActivity(ws.id)
      deleteActivityTime(ws.id)
      deleteTitle(ws.id)
      deleteGitStatus(ws.id)
      deletePr(ws.id)
      hasFetchedRef.current.delete(ws.id)
      clearFooterActionsCache(ws.id)
      clearContextBudgetCache(ws.id)
    }
    setProjects((arr) => arr.filter((p) => p.id !== target.id))
    setExpandedProjectIds((prev) => {
      const next = new Set(prev)
      next.delete(target.id)
      return next
    })
    // Read selectedProjectId via ref to avoid capturing it in closure
    if (selectedProjectIdRef.current === target.id) {
      setSelectedProjectId(null)
      setSelectedWorkspaceId(null)
      setView({ kind: 'sessions' })
    }
    refreshPins()
  }, [removeConfirmTarget, refreshPins])

  const handleCancelRemove = useCallback((): void => {
    setRemoveConfirmTarget(null)
  }, [])

  const handleReorderProjects = useCallback((orderedIds: string[]): void => {
    // Optimistic reorder — update local state immediately using functional updater
    setProjects((arr) => {
      const byId = new Map(arr.map((p) => [p.id, p]))
      return orderedIds.map((id) => byId.get(id)).filter((p): p is ProjectRecord => !!p)
    })
    window.api.projects.reorder(orderedIds).catch((err) => {
      console.error('[dashboard] reorder failed; refetching', err)
      window.api.projects.list().then(setProjects).catch(console.error)
    })
  }, [])

  const handleReorderWorkspaces = useCallback(
    (projectId: string, orderedIds: string[]): void => {
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
    },
    [fetchWorkspacesForProject]
  )

  useEffect(() => {
    refreshPins()
  }, [refreshPins])

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
        onToggleCollapsed={handleToggleSidebarCollapsed}
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
          onCloseWorkspace={handleCloseWorkspace}
          onTogglePinWorkspace={handleToggleWorkspacePin}
          onReorderProjects={handleReorderProjects}
          onReorderWorkspaces={handleReorderWorkspaces}
          onRefreshPins={refreshPins}
        />

        <main
          className={
            // Workspace view: terminal always sits above web layer (native z-order),
            // so this container stays transparent to let the NSView paint through.
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
