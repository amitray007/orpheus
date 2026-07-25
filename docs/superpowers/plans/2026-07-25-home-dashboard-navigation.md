# Home Dashboard & Navigation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed activity rail with one shared surface-sidebar system and turn Home into a persisted, provider-neutral command center whose seven pages render only data Orpheus already exposes.

**Architecture:** A solo Sonnet foundation unit first freezes renderer route/state types, sidebar-shell contracts, Home domain contracts, persistence compatibility, and a tracked interface manifest. Only after that unit passes review and typecheck may isolated Sonnet worktrees implement page units in parallel; the orchestrator integrates them serially in the order defined at the end. Existing project/workspace navigation remains owned by `Dashboard.tsx`, while focused Home adapters normalize current activity, GitHub, Claude usage, and transcript-scanner data without adding backend scope.

**Tech Stack:** Electron 39, React 19, TypeScript, Tailwind CSS v4, `useSyncExternalStore`, Phosphor icons, typed Electron IPC, SQLite declarative migration engine, Bun.

## Global Constraints

- All product-code edits are performed by fresh **Sonnet** builder subagents; the top-level agent orchestrates, reviews, and integrates only.
- The foundation task is solo. No page builder starts until its interfaces, `INTERFACES.md`, targeted lint, DB migration harness, and typecheck pass review.
- Every parallel builder uses an isolated worktree. Before worktree/branch operations, run `git worktree list`.
- Integration is serial, one unit at a time, onto the active feature worktree; the completed subsystem ultimately lands on `staging`.
- Home is an operational command center, not the project/workspace landing page. Projects stays the default unless `defaultSurface` explicitly selects otherwise.
- Preserve `projectsLast*`, privacy redaction/hidden projects, pinning, worktrees, LRU workspace views, terminal hide-not-destroy navigation, background mount-then-hide, active-surface re-promotion, and native overlay/z-order behavior.
- Preserve stale-while-revalidate: cached content stays visible, refresh is silent, source failures are isolated, and empty/loading/unavailable/error are distinct.
- Preserve legacy `lastViewKind: 'dashboard'` and `defaultSurface: 'dashboard'` compatibility. New state writes use Home terminology and `homeLastPage`; Settings remains non-restorable.
- Do not fabricate Codex, Grok, Antigravity, review/check state, provider limits, Claude windows, ranges, project/provider breakdowns, or historical completions.
- Prefer existing invoke/push contracts. If implementation discovers genuinely missing data, stop and re-plan before adding IPC; any new IPC must follow `src/shared/types.ts` → `src/shared/ipc.ts` → typed `handle()` → preload → renderer.
- Projects and Panes trees remain intact except shared shell/footer composition. Settings promotes its existing search/grouped section navigation into the shared surface sidebar.
- No general renderer test runner exists. Do not introduce Jest/Vitest or pretend test-first UI coverage exists. Verification is pure-helper assertions where already practical, `bun run test:db` for DB changes, typecheck, targeted ESLint, full gates, packaged DEV build, and real-app assertions.
- Always launch the packaged development variant with `open -g`; never run `bun run dev`, never build/install production, and never foreground the app during verification.
- Follow the frozen specification at `docs/superpowers/specs/2026-07-25-home-dashboard-navigation-design.md` without changing scope during execution.

---

## File / Responsibility Map

### Foundation and persisted routing

- Modify `src/shared/types.ts:193-374` — add canonical `SurfaceId`, `HomePageId`, compatibility spellings, `homeLastPage`, and approved provider-neutral Home domain types.
- Modify `src/shared/uiStateDefaults.ts:9-83` — add `homeLastPage: 'overview'`; extend default-surface validation to accept canonical `home` while retaining legacy `dashboard`.
- Modify `src/main/db/schema.ts:42-54,472-669` — add `home_last_page`; retain legacy enum values and non-destructive reconciliation.
- Modify `src/main/uiState.ts:27-270,402-630` — map, validate, and persist `homeLastPage`; normalize legacy surface spellings without unexpected fallback.
- Modify `src/renderer/src/components/dashboard/MainContent.tsx:185-305` — replace the dashboard-only view variant with a typed Home route.
- Modify `src/renderer/src/components/dashboard/dashboard.helpers.ts:9-84` — canonical surface derivation and launch restoration.
- Modify `src/renderer/src/components/dashboard/Dashboard.tsx:97-100,750-849,1052-1102,1725-1875` — convert the live route owner, surface-selection callback, hydration, and rail pass-site to canonical Home while preserving Projects-local restoration.
- Modify `src/renderer/src/components/dashboard/ActivityRail.tsx:34-44,212-255` — minimal temporary canonical `SurfaceId` prop/callback conversion only; Task 2 still owns its visual removal.
- Modify `src/renderer/src/components/dashboard/Sidebar.tsx:1468-1475` — remove the obsolete `dashboard` sidebar-active discriminant; Task 2 still owns shell composition.
- Modify `src/renderer/src/components/dashboard/settings/OrpheusNavigationSection.tsx:8-58` — present and write canonical `home` for the launch-surface preference while shared/main boundaries continue accepting legacy `dashboard`.
- Create `src/renderer/src/components/dashboard/home/home.types.ts` — renderer-facing navigation/facade contracts and stable callback signatures.
- Create `src/renderer/src/components/dashboard/home/INTERFACES.md` — tracked frozen seam manifest for all subsequent builders. This path is adjacent to every Home consumer, survives the implementation, and avoids putting product contracts in ignored planning docs.
- Modify `CLAUDE.md:renderer view kinds section` — reconcile the operational Home policy during implementation, not during this planning pass.

### Shared shell and Settings

- Create `src/renderer/src/components/dashboard/sidebar/SurfaceSidebarShell.tsx` — common expanded/collapsed/resizable aside geometry and labelled `nav` landmark.
- Create `src/renderer/src/components/dashboard/sidebar/SurfaceFooter.tsx` — ordered Home/Projects/Panes/Settings buttons, accessible active state, tooltips, optional Settings update badge.
- Create `src/renderer/src/components/dashboard/sidebar/sidebarLayout.ts` — shared expanded/compact width helpers/tokens.
- Modify `src/renderer/src/components/dashboard/Sidebar.tsx:1450-end` — render the existing Projects tree inside the common shell without changing tree behavior.
- Modify `src/renderer/src/components/dashboard/PanelsSection.tsx` — retain the existing Panes tree and consume the shell/footer contract.
- Modify `src/renderer/src/components/dashboard/SettingsView.tsx:159-581` — split section navigation from content so Settings uses the common surface sidebar instead of nesting its own fixed `w-56` pane behind Projects.
- Modify `src/renderer/src/components/dashboard/TopBar.tsx:1-34,740-808` — remove `ACTIVITY_RAIL_WIDTH` and align to the actual current sidebar width.
- Delete `src/renderer/src/components/dashboard/ActivityRail.tsx` after all imports are removed.

### Home routing and data

- Create `src/renderer/src/components/dashboard/home/HomeSidebar.tsx` — ordered seven-item index, badges, collapsed labels/tooltips, keyboard-origin navigation metadata.
- Create `src/renderer/src/components/dashboard/home/HomeSurface.tsx` — page switch and page-heading focus policy.
- Create `src/renderer/src/components/dashboard/home/homeNavigation.ts` — Home page definitions and pure normalization helpers.
- Create `src/renderer/src/components/dashboard/home/homeFacade.ts` — pure adapters for agents/actions/limits/activity/stats.
- Create `src/renderer/src/components/dashboard/home/homeStore.ts` — shared external store that owns existing hooks/source subscriptions and exposes one stable snapshot.
- Create `src/renderer/src/components/dashboard/home/useHomeSnapshot.ts` — `useSyncExternalStore` hook and refresh entry point.
- Reuse/refactor `src/renderer/src/components/dashboard/dashboard-home/useLiveAgents.ts`, `useGithubData.ts`, `useClaudeUsage.ts`, `usePulseData.ts`, and their helpers so there is one source fetch/subscription per domain, not one per page.

### Home pages

- Create all seven concrete source-aware page frames in Task 3: `HomeOverviewPage.tsx`, `NeedsYouPage.tsx`, `LiveAgentsPage.tsx`, `GithubPage.tsx`, `LimitsPage.tsx`, `ActivityPage.tsx`, and `StatsPage.tsx`. Task 3 wires these files into `HomeSurface.tsx`; subsequent page builders modify only their assigned page files and never modify the page registry.
- Task 4 modifies only `HomeOverviewPage.tsx` and owns the shared facade/store plus the overview-specific source-hook refactor.
- Task 5 modifies only `NeedsYouPage.tsx` and `LiveAgentsPage.tsx` plus `actionQueue.ts`, `liveAgents.helpers.ts`, and `LiveAgentsTable.tsx`.
- Task 6 modifies only `GithubPage.tsx` plus `PrTable.tsx`, `IssuesTable.tsx`, and `TablePager.tsx`.
- Task 7 modifies only `LimitsPage.tsx`, creates `LimitBucketView.tsx`, and uniquely owns `UsageLimitsCard.tsx`.
- Task 8 modifies only `ActivityPage.tsx` and `StatsPage.tsx`, creates `AccessibleActivitySummary.tsx`, and uniquely owns `ActivityChart.tsx` and `StatTile.tsx`.
- Reuse/refactor focused visual primitives under `src/renderer/src/components/dashboard/dashboard-home/` rather than duplicating cards, tables, charts, pagination, loading states, or formatting.
- Remove `src/renderer/src/components/dashboard/DashboardView.tsx` only after its useful components/data ownership have moved and no imports remain.

---

### Task 1: Freeze Navigation, Persistence, Shell, and Home Interfaces

**Plan correction:** The canonical route/surface types cannot be frozen in isolation: `Dashboard.tsx` owns the live `View`, persistence writes, hydration, and `handleSelectSurface`, while `ActivityRail`, `Sidebar`, and Navigation Settings are direct consumers of the legacy spelling. They are included here only for the minimum complete canonical caller conversion; Task 2 still owns rail deletion and shell/visual work, and Task 3 still owns the Home sidebar, page registry, and focus semantics.

**Execution:** One fresh Sonnet builder, isolated worktree, no parallel feature builders.

**Files:**
- Create: `src/renderer/src/components/dashboard/home/home.types.ts`
- Create: `src/renderer/src/components/dashboard/home/INTERFACES.md`
- Modify: `src/shared/types.ts:193-374`
- Modify: `src/shared/uiStateDefaults.ts:9-83`
- Modify: `src/main/db/schema.ts:42-54,472-669`
- Modify: `src/main/uiState.ts:27-270,402-630`
- Modify: `src/renderer/src/components/dashboard/MainContent.tsx:185-305`
- Modify: `src/renderer/src/components/dashboard/dashboard.helpers.ts:9-84`
- Modify: `src/renderer/src/components/dashboard/Dashboard.tsx:97-100,750-849,1052-1102,1725-1875`
- Modify: `src/renderer/src/components/dashboard/ActivityRail.tsx:34-44,212-255` (temporary canonical prop/callback typing only; no redesign)
- Modify: `src/renderer/src/components/dashboard/Sidebar.tsx:1468-1475` (remove obsolete renderer-only `dashboard` active-view member only)
- Modify: `src/renderer/src/components/dashboard/settings/OrpheusNavigationSection.tsx:8-58` (canonical Home option/write only)
- Modify: `CLAUDE.md:Renderer view kinds`
- Test: `scripts/verify-migration-engine.ts` through `bun run test:db`

**Interfaces:**
- Consumes: current `AppUiState`, `AppUiStatePatch`, renderer `View`, `Dashboard` route ownership, `ActivityRail` surface props, `SidebarActiveView`, Navigation Settings `defaultSurface` control, `deriveSurface()`, `resolveLandingView()`, and declarative `app_ui_state` schema.
- Produces exactly:

```ts
export type SurfaceId = 'home' | 'projects' | 'panes' | 'settings'
export type PersistedSurfaceId = Exclude<SurfaceId, 'settings'> | 'dashboard'
export type HomePageId =
  | 'overview'
  | 'needs-you'
  | 'live-agents'
  | 'github'
  | 'limits'
  | 'activity'
  | 'stats'

export type AppView =
  | { kind: 'home'; page: HomePageId }
  | { kind: 'project'; projectId: string }
  | { kind: 'sessions' }
  | { kind: 'workspace'; workspaceId: string; projectId: string }
  | { kind: 'settings'; section?: SettingsSectionId }
  | { kind: 'panes' }

export interface ProviderDescriptor {
  id: string
  label: string
  kind: 'claude' | 'other'
}
export type HomeAgentState = 'working' | 'waiting' | 'ready'
export interface HomeAgent {
  id: string
  provider: ProviderDescriptor
  workspaceId?: string
  projectId?: string
  task: string
  state: HomeAgentState
  observedAt: number
  elapsedLabel: string
}
export type HomeActionSource =
  | 'agent'
  | 'github-check'
  | 'completed-run'
  | 'github-review'
  | 'github-issue'
export type HomeActionPriority = 'urgent' | 'high' | 'normal'
export type HomeActionTarget =
  | { kind: 'workspace'; workspaceId: string; projectId: string }
  | { kind: 'external-url'; url: string }
  | { kind: 'home-page'; page: HomePageId }
export interface HomeActionItem {
  id: string
  source: HomeActionSource
  priority: HomeActionPriority
  title: string
  detail?: string
  observedAt?: number
  target?: HomeActionTarget
}
export type LimitScope = 'current' | 'daily' | 'weekly' | 'all'
export interface LimitBucket {
  id: string
  label: string
  scopes: LimitScope[]
  remaining?: number
  used?: number
  total?: number
  resetsAt?: number
  modelFamily?: string
}
export interface ProviderLimitSnapshot {
  provider: ProviderDescriptor
  fetchedAt?: number
  stale: boolean
  availability: 'available' | 'unavailable' | 'error'
  buckets: LimitBucket[]
}
export type ActivityRange = 'daily' | 'weekly' | 'monthly' | 'custom'
export interface HomeActivitySnapshot {
  provider: ProviderDescriptor
  supportedRanges: ActivityRange[]
  summaries: ClaudeActivitySummary['weeklyActivity']
  freshness: { fetchedAt?: number; stale: boolean }
}
export interface HomeStatsSnapshot {
  provider: ProviderDescriptor
  window: 'weekly' | 'all'
  sessions?: number
  tokens?: number
  activeDays?: number
  streak?: number
  peakHour?: number
  breakdowns?: Array<{ id: string; label: string; value: number }>
}

export interface SurfaceNavigationRequest {
  surface: SurfaceId
  homePage?: HomePageId
  input: 'pointer' | 'keyboard' | 'programmatic'
}
export type NavigateSurface = (request: SurfaceNavigationRequest) => void
export type NavigateWorkspace = (workspaceId: string, projectId: string) => void

export interface HomeSourceState<T> {
  data: T
  loading: boolean
  refreshing: boolean
  error: string | null
  unavailable: boolean
  fetchedAt?: number
  stale: boolean
}
export interface HomeCounts {
  needsYou: number
  liveAgents: number
  github: number
}
export interface HomeSnapshot {
  agents: HomeSourceState<HomeAgent[]>
  actions: HomeSourceState<HomeActionItem[]>
  github: HomeSourceState<{ prs: GhSearchPr[]; issues: GhSearchIssue[] }>
  limits: HomeSourceState<ProviderLimitSnapshot[]>
  activity: HomeSourceState<HomeActivitySnapshot[]>
  stats: HomeSourceState<HomeStatsSnapshot[]>
  counts: HomeCounts
}
export interface HomePageProps {
  snapshot: HomeSnapshot
  onNavigate: NavigateSurface
  onSelectWorkspace: NavigateWorkspace
}
export type HomePageComponent = React.ComponentType<HomePageProps>
export function getHomeSnapshot(): HomeSnapshot
export function subscribeHome(listener: () => void): () => void
export function refreshHomeSource(source: keyof Omit<HomeSnapshot, 'counts'>): void
export function useHomeSnapshot(): HomeSnapshot
```

- Extend `AppUiState` with `homeLastPage: HomePageId`; use `UI_STATE_DEFAULTS.homeLastPage === 'overview'`.
- `AppView` is the canonical replacement for `MainContent`'s exported `View`: define it once in `home.types.ts`, import it into `MainContent.tsx`, `Dashboard.tsx`, and `dashboard.helpers.ts`, and remove the old exported `View` union rather than retaining an alias.
- `INTERFACES.md` records these exact names, ownership, allowed dependency direction, navigation callbacks, facade snapshot shape, and the “no builder changes an interface without stopping and re-planning” gate.

- [ ] **Step 1: Capture the current compatibility baseline**

Run:

```bash
rg -n "dashboard|defaultSurface|lastViewKind|projectsLast|ActivityRail" src/shared src/main src/renderer/src/components/dashboard
```

Expected: matches include legacy `dashboard`, `projectsLast*`, `resolveLandingView`, `ActivityRail`, and the persisted UI-state mapping; save the relevant paths in the builder report, not a new file.

- [ ] **Step 2: Add the stable shared/domain type definitions**

Add the exact signatures above. Keep provider-neutral types in `src/shared/types.ts` only if main/preload must name them; keep renderer-only route/facade types in `home.types.ts`. Do not duplicate the same interface in both files.

- [ ] **Step 3: Add non-destructive `home_last_page` persistence**

Add to the `app_ui_state` table definition:

```ts
home_last_page: {
  type: 'TEXT',
  notNull: true,
  default: "'overview'",
  check: enumCheck('home_last_page', HOME_PAGE)
}
```

Map `homeLastPage`, validate it against the seven exact ids, and add it to `columnMap`. Keep legacy `dashboard` accepted. Normalize reads to canonical Home in renderer routing without deleting compatibility spellings from persisted validation.

- [ ] **Step 4: Replace the renderer view discriminant with the canonical Home route**

Make Home selection explicit as `{ kind: 'home'; page }`. `deriveSurface()` returns `SurfaceId`; `resolveLandingView()` maps legacy persisted `defaultSurface === 'dashboard'` to `{ kind: 'home', page: uiState.homeLastPage }`, keeps Projects default, and never restores Settings.

Complete every existing renderer caller in this task: `Dashboard` initializes and sets only canonical `AppView` values; its Home branch writes canonical `lastViewKind: 'home'` and restores `uiState.homeLastPage`; hydration consumes the normalized route; `handleSelectSurface` accepts `SurfaceId` (Settings delegates to the existing settings handler); the temporary `ActivityRail` receives canonical `home | projects | panes` values and emits canonical requests without changing its layout; `SidebarActiveView` no longer contains `dashboard`; and Navigation Settings labels the option “Home” and writes `defaultSurface: 'home'`. Do not add a renderer `dashboard` route alias or a helper adapter that translates canonical Home back to `dashboard`. Legacy `dashboard` remains accepted only in shared/main persistence validation and normalization.

- [ ] **Step 5: Document the frozen interfaces**

Write `INTERFACES.md` with: type signatures; owner file for each type; allowed imports; `NavigateSurface` and `NavigateWorkspace`; persistence semantics; facade snapshot contract; state/error/freshness rules; terminal/privacy invariants; and the foundation acceptance gate.

- [ ] **Step 6: Reconcile repository policy**

Replace the obsolete prohibition in `CLAUDE.md` with exactly: “Home is an operational command center that aggregates and routes to existing work; it is not a project/workspace landing page. Projects remains the default launch surface unless user navigation settings choose otherwise.”

- [ ] **Step 7: Verify migration and type contracts**

Run:

```bash
bun run test:db
bun run typecheck
bunx eslint src/shared/types.ts src/shared/uiStateDefaults.ts src/main/uiState.ts src/main/db/schema.ts src/renderer/src/components/dashboard/Dashboard.tsx src/renderer/src/components/dashboard/MainContent.tsx src/renderer/src/components/dashboard/ActivityRail.tsx src/renderer/src/components/dashboard/Sidebar.tsx src/renderer/src/components/dashboard/dashboard.helpers.ts src/renderer/src/components/dashboard/settings/OrpheusNavigationSection.tsx src/renderer/src/components/dashboard/home/home.types.ts
```

Expected: DB harness passes fresh schema, upgrade, backup/rebuild, and convergence checks; both TypeScript projects pass; targeted ESLint adds no warnings/errors.

- [ ] **Step 8: Request two reviews and freeze**

Dispatch a Sonnet code reviewer for compatibility/migration and a type-design reviewer for the contracts. Expected: no unresolved blocking findings. If signatures change, stop all execution, revise this plan and `INTERFACES.md`, rerun Step 7, and only then declare the interface stable.

- [ ] **Step 9: Commit the foundation**

```bash
git add CLAUDE.md src/shared/types.ts src/shared/uiStateDefaults.ts src/main/db/schema.ts src/main/uiState.ts src/renderer/src/components/dashboard/Dashboard.tsx src/renderer/src/components/dashboard/MainContent.tsx src/renderer/src/components/dashboard/ActivityRail.tsx src/renderer/src/components/dashboard/Sidebar.tsx src/renderer/src/components/dashboard/dashboard.helpers.ts src/renderer/src/components/dashboard/settings/OrpheusNavigationSection.tsx src/renderer/src/components/dashboard/home/home.types.ts src/renderer/src/components/dashboard/home/INTERFACES.md
git commit -m "feat(navigation): establish Home surface interfaces"
```

**Acceptance:** The renderer compiles with canonical `SurfaceId` and `{ kind: 'home'; page }` end-to-end across `Dashboard`, helpers, `MainContent`, the temporary rail, Sidebar active typing, and Navigation Settings; no renderer route/helper alias emits or consumes `kind: 'dashboard'`; new persistence writes use `home`; legacy `dashboard` is accepted and normalized only at shared/main DB boundaries; Projects remains default; `projectsLast*` is untouched; `homeLastPage` defaults/restores independently; Settings is non-restorable; migration harness/typecheck/lint pass; and reviewers approve the stable seam.

---

### Task 2: Build the Shared Sidebar Footer and Settings Shell

**Execution:** Fresh Sonnet builder in an isolated worktree, based on integrated Task 1.

**Files:**
- Create: `src/renderer/src/components/dashboard/sidebar/SurfaceSidebarShell.tsx`
- Create: `src/renderer/src/components/dashboard/sidebar/SurfaceFooter.tsx`
- Create: `src/renderer/src/components/dashboard/sidebar/sidebarLayout.ts`
- Modify: `src/renderer/src/components/dashboard/Dashboard.tsx:511-849,1725-1875`
- Modify: `src/renderer/src/components/dashboard/Sidebar.tsx:1450-end`
- Modify: `src/renderer/src/components/dashboard/PanelsSection.tsx`
- Modify: `src/renderer/src/components/dashboard/SettingsView.tsx:159-581`
- Modify: `src/renderer/src/components/dashboard/TopBar.tsx:1-34,740-808`
- Delete: `src/renderer/src/components/dashboard/ActivityRail.tsx`

**Interfaces:**
- Consumes: `SurfaceId`, `NavigateSurface`, existing `sidebarCollapsed`, persisted `sidebarWidth`, Settings `SectionId`, `useUpdateAvailable()`.
- Produces:

```ts
export interface SurfaceSidebarShellProps {
  surface: SurfaceId
  collapsed: boolean
  width: number
  ariaLabel: string
  children: React.ReactNode
  footer: React.ReactNode
}
export interface SurfaceFooterProps {
  activeSurface: SurfaceId
  collapsed: boolean
  updateAvailable: boolean
  updateLatest: string | null
  onNavigate: NavigateSurface
  onOpenUpdates: (input: 'pointer' | 'keyboard') => void
}
export interface SettingsNavigationProps {
  activeId: SectionId
  collapsed: boolean
  query: string
  onQueryChange: (query: string) => void
  onSelect: (id: SectionId, input: 'pointer' | 'keyboard') => void
}
```

- [ ] **Step 1: Implement shared geometry tokens**

Export `COLLAPSED_SIDEBAR_WIDTH = 56` and `resolveSidebarWidth(collapsed, expandedWidth): number`. Use this helper in shell and TopBar; no `46` rail offset remains.

- [ ] **Step 2: Implement the persistent footer**

Render buttons in exact order Home, Projects, Panes, Settings. Each is a real `button`, has `aria-current="page"` when active, visible focus ring, and overlay tooltip in collapsed mode. Put the update badge on Settings; clicking it opens `orpheus-updates`.

- [ ] **Step 3: Wrap Projects and Panes without changing their trees**

Keep `Sidebar` project rows, collapsed behavior, drag/reorder, privacy, pinned sections, and `PanelsSection` contents intact. Change only the outer aside/footer composition.

- [ ] **Step 4: Extract Settings navigation into the shell**

Keep `GROUPS`, `SectionId`, search, deep-link updates, lazy section loading, Cmd/Ctrl+F, and Escape behavior. Remove the nested `w-56` nav from the content pane; render Settings search/groups as shell children, with an explicit expand affordance when collapsed.

- [ ] **Step 5: Remove the rail and TopBar offset dependency**

Delete `ActivityRail.tsx`, its import/render path, and `ACTIVITY_RAIL_WIDTH`. TopBar left width follows `resolveSidebarWidth()` and still reserves `TRAFFIC_LIGHT_CLEARANCE` plus its controls.

- [ ] **Step 6: Verify statically**

Run:

```bash
bun run typecheck
bunx eslint src/renderer/src/components/dashboard/Dashboard.tsx src/renderer/src/components/dashboard/Sidebar.tsx src/renderer/src/components/dashboard/PanelsSection.tsx src/renderer/src/components/dashboard/SettingsView.tsx src/renderer/src/components/dashboard/TopBar.tsx src/renderer/src/components/dashboard/sidebar
rg -n "ActivityRail|ACTIVITY_RAIL_WIDTH|46" src/renderer/src/components/dashboard
```

Expected: typecheck/lint pass; final search has no rail symbol or rail-width dependency.

- [ ] **Step 7: Verify in packaged DEV**

```bash
osascript -e 'tell application "Orpheus Dev" to quit' 2>/dev/null; sleep 1
pkill -x "Orpheus Dev" 2>/dev/null; true
bun run build:unpack
open -g "/Applications/Orpheus Dev.app"
pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1
```

Expected: one running DEV process; Projects/Panes/Settings show one aligned sidebar each; footer does not jump; collapse keeps content mounted; Settings sections/search remain reachable; no fixed rail remains.

- [ ] **Step 8: Review and commit**

Request a Sonnet reviewer focused on shell geometry, accessibility, and accidental tree behavior changes, then:

```bash
git add src/renderer/src/components/dashboard/Dashboard.tsx src/renderer/src/components/dashboard/Sidebar.tsx src/renderer/src/components/dashboard/PanelsSection.tsx src/renderer/src/components/dashboard/SettingsView.tsx src/renderer/src/components/dashboard/TopBar.tsx src/renderer/src/components/dashboard/sidebar src/renderer/src/components/dashboard/ActivityRail.tsx
git commit -m "feat(navigation): unify surface sidebars and footer"
```

**Acceptance:** All four surfaces use one sidebar width/collapse contract, Projects/Panes trees are behaviorally unchanged, Settings navigation lives in the shared sidebar, update access remains, keyboard labels work, and the rail/46px dependency is gone.

---

### Task 3: Add Home Sidebar, Page Routing, and Focus Semantics

**Execution:** Fresh Sonnet builder in an isolated worktree, based on integrated Task 2. Task 3 is a serial gate before the facade and page fan-out.

**Files:**
- Create: `src/renderer/src/components/dashboard/home/HomeSidebar.tsx`
- Create: `src/renderer/src/components/dashboard/home/HomeSurface.tsx`
- Create: `src/renderer/src/components/dashboard/home/homeNavigation.ts`
- Create: `src/renderer/src/components/dashboard/home/pages/HomePageFrame.tsx`
- Create: `src/renderer/src/components/dashboard/home/pages/HomeOverviewPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/pages/NeedsYouPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/pages/LiveAgentsPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/pages/GithubPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/pages/LimitsPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/pages/ActivityPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/pages/StatsPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/homeFacade.ts` with pure empty/source-state constructors matching Task 1 contracts
- Create: `src/renderer/src/components/dashboard/home/homeStore.ts` with a stable empty `HomeSnapshot` external-store shell
- Create: `src/renderer/src/components/dashboard/home/useHomeSnapshot.ts` as the `useSyncExternalStore` consumer of that shell
- Modify: `src/renderer/src/components/dashboard/Dashboard.tsx:canonical Home branch and render pass-site` — add Home page selection/request handling atop Task 1's canonical route; do not repeat the route-name migration.
- Modify: `src/renderer/src/components/dashboard/MainContent.tsx:canonical Home render branch` — replace the Task 1 compatibility content with `HomeSurface`; do not change the `AppView` discriminant.
- Modify: `src/renderer/src/components/dashboard/dashboard.helpers.ts:Home page routing helpers only` — Task 1 already owns canonical `deriveSurface()` and launch restoration.

**Interfaces:**
- Consumes: Task 1 route, snapshot, count, page-prop, and navigation types; Task 2 shell/footer; `updateUiState({ homeLastPage })`.
- Produces the frozen page registry and surface component:

```ts
export const HOME_NAV_ITEMS: ReadonlyArray<{
  id: HomePageId
  label: string
  icon: Icon
  countKey?: keyof HomeCounts
  group: 'operations' | 'insights'
}>
export const HOME_PAGE_COMPONENTS: Readonly<Record<HomePageId, HomePageComponent>>
export interface HomeSurfaceProps {
  page: HomePageId
  counts: HomeCounts
  collapsed: boolean
  sidebarWidth: number
  snapshot: HomeSnapshot
  onNavigate: NavigateSurface
  onSelectWorkspace: NavigateWorkspace
}
```

- [ ] **Step 1: Define the exact ordered Home index**

Use Overview, Needs you now, Live agents, GitHub, separator, Limits, Activity, Stats. Count labels exist only for the three specified entries.

- [ ] **Step 2: Persist Home-local routing optimistically**

On Home page selection call `updateUiState({ homeLastPage: page })`; do not write project ids or `projectsLast*`. Surface switching to Home restores the existing Home page.

- [ ] **Step 3: Implement collapsed and narrow behavior**

Keep seven icons plus footer mounted at compact width. Include badge count in `aria-label` and tooltip. Use container-driven fluid layout; do not add device-specific breakpoints.

- [ ] **Step 4: Implement keyboard-origin heading focus**

Track navigation input in the request. After keyboard activation only, focus the page `<h1 tabIndex={-1}>`; pointer activation does not move focus. Enter/Space activates; use one consistent sequential-button pattern and do not intercept arrows inside search/text fields.

- [ ] **Step 5: Add all seven concrete source-aware page frames and freeze the registry**

Create each named page file and register it once in `HOME_PAGE_COMPONENTS`. Each page renders a distinct stable heading plus loading/empty/unavailable/error copy from the stable `HomePageProps`; the initial external store returns a typed empty snapshot without fetching. Tasks 4–8 replace content inside their assigned page files and must not modify `HomeSurface.tsx`, `homeNavigation.ts`, or the registry.

- [ ] **Step 6: Verify**

```bash
bun run typecheck
bunx eslint src/renderer/src/components/dashboard/Dashboard.tsx src/renderer/src/components/dashboard/MainContent.tsx src/renderer/src/components/dashboard/dashboard.helpers.ts src/renderer/src/components/dashboard/home
```

Expected: pass. In packaged DEV, every Home item opens a distinct heading; return to Projects restores its prior workspace/project; return to Home restores the last page; keyboard navigation focuses the heading while pointer navigation does not.

- [ ] **Step 7: Review and commit**

```bash
git add src/renderer/src/components/dashboard/Dashboard.tsx src/renderer/src/components/dashboard/MainContent.tsx src/renderer/src/components/dashboard/dashboard.helpers.ts src/renderer/src/components/dashboard/home
git commit -m "feat(home): add sidebar and persisted page routing"
```

**Acceptance:** Seven complete routes exist, counts have accessible labels, collapse remains usable, `homeLastPage` restores independently, and no Home action focuses or mounts a terminal.

---

### Task 4: Build the Shared Home Facade and Overview

**Execution:** Fresh Sonnet builder in an isolated worktree, based on integrated Task 3. Task 4 is the final serial gate before page fan-out.

**Files:**
- Modify: `src/renderer/src/components/dashboard/home/homeFacade.ts`
- Modify: `src/renderer/src/components/dashboard/home/homeStore.ts`
- Modify: `src/renderer/src/components/dashboard/home/useHomeSnapshot.ts`
- Modify: `src/renderer/src/components/dashboard/home/pages/HomeOverviewPage.tsx`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/useLiveAgents.ts`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/useGithubData.ts`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/useClaudeUsage.ts`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/usePulseData.ts`
- Reuse: `DashboardCard.tsx`, `UsageLimitsCard.tsx`, `ActivityChart.tsx`, `StatTile.tsx`, table/card primitives.

**Interfaces:**
- Consumes: Task 1 `HomeSourceState`, `HomeSnapshot`, and provider-neutral domain types; Task 3’s frozen page registry/store shell; current authoritative adapters.
- Produces the implementation behind the already-frozen store API without changing its signatures:

```ts
export function getHomeSnapshot(): HomeSnapshot
export function subscribeHome(listener: () => void): () => void
export function refreshHomeSource(source: keyof Omit<HomeSnapshot, 'counts'>): void
export function useHomeSnapshot(): HomeSnapshot
```

- Must not modify `HomeSurface.tsx`, `homeNavigation.ts`, or any page other than `HomeOverviewPage.tsx`.

- [ ] **Step 1: Move source ownership out of page components**

Adapt current fetch/subscription logic into one module-level external store. Preserve cached reads, main-process pushes, silent refresh, and prior data on refresh failure. Do not issue duplicate project/workspace/session/GitHub/usage/activity fetches per page.

- [ ] **Step 2: Implement pure normalizers**

Map current Claude rows to `ProviderDescriptor { id: 'claude', label: 'Claude', kind: 'claude' }`; map actual usage windows only; expose Weekly activity only; derive weekly/all stats from actual scanner fields. Never emit absent provider rows, scopes, ranges, breakdowns, failed checks, or review requests.

- [ ] **Step 3: Derive shared counts**

`needsYou = actions.length`; `liveAgents = working + waiting + ready`; `github = prs.length + issues.length` because the current contract cannot distinguish review requests. Counts must update from the same snapshot rendered by pages.

- [ ] **Step 4: Implement Overview**

Header is `Home` plus local date. Action row routes to Needs you now, Live agents, GitHub. Pulse row routes to Limits, Activity, Stats. Render cached values immediately; first-ever loads reserve stable space; unavailable/error treatment is source-local.

- [ ] **Step 5: Verify pure adapters without adding a runner**

Use TypeScript `satisfies` checks and deterministic exported pure functions. Do not add a generic test framework. Run:

```bash
bun run typecheck
bunx eslint src/renderer/src/components/dashboard/home src/renderer/src/components/dashboard/dashboard-home/useLiveAgents.ts src/renderer/src/components/dashboard/dashboard-home/useGithubData.ts src/renderer/src/components/dashboard/dashboard-home/useClaudeUsage.ts src/renderer/src/components/dashboard/dashboard-home/usePulseData.ts
```

Expected: pass; no duplicate source hook remains mounted by both Overview and full pages.

- [ ] **Step 6: Packaged DEV QA**

Expected: Overview shows real local date/data, cards route to full pages, a manual refresh retains old content, GitHub unavailability does not blank usage/activity/stats, and no skeleton flashes on background pushes.

- [ ] **Step 7: Review and commit**

Request reviewers for store concurrency/SWR and domain type use, then:

```bash
git add src/renderer/src/components/dashboard/home/homeFacade.ts src/renderer/src/components/dashboard/home/homeStore.ts src/renderer/src/components/dashboard/home/useHomeSnapshot.ts src/renderer/src/components/dashboard/home/pages/HomeOverviewPage.tsx src/renderer/src/components/dashboard/dashboard-home/useLiveAgents.ts src/renderer/src/components/dashboard/dashboard-home/useGithubData.ts src/renderer/src/components/dashboard/dashboard-home/useClaudeUsage.ts src/renderer/src/components/dashboard/dashboard-home/usePulseData.ts
git commit -m "feat(home): add shared data facade and overview"
```

**Acceptance:** One shared snapshot powers counts and cards, cached data survives revalidation, failures are isolated, and only actual Claude/Orpheus/GitHub fields render.

---

### Task 5: Implement Needs You and Live Agents Pages

**Files:**
- Modify: `src/renderer/src/components/dashboard/home/pages/NeedsYouPage.tsx`
- Modify: `src/renderer/src/components/dashboard/home/pages/LiveAgentsPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/actionQueue.ts`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/liveAgents.helpers.ts:29-195`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/LiveAgentsTable.tsx`

**Parallel ownership:** This task must not modify `HomeSurface.tsx`, `homeNavigation.ts`, the shared facade/store, or any Task 6–8 page/primitive.

**Interfaces:**
- Consumes: `HomeSnapshot.actions`, `HomeSnapshot.agents`, `NavigateWorkspace`, existing workspace selection path.
- Produces:

```ts
export type HomeActionFilter = 'all' | HomeActionSource
export function orderHomeActions(items: readonly HomeActionItem[]): HomeActionItem[]
export interface HomeAgentSummary {
  working: number
  waiting: number
  ready: number
}
```

- [ ] **Step 1: Build the queue only from supported sources**

Emit `agent` for waiting/attention, `completed-run` for current ready rows, and `github-issue` only for actual assigned issues. Do not emit GitHub checks/reviews unless current fields prove them.

- [ ] **Step 2: Implement urgency ordering**

Rank waiting/input first, failed checks if ever present, ready runs, then GitHub work; within a class sort newest `observedAt` first and preserve stable id order when absent.

- [ ] **Step 3: Implement supported filters**

Show only filters represented in the current queue plus All. No disabled decorative fake filter. Preserve filter and scroll during source refresh.

- [ ] **Step 4: Implement provider-neutral live rows and summaries**

Display Claude provider, project/workspace, task, working/waiting/ready, and relative activity label. Label coarse timestamps as last activity, not precise run duration.

- [ ] **Step 5: Route through existing workspace selection**

Call `NavigateWorkspace(workspaceId, projectId)`; do not call terminal IPC directly. This preserves reopen, mount/hide, privacy guards, project expansion, and persisted Projects location.

- [ ] **Step 6: Verify**

```bash
bun run typecheck
bunx eslint src/renderer/src/components/dashboard/home/pages/NeedsYouPage.tsx src/renderer/src/components/dashboard/home/pages/LiveAgentsPage.tsx src/renderer/src/components/dashboard/home/actionQueue.ts src/renderer/src/components/dashboard/dashboard-home/liveAgents.helpers.ts src/renderer/src/components/dashboard/dashboard-home/LiveAgentsTable.tsx
```

Packaged DEV assertions: attention/ready transitions update counts and rows; selecting a row opens the workspace; navigating back to Home leaves its terminal hidden rather than destroyed; privacy-locked/hidden work is not exposed; empty copy says no current actionable/live items.

- [ ] **Step 7: Review and commit**

```bash
git add src/renderer/src/components/dashboard/home/pages/NeedsYouPage.tsx src/renderer/src/components/dashboard/home/pages/LiveAgentsPage.tsx src/renderer/src/components/dashboard/home/actionQueue.ts src/renderer/src/components/dashboard/dashboard-home/liveAgents.helpers.ts src/renderer/src/components/dashboard/dashboard-home/LiveAgentsTable.tsx
git commit -m "feat(home): add action queue and live agents pages"
```

**Acceptance:** Queue and agents update live from actual state, unsupported sources are absent, filters are truthful, and workspace navigation preserves terminal/privacy behavior.

---

### Task 6: Implement the Full GitHub Page

**Files:**
- Modify: `src/renderer/src/components/dashboard/home/pages/GithubPage.tsx`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/PrTable.tsx`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/IssuesTable.tsx`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/TablePager.tsx`

**Parallel ownership:** This task must not modify `HomeSurface.tsx`, `homeNavigation.ts`, the shared facade/store, or any Task 5, 7, or 8 page/primitive.

**Interfaces:**
- Consumes: `HomeSnapshot.github`, existing `GhSearchPr`, `GhSearchIssue`, and current URL/detail actions.
- Produces no new backend or IPC interface.

- [ ] **Step 1: Locate callers before changing reusable table props**

```bash
rg -n "<PrTable|<IssuesTable|PrTable\(|IssuesTable\(" src/renderer/src
```

Expected: enumerate every caller and update all in the same commit; do not change endpoint shape/auth.

- [ ] **Step 2: Expand current content into a full page**

Render actual account-wide PRs and assigned issues, current draft/state/repo metadata, pagination/list treatment, freshness, retry, and calm unavailable state.

- [ ] **Step 3: Preserve SWR and actions**

Use facade data; do not mount `useGithubData()` again. Refresh keeps rows visible. Open only existing URLs/detail behavior; add no write actions or repository explorer.

- [ ] **Step 4: Verify**

```bash
bun run typecheck
bunx eslint src/renderer/src/components/dashboard/home/pages/GithubPage.tsx src/renderer/src/components/dashboard/dashboard-home/PrTable.tsx src/renderer/src/components/dashboard/dashboard-home/IssuesTable.tsx src/renderer/src/components/dashboard/dashboard-home/TablePager.tsx
```

Packaged DEV assertions: cached rows show before refresh completes; empty differs from unavailable; count equals available open PRs plus assigned issues; no review/check badge appears unless present in source fields.

- [ ] **Step 5: Review and commit**

```bash
git add src/renderer/src/components/dashboard/home/pages/GithubPage.tsx src/renderer/src/components/dashboard/dashboard-home/PrTable.tsx src/renderer/src/components/dashboard/dashboard-home/IssuesTable.tsx src/renderer/src/components/dashboard/dashboard-home/TablePager.tsx
git commit -m "feat(home): add full GitHub work page"
```

**Acceptance:** The page is a truthful expansion of current cached/live data, GitHub failure is isolated, and no backend scope or fictional review/check count is added.

---

### Task 7: Implement Limits Page

**Files:**
- Modify: `src/renderer/src/components/dashboard/home/pages/LimitsPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/LimitBucketView.tsx`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/UsageLimitsCard.tsx`

**Parallel ownership:** This task must not modify `HomeSurface.tsx`, `homeNavigation.ts`, the shared facade/store, or any Task 5, 6, or 8 page/primitive.

**Interfaces:**
- Consumes: `HomeSnapshot.limits`, `ProviderLimitSnapshot`, `LimitBucket`.
- Produces no new source contract.

- [ ] **Step 1: Render only emitted buckets/scopes**

The adapter decides what exists from `ClaudeUsageResult`; the page iterates it. Do not hardcode Current/Daily/Weekly/All controls or Fable/model-family allocations.

- [ ] **Step 2: Represent availability/freshness accessibly**

For each provider show label, named bucket, remaining/used/total only when defined, reset only when defined, stale marker, and unavailable/error treatment with text.

- [ ] **Step 3: Reuse the overview visual**

Refactor `UsageLimitsCard` to consume normalized buckets or share `LimitBucketView`; do not fork percentage/reset formatting.

- [ ] **Step 4: Verify and commit**

```bash
bun run typecheck
bunx eslint src/renderer/src/components/dashboard/home/pages/LimitsPage.tsx src/renderer/src/components/dashboard/home/LimitBucketView.tsx src/renderer/src/components/dashboard/dashboard-home/UsageLimitsCard.tsx
```

Packaged DEV assertion: only actual returned Claude windows appear; missing totals/resets do not become zero; no provider comparison or unsupported scope selector renders.

```bash
git add src/renderer/src/components/dashboard/home/pages/LimitsPage.tsx src/renderer/src/components/dashboard/home/LimitBucketView.tsx src/renderer/src/components/dashboard/dashboard-home/UsageLimitsCard.tsx
git commit -m "feat(home): add provider-neutral limits page"
```

**Acceptance:** Limits are extensible in type design but initial UI contains only actual Claude results.

---

### Task 8: Implement Activity and Stats Pages

**Files:**
- Modify: `src/renderer/src/components/dashboard/home/pages/ActivityPage.tsx`
- Modify: `src/renderer/src/components/dashboard/home/pages/StatsPage.tsx`
- Create: `src/renderer/src/components/dashboard/home/AccessibleActivitySummary.tsx`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/ActivityChart.tsx:24-132`
- Modify: `src/renderer/src/components/dashboard/dashboard-home/StatTile.tsx`

**Parallel ownership:** This task must not modify `HomeSurface.tsx`, `homeNavigation.ts`, the shared facade/store, or any Task 5–7 page/primitive.

**Interfaces:**
- Consumes: `HomeSnapshot.activity`, `HomeSnapshot.stats`; supported activity range is initially `['weekly']`.
- Produces no new aggregation contract.

- [ ] **Step 1: Implement truthful range gating**

Render Weekly as the only enabled/visible range. Do not show Daily, Monthly, Custom, provider filters, or project filters until a source contract exists.

- [ ] **Step 2: Make Activity textual and visual**

Reuse the Mon–Sun sessions/messages visual, add explicit totals and an accessible data summary/table. Bar meaning cannot rely on color or title attributes alone.

- [ ] **Step 3: Implement actual weekly/all stats**

Show sessions, tokens, active days, current streak, and peak hour where available. Use weekly and all-history snapshots. Omit active time and breakdowns when unsupported.

- [ ] **Step 4: Verify and commit**

```bash
bun run typecheck
bunx eslint src/renderer/src/components/dashboard/home/pages/ActivityPage.tsx src/renderer/src/components/dashboard/home/pages/StatsPage.tsx src/renderer/src/components/dashboard/home/AccessibleActivitySummary.tsx src/renderer/src/components/dashboard/dashboard-home/ActivityChart.tsx src/renderer/src/components/dashboard/dashboard-home/StatTile.tsx
```

Packaged DEV assertions: Weekly is the sole range; chart has readable totals/text equivalent; stats match current scanner results; no inferred project/provider breakdown appears.

```bash
git add src/renderer/src/components/dashboard/home/pages/ActivityPage.tsx src/renderer/src/components/dashboard/home/pages/StatsPage.tsx src/renderer/src/components/dashboard/home/AccessibleActivitySummary.tsx src/renderer/src/components/dashboard/dashboard-home/ActivityChart.tsx src/renderer/src/components/dashboard/dashboard-home/StatTile.tsx
git commit -m "feat(home): add activity and stats pages"
```

**Acceptance:** Activity and Stats expose the scanner’s exact capabilities without relabeling or inference, with accessible non-color summaries.

---

### Task 9: Integrate, Remove Legacy Dashboard Composition, and Run Full Regression QA

**Files:**
- Modify: `src/renderer/src/components/dashboard/Dashboard.tsx`
- Modify: `src/renderer/src/components/dashboard/MainContent.tsx`
- Modify: `src/renderer/src/components/dashboard/dashboard.helpers.ts`
- Modify: `src/renderer/src/assets/main.css` only for shared container/focus/reduced-motion rules that cannot be expressed with existing utilities.
- Delete: `src/renderer/src/components/dashboard/DashboardView.tsx` after dependency search is empty.
- Delete/refactor: obsolete `dashboard-home` components only when `rg` proves no remaining callers.
- Review: `src/renderer/src/components/dashboard/WorkspaceView.tsx`, `src/renderer/src/lib/freezeWatchdog.ts`, `src/renderer/src/lib/overlayClient.ts` for regression verification only unless an integration defect is proven.

**Interfaces:**
- Consumes all frozen Task 1 interfaces and integrated Tasks 2–8.
- Produces the complete Home/navigation subsystem; no new interface may be introduced here.

- [ ] **Step 1: Integrate units serially in the required order**

Order: Task 1 foundation → Task 2 shell → Task 3 routing → Task 4 facade/overview → Task 5 actions/agents → Task 6 GitHub → Task 7 limits → Task 8 activity/stats → Task 9 cleanup. After each merge/cherry-pick run that unit’s acceptance command before proceeding. Use a scoped conflict-resolution agent for non-trivial conflicts.

- [ ] **Step 2: Remove obsolete composition only after caller search**

```bash
rg -n "DashboardView|dashboard-home/|ActivityRail|kind: 'dashboard'|=== 'dashboard'" src/renderer/src src/shared src/main
```

Expected: remaining `dashboard` occurrences are documented legacy compatibility only; every deleted component has zero callers.

- [ ] **Step 3: Run repository gates**

```bash
bun run test:db
bun run check
bun run format
bun run check
```

Expected: DB harness passes; typecheck, ESLint warning ratchet, duplication, and architecture pass; format changes are included; second check remains green.

- [ ] **Step 4: Build and launch packaged DEV in background**

```bash
osascript -e 'tell application "Orpheus Dev" to quit' 2>/dev/null; sleep 1
pkill -x "Orpheus Dev" 2>/dev/null; true
bun run build:unpack
open -g "/Applications/Orpheus Dev.app"
pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1
```

Expected: build installs `/Applications/Orpheus Dev.app`; launch does not steal focus; `pgrep` prints one matching process.

- [ ] **Step 5: Run real-app navigation and restore QA**

Assert: footer order and active states; no rail/layout shift; every Home page is distinct; `homeLastPage` survives Home→Projects→Home and relaunch when Home is selected; Projects restores prior project/workspace; Settings relaunches to a restorable surface; legacy dashboard/default-surface rows open Home; Projects remains default for fresh state.

- [ ] **Step 6: Run terminal lifecycle and native-layer QA**

Open a workspace, navigate Home, return, and confirm the same live terminal resumes without process/surface recreation. Trigger a background workspace open and verify mount-then-hide plus active workspace re-promotion. Exercise an overlay/tooltip over workspace UI and confirm native z-order remains correct. Home navigation must not focus a terminal.

- [ ] **Step 7: Run privacy, freshness, responsive, and accessibility QA**

Assert: classified/hidden projects do not leak into Home; GitHub failure leaves other pages useful; refresh retains cached rows/cards and scroll/filter selection; minimum supported width collapses sidebar before clipping main content; Home grids become one column by container; all navs have distinct labels; `aria-current`, counts, focus rings, keyboard activation, Escape/search behavior, reduced motion, and chart text equivalents work.

- [ ] **Step 8: Request final independent reviews**

Dispatch Sonnet reviewers for code quality, type design, accessibility/test coverage, and silent-failure/SWR behavior. Resolve every blocking finding and rerun Steps 3–7.

- [ ] **Step 9: Commit final integration cleanup**

```bash
git status --short
git add CLAUDE.md \
  src/shared/types.ts \
  src/shared/uiStateDefaults.ts \
  src/main/db/schema.ts \
  src/main/uiState.ts \
  src/renderer/src/assets/main.css \
  src/renderer/src/components/dashboard/Dashboard.tsx \
  src/renderer/src/components/dashboard/MainContent.tsx \
  src/renderer/src/components/dashboard/dashboard.helpers.ts \
  src/renderer/src/components/dashboard/DashboardView.tsx \
  src/renderer/src/components/dashboard/ActivityRail.tsx \
  src/renderer/src/components/dashboard/Sidebar.tsx \
  src/renderer/src/components/dashboard/PanelsSection.tsx \
  src/renderer/src/components/dashboard/SettingsView.tsx \
  src/renderer/src/components/dashboard/TopBar.tsx \
  src/renderer/src/components/dashboard/sidebar \
  src/renderer/src/components/dashboard/home \
  src/renderer/src/components/dashboard/dashboard-home/ActivityChart.tsx \
  src/renderer/src/components/dashboard/dashboard-home/IssuesTable.tsx \
  src/renderer/src/components/dashboard/dashboard-home/LiveAgentsTable.tsx \
  src/renderer/src/components/dashboard/dashboard-home/PrTable.tsx \
  src/renderer/src/components/dashboard/dashboard-home/StatTile.tsx \
  src/renderer/src/components/dashboard/dashboard-home/TablePager.tsx \
  src/renderer/src/components/dashboard/dashboard-home/UsageLimitsCard.tsx \
  src/renderer/src/components/dashboard/dashboard-home/liveAgents.helpers.ts \
  src/renderer/src/components/dashboard/dashboard-home/useClaudeUsage.ts \
  src/renderer/src/components/dashboard/dashboard-home/useGithubData.ts \
  src/renderer/src/components/dashboard/dashboard-home/useLiveAgents.ts \
  src/renderer/src/components/dashboard/dashboard-home/usePulseData.ts
git diff --cached --name-only
git commit -m "feat(home): complete command center navigation"
```

Expected staged-path audit: every listed path belongs to this subsystem, deleted files appear in the cached diff, and no unrelated renderer/shared/main file is staged.

**Acceptance:** Full gates pass; packaged DEV QA proves navigation, accessibility, responsive behavior, privacy, SWR, legacy restoration, and native terminal invariants; no obsolete rail/dashboard composition or unsupported data remains.

---

## Parallel Execution and Serial Integration Order

1. Run Task 1 alone with one Sonnet builder. Review and integrate it. Freeze `home/INTERFACES.md`.
2. Run Task 2 from integrated Task 1. Review, package-test, and integrate it before Task 3 starts.
3. Run Task 3 from integrated Task 2. It creates and wires the immutable page registry, all seven concrete page-frame files, and the empty typed store shell. Review and integrate it before Task 4 starts.
4. Run Task 4 from integrated Task 3. It implements the shared facade/store and Overview without changing the registry. Review and integrate it; this is the final serial foundation gate.
5. Only after Task 4 is integrated, create four isolated worktrees and fan out Tasks 5, 6, 7, and 8 to fresh Sonnet builders. Their declared product file sets are disjoint: Task 5 owns actions/agents, Task 6 owns GitHub, Task 7 owns limits, and Task 8 owns activity/stats. None may modify `HomeSurface.tsx`, `homeNavigation.ts`, or the shared facade/store.
6. Integrate serially: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Run each task’s exact acceptance check immediately after integration even though Tasks 5–8 were built concurrently.
7. If a builder discovers an interface defect, stop affected builders, discard no work, revise the plan/interface in a dedicated foundation correction, review/typecheck it, then rebase/restart consumers. Never live-edit the interface under running builders.
8. Each builder gets a fresh Sonnet reviewer after completion. The orchestrator reviews diffs and acceptance evidence but does not implement fixes.
9. Execution happens in the active feature worktree/branch and is integrated ultimately to `staging`; do not commit directly to `main`.

## Final User Copy-Paste Verification Commands

```bash
cd /Users/maverick/code/projects/orpheus/.claude/worktrees/home-dashboard
bun run test:db
bun run check
osascript -e 'tell application "Orpheus Dev" to quit' 2>/dev/null; sleep 1
pkill -x "Orpheus Dev" 2>/dev/null; true
bun run build:unpack
open -g "/Applications/Orpheus Dev.app"
pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1
```

Expected: all gates pass, DEV build/install succeeds, one DEV process is running, and the app opens in the background ready for the Task 9 QA flows.
