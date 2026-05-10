# Phase 2B — Task breakdown

Concrete tasks derived from the README + locked decisions. Eight groups; commit each as a logical chunk.

## Group 1 — Xcode project scaffold

1. **Create `apps/Orpheus/Orpheus.xcodeproj`.**
   - Use Xcode's `File → New → Project → macOS → App` template, then move the resulting files into `apps/Orpheus/`. Or generate via `xcodegen` if cleaner — your call.
   - Bundle identifier: `com.orpheus.app` (placeholder; user can change before signing for distribution).
   - Deployment target: **macOS 14.0**.
   - Swift language: **Swift 5.9 / 6.0**.
   - App target name: `Orpheus`.
   - Test target name: `OrpheusAppTests`.
   - Code signing: **automatic, development team** (the user's personal Apple ID team or empty for now).
   - Don't enable App Sandbox yet — Orpheus needs unsandboxed shell spawning. App Sandbox is a Phase 7 distribution concern.

2. **Add local SwiftPM packages.** Via Xcode's File → Add Package Dependency → Add Local… for each:
   - `../../packages/OrpheusDesign`
   - `../../packages/OrpheusCore`
   - (Do NOT add `OrpheusTerminal` — Phase 2B doesn't import it.)

3. **Project structure.** Inside `apps/Orpheus/`:
   ```
   apps/Orpheus/
   ├── Orpheus.xcodeproj/
   ├── Orpheus/                          # app target source root
   │   ├── App/                          # app entry + lifecycle
   │   │   ├── OrpheusApp.swift          # @main, NSApplicationDelegate adaptor
   │   │   └── AppDelegate.swift
   │   ├── State/                        # @Observable view models
   │   │   ├── AppState.swift            # top-level
   │   │   ├── SidebarViewModel.swift
   │   │   ├── DashboardViewModel.swift
   │   │   └── OnboardingViewModel.swift
   │   ├── Window/                       # AppKit chrome
   │   │   ├── MainWindowController.swift
   │   │   ├── MainWindow.swift          # NSWindow subclass with custom chrome
   │   │   └── ToolbarBuilder.swift
   │   ├── Views/                        # SwiftUI views (hosted via NSHostingView)
   │   │   ├── ContentView.swift         # root SwiftUI view (split: Sidebar | Main)
   │   │   ├── Sidebar/
   │   │   │   ├── SidebarView.swift
   │   │   │   ├── ProjectRow.swift
   │   │   │   ├── SpaceRow.swift
   │   │   │   └── SidebarSection.swift
   │   │   ├── Dashboard/
   │   │   │   ├── DashboardView.swift   # W1 empty + W2 populated
   │   │   │   ├── ActivityHeatmapStub.swift
   │   │   │   ├── ProjectsListPane.swift
   │   │   │   └── SessionsListPane.swift
   │   │   ├── EmptySpace/
   │   │   │   └── EmptySpaceView.swift  # W3
   │   │   ├── Onboarding/
   │   │   │   └── OnboardingView.swift  # W18
   │   │   └── States/                    # W19 reusable patterns
   │   │       ├── EmptyState.swift
   │   │       ├── LoadingSkeleton.swift
   │   │       ├── ErrorToast.swift
   │   │       └── ErrorBanner.swift
   │   ├── Resources/
   │   │   ├── Assets.xcassets/
   │   │   └── Info.plist
   │   └── Internal/
   │       ├── OrpheusAppLogger.swift     # os.Logger wrapper, subsystem com.orpheus.app
   │       └── DBLocator.swift           # ~/.orpheus/orpheus.db path resolution
   └── OrpheusAppTests/
       ├── AppStateTests.swift
       ├── SidebarViewModelTests.swift
       ├── DashboardViewModelTests.swift
       ├── OnboardingViewModelTests.swift
       └── DisciplineLintTests.swift     # apps/Orpheus/-scoped lint
   ```

4. **Build proves SwiftPM dep resolution.** From `apps/Orpheus/`:
   ```bash
   xcodebuild -project Orpheus.xcodeproj -scheme Orpheus -configuration Debug build
   ```
   Must succeed cleanly. Optionally also verify with `xcodebuild test` (no tests yet, but the test target should link).

5. **`Info.plist` minimum keys:**
   - `CFBundleName = Orpheus`
   - `CFBundleDisplayName = Orpheus`
   - `CFBundleIdentifier = com.orpheus.app`
   - `LSMinimumSystemVersion = 14.0`
   - `NSPrincipalClass = NSApplication`
   - `LSApplicationCategoryType = public.app-category.developer-tools`

## Group 2 — App lifecycle + DB open

6. **`OrpheusApp.swift` (`@main`).** SwiftUI `App` struct that uses `@NSApplicationDelegateAdaptor` to attach an `AppDelegate`. Empty `WindowGroup` (the actual window is owned by `MainWindowController`).

7. **`AppDelegate.swift`.** Implements `NSApplicationDelegate`:
   - `applicationDidFinishLaunching`:
     - Resolve DB path via `DBLocator` (`~/.orpheus/orpheus.db`, override via `--orpheus-db-path` CLI arg or `ORPHEUS_DB_PATH` env var for development).
     - Open `Database` (handle errors via `OrpheusAppLogger.error` + show a critical-error full-page view per W19 if DB open fails).
     - Construct repositories.
     - Construct `AppState` (the root `@Observable`) and inject the database / repositories.
     - Decide which view to show on launch (onboarding vs dashboard) per the rule in README "Onboarding behaviour":
       - If projects table empty AND `app_state['onboarding_seen'] != "true"` → onboarding (W18).
       - Else → dashboard (W1 empty if no projects, W2 if projects exist).
     - Construct `MainWindowController` and show its window.
   - `applicationShouldTerminateAfterLastWindowClosed` → `true`.
   - `applicationWillTerminate` → close DB cleanly.

8. **`AppState` (`@Observable` class).** Top-level state container. Owns:
   - The `Database` reference.
   - Each repository.
   - The `SettingsWatcher` and the resolved `OrpheusSettings`.
   - Sub-view-models (created on demand: SidebarViewModel, DashboardViewModel, OnboardingViewModel).
   - `currentScreen: Screen` enum (`.onboarding`, `.dashboard`, `.emptySpace(SpaceID)`, `.criticalError(message)`).

   `@MainActor`-isolated (the whole class).

## Group 3 — Window + toolbar chrome (custom)

9. **`MainWindow` (NSWindow subclass).** Custom chrome:
   - `titlebarAppearsTransparent = true`, `titleVisibility = .hidden`.
   - Standard traffic lights (don't move them — re-positioning is brittle and the toolbar accommodates them).
   - Toolbar via `NSToolbar` with these items (matching W1/W2):
     - Sidebar toggle (`[<|]`), left-aligned.
     - Centered search field (per W1/W2). On W18 the search is hidden — bind toolbar item visibility to `appState.currentScreen`.
     - Right-side user menu (`[User v]`).
   - Window size: 1100×680 default. Min size: 880×520. Position persisted to `app_state['window_geometry']` (write on resize/move; restore on launch).

10. **`MainWindowController` (NSWindowController).**
    - Owns the `MainWindow`.
    - Hosts the SwiftUI `ContentView` via `NSHostingView`.
    - Wires the SwiftUI `ContentView` to `appState`.

11. **Toolbar items use OrpheusDesign components.** Don't use stock `NSToolbarItem` styling — wrap each item's view in `OrpheusButton` / `OrpheusTextField` etc. via `NSHostingView`. The `NSToolbar` API allows custom-view items.

## Group 4 — Sidebar (data + view)

12. **`SidebarViewModel` (`@Observable`).**
    - Subscribes to `ProjectRepository.observeAll()` → `projects: [Project]`.
    - Lazily subscribes to `SpaceRepository.observeByProject(_:)` per expanded project → `spacesByProject: [ProjectID: [Space]]`.
    - Lazily subscribes to `TerminalRepository.observeBySpace(_:)` per expanded space — for the count-per-space and to know "no active terminals" (the W3 secondary label). Cached.
    - Holds `expandedProjects: Set<ProjectID>` (initial = all pinned projects expanded).
    - `selectedItem: SidebarSelection?` enum: `.dashboard` / `.sessions` / `.project(ProjectID)` / `.space(SpaceID)`. Default `.dashboard`.
    - Pinned vs not: a `Project` is "pinned" if `lifecycleState == .pinned`. Render Pinned section first, Projects section below.
    - Methods: `expand(_ projectID: ProjectID)`, `collapse(_:)`, `select(_:)`, `addProject(_:)`, `archive(_:)`, etc. — write through to `OrpheusCore` repositories.

13. **`SidebarView` (SwiftUI).**
    - Top nav: `[D] Dashboard`, `[T] Sessions`, `[+] New Space ⌘N` — three rows, OrpheusDesign-token styled. The `[T] Sessions` row routes to a stubbed view ("Sessions browser — Phase 4").
    - Pinned section: header `-- Pinned --` (only shown if there's at least one pinned project). Each row = `[logo] <name> (count) <chevron>`. Expanded shows nested Space rows below, indented.
    - Projects section: header `-- Projects --`. Same row shape.
    - Footer: `[+] Add repository` button (kicks off the new-project flow — Phase 2B uses a minimal `NSOpenPanel` folder picker; W10 modal is Phase 2C).
    - Use `OrpheusList` / `OrpheusRow` (or compose with `OrpheusButton` + tokens) — NEVER stock `List` or `Button`.
    - Project chevron uses `OrpheusIcon` with the right SF Symbol (`chevron.right` / `chevron.down`).
    - Logo glyph: `[g]` for projects whose `rootPath` contains a `.git` directory; `[~]` for everything else. Render via `OrpheusText` with mono font + token-coloured background.
    - Counts: number of nested Spaces (NOT terminals).

14. **Sidebar selection drives main pane.** `selectedItem` change → `appState.currentScreen` change. The content pane re-renders.

## Group 5 — Dashboard (W1 + W2)

15. **`DashboardViewModel` (`@Observable`).**
    - `projects: [Project]` from `ProjectRepository.observeAll()`.
    - `recentSessions: [SessionMetadata]` from `SessionRegistry.recent(limit: 6)` — refreshed periodically (every 30s) AND on `SessionRegistry.updates()` events.
    - `isLoading: Bool` — true during the initial load (first emission not yet received).

16. **`DashboardView` (SwiftUI).**
    - **W1 empty state** (when `projects.isEmpty`):
      - Centered welcome block: `Welcome to Orpheus` title (use `OrpheusTypography.display`).
      - One-line tagline.
      - Two CTAs: `[ + New project ]` (primary) and `[ Open folder... ]` (secondary). Both are `OrpheusButton`.
      - Keyboard hint `Cmd+N for a new space` in `OrpheusColor.Text.secondary`.
    - **W2 populated state** (when `projects` non-empty):
      - Header row: `Dashboard` (title) + `[ + Project ]` button (right-aligned, `OrpheusButton.primary`).
      - **Activity heatmap section (stubbed)**: title `Activity (last 30 days)`, two static grids labelled `Claude Code` and `GitHub`. Rendered via SwiftUI `Canvas` with hard-coded placeholder cells matching the wireframe shape. `ActivityHeatmapStub.swift` lives in `Views/Dashboard/`. Phase 4 will replace it.
      - **Projects list pane** (left): `ProjectsListPane` rendering each project as `[logo] <name> (count)` rows using `OrpheusRow`. Click → `appState.currentScreen = .project(id)`.
      - **Sessions list pane** (right): `SessionsListPane` rendering `recentSessions` as `<status-dot> <truncated-title> <relative-time>` rows using `OrpheusRow`. Click → stubbed (Phase 2C resumes via terminal).
    - Loading state: while `isLoading`, render `LoadingSkeleton` (W19 pattern).

17. **`ProjectsListPane` and `SessionsListPane`** use OrpheusDesign components consistently. No stock `List`.

## Group 6 — Empty space + session picker (W3)

18. **Navigation routing.** When `appState.currentScreen == .space(SpaceID)`:
    - Look up the Space's terminals via `TerminalRepository.fetchBySpace(spaceID)`.
    - If empty → render `EmptySpaceView` (W3).
    - Else → in Phase 2B, render a placeholder "Phase 2C will host terminals here" view. (Phase 2C replaces this with the real terminal layout.)

19. **`EmptySpaceView` (SwiftUI) — W3 shape.**
    - Header: `[ + ]` toggle (left, OrpheusButton) + `[ +- Terminal ]` (right). The `[ + ]` is a stub for the future space switcher; the `[ +- Terminal ]` is stubbed for Phase 2C.
    - Title row: space name + horizontal rule.
    - Center body:
      - `Start a Claude session in this space` heading.
      - **New session card**: `OrpheusButton`-styled card with `[ + ] New Claude session` + cwd subtitle + `⌘Enter` shortcut hint. Click triggers a stub action that logs "Phase 2C will spawn the terminal here" via `OrpheusAppLogger`.
      - **Resume cards**: list of recent sessions in this space's project (from `SessionRegistry.sessions(forCWD: project.rootPath)`). Each card: `<status-dot> <title> <time> <token-count> [Resume]`. `[Resume]` is also stubbed.
      - `[ View all sessions ]` link at the bottom (stubbed → Phase 4 sessions browser).
    - Use `OrpheusRow` / `OrpheusButton` exclusively.

## Group 7 — Onboarding (W18) + state patterns (W19)

20. **`OnboardingView` (SwiftUI) — W18 shape.**
    - Centered welcome block: title `Welcome to Orpheus` + tagline `A Mac IDE built around Claude Code.`
    - 3-step explainer (numbered headings + one-line descriptions per the wireframe).
    - Two CTAs: `[ + Add repository ]` (primary) → minimal folder-picker `NSOpenPanel` flow + `[ Open folder... ]` → same picker.
    - Keyboard hint: `Cmd+,  to open Settings` (settings is Phase 4 — stub the action).
    - On any project creation OR if user clicks `[ + Add repository ]` and confirms → set `app_state['onboarding_seen'] = "true"` and transition to dashboard.

21. **`OnboardingViewModel` (`@Observable`).**
    - Single method: `addRepositoryViaFolderPicker()` → presents `NSOpenPanel`, on selection creates a `Project` row in OrpheusCore + a `Space` row (the Default Space) + sets `onboarding_seen` flag, then transitions `appState.currentScreen` to `.space(defaultSpaceID)`.
    - The Default Space has zero terminals (Phase 2C wires actual terminal spawn).

22. **W19 state-pattern utilities.**
    - `EmptyState.swift` — generic component: `init(title: String, message: String, ctaLabel: String?, ctaAction: (() -> Void)?)`. Used by Sessions list when empty, MCP list (Phase 4), etc. — all consumers in 2B + reused later.
    - `LoadingSkeleton.swift` — token-styled gray blocks with shimmer animation. `init(rows: Int, hasHeader: Bool)`. Used by DashboardView during initial load.
    - `ErrorToast.swift` — top-right transient notification with `OrpheusToast` (the OrpheusDesign component). 6s auto-dismiss; explicit close.
    - `ErrorBanner.swift` — top-of-surface persistent banner. Uses OrpheusDesign tokens (semantic.error tokens for background + border). Manual dismiss only.
    - All four use OrpheusDesign components/tokens — no stock SwiftUI primitives.

23. **Critical-error full-page view.** When `Database` open fails on launch (e.g. corrupt DB), `appState.currentScreen = .criticalError(message)` renders a centered apology + diagnostic info + `[ Open support ]` (mailto stub) + `[ Reset app data ]` (deletes the DB and restarts the app). Uses W19 patterns.

## Group 8 — Tests + DisciplineLintTests + docs

24. **`AppStateTests`.** Unit tests for the launch decision tree:
    - Empty DB + `onboarding_seen` unset → `.onboarding`.
    - Empty DB + `onboarding_seen == "true"` → `.dashboard` (empty W1 state).
    - DB with projects → `.dashboard` (populated W2 state).
    - DB open failure → `.criticalError`.
    Use an in-memory `Database` for the test fixture.

25. **`SidebarViewModelTests`.** Unit tests:
    - `projects` reflects the repository's emissions in order.
    - Expanding a project triggers `observeByProject` subscription; collapsing tears it down.
    - Pinned projects appear in the Pinned section; non-pinned in Projects.
    - Logo glyph derivation: `.git` directory → `[g]`; otherwise → `[~]`.
    Mock the repositories with in-memory fixtures.

26. **`DashboardViewModelTests`.** Unit tests:
    - `recentSessions` is sorted by `lastUpdated` descending.
    - Refresh on `SessionRegistry.updates()` event.
    - `isLoading` flips to false on first emission.

27. **`OnboardingViewModelTests`.** Unit tests:
    - After `addRepositoryViaFolderPicker` completes, `onboarding_seen` flag is true in the AppStateRepository.
    - The Default Space row exists in the DB.
    - Transition target is `.space(defaultSpaceID)`.

28. **`DisciplineLintTests` for `apps/Orpheus/`.** Mirror the pattern from `packages/OrpheusCore/Tests/DisciplineLintTests/DisciplineLintTests.swift`. Forbidden patterns:
    - `import OrpheusTerminal` — empty (Phase 2C concern).
    - `Button(` (uppercase B from SwiftUI — but only outside `Sources` of OrpheusDesign which we don't ship inside Orpheus app target). Actually the rule is: scan for `SwiftUI.Button`, `SwiftUI.List`, `SwiftUI.Toggle`, `SwiftUI.TextField`, `SwiftUI.Menu`, `SwiftUI.NavigationStack`, `SwiftUI.NavigationSplitView`, `SwiftUI.TabView`, `SwiftUI.DisclosureGroup`. Allow `// orpheus-allow:stock-control` markers per Phase 0's convention.
    - `Color(red:` / `Color.white` / `Color.black` / `Color.blue` etc. — must use `OrpheusColor.*`.
    - `.font(.system` — must use `OrpheusTypography.*`.
    - Hardcoded `/Users/` paths.
    - `print(` — should use `OrpheusAppLogger`. Allow markers.
    - No basename collisions across `apps/Orpheus/Orpheus/`.

29. **`apps/Orpheus/README.md`** — short. Covers:
    - What this is (the Orpheus.app target).
    - How to build (`xcodebuild ...` and Xcode `Run`).
    - Launch decision tree (onboarding vs dashboard).
    - State management (AppState + view models + OrpheusCore observers).
    - Where each surface lives (W1/W2 → DashboardView, W3 → EmptySpaceView, W18 → OnboardingView, W19 → States/).
    - Debug overrides (`--orpheus-db-path`, `ORPHEUS_DB_PATH`).
    - Cross-link to `apps/Orpheus/AGENTS.md`.

30. **`apps/Orpheus/AGENTS.md`** — discipline rules adapted for an app target. Same shape as `packages/OrpheusCore/AGENTS.md`. Highlights:
    - No `import OrpheusTerminal` (Phase 2C concern).
    - No stock SwiftUI controls (use OrpheusDesign).
    - All views are SwiftUI, hosted via `NSHostingView` from AppKit window.
    - Errors logged via `OrpheusAppLogger`.
    - State management = `@Observable` view models + AsyncStream subscriptions.

## Decisions to lock in this phase

These are recommendations; pick one in code and confirm in handoff:

- **Initial sidebar state.** Recommended: select `.dashboard` on launch unless restoring from `app_state['last_selection']`. Persist selection on every change.
- **Window geometry persistence cadence.** Recommended: write on `windowDidEndLiveResize` and `windowDidMove`. Don't write on every frame.
- **Folder picker UX in W18 / W1.** Recommended: standard `NSOpenPanel` with `canChooseDirectories = true`, `canChooseFiles = false`, `allowsMultipleSelection = false`. Phase 2C will replace with the W10 modal.
- **Pinned projects ordering within the Pinned section.** Recommended: `created_at` ascending (oldest pinned at top). Document the choice.

## Out of scope (flag if you hit them)

- libghostty / `OrpheusTerminal` integration — Phase 2C.
- W10 / W11 modals at full fidelity — Phase 2C.
- Real heatmap data / GitHub API integration — Phase 4.
- Logo auto-fetch — Phase 4 or later.
- Quick Actions footer — Phase 4.
- Command palette ⌘K — Phase 4.
- Menubar dropdown — Phase 4.
- Settings windows — Phase 4.
- Sessions browser (W5) — Phase 4 (sidebar `[T] Sessions` row stubs to a placeholder).
- Voice HUD — Phase 6.
- Sandboxing / distribution signing — Phase 7.

If a task can't be completed without touching out-of-scope code, **stop and flag it in your handoff report**.
