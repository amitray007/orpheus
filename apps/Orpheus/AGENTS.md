# AGENTS.md — Orpheus App Target

Discipline rules for human contributors and AI coding agents working in `apps/Orpheus/`.

---

## Hard Rules

### 1. No `import OrpheusTerminal`

Phase 2B does not host terminals. The `DisciplineLintTests.testNoOrpheusTerminalImport` test enforces this. Phase 2C lifts the rule when it wires the terminal integration.

### 2. No stock SwiftUI controls in user-facing views

Forbidden in `Orpheus/Views/`:
- `Button { }` as visible chrome — use `OrpheusButton`
- `Toggle { }` — use `OrpheusToggle`
- `TextField { }` / `TextEditor { }` — use `OrpheusTextField`
- `List { }` — use `OrpheusList` or compose with `OrpheusRow` + `LazyVStack` / `ScrollView`
- `Menu { }`, `NavigationStack`, `NavigationSplitView`, `TabView`, `DisclosureGroup`, `Form { }` — none of these

The rare exception: `Button(action: ...) { }.buttonStyle(.plain)` where the body is entirely your own chrome. Mark with `// orpheus-allow:stock-control`.

`DisciplineLintTests.testNoStockSwiftUIControls` scans for the most dangerous patterns. Fix the source — never whitelist the rule.

### 3. Use OrpheusDesign tokens for everything visible

- **Colors:** `OrpheusColor.<category>.<token>`. Never `Color.white`, `Color.black`, raw hex.
- **Typography:** `OrpheusTypography.<style>` via `.orpheusFont(_:)`. Never `.font(.system(...))`.
- **Spacing:** `OrpheusSpacing.<token>`. Never `padding(20)`.
- **Radius:** `OrpheusRadius.<token>` or `.orpheusCornerRadius(...)`.
- **Material:** `.orpheusMaterial(OrpheusMaterial.sidebar)` etc.
- **Animation:** `OrpheusMotion.standardAnim` / `quickAnim` etc.

### 4. State management = `@Observable` view models + `AsyncStream` consumers

```swift
@Observable
@MainActor
final class MyViewModel {
    var items: [Item] = []
    private var streamTask: Task<Void, Never>?

    func start(repository: ItemRepository) {
        streamTask?.cancel()
        streamTask = Task { [weak self] in
            for await snapshot in await repository.observeAll() {
                guard let self else { return }
                self.items = snapshot
            }
        }
    }

    func cleanup() {
        streamTask?.cancel()
        streamTask = nil
    }
}
```

No Combine subscriptions. No NotificationCenter chains. No manual KVO. No `@Published`.

### 5. No `print(` in app-target source

Use `OrpheusAppLogger.<category>` (`os.Logger` wrapper, subsystem `com.orpheus.app`). Categories: `app`, `sidebar`, `dashboard`, `onboarding`, `errors`. `DisciplineLintTests.testNoPrint` enforces this.

### 6. No hardcoded `/Users/...` paths

Always derive via `FileManager.default.homeDirectoryForCurrentUser`. The `DBLocator` singleton handles the database path, respecting `--orpheus-db-path` and `ORPHEUS_DB_PATH`. `DisciplineLintTests.testNoHardcodedUserPaths` enforces this.

### 7. Errors are typed

App-level errors live in `OrpheusAppError` (not `OrpheusCoreError`). Bridge `OrpheusCoreError` into `OrpheusAppError` at the boundary. Don't propagate library errors into app-level catch sites.

### 8. AppKit owns window chrome; SwiftUI owns content

`MainWindow` (NSWindow) + `NSToolbar` are AppKit. Everything inside the content view is SwiftUI, hosted via `NSHostingView`. Don't mix the two in the same view tree.

### 9. Crash-safety on launch

- `Database` open failure → `.criticalError(message)` screen, never crash.
- Settings load failure → log + continue with defaults.
- Window geometry restore failure → use defaults, don't block.

---

## Common Pitfalls

### `deinit` can't access `@MainActor` properties

`deinit` is nonisolated in Swift concurrency. Cancel tasks via a `cleanup()` method the owner calls before releasing the view model.

### Two-phase init for circular references

`OnboardingViewModel` needs a reference to `AppState`, which creates `OnboardingViewModel` during its own `init`. Pattern: create a placeholder with `OnboardingViewModel.__placeholder()`, then call `appState.wireOnboardingViewModel()` after `AppState.init` completes.

### `NSOpenPanel.runModal()` blocks the calling thread

Always wrap in `await withCheckedContinuation { ... }` from a `Task { @MainActor in ... }`. Never call it synchronously from a SwiftUI button's `.action`.

### Test host detection

`applicationDidFinishLaunching` checks `ProcessInfo.processInfo.environment["XCTestBundlePath"]` and skips the full launch sequence when running as a unit-test host. This prevents the app from trying to open the real database during `xcodebuild test`.

### `@Observable` doesn't support `lazy` stored properties

Create sub-view-models eagerly in `init`. They should be fast (no async, no I/O) — defer subscriptions to `start()` / `.task { }`.

---

## No-goes

- Do not import `OrpheusTerminal` (Phase 2C).
- Do not touch `packages/OrpheusDesign/`, `packages/OrpheusCore/`, `packages/OrpheusTerminal/` — read-only from this target.
- Do not enable App Sandbox (Phase 7 distribution concern).
- Do not skip `DisciplineLintTests` — it's the gate.
- Do not reach for stock SwiftUI controls to dodge an OrpheusDesign gap. Raise the gap as a separate sub-phase.
