# Orpheus — Mac App Target

`apps/Orpheus/Orpheus.xcodeproj` is the first user-visible Mac application in the Orpheus project. It provides the main window chrome (sidebar + content pane), onboarding flow, and dashboard views without hosting any terminal — that arrives in Phase 2C.

## Building

```bash
# Debug build
cd apps/Orpheus
xcodebuild -project Orpheus.xcodeproj -scheme Orpheus -configuration Debug build \
    CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO

# Release build (zero warnings expected)
xcodebuild -project Orpheus.xcodeproj -scheme Orpheus -configuration Release build \
    CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO

# Run tests
xcodebuild test -project Orpheus.xcodeproj -scheme Orpheus \
    -destination 'platform=macOS' CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO
```

Or open `Orpheus.xcodeproj` in Xcode and use ⌘R / ⌘U.

## Project Generation

`project.yml` drives `xcodegen`. To regenerate after editing it:
```bash
cd apps/Orpheus && xcodegen generate
```

## Launch Decision Tree

On `applicationDidFinishLaunching`, the app reads from the OrpheusCore database:

1. If `projects` table is empty AND `app_state['onboarding_seen'] != "true"` → **Onboarding (W18)**
2. If `app_state['onboarding_seen'] == "true"` OR projects exist → **Dashboard (W1/W2)**
3. If the database fails to open → **Critical Error view** (no crash)

After the user creates a first project (via folder picker), `onboarding_seen` is set to `"true"` and the screen transitions to **EmptySpaceView (W3)**.

## Surfaces Implemented

| Screen | View | When shown |
|--------|------|------------|
| W1 | `DashboardView` (empty state) | Dashboard with no projects |
| W2 | `DashboardView` (populated) | Dashboard with projects |
| W3 | `EmptySpaceView` | Space selected, no active terminals |
| W18 | `OnboardingView` | True first launch |
| W19 | `EmptyState`, `LoadingSkeleton`, `ErrorToast`, `ErrorBanner`, `CriticalErrorView` | Various loading/error states |

## State Management

- `AppState` (`@Observable @MainActor`) — root container; owns repositories, session registry, sub-view-models, and `currentScreen: Screen`.
- `SidebarViewModel` — subscribes to `ProjectRepository.observeAll()`, lazily subscribes to `SpaceRepository.observeByProject()` and `TerminalRepository.observeBySpace()` per expanded project.
- `DashboardViewModel` — subscribes to project list + refreshes `SessionRegistry.recent(6)` every 30s and on `updates()` events.
- `OnboardingViewModel` — two-phase init (call `__wire()` after `AppState.init`); presents `NSOpenPanel` folder picker; creates Project + Default Space + marks `onboarding_seen`.

No Combine. No manual KVO. All observation is `AsyncStream` → `for await` loop → `@Observable` property assignment.

## Window Chrome

AppKit owns the window (`MainWindow: NSWindow`) with:
- `titlebarAppearsTransparent = true`, `titleVisibility = .hidden`
- Standard traffic lights (not repositioned — that's a private API trap)
- Custom `NSToolbar` with sidebar toggle, centered search placeholder, user menu — all via `NSHostingView<OrpheusButton>` items

SwiftUI `ContentView` is hosted in the window's `contentView` via `NSHostingView`.

## Debug Overrides

| Method | Example |
|--------|---------|
| CLI argument | `--orpheus-db-path /tmp/test.db` |
| Environment variable | `ORPHEUS_DB_PATH=/tmp/test.db` |

Both override the default `~/.orpheus/orpheus.db` path.

## Decisions Locked in Phase 2B

- **Initial sidebar selection:** `.dashboard` on launch (unless restoring from `app_state['last_selection']` — not yet implemented; Phase 2C).
- **Window geometry persistence:** written on `windowDidEndLiveResize` and `windowDidMove`. Not per-frame.
- **Folder picker UX (W18 / W1):** `NSOpenPanel` with `canChooseDirectories = true`, `canChooseFiles = false`, `allowsMultipleSelection = false`. Full W10 modal is Phase 2C.
- **Pinned projects ordering:** `created_at` ascending (oldest pinned first) within the Pinned section.
- **Project logo glyph:** `[g]` (git — detected by `.git` directory presence) vs `[~]` (non-git). No GitHub API fetch in Phase 2B.

## Phase Boundaries

- **Phase 2B (this phase):** app chrome, sidebar, W1/W2/W3/W18/W19. No terminals.
- **Phase 2C:** imports `OrpheusTerminal`, swaps `EmptySpaceView` placeholder for real terminal hosting, adds W10/W11 modals, wires `--resume`.
- **Phase 4:** real activity heatmap data, logo fetch, Sessions browser (W5), command palette (W9), quick actions (W4), settings (W12/W13).

## See Also

- `AGENTS.md` — discipline rules for contributors and AI agents working in this target.
- `docs/agent-briefs/v2b/` — the full Phase 2B brief.
- `packages/OrpheusDesign/` — design system (no stock SwiftUI controls allowed).
- `packages/OrpheusCore/` — data layer (repositories, settings, sessions).
