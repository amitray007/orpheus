# Phase 2B — Inputs to read before writing any code

All paths are relative to the Orpheus code repo root: `/Users/maverick/code/projects/orpheus/`.

## Primary sources of truth (LOCKED — treat as contract)

### `docs/specs/architecture.md` § 1 — Shell — AppKit + SwiftUI interop
**LOCKED.** The interop pattern: AppKit for window + toolbar + libghostty hosting; SwiftUI for declarative subviews via `NSHostingView`. Read this verbatim.

### `docs/specs/design-principles.md`
**LOCKED.** The 8 discipline rules. Phase 2B is the first phase where they're enforced on real product UI.

### `docs/wireframes/wireframes-v0.5.md` — W1, W2, W3, W18, W19
**LOCKED.** The exact surfaces to build:
- **W1:** Main window — Dashboard (empty, no projects)
- **W2:** Main window — Dashboard (with projects + activity)
- **W3:** Main window — empty space, session picker
- **W18:** Onboarding — first-run welcome
- **W19:** State patterns reference (empty / loading / error)

Read each one carefully — the ASCII layout PLUS the Elements and Interaction sections beneath. Don't skim.

### `docs/agent-briefs/v2b/tasks.md`
**LOCKED.** Concrete task breakdown. Anything in Phase 2 of `plan.md` that's relevant to app-shell + sidebar + dashboard but not in `tasks.md` is an oversight — raise it.

### `docs/agent-briefs/v2b/discipline.md`
**LOCKED.** Hard rules + common pitfalls.

## Reference — read for shape, mirror conventions

### `packages/OrpheusDesign/`
**The discipline source.** Every visible element in `apps/Orpheus/` uses an OrpheusDesign component or is built from OrpheusDesign tokens. Specifically:
- `OrpheusButton`, `OrpheusToggle`, `OrpheusTextField`, `OrpheusList`, `OrpheusRow`, `OrpheusMenu`, `OrpheusSplitView`, `OrpheusSpaceSwitcher`, `OrpheusSidebar`, `OrpheusCommandPalette`, `OrpheusQuickAction`, `OrpheusStatusBadge`, `OrpheusModal`, `OrpheusSheet`, `OrpheusToast` — read `Sources/OrpheusDesign/Components/` to know what's available.
- `OrpheusColor.*`, `OrpheusSpacing.*`, `OrpheusRadius.*`, `OrpheusMaterial.*`, `OrpheusTypography.*`, `OrpheusMotion.*` — the tokens you compose with.

**If a wireframe needs something OrpheusDesign doesn't provide**, raise it — don't reach for stock SwiftUI. The fix is to extend OrpheusDesign (separate sub-phase), not to re-introduce stock chrome.

### `packages/OrpheusCore/`
**The data + plumbing.** Phase 2B's app target imports it as a SwiftPM package dep. Specifically:
- `Database` — open on launch at `~/.orpheus/orpheus.db`. Path is overridable via `--orpheus-db-path <path>` command-line argument for development.
- `ProjectRepository`, `SpaceRepository`, `TerminalRepository`, `AppStateRepository`, `SessionsIndexRepository` — observe + write.
- `SettingsLoader`, `SettingsMerger`, `SettingsWatcher` — load global + project settings on launch and watch for changes.
- `SessionRegistry` — for the W3 empty-space session picker (`recent` + `sessions(forCWD:)`).
- `OrpheusSettings` — typed settings struct.
- `OrpheusCoreError` — typed errors thrown by the data layer.

### `packages/OrpheusCore/AGENTS.md`
**Read for conventions.** Mirror the discipline rules where applicable (errors are typed, comments default to none, etc.).

### `packages/OrpheusTerminal/`
**DO NOT IMPORT in Phase 2B.** Reading the README is fine for context. Phase 2C composes Terminal + Core in the app target.

## Read-only architectural reference

### `docs/specs/architecture.md` (full document)
Skim § 4 (Core), § 7 (Persistence), § 8 (Design system) for context. Don't depend on any deep details — those are encoded in the LOCKED briefs above.

### `docs/wireframes/wireframes-v0.5.md` — other wireframes
Skim only for awareness:
- **W4** — what space-active-with-terminal looks like (Phase 2C target).
- **W6, W7, W8, W17** — terminal layouts (Phase 2C / 2D).
- **W9** — command palette (Phase 4).
- **W10, W11** — new-project / new-space modals (Phase 2C; Phase 2B uses minimal stand-ins).
- **W14, W15, W16** — menubar dropdown (Phase 4).

You are not building any of these in 2B. Knowing they exist sharpens API design (e.g. the sidebar should remain stable when Phase 2C swaps the empty content pane for a terminal view).

## External references

### Apple HIG — macOS Sonoma+ window chrome
For the custom traffic-light positioning + hidden title bar + toolbar pattern. Use AppKit's `NSWindow.titlebarAppearsTransparent = true`, `NSWindow.titleVisibility = .hidden`, and a custom `NSToolbar` for the chrome. Search "macOS unified toolbar" + Apple's `NSWindowDelegate` docs.

### SwiftUI `@Observable` macro
Swift 5.9+. Use `@Observable` (the macro) on view models that wrap `OrpheusCore` actor observers. Convert each `AsyncStream<[Project]>` etc. into `@Published`-style properties via a setup task that consumes the stream and assigns to `@MainActor`-isolated properties.

## Not inputs for this phase

- Self-drive daemon (Phase 3).
- Voice pipeline (Phase 6).
- Logotype / icon catalog beyond what `OrpheusDesign.Icons` already exposes.
- Ghostty / libghostty C ABI — `OrpheusTerminal` hides it; you don't import it.
- The `orpheus` CLI binary — Phase 3.
