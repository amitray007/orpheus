# Phase 2B — Handoff: what to produce, where it goes, how to report done

## Artifacts

### 1. The Xcode project + app target
- Location: `apps/Orpheus/Orpheus.xcodeproj` and source under `apps/Orpheus/Orpheus/`.
- Structure per `tasks.md` Group 1.
- Committed to the orpheus code repo with one commit per logical chunk (per the "commit as you go" workflow established during Phases 0/1/2A) — at minimum:
  - Group 1 (scaffold)
  - Group 2 (lifecycle + DB open)
  - Group 3 (window + toolbar chrome)
  - Group 4 (sidebar)
  - Group 5 (dashboard W1/W2)
  - Group 6 (empty space W3)
  - Group 7 (onboarding W18 + state patterns W19)
  - Group 8 (tests + DisciplineLintTests + README + AGENTS)
  - Final review session-file commit

### 2. Working `.app`
- Buildable via `xcodebuild -project apps/Orpheus/Orpheus.xcodeproj -scheme Orpheus -configuration Debug build`.
- Launchable via `open apps/Orpheus/build/Build/Products/Debug/Orpheus.app` OR Xcode `Run`.
- True first launch shows W18 onboarding.
- Post-onboarding shows W1 (no projects) or W2 (projects exist).
- Adding a project via the folder picker creates a sidebar row + Default Space + lands user on W3 (empty space session picker).

### 3. Tests
- `apps/Orpheus/OrpheusAppTests/` per `tasks.md` Group 8 task 24-28.
- `apps/Orpheus/OrpheusAppTests/DisciplineLintTests.swift` per task 28.
- `xcodebuild test -project apps/Orpheus/Orpheus.xcodeproj -scheme Orpheus` runs all tests successfully.

### 4. Package README
- `apps/Orpheus/README.md` per `tasks.md` task 29.

### 5. Package AGENTS
- `apps/Orpheus/AGENTS.md` per `tasks.md` task 30.

## How to report done

When gate criteria are met, **create a session file** in the thoughts repo:

**Path:** `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-2b-app-shell-build.md`

**Naming:** `YYYY-MM-DD-HHMM-review-phase-2b-app-shell-build.md`. Use **IST timezone** for the date/time. `review` is the verb.

**Contents (template):**

```markdown
# Review — Phase 2B app shell build

**Date:** YYYY-MM-DD IST
**Verb:** review
**Context:** Phase 2B (`apps/Orpheus/` app target) build completed. Reporting against the brief at `docs/agent-briefs/v2b/`.

---

## Gate criteria check

- [x] / [ ] `apps/Orpheus/Orpheus.xcodeproj` builds with zero warnings in Release
- [x] / [ ] The `.app` launches
- [x] / [ ] True first launch renders W18 onboarding
- [x] / [ ] Second launch with no projects renders W1 (NOT onboarding)
- [x] / [ ] Adding a project via folder picker → appears in sidebar within ~250 ms
- [x] / [ ] Sidebar tree expand/collapse works
- [x] / [ ] Clicking a Space row navigates to W3 (empty space + session picker)
- [x] / [ ] Sidebar reactively updates on DB changes
- [x] / [ ] All chrome uses OrpheusDesign components — DisciplineLintTests passes
- [x] / [ ] Empty / loading / error visuals match W19 patterns
- [x] / [ ] No terminal hosting attempted; W3 picker buttons stub correctly

## Deliverables — what was produced

- **Xcode project location:** `apps/Orpheus/Orpheus.xcodeproj`
- **App bundle ID:** `com.orpheus.app`
- **Version / commit(s):** <list each commit's SHA + scope>

## Wireframes implemented

- **W1** (empty dashboard): <how it renders, any deltas>
- **W2** (populated dashboard): <heatmap stub, projects list, sessions list>
- **W3** (empty space session picker): <stubbed actions list>
- **W18** (onboarding first-run): <flow + transition>
- **W19** (state patterns): <which patterns are exercised + where>

## Modules implemented

- App lifecycle: <AppDelegate, OrpheusApp, AppState>
- State models: <each @Observable view model>
- Window chrome: <MainWindow, MainWindowController, ToolbarBuilder>
- Sidebar: <SidebarView, ProjectRow, SpaceRow>
- Dashboard: <DashboardView, ActivityHeatmapStub, ProjectsListPane, SessionsListPane>
- Empty space: <EmptySpaceView>
- Onboarding: <OnboardingView, OnboardingViewModel>
- State patterns: <EmptyState, LoadingSkeleton, ErrorToast, ErrorBanner>

## Decisions locked

- App target structure: Xcode project at apps/Orpheus/. <any deltas from brief>
- Initial sidebar selection: <choice>
- Window geometry persistence cadence: <choice>
- Folder picker UX in W18 / W1: <choice>
- Pinned projects ordering: <choice>
- Anything else lock-worthy: <list>

## Open items / TODOs stubbed

- W4 (chat viewer) — Phase 3.
- W5 (sessions browser) — Phase 4. Sidebar `[T] Sessions` row stubbed.
- W7, W8, W17 (terminal layouts) — Phase 2C / 2D.
- W9 (command palette) — Phase 4.
- W10, W11 (modals) — Phase 2C uses the brief's minimal NSOpenPanel; full fidelity in 2C.
- W12, W13 (settings) — Phase 4.
- W14, W15, W16 (menubar) — Phase 4.
- Activity heatmap real data — Phase 4.
- Logo auto-fetch — Phase 4 or later.
- Quick Actions footer — Phase 4.
- claude integration — Phase 2C.
- Voice HUD — Phase 6.
- Code signing for distribution — Phase 7.

## Discipline-rule violations (with justifications if any)

- <any cases where a rule had to bend; should be a short list or empty>

## Spec gaps encountered

- <any architectural details that weren't in the brief; what placeholder was used>

## External-reference issues

- <NSToolbar quirks, NSHostingView edge cases, @Observable + AsyncStream bridging gotchas, etc.>

## Suggestions for Phase 2C integration

- <what the swap from EmptySpaceView placeholder to real terminal hosting will look like>
- <what state the AppState should hold for the terminal layout per Space>
- <how SubprocessManager and OrpheusTerminal compose in the app target>
- <any awkward API surface worth revisiting>
```

### Commit message for the handoff session file

Write a `.commit-msg` at `/Users/maverick/code/projects/thoughts/projects/orpheus/.commit-msg` before reporting done:

```
[orpheus] review: Phase 2B app shell + sidebar build complete
```

### Update `docs/plan.md` Phase 2 status

Add a sub-phase status line near the top of the Phase 2 section in the **code repo**:

```markdown
**Phase 2B (app shell + sidebar) status as of YYYY-MM-DD:** ✅ DONE. See `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-2b-app-shell-build.md`.
```

(The full Phase 2 status doesn't flip until 2A + 2B + 2C are all done — leave the per-phase header alone.)

### Update `docs/queue.md`

Move Phase 2B from **Now** to **Done** with the date and commit references. Move Phase 2C from **Next** into **Now** if the user is ready to start it (otherwise leave Now empty and surface that in the handoff).

## If blocked

Most likely blockers for Phase 2B:

1. **OrpheusDesign component gap** — a wireframe needs a control OrpheusDesign doesn't provide (e.g. a tree-view component, a search field with suggestions, a hover-tooltip primitive). Don't reach for stock SwiftUI; raise the gap.
2. **AppKit + SwiftUI interop sharp edge** — e.g. `NSToolbar` items hosting SwiftUI fight the SwiftUI lifecycle in unexpected ways.
3. **`@Observable` + `AsyncStream` performance** — visible jank under realistic project counts.
4. **`xcodebuild` from CLI vs Xcode-only quirks** — the agent runs CLI; some Xcode features only resolve correctly inside the Xcode app.

For each blocker:

**Path:** `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/YYYY-MM-DD-HHMM-review-phase-2b-blocked-<short-reason>.md`

**Contents:**
- What you were trying to do.
- What's blocking (with concrete evidence).
- What you've ruled out.
- Proposed resolution(s) for user to choose from.
- What's safe to continue on in parallel.

User will create a follow-up session to unblock. **Do not merge or deploy a blocked build.**

## Do not

- Do not modify `docs/specs/*`, `docs/wireframes/*`, or any other LOCKED file.
- Do not reach for stock SwiftUI controls to sidestep an OrpheusDesign gap. Raise the gap instead.
- Do not import `OrpheusTerminal` in `apps/Orpheus/`.
- Do not touch `packages/OrpheusDesign/`, `packages/OrpheusCore/`, `packages/OrpheusTerminal/` (read-only).
- Do not skip the DisciplineLintTests target — it's the discipline-enforcement gate.
- Do not skip incremental commits.
- Do not enable App Sandbox.
- Do not invent wireframe surfaces beyond W1, W2, W3, W18, W19.
- Do not implement modals at full W10/W11 fidelity — minimal `NSOpenPanel` only.
