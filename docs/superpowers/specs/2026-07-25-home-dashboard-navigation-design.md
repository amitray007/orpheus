# Home Dashboard & Navigation Redesign

**Date:** 2026-07-25  
**Status:** Frozen design specification
**Scope:** Renderer navigation shell and Home command center; implementation planning follows separately.

## Intent

Replace the standalone activity rail with a coherent two-level navigation model. Home is an operational command center for work already visible in Orpheus; it is not a replacement project/workspace landing page. Projects remains the default launch surface unless the user explicitly selects another `defaultSurface`.

The existing interactive brainstorming mockup is a discussion reference only. It is not a product asset and no `.superpowers` artifact is a runtime source asset.

## Decisions

1. Remove `ActivityRail` and its fixed 46px top-level navigation column. Remove its corresponding top-bar offset contract.
2. Every top-level surface has one surface sidebar. Its persistent footer contains icon buttons, in this order: **Home, Projects, Panes, Settings**. The footer is bottom-anchored and is part of the sidebar, not a new global rail.
3. Projects retains the current project/workspace tree and collapsed-tree behavior. Panes retains `PanelsSection` and its current tree. This work changes their shell/footer geometry only; it does not redesign either tree.
4. Settings uses the same sidebar shell and persistent global footer. Its existing section navigation remains above that footer, including search and grouped settings sections.
5. Home gains a real secondary sidebar. Its ordered index is **Overview**, **Needs you now** (count), **Live agents** (count), **GitHub** (count), separator, **Limits**, **Activity**, **Stats**, then the persistent global footer.
6. Each Home index item routes to a complete page in the main content area. Overview cards navigate to those pages; they are not anchors into one oversized page.
7. Home derives only from actual available data. The initial release is Claude/Orpheus-backed but uses provider-neutral presentation and domain contracts. Codex, Grok, Antigravity, and fabricated provider rows/limits are explicitly out of scope.

## Navigation and shell

### Surface selection

Use a top-level surface identity of `home | projects | panes | settings` in renderer routing. `dashboard` is the current in-memory and persisted legacy spelling for Home and must continue to resolve to Home; it must not be written for new state after migration. `settings` remains non-restorable unless a future persistence migration deliberately adds it.

- **Home:** renders the Home secondary sidebar and one selected Home page.
- **Projects:** renders the current `Sidebar` project tree and restores its dedicated `projectsLast*` location exactly as today.
- **Panes:** renders the current `PanelsSection` sidebar and current panes selection behavior.
- **Settings:** renders the existing settings section sidebar within the common shell.

The persistent footer uses the existing active-row visual language: icon, accessible name, accent fill/soft background for the active surface, visible keyboard focus ring, and overlay tooltip where a collapsed sidebar does not expose a text label. Update availability remains reachable from Settings/Updates (and may remain a compact badge on the Settings footer icon); it is not a fifth primary surface.

### Sidebar geometry and collapse

The current shared sidebar width preference and `sidebarCollapsed` behavior remain the source of truth. The shell owns expanded/collapsed widths via shared layout tokens/constants rather than per-surface magic values.

- Expanded Home, Projects, Panes, and Settings sidebars align to the same resizable sidebar geometry.
- Collapsing keeps the surface sidebar mounted at its current compact width; it does not unmount data trees or reset page/selection state.
- In collapsed Home, show the seven index icons plus the global footer; badges remain available through accessible labels/tooltips and should not become unreadable dots. In collapsed Settings, expose the existing settings navigation via icon/accessibility treatment or an explicit expand affordance; do not strand settings search/sections.
- At the app's supported minimum width, preserve main-content readability: collapse the secondary sidebar before clipping the content; if space remains insufficient, use the established narrow-shell behavior rather than device-specific breakpoints. Home pages use fluid grids that become one column at their container threshold.

The old `ActivityRail` width constant and `TopBar` alignment dependency are deleted. The top bar aligns to the actual shell below it, not to an invisible former rail.

### Home page selection

Add the Home-local persisted field `homeLastPage`, with `overview` as its default. It is separate from `lastViewKind`, `projectsLast*`, and `defaultSurface`; selecting a Home subpage must not erase the last project/workspace location. Home navigation updates `homeLastPage` optimistically through the existing `uiStateStore` pattern and restores it when returning to Home or relaunching with Home selected.

Counts are labels for currently available actionable data, not promises of historical completeness:

- Needs you now: total visible actionable queue items.
- Live agents: working + waiting + ready live workspace rows.
- GitHub: open PRs plus assigned/review-requested issues/PRs only where current fetched data can distinguish them; otherwise show the available open count without inventing a review count.

## Home information architecture

### Overview

The Overview page header is `Home` and the current local date. It is a compact operational header, not a marketing greeting or hero.

1. **Action row:** Needs you now, Live agents, GitHub. Each section is a concise summary with state-aware empty/loading/error treatment and an explicit action that opens its full page.
2. **Pulse row:** Weekly Limits, Weekly Activity, Stats. Use the existing cards, typography, compact table/list treatments, spacing, colors, and responsive behavior rather than reproducing a literal mockup. Limits display only the usage windows actually returned. Activity uses actual recent scanner data. Stats shows actual current metrics.

The page retains useful existing visual components and data hooks where their contracts fit, but reorganizes them into the navigation/page model rather than duplicating independent fetches in every card.

### Needs you now

A unified, ordered action queue. An item has a stable id, source, priority, title, supporting context, timestamp/staleness, and an optional action target. Initial sources are:

1. `agent`: Orpheus workspace in `attention` / waiting-for-input-or-permission state.
2. `github-check`: a failed PR check **only if current GitHub data already provides it**; otherwise this source is absent, not simulated.
3. `completed-run`: a live workspace in current `ready` state, presented as ready to review (not claimed to be a durable historical completion).
4. `github-review` / `github-issue`: review requests and assigned issues only to the degree returned by the existing account-wide GitHub contract.

The page supports source and priority filters when those fields are available. Unsupported filters are omitted or disabled with explanatory text, never populated with fake results. Ordering is actionable urgency first: attention/input, failed checks, ready-for-review, then remaining GitHub work; within a class use newest actionable event first when timestamps exist. Selecting an agent item navigates to its workspace; selecting GitHub work opens the existing relevant detail/URL behavior only where already available.

### Live agents

A provider-neutral live-work list with summary state counts for **working**, **waiting**, and **ready**. Each row displays provider, project/workspace, task/title, state, and elapsed/last-activity time. Initial rows come only from the current workspace/session/activity-store join:

- provider label is Claude for currently-supported rows;
- state derives from the file-authoritative activity status already surfaced through `activityStore`;
- project/workspace and task derive from existing records/session preview/title;
- elapsed is the existing real activity timestamp behavior and is labeled as relative activity when a precise start time is not available.

Rows navigate through the existing workspace selection path, preserving terminal lifecycle behavior. `projectId` and `workspaceId` remain navigation identities; rows display the required human `projectLabel` and `workspaceLabel` derived from authoritative project/workspace records. Raw UUIDs are never used as display fallbacks. Empty state says there are no live agents; it does not imply that no external providers exist.

### GitHub

Expand current account-wide GitHub content into a full page for existing PRs, issues, and any already-available check/review state. Keep the current stale-while-revalidate cache and live refresh behavior. No separate GitHub synchronization service, repository explorer, write actions, or new backend query scope is introduced solely for this redesign. If GitHub is unavailable, show a calm unavailable/connection state while leaving all unrelated Home pages useful.

### Limits

Define a provider-neutral limits page capable of representing multiple providers, windows, and buckets. The interface must represent:

- provider identity and display name;
- one or more named buckets/windows per provider;
- supported scope (`current`, `daily`, `weekly`, `all`);
- remaining usage, optional total/used value, reset time, freshness, and availability;
- model family or bucket label when applicable.

Claude conceptually supports a current session window, an all-model weekly window, and distinct Fable/model-family windows. The initial UI renders only the actual `ClaudeUsageResult` fields presently returned (currently session/five-hour and weekly values plus actual returned limits). Do not display unsupported Current/Daily/Weekly/All controls, Fable allocations, or provider rows. If a future provider supplies a different set, the page selects only scopes that it actually supports and compares providers only when the units are meaningfully compatible.

### Activity

Activity is a provider/project-filterable page architecture with range choices **Daily, Weekly, Monthly, Custom**. The initial implementation enables only ranges supported by actual historical data. The current transcript scanner supplies a fixed trailing seven-day Claude summary, so Weekly is initially enabled; Daily/Monthly/Custom and provider/project filters are shown only after their backing aggregation/filter contract exists. Do not relabel a seven-day summary as monthly/custom data.

Use compact, accessible chart/list semantics consistent with current `ActivityChart`; provide textual totals and an accessible data summary, not color-only meaning.

### Stats

Stats is a full page of actual sessions, token totals, active days/time where available, current streak, peak hour, and supported project/provider breakdowns. The current activity scanner supports all-history and trailing-seven-day session/message/token totals, current streak, active days, and peak hour. Project/provider breakdowns appear only when their source data can support them; no inferred per-provider or project totals are shown.

## Data and interface boundaries

### Renderer contracts

Do not place a new Home monolith in `Dashboard.tsx`. Create focused page/sidebar components and a shared Home data facade/store. Follow the renderer convention: cross-page state and live subscriptions live in external `useSyncExternalStore`-style stores or focused hooks; page-local focus/filter input may remain local.

The Home facade normalizes existing sources into provider-neutral view models before rendering. The following are the approved stable contract names:

- `ProviderDescriptor { id, label, kind }`
- `HomeAgent { id, provider, workspaceId?, projectId?, projectLabel, workspaceLabel, task, state, observedAt, elapsedLabel }`
- `HomeActionItem { id, source, priority, title, detail?, observedAt?, target? }`
- `ProviderLimitSnapshot { provider, fetchedAt?, stale, availability, buckets }`
- `LimitBucket { id, label, scopes, remaining?, used?, total?, resetsAt?, modelFamily? }`
- `HomeActivitySnapshot { provider, supportedRanges, summaries, freshness }`
- `HomeStatsSnapshot { provider, window, sessions?, tokens?, activeDays?, streak?, peakHour?, breakdowns? }`

These are presentation/domain seams, not a claim that a generic multi-provider backend is built now. Existing `ClaudeUsageResult`, `ClaudeActivitySummary`, project/workspace/session records, `activityStore`, `activityTimeStore`, `prStore`, and current GitHub hooks remain authoritative adapters until a new source is genuinely needed.

**Final correction (whole-branch review):** `HomeAgent` carries required human project/workspace labels separately from optional navigation ids so Live Agents never renders raw UUIDs as user-facing identity.

### Main/preload/shared boundaries

Reuse existing typed IPC and push channels where possible. New data requires, in order: shared type in `src/shared/types.ts`, invoke/push map entry in `src/shared/ipc.ts`, typed `handle()` registration in the appropriate main IPC module, typed preload exposure, and a renderer adapter/store. Never add raw IPC registration or import `index.ts` into an IPC module.

Backend expansion is limited to data necessary for the pages above and only after confirming it is not already exposed. Any durable new aggregate/cache/migration follows the declarative schema/migration engine and receives migration-harness coverage. GitHub data must preserve its current total/degraded contract and never treat missing auth as zero work without an unavailable state.

### Freshness, loading, errors, and focus

All Home data is stale-while-revalidate:

- Render cached data immediately with an explicit subdued freshness marker when available.
- A first-ever load uses a stable, space-reserving loading treatment; refreshes retain prior content and update silently.
- A source-specific failure leaves unrelated sections usable and exposes a concise retry/status treatment.
- Empty is distinct from unavailable/error and explains the actionable meaning (for example, “No agents need input”).
- Background poller pushes and manual refreshes must not flash skeletons, reset filters/scroll/selection, steal terminal focus, foreground the app, or navigate the user.

## Existing behavior that must remain intact

- Workspace navigation continues through the existing selection/open path. Workspace surfaces are hidden on navigation, not destroyed; destruction remains archive/remove-only.
- Background mounting remains mount-then-hide and must re-promote the viewed workspace when necessary. Home navigation must never cause terminal teardown, remount churn, or focus theft.
- The LRU kept workspace views and native terminal z-order/overlay constraints remain intact.
- Project privacy redaction, hidden projects, pinning, worktree behavior, and project sidebar restore semantics remain unchanged.
- Existing UI state behavior remains compatible: `lastViewKind` legacy values (notably `dashboard`) resolve correctly; `sessions` remains the Projects resting route; `projectsLast*` survives surface switching; `defaultSurface` continues to control explicit launch preference.

## Accessibility and keyboard behavior

- Use semantic `nav` landmarks with distinct labels for surface navigation, Home index, project tree, panes tree, and settings sections.
- Surface/footer and Home index controls are real buttons/links with `aria-current="page"`; counts are included in accessible names but do not replace labels.
- Implement roving tab order or normal sequential buttons consistently with the existing sidebar; arrow-key navigation within a composite list must not conflict with text inputs. Enter/Space activates, Home/End move to endpoints where the chosen pattern supports it, and Escape returns focus predictably after overlays/search.
- Preserve visible focus indicators, target sizes, tooltip alternatives, reduced-motion behavior, and text equivalents for charts/status color. Status is never conveyed by color or animation alone.
- On page navigation, move focus to the main page heading only for keyboard-initiated navigation; pointer navigation preserves expected pointer context. Do not automatically focus a workspace terminal from Home.

## Migration and documentation

Implementation must update `CLAUDE.md`'s current prohibition on reintroducing a dashboard/home page. Replace it with: **Home is an operational command center that aggregates and routes to existing work; it is not a project/workspace landing page. Projects remains the default launch surface unless user navigation settings choose otherwise.**

Migrate legacy persisted data non-destructively:

- Read legacy `lastViewKind: 'dashboard'` as Home.
- Continue accepting legacy values in coercion/restore code during the compatibility window.
- Write new Home page selection separately; do not overload `lastViewKind` with subpage ids.
- Preserve current `defaultSurface: 'dashboard'` compatibility while introducing/using `home` only if a schema/type migration is required; normalization must avoid making existing preferences fall back unexpectedly.
- Do not remove legacy coercion until a documented compatibility release has shipped and persisted rows are safely normalized.

## Non-goals

- Redesigning Projects or Panes trees beyond the shared footer/shell changes.
- Adding integrations for Codex, Grok, Antigravity, or any provider beyond actual current Claude/Orpheus data.
- Showing fake provider, limit, check, completion, activity, or stats data.
- Building a new GitHub backend/product surface beyond data necessary to render currently available PR/issue/check information.
- Replacing the native terminal model, workspace lifecycle, project restore logic, or settings architecture.
- Turning Home into the mandatory landing page or a generic marketing/analytics dashboard.

## Conceptual implementation units and acceptance checks

These units are intentionally independent after the routing/shell foundation is stable. They are not the detailed implementation plan.

1. **Navigation foundation and compatibility** — Establish the surface/Home route model, persisted Home selection, legacy coercion, and update `CLAUDE.md`.  
   *Acceptance:* a legacy dashboard preference opens Home; Projects restoration and `defaultSurface` behavior remain correct; typecheck passes.
2. **Shared sidebar shell/footer** — Remove `ActivityRail`, move global navigation into a reusable bottom footer, and align top-bar/sidebar geometry for all surfaces.  
   *Acceptance:* Home/Projects/Panes/Settings switch without layout shift; expanded/collapsed behavior and footer keyboard labels work; no 46px rail remains.
3. **Home index and page routing** — Add the Home sidebar, counts, collapsed behavior, and individual page routes with stable headings/focus behavior.  
   *Acceptance:* every index entry opens a distinct page and restores the last Home page without altering project selection.
4. **Home data facade and overview** — Normalize current live-agent, GitHub, Claude usage, and activity sources; rebuild Overview with real, navigable summaries and stale-while-revalidate state.  
   *Acceptance:* cached data remains visible during refresh; unavailable/empty/error states are distinguishable; overview cards route to the matching full page.
5. **Action queue and live agents** — Implement current-source Needs you now and provider-neutral Live agents pages with filters where source data supports them.  
   *Acceptance:* attention and ready workspace state changes update counts/rows; selecting a row navigates without destroying a terminal; unsupported queue sources are absent rather than fabricated.
6. **GitHub, limits, activity, and stats pages** — Expand each into a full page strictly from actual supported contracts, including freshness and range/scope gating.  
   *Acceptance:* only available Claude windows/ranges and GitHub fields render; no fictional provider data appears; text alternatives accompany visual summaries.
7. **Verification and regression pass** — Exercise real packaged-dev navigation and responsive/accessibility cases, then run repository gates.  
   *Acceptance:* `bun run check` passes; manual packaged-dev checks confirm silent refresh, focus stability, workspace hide-vs-destroy behavior, legacy restore, privacy behavior, collapsed sidebars, minimum-width layout, and keyboard traversal.
