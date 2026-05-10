# Phase 2B — App shell + sidebar

**Role:** You are a build agent assembling the first user-visible Mac app target for Orpheus.
**Output:** an `Orpheus.xcodeproj` at `apps/Orpheus/`, a working main window with custom chrome (toolbar, sidebar, content pane), a Project ▸ Space ▸ Terminal sidebar tree fed by `OrpheusCore` observers, the dashboard / empty-space / onboarding surfaces (W1, W2, W3, W18), and the W19 reusable state-pattern utilities (empty / loading / error). **No terminal hosting yet — that's Phase 2C.**

**Scope in one sentence:** the app launches, you see a real Orpheus window with sidebar + main pane, you can create a project (which becomes a row in the sidebar), you can click a project + space and land on the empty-space session picker — but nothing actually spawns a terminal until 2C.

---

## Why this phase exists

Phase 2A proved we can render a libghostty terminal in a custom NSView. Phase 2B builds the **app around it** — without yet wiring up terminals. Splitting these makes the integration in 2C mostly mechanical (plug the proven terminal view into the proven chrome) rather than a death march of UI + FFI + persistence all at once.

Phase 2B is also the first phase where the **OrpheusDesign discipline** stops being theoretical and starts being load-bearing. Every visible element must use OrpheusDesign components (no `Button {}`, no `List {}`, no stock SwiftUI chrome). Phase 0 pre-built the components for exactly this moment.

Downstream consumers:
- Phase 2C swaps the empty content pane for `OrpheusTerminalView`, adds new-project / new-space modals (W10, W11), wires auto-restore.
- Phase 4 replaces Phase 2B's stubbed heatmap on W2 with real activity data.
- Phase 5+ extends the sidebar + toolbar with quick actions, voice HUD, etc.

---

## What "done" looks like

Gate criteria for Phase 2B specifically:

- [ ] `apps/Orpheus/Orpheus.xcodeproj` builds with **zero warnings** in Release configuration
- [ ] The built `.app` launches via `open apps/Orpheus/build/Build/Products/Debug/Orpheus.app` (or Xcode `Run`)
- [ ] On true first launch (empty `~/.orpheus/orpheus.db`), the W18 onboarding screen renders
- [ ] On second launch with no projects, the W1 empty dashboard renders (NOT onboarding — first-launch is one-shot)
- [ ] Adding a project (any local folder picked via `[+ Add repository]`) appears in the sidebar within ~250 ms
- [ ] The sidebar tree expands/collapses Project rows to show nested Spaces (chevron `>` / `v`)
- [ ] Clicking a Space row navigates to W3 (empty space + session picker)
- [ ] The sidebar reactively updates when `~/.orpheus/orpheus.db` changes (e.g. another instance writes — exercise via `swift run` editing the DB directly)
- [ ] All chrome uses OrpheusDesign components — `DisciplineLintTests` confirms no stock `Button` / `List` / `Toggle` / `TextField` etc. in `apps/Orpheus/`
- [ ] Empty / loading / error visuals match W19 patterns
- [ ] No terminal hosting attempted; the W3 session picker buttons are wired to a placeholder action that prints "Phase 2C will spawn a terminal here" via `OrpheusLogger`

The smoke artefact is the running `.app`. That's the human-verifiable gate.

---

## Reading order

Before doing anything, read in this order:

1. **`inputs.md`** (this folder) — exact read list with locked status.
2. **`docs/agent-briefs/v2b/tasks.md`** — task breakdown.
3. **`docs/agent-briefs/v2b/discipline.md`** — hard rules + pitfalls.
4. **`docs/agent-briefs/v2b/handoff.md`** — artifacts + reporting.
5. **`docs/specs/architecture.md` § 1 Shell** — the AppKit + SwiftUI interop pattern.
6. **`docs/specs/design-principles.md`** — the discipline rules (no stock SwiftUI controls).
7. **`docs/wireframes/wireframes-v0.5.md` W1, W2, W3, W18, W19** — the surfaces to build.

The brief is the contract.

---

## Locked decisions (do not propose alternatives)

These were resolved with the user before this brief was written.

- **App target:** Xcode project at `apps/Orpheus/Orpheus.xcodeproj`. Local SwiftPM packages (`OrpheusDesign`, `OrpheusCore`, `OrpheusTerminal`) added as dependencies via Xcode's "Add Package Dependency → Add Local…". Standard Mac app target, signed-development for now (signing for distribution is Phase 7).
- **Activity heatmap on W2:** stubbed. Render a static 5×7 grid of placeholder cells matching the wireframe shape. The data shape + GitHub integration + period toggles land in Phase 4. Phase 2B's stub is opaque to Phase 4 — no need to reuse the stub renderer.
- **Project logos:** generic glyphs only (`[g]` for git-detected projects, `[~]` for non-git). No GitHub API fetch, no logo caching, no avatar parsing in 2B.
- **Default Space + seeded Claude session (per W18 step 2):** create the Default Space row in the database, but DO NOT spawn a terminal — Phase 2B has no terminal hosting. The Default Space lands the user on W3 (empty space, session picker) where the picker buttons stub out the actual spawn.
- **Onboarding behaviour:** show only on **true first launch** (database file doesn't exist OR `projects` table empty AND `app_state['onboarding_seen'] != "true"`). Subsequent launches with no projects show W1 (empty dashboard), NOT onboarding. After the user creates a first project OR clicks past the onboarding, set `app_state['onboarding_seen'] = "true"`.
- **AppKit + SwiftUI interop:** AppKit owns the window + toolbar (custom traffic-light positioning is easier in AppKit). SwiftUI owns sidebar contents and main-pane content via `NSHostingView`. Per architecture.md §1.
- **State management:** SwiftUI `@Observable` (Swift 5.9+) wrappers around `OrpheusCore` actor observers. Each repository's `observeAll()` / `observeBy*()` `AsyncStream` feeds an `@Observable` view-model. No Combine, no GRDB-direct-from-views.
- **No `OrpheusTerminal` import.** Phase 2B does not import `OrpheusTerminal` at all. The empty-space picker stubs the spawn action; Phase 2C wires it up.
- **Deployment target: macOS 14+** (matches all prior phases).

---

## Non-goals for Phase 2B

- **No terminal hosting.** The content pane shows W1/W2/W3 dashboards; never an actual terminal. Phase 2C.
- **No new-project modal (W10) wireframe-fidelity yet.** A minimal "pick a folder" modal is acceptable in 2B — full W10 fidelity (recent folders, git detection summary, etc.) lands in 2C.
- **No new-space modal (W11) yet.** Phase 2C.
- **No splits, canvas, drag UX.** Phase 2C / 2D.
- **No real heatmap data.** Stub only.
- **No logo fetch.** Generic glyphs only.
- **No quick actions footer (W4 element).** Phase 4.
- **No command palette (W9).** Phase 4.
- **No menubar dropdown (W14, W15, W16).** Phase 4.
- **No settings windows (W12, W13).** Phase 4.
- **No sessions browser (W5).** Phase 4. (`[T] Sessions` sidebar entry is present but the destination view is a stubbed placeholder.)
- **No voice HUD.** Phase 6.
- **No code signing for distribution.** Development signing only.
- **No `claude` integration.** No `--resume`, no `--bare`, no spawn calls.

---

## Companion phases

- **Phase 0 (`OrpheusDesign`) — DONE.** This is where Phase 2B's discipline is enforced. Every chrome element uses an OrpheusDesign component or is built from `OrpheusColor` / `OrpheusSpacing` / `OrpheusRadius` / `OrpheusMaterial` tokens.
- **Phase 1 (`OrpheusCore`) — DONE.** Phase 2B opens `Database` on launch, subscribes to repositories, reads/writes `OrpheusSettings`, and reads from `SessionRegistry`. The integration is one-way: views observe; user actions write; observers re-emit.
- **Phase 2A (`OrpheusTerminal`) — DONE.** Not imported by 2B. Phase 2C will compose 2A + 2B.

---

## When to stop and ask

Phase 2B has more "is this the right shape?" decisions than 2A. If during implementation you discover that:

- The `@Observable` + `AsyncStream` bridge produces visible jank under realistic project counts (>50 projects),
- The custom traffic-light positioning fights AppKit's built-in toolbar in ways that break window controls,
- The sidebar tree's expand/collapse animation can't be implemented without re-introducing stock SwiftUI `DisclosureGroup`,
- Loading the database synchronously on launch produces a user-visible blank window (>500 ms),

stop and report `DONE_WITH_CONCERNS` with the specific finding. Don't silently re-introduce stock SwiftUI chrome to dodge a bug — that violates the locked design discipline.

The fallback for the design-discipline issues is to design + implement the missing OrpheusDesign primitive (in Phase 0's `OrpheusDesign` package) before continuing here. That's a sub-phase, not an inline workaround.
