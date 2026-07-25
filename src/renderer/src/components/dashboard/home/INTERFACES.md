# Home interfaces

This directory owns the renderer-only Home route and facade contracts. These
interfaces are frozen before Home pages or providers are built. No builder
changes an interface without stopping and re-planning.

## Ownership

| Contract                                                                                   | Owner                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `HomePageId`, `AppUiState.homeLastPage`                                                    | `src/shared/types.ts`                          |
| `UI_STATE_DEFAULTS.homeLastPage`, `VALID_HOME_PAGES`                                       | `src/shared/uiStateDefaults.ts`                |
| `home_last_page` schema, read mapping, validation, persistence                             | `src/main/db/schema.ts`, `src/main/uiState.ts` |
| `SurfaceId`, `PersistedSurfaceId`, `AppView`                                               | `home.types.ts`                                |
| Provider, agent, action, limits, activity, stats, snapshot, navigation, and page contracts | `home.types.ts`                                |

`AppView` is:

```ts
| { kind: 'home'; page: HomePageId }
| { kind: 'project'; projectId: string }
| { kind: 'sessions' }
| { kind: 'workspace'; workspaceId: string; projectId: string }
| { kind: 'settings'; section?: SettingsSectionId }
| { kind: 'panes' }
```

`SurfaceId` is `'home' | 'projects' | 'panes' | 'settings'`.
`PersistedSurfaceId` additionally preserves the legacy `'dashboard'` spelling
and excludes non-restorable Settings.

## Dependency direction

`src/shared` remains dependency-free from main, preload, and renderer. The main
process owns SQLite persistence and may import shared Home identifiers only.
The preload only exposes main-owned payloads. Home renderer pages may import
`home.types.ts` and shared payload types; they must not import main-process
modules or reach into provider implementations. Home source adapters populate
the facade, while pages consume only `HomeSnapshot`.

## Navigation

Pages receive navigation through these callbacks rather than owning route or
terminal state:

```ts
type NavigateSurface = (request: SurfaceNavigationRequest) => void
type NavigateWorkspace = (workspaceId: string, projectId: string) => void
```

`SurfaceNavigationRequest` carries a `SurfaceId`, optional `HomePageId`, and
`input: 'pointer' | 'keyboard' | 'programmatic'`. Selecting a workspace must
route through `NavigateWorkspace`; it must not mount, destroy, or otherwise
manage a terminal surface.

## Persistence and compatibility

`home_last_page` is non-null, defaults to `'overview'`, and accepts exactly the
seven `HomePageId` values. It is independent of project-scoped
`projectsLast*` memory. New renderer writes use canonical `'home'` values.
The persisted legacy `default_surface: 'dashboard'` and
`last_view_kind: 'dashboard'` spellings remain valid compatibility input and
are normalized by renderer routing to `{ kind: 'home', page: homeLastPage }`.
Settings is never restored as a launch surface. Projects remains the default
launch surface unless the user selects another persisted surface.

## Agent identity contract

`HomeAgent` carries optional `projectId` and `workspaceId` solely for navigation,
and required `projectLabel` and `workspaceLabel` for presentation. The facade
maps those labels from the authoritative `LiveAgentRow.projectName` and
`LiveAgentRow.agentName` fields. Pages must never display either identifier as
a fallback label.

## Facade snapshot

`HomeSnapshot` is the sole page data shape:

```ts
interface HomeSnapshot {
  agents: HomeSourceState<HomeAgent[]>
  actions: HomeSourceState<HomeActionItem[]>
  github: HomeSourceState<{ prs: GhSearchPr[]; issues: GhSearchIssue[] }>
  limits: HomeSourceState<ProviderLimitSnapshot[]>
  activity: HomeSourceState<HomeActivitySnapshot[]>
  stats: HomeSourceState<HomeStatsSnapshot[]>
  counts: HomeCounts
}
```

The facade API is `getHomeSnapshot`, `subscribeHome`, `refreshHomeSource`, and
`useHomeSnapshot`. A source retains its last usable `data` while a refresh is
in flight; `loading` is only initial acquisition, `refreshing` is background
work, and `error` is user-displayable failure text. `unavailable` represents a
known unsupported or unavailable capability, while `stale` marks data that can
be displayed but is not fresh. `fetchedAt` is optional when no successful fetch
has occurred.

## Terminal and privacy invariants

Home is an operational routing surface only. It never directly mounts,
destroys, shows, or hides a workspace terminal: workspace selection delegates
to the Dashboard-owned navigation path, preserving sticky native surfaces.
Home snapshots and pages must honor the existing privacy-mode redaction and
exclusion rules; they must not expose classified or hidden project/workspace
metadata through aggregate data.

## Foundation acceptance gate

Future builders consume these names and shapes exactly. Any requirement that
needs an interface addition, removal, or signature change stops implementation,
updates the frozen plan, revises this document, and reruns migration,
TypeScript, and lint verification before parallel work resumes.
