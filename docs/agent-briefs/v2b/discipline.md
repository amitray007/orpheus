# Phase 2B — Discipline rules + common pitfalls

These rules adapt earlier phases' discipline to the **first user-visible Mac app target**. Phase 2B is where the OrpheusDesign promise — no stock SwiftUI chrome anywhere visible — stops being theoretical.

## Hard rules

### 1. No stock SwiftUI controls in user-facing chrome
Forbidden in `apps/Orpheus/Orpheus/Views/`:
- `Button { }` as visible chrome — use `OrpheusButton`.
- `Toggle { }` — use `OrpheusToggle`.
- `TextField { }` / `TextEditor { }` — use `OrpheusTextField`.
- `List { }` — use `OrpheusList` or compose with `OrpheusRow` + `LazyVStack` / `ScrollView`.
- `Menu { }`, `NavigationStack`, `NavigationSplitView`, `TabView`, `DisclosureGroup`, `Form { }` — none of these.

The rare case: an internal `Button(action: ...) { ... }.buttonStyle(.plain)` to wrap a tap target where the visible body is your own. Acceptable only if `.buttonStyle(.plain)` is set so the system style is fully overridden. Mark with `// orpheus-allow:stock-control` so the lint test ignores it.

The `DisciplineLintTests` test target enforces this. If it fails, fix the source — don't whitelist the rule.

### 2. No raw colours, no system fonts, no raw px values
- **Colours:** always `OrpheusColor.<category>.<token>`. Never `Color.white`, `Color.black`, `Color.blue`, `Color(red:green:blue:)`, hex literals.
- **Typography:** always `OrpheusTypography.<style>` via `.orpheusFont(_:)`. Never `.font(.system(...))`, `.font(.title)`, etc.
- **Spacing:** always `OrpheusSpacing.<token>`. Never `padding(20)`, `padding(.leading, 12)`, etc. Use `padding(OrpheusSpacing.md)`.
- **Radius:** always `OrpheusRadius.<token>` or via `.orpheusCornerRadius(...)`.
- **Materials:** `.orpheusMaterial(.sidebar)` / `.orpheusMaterial(.toolbar)` / etc. Never `.regularMaterial`, `.thinMaterial`.
- **Animation:** `OrpheusMotion.standardAnim` / `quickAnim` / `settleAnim` / `dramaticAnim`.

### 3. AppKit owns the window, SwiftUI owns the contents
- The `NSWindow` and `NSToolbar` are AppKit (custom traffic-light positioning is cleaner there).
- Everything inside the window's `contentView` is SwiftUI, hosted via `NSHostingView`.
- Don't mix the two within the same view tree. SwiftUI views can reach back into AppKit via `NSViewRepresentable` for the rare case (Phase 2C will need this for libghostty), but Phase 2B has no such case.

### 4. State management = `@Observable` view models + `AsyncStream` consumers
- Every view model is a class annotated with `@Observable` (Swift 5.9+).
- View models hold `@MainActor`-isolated properties.
- View models subscribe to `OrpheusCore` repository `AsyncStream`s in a setup method called from `init` or from a `.task { }` modifier in the consuming view.
- Consumers use `@State` / `@Bindable` to observe.
- Forbidden: Combine subscriptions, NotificationCenter chains, manual KVO, NSObject-based observation patterns. The `AsyncStream` → `@Observable` bridge is the only path.

### 5. No `import OrpheusTerminal` in `apps/Orpheus/`
Phase 2B doesn't host terminals. The lint test enforces this. Phase 2C will lift the rule when it adds the integration.

### 6. No `print(...)` in app-target source
Use `OrpheusAppLogger.<category>` (`os.Logger` wrapper, subsystem `com.orpheus.app`). Categories: `app` (lifecycle), `sidebar`, `dashboard`, `onboarding`, `errors`. Add categories as needed.

The `apps/Orpheus/Orpheus/` source has zero `print(`. Tests use `XCTAssert`; never `print` in tests.

### 7. No hardcoded `/Users/...` paths
Always derive via `FileManager.default.homeDirectoryForCurrentUser`. The DB path resolver (`DBLocator`) honours `--orpheus-db-path <path>` CLI arg and `ORPHEUS_DB_PATH` env var for development overrides.

### 8. Errors are typed
- App-level errors live in `apps/Orpheus/Orpheus/Internal/OrpheusAppError.swift`. Cases: `databaseOpenFailed(reason:)`, `windowSetupFailed(reason:)`, `onboardingFailed(reason:)`, etc. Add cases as code drives them.
- Don't reuse `OrpheusCoreError` in app-level catch sites — bridge `OrpheusCoreError` failures into `OrpheusAppError` cases at the boundary so the app's error handling stays its own.

### 9. Crash-safety on launch
- `Database` open failure → `.criticalError(message)` screen, never crash the app.
- Settings load failure → log + continue with defaults; don't block the UI.
- Window geometry restore failure → use defaults; don't block.

### 10. Phase 2B is parallel-safe with Phase 2A
- Don't touch `packages/OrpheusTerminal/` or its imports.
- Don't touch `packages/OrpheusCore/`. Read its public API; never modify.
- Don't touch `packages/OrpheusDesign/`. If a needed component is missing from OrpheusDesign, raise it as a separate sub-phase (extending OrpheusDesign), don't reach for stock SwiftUI as a workaround.

## Common pitfalls

### `@Observable` + `AsyncStream` bridging
The canonical pattern:

```swift
@Observable
@MainActor
final class SidebarViewModel {
    var projects: [Project] = []
    private var streamTask: Task<Void, Never>?

    func start(repository: ProjectRepository) {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            for await snapshot in await repository.observeAll() {
                guard let self else { return }
                self.projects = snapshot
            }
        }
    }

    deinit {
        streamTask?.cancel()
    }
}
```

The `for await` loop is on the MainActor (the view model is `@MainActor`-isolated), so the `@Observable` properties update synchronously on the main thread. Don't try to do this with Combine.

### Custom traffic-light positioning
Don't try to move the traffic lights. Apple's docs say it's a private API; doing it manually breaks under Stage Manager / full-screen / accessibility. Use `titlebarAppearsTransparent` + `titleVisibility = .hidden` + a custom `NSToolbar` that respects the standard left-aligned traffic-light gutter (Apple reserves ~78pt). The wireframes assume this layout.

### `NSToolbar` items that host SwiftUI
Use `NSToolbarItem` subclass with `view = NSHostingView(rootView: ...)`. Set `minSize` and `maxSize` per item. Don't try to use `.toolbar { ... }` modifiers in SwiftUI — they don't compose with custom `NSWindow` chrome.

### Sidebar performance with many projects
Realistic project count is < 100. Don't optimize for thousands. Use `LazyVStack` inside `ScrollView` so off-screen rows aren't laid out, but skip more elaborate virtualization. Profile if you see jank under realistic loads.

### Auto-restore vs first-launch
Restoring window geometry happens in `applicationDidFinishLaunching`, BEFORE `MainWindowController.showWindow(_:)`. If geometry is missing, use defaults. The decision tree (onboarding vs dashboard) is independent of geometry.

### `NSOpenPanel` from SwiftUI
`NSOpenPanel.runModal()` blocks the calling thread. Call it from a SwiftUI button's action via a `Task { @MainActor in ... }` so it doesn't block the run loop. The result is the picked URL; turn into a `Project` row via `ProjectRepository.create(...)`.

### Settings hot-reload affecting the UI
`SettingsWatcher.start()` returns `AsyncStream<OrpheusSettings>`. Subscribe in `AppState.start()` and update an `@Observable` `settings: OrpheusSettings` property. Views that depend on settings (e.g. theme) read from `appState.settings`.

### App Sandbox temptation
Don't enable App Sandbox in 2B. Orpheus needs unsandboxed shell spawning (in 2C). Sandboxing is a Phase 7 distribution concern with substantial entitlement work.

### `@main` + `NSApplicationDelegateAdaptor` quirks
SwiftUI's `App` protocol expects a `body: some Scene` returning `WindowGroup`. We don't want SwiftUI's `WindowGroup` (we want our custom `NSWindow`). The pattern: empty `WindowGroup { EmptyView() }` and let `AppDelegate` create + show the real window. The empty group exists only to satisfy the App protocol.

### Don't preload heavy state on `init`
View models' `init` should be fast (no async, no DB reads). Defer subscriptions to a `start(...)` method or `.task { }` in the view. This keeps the launch path snappy.

### Don't actor-wrap pure values
View models that hold mutable state are `@MainActor` classes (not actors). Actors are for concurrent shared state — `Database`, `SubprocessManager`. SwiftUI view models are inherently main-actor.

## When to break a rule

Same as prior phases: don't, in this phase. If a rule genuinely blocks you (e.g. a wireframe genuinely needs a control OrpheusDesign doesn't provide), it's a spec gap — stop, flag in handoff, wait for resolution. The fix is to extend OrpheusDesign in a separate sub-phase, not to reach for stock SwiftUI inline.
