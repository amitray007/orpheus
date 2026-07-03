import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react'
import { playSound, setSoundEnabled, setSoundPack } from '../../lib/sound'
import { logDiag } from '../../lib/diag'
import { DIAG_EVENTS } from '@shared/diagEvents'
import { Sidebar as SidebarBase } from './Sidebar'
import { TopBar } from './TopBar'
import { MainContent as MainContentBase, type View } from './MainContent'
import { showConfirmModalReact } from '@/lib/overlayClient'
import { setActivityBatch, deleteActivity, getActivitySnapshot } from '@/lib/activityStore'
import { setAuthoritativeActiveWorkspace, getActiveRemount } from '@/lib/freezeWatchdog'
import { bumpActivityTime, deleteActivityTime } from '@/lib/activityTimeStore'
import { setTitle, deleteTitle } from '@/lib/titleStore'
import { setGitStatus, deleteGitStatus } from '@/lib/gitStore'
import { setPr, deletePr } from '@/lib/prStore'
import { removeWorkbenchEntry } from '@/lib/workbenchStore'
import { useUpdateAvailable } from '@/lib/useUpdateAvailable'
import { useUiState, updateUiState } from '@/lib/uiStateStore'
import { mapWithConcurrency } from '@/lib/concurrency'
import { clearFooterActionsCache } from './footer/useFooterActions'
import { clearLiveChipCache } from './footer/liveChipCache'
import { clearContextBudgetCache } from './workspaceTitleBar.helpers'
import {
  viewToSidebarActiveView,
  mainContainerClassName,
  nextWorkspaceName,
  reorderById,
  reorderWithTail
} from './dashboard.helpers'
import type {
  PinnedItem,
  ProjectRecord,
  SessionRecord,
  WorkspaceRecord,
  GitStatus,
  GhPullRequest
} from '@shared/types'
import { UI_STATE_DEFAULTS } from '@shared/uiStateDefaults'

const Sidebar = memo(SidebarBase)
const MainContent = memo(MainContentBase)

interface DashboardProps {
  claudeInstalled: boolean
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- prop forwarded from App.tsx but not yet used in this component
export function Dashboard(_: DashboardProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // UI state — live subscription via the shared store (single get() + single
  // onChanged() for the whole renderer; see lib/uiStateStore.ts).
  const uiState = useUiState()
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
  // Per-project monotonic request counter so an in-flight fetchWorkspacesForProject
  // call that resolves after a newer call for the same project can't clobber the
  // fresher result (or wrongly blank the list on a stale error). Written directly,
  // not mirrored from state — no useLayoutEffect sync needed.
  const fetchSeqRef = useRef<Record<string, number>>({})
  // Stable callback ref — lets the zero-dep onNavigateTo effect always call
  // the latest handleSelectWorkspace without re-subscribing on every render.
  const handleSelectWorkspaceRef = useRef<(workspaceId: string, projectId: string) => void>(
    () => {}
  )
  // Stable callback ref for the native-modal-driven worktree archive flow —
  // handleArchiveWorkspaceFromSidebar is defined before runWorktreeArchiveFlow
  // (which depends on finishWorktreeArchive), so it reads through this ref
  // rather than forward-referencing an unassigned const.
  const runWorktreeArchiveFlowRef = useRef<
    (workspace: WorkspaceRecord, projectId: string) => Promise<void>
  >(async () => {})
  // De-races the archive navigation double-fire: finishWorktreeArchive (called
  // by the local runWorktreeArchiveFlow, awaited right after the archive IPC
  // resolves) and the workspaces:archived broadcast listener (below, fired for
  // ALL windows including this one) both used to navigate for the same
  // just-archived workspace — finishWorktreeArchive would land the UI in one
  // place, then the broadcast handler would immediately re-navigate (a second,
  // often redundant or stale transition). finishWorktreeArchive is the single
  // owner of post-archive navigation for workspaces it archives locally; it
  // stamps the workspaceId in here right before navigating, and the broadcast
  // listener skips its own navigation (but still does cache cleanup) for any
  // id found here.
  const locallyArchivedWorkspaceIdsRef = useRef<Set<string>>(new Set())
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
  const hasFetchedRef = useRef<Set<string> | null>(null)
  if (hasFetchedRef.current === null) hasFetchedRef.current = new Set<string>()

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
  useEffect(() => {
    return window.api.workspaces.onActivityBatch((batch) => {
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

  // Derived workspace id
  const currentlyViewedWorkspaceId = view.kind === 'workspace' ? view.workspaceId : null

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
      // Remove the workspace from local cache. Also captures the post-removal
      // list via a plain closure variable so the nav side-effects below can
      // read the up-to-date remaining list without depending on ref timing
      // (workspacesByProjectRef only syncs via useLayoutEffect after commit,
      // so it may still be stale at this point in the same tick). Assigning a
      // local `let` inside the updater is a pure, idempotent operation (safe
      // under StrictMode double-invocation) — no side effects run inside it.
      let remainingAfterRemoval: WorkspaceRecord[] = []
      setWorkspacesByProject((prev) => {
        const list = prev[projectId]
        if (!list) return prev
        const next = list.filter((w) => w.id !== workspaceId)
        remainingAfterRemoval = next
        return { ...prev, [projectId]: next }
      })
      // De-race: if this client's own archive flow (finishWorktreeArchive /
      // handleArchiveWorkspaceFromSidebar) already owns navigation for this
      // workspaceId, skip navigating again here — this broadcast fires for
      // ALL windows (including the one that initiated the archive), so
      // without this guard the local flow's navigation and this listener's
      // navigation would both fire for the same archive, landing the UI in
      // two places in quick succession. Still fall through to cache cleanup
      // below (idempotent) and consume the stamp so it doesn't leak.
      const wasLocallyOwned = locallyArchivedWorkspaceIdsRef.current.has(workspaceId)
      if (wasLocallyOwned) {
        locallyArchivedWorkspaceIdsRef.current.delete(workspaceId)
      }
      // If this was the active workspace, navigate to a fallback.
      if (!wasLocallyOwned && selectedWorkspaceIdRef.current === workspaceId) {
        const remaining = remainingAfterRemoval
        if (remaining.length > 0) {
          // Navigate to the first remaining workspace in the project.
          const next = remaining[0]
          setSelectedProjectId(projectId)
          setSelectedWorkspaceId(next.id)
          setView({ kind: 'workspace', workspaceId: next.id, projectId })
          updateUiState({
            lastViewKind: 'workspace',
            lastProjectId: projectId,
            lastWorkspaceId: next.id
          })
        } else {
          // No workspaces left — go to the project view.
          setSelectedProjectId(projectId)
          setSelectedWorkspaceId(null)
          setView({ kind: 'project', projectId })
          updateUiState({
            lastViewKind: 'project',
            lastProjectId: projectId,
            lastWorkspaceId: null
          })
        }
      }
      // Clear any stale entries for the deleted workspace from all stores.
      deleteActivity(workspaceId)
      deleteActivityTime(workspaceId)
      deleteTitle(workspaceId)
      deleteGitStatus(workspaceId)
      deletePr(workspaceId)
      removeWorkbenchEntry(workspaceId)
      hasFetchedRef.current!.delete(workspaceId)
      clearFooterActionsCache(workspaceId)
      clearLiveChipCache(workspaceId)
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
    const seq = (fetchSeqRef.current[projectId] = (fetchSeqRef.current[projectId] ?? 0) + 1)
    try {
      const workspaces = await window.api.workspaces.listForProject(projectId, { scope: 'all' })
      if (seq !== fetchSeqRef.current[projectId]) return
      setWorkspacesByProject((prev) => ({ ...prev, [projectId]: workspaces }))
    } catch (err) {
      if (seq !== fetchSeqRef.current[projectId]) return
      console.error('[dashboard] failed to load workspaces for', projectId, err)
      // Do NOT clobber with [] — keep previously-loaded data, just log.
    }
  }, [])

  // Stable sidebar toggle handler — uses functional setState to avoid capturing
  // sidebarCollapsed in closure (keeps this stable with empty deps).
  const handleToggleSidebarCollapsed = useCallback((): void => {
    // Uses functional form to avoid capturing sidebarCollapsed in closure
    setSidebarCollapsed((prev) => {
      const next = !prev
      playSound(next ? 'drawer-close' : 'drawer-open')
      updateUiState({ sidebarCollapsed: next })
      return next
    })
  }, [])

  const handleSelectWorkspace = useCallback(
    (workspaceId: string, projectId: string): void => {
      const fromId = selectedWorkspaceIdRef.current
      const toId = workspaceId
      if (fromId !== toId) {
        logDiag({
          category: 'lifecycle',
          level: 'info',
          event: DIAG_EVENTS.WORKSPACE_SWITCH,
          workspaceId: toId,
          data: { fromId, toId }
        })
      }
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
        // updateUiState() is fire-and-forget (own internal .catch), so only
        // workspaces.open needs to be awaited/caught here.
        updateUiState({
          lastViewKind: 'workspace',
          lastProjectId: projectId,
          lastWorkspaceId: workspaceId
        })
        await window.api.workspaces
          .open(workspaceId)
          .then((updated) => {
            setWorkspacesByProject((prev) => ({
              ...prev,
              [projectId]: (prev[projectId] ?? []).map((w) => (w.id === workspaceId ? updated : w))
            }))
          })
          .catch(console.error)
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

  // ---------------------------------------------------------------------------
  // BACKGROUND MOUNT (focus=false path of onWorkspaceRequestOpen below).
  //
  // DESIGN NOTE: handleSelectWorkspace couples two things — (1) setView (UI
  // navigation, steals the user's focus) and (2) making the workspace's
  // terminal surface live/injectable (mounting happens as a *side effect* of
  // WorkspaceView rendering once the view is active). For CLI-driven agent
  // fan-out (`ws new --background` / `ws send --background`), we want (2)
  // WITHOUT (1): the workspace should become injectable while the user stays
  // exactly where they are.
  //
  // MECHANISM CHOSEN: call window.api.terminal.mount(...) directly, then
  // immediately window.api.terminal.hide(...) — the same two IPC calls
  // WorkspaceView's own mount effect makes — WITHOUT touching `view` or
  // `selectedWorkspaceId` at all. This works because terminal:mount (see
  // src/main/index.ts) is a plain IPC handler keyed only by workspaceId + the
  // sender's BrowserWindow (for the native parent handle); it has no
  // dependency on WorkspaceView being mounted/active — it composes the launch
  // env, spawns/attaches the libghostty surface, and returns. `hide` (addon.hide)
  // does not destroy the surface — it just stops it from drawing/being
  // frontmost, exactly like navigating away from a normal workspace. Once
  // mount resolves, getSurfacePhase(workspaceId) is 'hidden' (not 'none') and
  // terminalActions.canInject() reports true, so the CLI's openAndSeed /
  // sendToWorkspace polling loops on the main side succeed exactly as if the
  // user had opened the workspace — the surface is fully live and injectable,
  // it simply isn't the one currently rendered/visible.
  //
  // This avoids the heavier alternative (mounting a hidden/off-screen
  // WorkspaceView instance) — no new render tree, no risk of the hidden
  // instance's resize/observer effects fighting the active view's.
  //
  // A rect is still required by the mount IPC signature even though nothing
  // is drawn on screen while hidden; reuse the current window's viewport rect
  // (falls back to a small nonzero rect if unavailable) — it only matters if
  // the surface is later made active via a normal navigation, at which point
  // WorkspaceView's own active-toggle effect immediately re-measures and
  // resizes it to the real container rect anyway.
  //
  // CWD: terminal:mount's 4th arg (cwd) is optional, and when omitted the
  // launched claude process inherits Electron's own cwd (effectively the
  // user's home directory) instead of the workspace's project directory —
  // that was a real bug here. WorkspaceView always passes workspace.cwd (see
  // its own terminal.mount call sites); this path must do the same. Since
  // onWorkspaceRequestOpen only carries {workspaceId, focus} (no projectId),
  // and a workspace freshly created via `ws new --background` may not be in
  // workspacesByProject yet, we resolve cwd via window.api.workspaces.open()
  // below, which reads the DB row directly and is authoritative regardless of
  // renderer state.
  const backgroundMountWorkspace = useCallback((workspaceId: string): void => {
    void (async (): Promise<void> => {
      // Resolve the workspace's cwd BEFORE mounting. window.api.workspaces.open()
      // reads straight from the DB (see openWorkspace() in src/main/workspaces.ts),
      // so it's authoritative even for a workspace the renderer hasn't fetched
      // into workspacesByProject yet (e.g. one just created by `ws new
      // --background` from the CLI). This also doubles as the "genuinely open
      // the workspace" call the code already needed to make (closedAt/
      // lastOpenedAt), so we just do it first instead of after mount.
      let cwd: string | undefined
      try {
        const opened = await window.api.workspaces.open(workspaceId)
        cwd = opened.cwd
        setWorkspacesByProject((prev) => {
          const projectId = opened.projectId
          const list = prev[projectId]
          if (!list) return prev
          return {
            ...prev,
            [projectId]: list.map((w) => (w.id === workspaceId ? opened : w))
          }
        })
      } catch (err) {
        console.error('[dashboard] background mount: failed to resolve workspace cwd:', err)
      }
      try {
        const scaleFactor = window.devicePixelRatio ?? 1
        const rect = {
          x: 0,
          y: 0,
          w: Math.max(1, Math.round(window.innerWidth || 1)),
          h: Math.max(1, Math.round(window.innerHeight || 1))
        }
        await window.api.terminal.mount(workspaceId, rect, scaleFactor, cwd)
        // Mount can attach the surface as frontmost momentarily; hide it right
        // away so it never becomes visible/steals draw time while the user is
        // looking at a different workspace (or no workspace at all).
        await window.api.terminal.hide(workspaceId).catch(() => {})
        // RACE-3: addon.mount unconditionally promotes this background-mounted
        // workspace to native visibility, transiently stealing it from whatever
        // the user is actually looking at. Re-promote the viewed workspace.
        const vid = selectedWorkspaceIdRef.current
        if (vid && vid !== workspaceId) {
          const remount = getActiveRemount()
          if (remount) remount()
        }
      } catch (err) {
        console.error('[dashboard] background mount failed:', err)
      }
    })()
  }, [])

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
      updateUiState({ lastViewKind: 'project', lastProjectId: id, lastWorkspaceId: null })
    },
    [fetchWorkspacesForProject]
  )

  const handleSelectNav = useCallback((nav: 'sessions'): void => {
    setView({ kind: nav })
    setSelectedProjectId(null)
    setSelectedWorkspaceId(null)
    updateUiState({ lastViewKind: nav, lastProjectId: null, lastWorkspaceId: null })
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
    return window.api.workspaces.onNavigateTo((workspaceId, projectId) => {
      // Prefer the projectId from the notification payload — the target
      // project may not be loaded in workspacesByProjectRef yet (it's lazily
      // populated), and handleSelectWorkspace lazy-loads it on demand.
      let resolvedProjectId = projectId
      if (resolvedProjectId === undefined) {
        const byProject = workspacesByProjectRef.current
        for (const [pid, wsList] of Object.entries(byProject)) {
          if (wsList.some((w) => w.id === workspaceId)) {
            resolvedProjectId = pid
            break
          }
        }
      }
      if (resolvedProjectId !== undefined) {
        handleSelectWorkspaceRef.current(workspaceId, resolvedProjectId)
      }
    })
  }, [])

  // onWorkspaceRequestOpen: main → renderer signal so the command server can ask
  // the renderer to open (and mount) a workspace — the entry point for U8/U12
  // and for the CLI's --focus/--background flags.
  //
  // focus=true  → current behavior: handleSelectWorkspace (navigate + mount).
  // focus=false → BACKGROUND MOUNT: mount the surface (backgroundMountWorkspace,
  //               see its doc comment above) WITHOUT setView/selectedWorkspaceId
  //               changing — the user stays exactly where they are.
  //
  // Uses the same zero-dep ref pattern as onNavigateTo so it never re-subscribes.
  useEffect(() => {
    return window.api.workspaces.onWorkspaceRequestOpen(({ workspaceId, focus }) => {
      if (!focus) {
        backgroundMountWorkspace(workspaceId)
        return
      }
      const byProject = workspacesByProjectRef.current
      const wsToProject = new Map<string, string>()
      for (const [projectId, wsList] of Object.entries(byProject)) {
        for (const w of wsList) wsToProject.set(w.id, projectId)
      }
      const projectId = wsToProject.get(workspaceId)
      if (projectId !== undefined) {
        handleSelectWorkspaceRef.current(workspaceId, projectId)
      }
      // If the workspace isn't in the loaded list yet (e.g. newly created by the
      // CLI before the renderer has fetched), we don't crash — the workspace will
      // become visible on the next workspaces:created broadcast or the next fetch.
    })
  }, [backgroundMountWorkspace])

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
    const missing = workspaces.filter((w) => !hasFetchedRef.current!.has(w.id))

    // Git + PR: concurrent per-workspace, capped at 5 in-flight to avoid
    // unbounded subprocess fan-out (via mapWithConcurrency) when a project
    // has many workspaces.
    if (missing.length > 0) {
      mapWithConcurrency(missing, 5, async (ws) => {
        let status: GitStatus | null = null
        try {
          status = await window.api.git.status(ws.cwd)
          if (!cancelled) {
            // Mark as fetched only after a successful response so a
            // cancelled mid-flight fetch retries on re-mount.
            hasFetchedRef.current!.add(ws.id)
            setGitStatus(ws.id, status)
          }
        } catch (err) {
          console.error('[dashboard] git status failed for', ws.id, err)
          if (!cancelled) {
            hasFetchedRef.current!.add(ws.id)
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
      }).catch((err) => console.error('[dashboard] fetchMissing allSettled failed', err))
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
    const expanded = new Set(projects.flatMap((p) => (p.expandedInSidebar ? [p.id] : [])))
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

  const { available: updateAvailable, latest: updateLatest } = useUpdateAvailable()

  const handleSelectSettings = useCallback((): void => {
    setView({ kind: 'settings' })
    setSelectedProjectId(null)
    setSelectedWorkspaceId(null)
    // Persist as 'sessions' — 'settings' is not in the DB enum; so on restore land on Workspaces
    updateUiState({ lastViewKind: 'sessions', lastProjectId: null, lastWorkspaceId: null })
  }, [])

  const handleOpenUpdates = useCallback((): void => {
    setView({ kind: 'settings', section: 'orpheus-updates' })
    setSelectedProjectId(null)
    setSelectedWorkspaceId(null)
    // Persist as 'sessions' — 'settings' is not in the DB enum; so on restore land on Workspaces
    updateUiState({ lastViewKind: 'sessions', lastProjectId: null, lastWorkspaceId: null })
  }, [])

  const handleAddProject = useCallback(async (): Promise<void> => {
    setAddingProject(true)
    try {
      const result = await window.api.projects.pickAndAdd()
      if (result) {
        playSound('success')
        setProjects((arr) => {
          const rest = arr.filter((p) => p.id !== result.id)
          // New projects are always unpinned, so insert after the pinned
          // prefix (top of the unpinned tier) instead of the very front.
          const firstUnpinnedIndex = rest.findIndex((p) => p.pinnedAt == null)
          const insertAt = firstUnpinnedIndex === -1 ? rest.length : firstUnpinnedIndex
          return [...rest.slice(0, insertAt), result, ...rest.slice(insertAt)]
        })
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
          updateUiState({
            lastViewKind: 'project',
            lastProjectId: result.id,
            lastWorkspaceId: null
          })
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

  const handleToggleProjectPin = useCallback(async (projectId: string): Promise<void> => {
    const project = projectsRef.current.find((p) => p.id === projectId)
    // pinnedAt === null means currently unpinned → pin it (pass true)
    // pinnedAt !== null means currently pinned → unpin it (pass false)
    const pinned = project?.pinnedAt === null || project?.pinnedAt === undefined
    try {
      const updated = await window.api.projects.setPinned(projectId, pinned)
      // Optimistic patch so the badge flips immediately, then refetch to
      // get the authoritative pinned-first ordering from the DB.
      setProjects((arr) => arr.map((p) => (p.id === projectId ? updated : p)))
      window.api.projects.list().then(setProjects).catch(console.error)
    } catch (err) {
      console.error('[dashboard] project setPinned failed', err)
      window.api.projects.list().then(setProjects).catch(console.error)
    }
  }, [])

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
      const defaultName = nextWorkspaceName(existing)

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
      // Look up the workspace record to detect whether it is worktree-backed.
      const ws = (workspacesByProjectRef.current[projectId] ?? []).find((w) => w.id === workspaceId)

      // Worktree-backed workspace: always show a confirm before removing
      // (the branch is kept but the working directory disappears).
      // Show the light confirm first; if the backend detects uncommitted
      // changes (wasDirty:true) the confirm escalates to the dirty variant.
      if (ws?.worktreeParentCwd) {
        // Show the "branch is kept" confirm (native modal) upfront; the flow
        // itself handles the dirty-escalation confirm if the backend reports
        // uncommitted changes.
        await runWorktreeArchiveFlowRef.current(ws, projectId)
        return
      }

      // Non-worktree workspace: original behaviour.
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
      removeWorkbenchEntry(workspaceId)
      hasFetchedRef.current!.delete(workspaceId)
      clearFooterActionsCache(workspaceId)
      clearLiveChipCache(workspaceId)
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

  // Shared post-archive cleanup for worktree workspaces. Sole owner of
  // post-archive navigation for workspaces archived via this (local) flow —
  // see locallyArchivedWorkspaceIdsRef for why the workspaces:archived
  // broadcast listener must NOT also navigate for the same id.
  const finishWorktreeArchive = useCallback(
    async (workspaceId: string, projectId: string): Promise<void> => {
      // Stamp BEFORE navigating so the broadcast listener (which may fire
      // before or after this local completion, depending on IPC scheduling)
      // sees the id and skips its own navigation regardless of ordering.
      locallyArchivedWorkspaceIdsRef.current.add(workspaceId)
      deleteActivity(workspaceId)
      deleteActivityTime(workspaceId)
      deleteTitle(workspaceId)
      deleteGitStatus(workspaceId)
      deletePr(workspaceId)
      removeWorkbenchEntry(workspaceId)
      hasFetchedRef.current!.delete(workspaceId)
      clearFooterActionsCache(workspaceId)
      clearLiveChipCache(workspaceId)
      clearContextBudgetCache(workspaceId)
      playSound('archive')
      await fetchWorkspacesForProject(projectId)
      const wasSelected = selectedWorkspaceIdRef.current === workspaceId
      if (wasSelected) {
        setSelectedWorkspaceId(null)
        setView({ kind: 'project', projectId })
      } else if (selectedWorkspaceIdRef.current) {
        // A different workspace remained active throughout (the archived one
        // was a background sidebar row) — the confirm modal still stole first
        // responder from it, so re-assert focus now that the modal is closed.
        void window.api.terminal.focus(selectedWorkspaceIdRef.current).catch(() => {})
      }
      refreshPins()
    },
    [fetchWorkspacesForProject, refreshPins]
  )

  // Worktree archive flow (both clean and dirty-escalation cases). Shows the
  // "branch is kept" confirm first; if the backend detects uncommitted
  // changes (wasDirty:true) it escalates to a "Remove anyway" confirm before
  // actually force-removing. Renders via the overlay layer's confirmModal
  // kind (overlayClient.showConfirmModalReact).
  const runWorktreeArchiveFlow = useCallback(
    async (workspace: WorkspaceRecord, projectId: string): Promise<void> => {
      // Cancel/error paths below don't run finishWorktreeArchive (which owns
      // the success-path focus re-assert), so each one re-asserts focus itself
      // if a workspace is still selected/visible — the modal stole first
      // responder from it regardless of how the flow ends.
      const refocusIfSelected = (): void => {
        if (selectedWorkspaceIdRef.current) {
          void window.api.terminal.focus(selectedWorkspaceIdRef.current).catch(() => {})
        }
      }

      const clean = await showConfirmModalReact({
        title: 'Remove worktree?',
        body: `Remove worktree ${workspace.worktreeBranch ?? ''}? The branch is kept.`,
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'confirm', label: 'Remove worktree', style: 'danger' }
        ]
      })
      if (clean.buttonId !== 'confirm') {
        refocusIfSelected()
        return
      }

      const result = await window.api.workspaces.archive(workspace.id, { force: false })
      if (result.wasDirty) {
        // Backend says the worktree is dirty — escalate to the "remove anyway" confirm.
        const dirty = await showConfirmModalReact({
          title: 'Remove worktree?',
          body: `Remove worktree ${workspace.worktreeBranch ?? ''}? It has uncommitted changes.\nUncommitted changes will be lost. The branch is kept.`,
          buttons: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'force', label: 'Remove anyway', style: 'danger' }
          ]
        })
        if (dirty.buttonId !== 'force') {
          refocusIfSelected()
          return
        }
        const forced = await window.api.workspaces.archive(workspace.id, { force: true })
        if (!forced.archived) {
          console.error('[dashboard] worktree archive failed', forced)
          refocusIfSelected()
          return
        }
        await finishWorktreeArchive(workspace.id, projectId)
        return
      }
      if (!result.archived) {
        console.error('[dashboard] worktree archive failed', result)
        refocusIfSelected()
        return
      }
      await finishWorktreeArchive(workspace.id, projectId)
    },
    [finishWorktreeArchive]
  )
  useLayoutEffect(() => {
    runWorktreeArchiveFlowRef.current = runWorktreeArchiveFlow
  })

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

  // Shared post-remove cleanup after a project delete succeeds.
  const finishProjectRemove = useCallback(
    (target: ProjectRecord): void => {
      const projectWorkspaces = workspacesByProjectRef.current[target.id] ?? []
      playSound('delete')
      // Drop cached data for all removed workspaces from all stores.
      for (const ws of projectWorkspaces) {
        deleteActivity(ws.id)
        deleteActivityTime(ws.id)
        deleteTitle(ws.id)
        deleteGitStatus(ws.id)
        deletePr(ws.id)
        removeWorkbenchEntry(ws.id)
        hasFetchedRef.current!.delete(ws.id)
        clearFooterActionsCache(ws.id)
        clearLiveChipCache(ws.id)
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
      } else if (selectedWorkspaceIdRef.current) {
        // The removed project wasn't the one in view — a different workspace
        // stayed selected/visible throughout, but the confirm modal(s) still
        // stole first responder from it. Re-assert focus now that they're closed.
        void window.api.terminal.focus(selectedWorkspaceIdRef.current).catch(() => {})
      }
      refreshPins()
    },
    [refreshPins]
  )

  // Destroy all terminal surfaces for a project's workspaces before the DB
  // cascade-delete removes the workspace rows. Serialised with a microtask
  // yield between each destroy so AppKit can drain main-queue work
  // (ghostty_surface_free stalls ~200ms-2s per surface) without blocking the
  // event loop for the full N-surface burst.
  const destroyProjectWorkspaceSurfaces = useCallback(
    async (projectId: string, logLabel: string): Promise<void> => {
      const projectWorkspaces = workspacesByProjectRef.current[projectId] ?? []
      for (const ws of projectWorkspaces) {
        await window.api.terminal
          .destroy(ws.id)
          .catch((e) => console.error(`[dashboard] terminal.destroy before ${logLabel}:`, ws.id, e))
        await new Promise<void>((r) => setTimeout(r, 0))
      }
    },
    []
  )

  // Project removal flow. Probes the project's worktree count so the "Also
  // delete worktrees" checkbox is only offered when relevant; escalates to a
  // "Delete anyway" confirm if the backend reports dirty worktrees blocking
  // the first attempt. Same confirm-modal pattern as runWorktreeArchiveFlow
  // above.
  const handleRequestRemoveProject = useCallback(
    async (project: ProjectRecord): Promise<void> => {
      let worktreeCount = 0
      try {
        const summary = await window.api.projects.worktreeSummary(project.id)
        worktreeCount = summary.count
      } catch (err) {
        console.error('[dashboard] worktreeSummary failed', err)
      }

      const first = await showConfirmModalReact({
        title: 'Remove?',
        body: `${project.name} will be removed from Orpheus along with its workspaces and sessions. Files on disk are untouched. You can re-add the folder later.`,
        buttons: [
          { id: 'cancel', label: 'Cancel' },
          { id: 'confirm', label: 'Remove', style: 'danger' }
        ],
        checkbox:
          worktreeCount > 0
            ? {
                id: 'deleteWorktrees',
                label: 'Also delete worktrees (branches are kept)',
                checked: false
              }
            : undefined
      })
      if (first.buttonId !== 'confirm') {
        // Cancelled — the modal still stole first responder from whatever
        // workspace terminal was active; re-assert focus now that it's closed.
        if (selectedWorkspaceIdRef.current) {
          void window.api.terminal.focus(selectedWorkspaceIdRef.current).catch(() => {})
        }
        return
      }

      await destroyProjectWorkspaceSurfaces(project.id, 'project remove failed')
      const result = await window.api.projects.remove(project.id, {
        deleteWorktrees: first.checkboxChecked
      })
      if (!result.deleted && result.dirtyWorktrees > 0) {
        // Escalate: some worktrees are dirty — ask for force confirmation.
        const dirtyCount = result.dirtyWorktrees
        const escalate = await showConfirmModalReact({
          title: 'Remove worktrees with uncommitted changes?',
          body: `${dirtyCount} ${dirtyCount === 1 ? 'worktree has' : 'worktrees have'} uncommitted changes.\nUncommitted changes will be lost. Branches are kept.`,
          buttons: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'force', label: 'Delete anyway', style: 'danger' }
          ]
        })
        if (escalate.buttonId !== 'force') {
          if (selectedWorkspaceIdRef.current) {
            void window.api.terminal.focus(selectedWorkspaceIdRef.current).catch(() => {})
          }
          return
        }
        await destroyProjectWorkspaceSurfaces(project.id, 'force project remove failed')
        await window.api.projects.remove(project.id, { deleteWorktrees: true, force: true })
        finishProjectRemove(project)
        return
      }
      finishProjectRemove(project)
    },
    [destroyProjectWorkspaceSurfaces, finishProjectRemove]
  )

  const handleReorderProjects = useCallback((orderedIds: string[]): void => {
    // Optimistic reorder — update local state immediately using functional updater
    setProjects((arr) => reorderById(arr, orderedIds))
    window.api.projects.reorder(orderedIds).catch((err) => {
      console.error('[dashboard] reorder failed; refetching', err)
      window.api.projects.list().then(setProjects).catch(console.error)
    })
  }, [])

  const handleReorderWorkspaces = useCallback(
    (projectId: string, orderedIds: string[]): void => {
      // Optimistic: reorder the local workspacesByProject[projectId] immediately.
      // reorderWithTail appends workspaces missing from orderedIds (e.g. archived
      // ones not in the visible drag group) to the tail.
      setWorkspacesByProject((prev) => ({
        ...prev,
        [projectId]: reorderWithTail(prev[projectId] ?? [], orderedIds)
      }))
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

  const activeView = viewToSidebarActiveView(view)

  return (
    <div className="flex flex-col h-screen">
      <TopBar
        onToggleCollapsed={handleToggleSidebarCollapsed}
        sidebarCollapsed={sidebarCollapsed}
        sidebarWidth={uiState?.sidebarWidth ?? UI_STATE_DEFAULTS.sidebarWidth}
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
          sidebarWidth={uiState?.sidebarWidth ?? UI_STATE_DEFAULTS.sidebarWidth}
          fetchGithubAvatars={uiState?.fetchGithubAvatars ?? true}
          pinnedItems={pinnedItems}
          onSelectProject={handleSelectProject}
          onSelectNav={handleSelectNav}
          onSelectSettings={handleSelectSettings}
          onOpenUpdates={handleOpenUpdates}
          updateAvailable={updateAvailable}
          updateLatest={updateLatest}
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
          onTogglePinProject={handleToggleProjectPin}
          onReorderProjects={handleReorderProjects}
          onReorderWorkspaces={handleReorderWorkspaces}
          onRefreshPins={refreshPins}
        />

        <main
          className={
            // Workspace view: the libghostty terminal NSView always sits above
            // this window's web layer (native z-order), so this container stays
            // transparent to let it paint through. React UI that needs to sit
            // above the terminal uses the child-window overlay layer
            // (overlayClient.ts) instead — see
            // docs/learnings/overlay-child-window-macos.md.
            mainContainerClassName(view.kind)
          }
        >
          <MainContent
            view={view}
            project={view.kind === 'project' ? activeProject : activeProjectForWorkspace}
            workspace={activeWorkspace}
            workspacesForProject={
              view.kind === 'project' || view.kind === 'workspace'
                ? (workspacesByProject[view.projectId] ?? null)
                : null
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
    </div>
  )
}
