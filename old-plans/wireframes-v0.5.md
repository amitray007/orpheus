# Orpheus — Wireframes v0.5

**Scope:** Phase 0.5 wireframes — all main-window states, overlays, and major views for v0. This file is the **living canonical source** for the v0.5 iteration. Future phases get their own versioned file (`wireframes-v0.6.md`, etc.).

**Convention:**

- One file per version (this file = v0.5).
- Wireframes iterate in place within this file; `## Iteration history` logs what changed per iteration.
- Each wireframe carries a `Status:` line: `draft` · `🔄 in review` · `✅ locked`.
- Locked wireframes stop iterating unless explicitly reopened (and the reopen is logged).

**ASCII convention:**

- Box-drawing only for borders (`┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ─ │ ╭ ╮ ╰ ╯`). Single-width, reliable.
- Pure ASCII inside cells. Stand-ins:
  - `[o o o]` = traffic-light window controls
  - `[<|]` = sidebar toggle
  - `[D]` / `[T]` / `[+]` = sidebar nav icons (Dashboard / Sessions / New)
  - `[g]` = project logo sourced from GitHub avatar (auto)
  - `[i]` = project logo from user-uploaded image
  - `[~]` = project logo from generated identicon (default fallback)
  - `*` = active steady (terminal running, session live-but-idle)
  - `/` `-` `\` `|` = spinner animation frames (Claude mid-response; cycles live in UI)
  - `o` = dormant / idle (session exists but not active)
  - `.` = inactive (no terminals) / heatmap empty cell
  - `#` = heavy activity (heatmap — darkest cell)
  - `@` = max-intensity heatmap cell
  - `v` / `>` = expand / collapse chevron
  - `+-` = toggle icon (`±`)
  - `|=|` = split icon
  - `x` = close icon
  - `└` = tree-branch line (single-width box-drawing)
- **Column widths:** `sidebar = 28`, `main = 71`, `total = 102`. Pipes at columns 1, 30, 102. Every row padded to exactly 102 chars (verified via automation). Overlay wireframes (dropdowns/modals) declare their own width.

**Design tokens reference:** `docs/specs/design-principles.md` (LOCKED v0 starter values).

**Product principles baked into these wireframes:**

- **Unrestricted multi-session.** A space holds **any number** of Claude sessions, shells, splits, or forks. UI never forces "one of X" at creation or operation time.
- **Flow-first creation.** Single-click to working state for common paths (`[+]` spawns a Claude session directly; alternate gestures handle other types).
- **Gated creation modals.** Project- and space-creation modals are visible by default but gated by general settings (`show_project_creation_modal`, `show_space_creation_modal`). When disabled, the flow skips to folder-picker-and-defaults (project) or auto-named-with-defaults (space); settings are editable later via right-click → settings.

---

## Iteration history

### 2026-04-19 — 🎉 full v0.5 lockdown: W26 approved → Phase 0.5 wireframes complete

- W26 (Compact Voice HUD) approved → ✅ locked.
- **All 22 active v0 wireframes now ✅ locked.** 4 wireframes archived for post-v0. Phase 0.5 wireframes are **complete**.
- Next: behavior specs for locked wireframes, or Phase 1 kickoff prep.

### 2026-04-19 — W21 collapsible files panel approved → locked

- W21 approved after the iteration 13 collapsible-files update → ✅ locked.
- Only W26 (Compact Voice HUD) remains 🔄 in review.

### 2026-04-19 — iteration 13 (W20 locked as Full HUD; W26 Compact HUD added as default; W21 files panel made collapsible)

- **W20** approved by user → ✅ locked. Renamed **Voice HUD — Full (hovering overlay)** to distinguish from the compact variant.
- **W26** added — **Voice HUD — Compact (toolbar chip, default state)**. Lives in the toolbar between `Search` and `[User v]`, styled like macOS's screen-recording chip: `[ * 0:05  | | | | ]`. Shows red rec indicator + elapsed time + mini waveform. **Default voice surface** — speaking to Claude doesn't take over the screen. Click chip → expands to full hovering HUD (W20).
- **W21** updated — **files panel narrowed (~23 chars, basename-only) + collapse toggle `[<<]` in panel header**. Collapsed state (shown as a secondary mini-ASCII in the wireframe) gives the diff body the full main-area width for dense code review. Priority: diff content gets the horizontal space.

### 2026-04-19 — iteration 12 (W20 composite + W21 diffs.com rework; W22-W25 archived to post-v0)

- **W20** redrafted — now shown as a **complete desktop UI** with the Voice HUD floating as an overlay over the main window (not standalone 80-char snippet). User can see how the HUD sits within the app visually. Still 🔄 in review.
- **W21** redrafted — now **diffs.com-style** multi-file viewer. Left panel: changed-files list with per-file stats + Prev/Next; right panel: diff body. **Unified / Split mode toggle** in the header (`[*Unified*]  [ Split ]`). Still 🔄 in review.
- **W22, W23, W24, W25 → 📦 archived** to post-v0. Wireframes kept in the file (design preserved) but status marks them as deferred. Corresponding entries added to `docs/future-scope.md` under new "Post-launch feature wireframes" section. Rationale: focus v0 on the base + a few core features; extensions browser, Git surfaces, automations, and ideas inbox are valuable but not blocking for launch.

### 2026-04-19 — iteration 11 (final batch: 6 specialized surfaces)

- **W20** — Voice HUD. 80-char floating overlay during voice interaction. Shows mic state, live waveform, streaming transcript, Stop button, PTT hint. Three states (Listening / Speaking / Interrupt) documented in Elements.
- **W21** — Diff viewer. Main-area view that opens when a Claude-proposed file edit is clicked. Unified `@@` hunk format (fits in 71-char main area better than side-by-side). Accept / Reject / Open in editor / Accept + /compact actions.
- **W22** — Extensions browser (MCP / Skills / KB). Main-area view with three tabs (`[*MCP*]` selected default) + list/detail split. Lists installed items with version + on/off toggle; detail pane shows scope (global/per-project), tools exposed, and manage buttons.
- **W23** — Git surfaces. Main-area view with four tabs (`[*PRs*]` default, Issues, Actions, Branches) + list/detail split. List shows PR number + title + author + time + status; detail pane shows diff stats, checks, and action buttons (Review, Ask Claude, Check out, Open in browser).
- **W24** — Automations. Main-area view with three tabs (`[*Rules*]` default, Schedule, Running) + list/detail split. Rules list shows on/off toggle + name + action summary; detail pane shows trigger condition, actions, run history, manage buttons.
- **W25** — Ideas Inbox. Main-area view with a top capture input (`⌘Shift+I`) + list/detail split. Two sections in the list: Unsorted (captured ideas) and Scaffolded (those promoted to projects). Detail pane shows body + `[ Scaffold into project ]` or `[ Add to existing project ]`.

All 6 in review pending user pass. With this batch, every surface originally slated for Phase 0.5 is drafted.

### 2026-04-19 — W17 canvas-mode rework approved → locked

- W17 approved after iteration 10 rework → ✅ locked.
- All 19 drafted wireframes now locked. 6 specialized surfaces remain undrafted (voice HUD, diff viewer, MCP/Skills/KB, Git surfaces, automations, ideas-inbox).

### 2026-04-19 — iteration 10 (W18/W19 lock + W17 canvas-mode rework)

- **W18** (Onboarding) and **W19** (State patterns) approved as-is → locked.
- **W17 (Canvas mode) reworked** per feedback:
  - Top **two bars merged into one** — no tab strip in canvas mode (tiles are the canvas; tabs would be redundant).
  - **Removed** the split icon `[|=|]` from canvas header (splits belong to list mode).
  - **Removed** top-level close `[x]` — each tile has its own close; space-level close handled at sidebar (right-click → Archive/Delete).
  - **Added** `[ Exit canvas ]` button in the merged bar (alongside `[+ Claude]` and `[+ Term]`). Clicking it returns the space to list mode.
  - **Quick Actions footer** noted as **type-aware per focused tile** — Claude tile focused → Claude actions; shell tile focused → shell actions. Applies in all layout modes (not canvas-only); captured in Elements for future quick-actions spec extension.
- **Notifications** added to future-scope (macOS native notification surface for long-running Claude turns, dev-server errors, automation triggers, etc.).

### 2026-04-19 — iteration 9 (state surfaces batch: W17 Canvas + W18 Onboarding + W19 State patterns)

- Added **Wireframe 17** — Canvas mode. Alternate space layout where terminals render as free-arranged tiles within the main area instead of the default chat-viewer + tab-strip layout. Row B shows `(canvas)` tag; tiles have mini-headers with status glyph + title + `[x]` close. Switchable via `View → Layout` or `⌘Shift+C`.
- Added **Wireframe 18** — Onboarding (first-run). Shown when Orpheus launches with zero projects. Centered 3-step welcome — add repo → Default Space with Claude session seeded → start chatting. Two CTAs: `[  + Add repository  ]` (→ W10 or folder picker) and `[  Open folder...  ]`. Distinct from W1 (empty Dashboard) by having explicit onboarding messaging.
- Added **Wireframe 19** — State patterns reference. Single document showing four reusable patterns: empty state (full-panel centered message + CTA), loading skeleton (shimmer blocks), error toast (transient top-right with Retry/Details), error banner (persistent top-of-surface with action buttons). Not a single "state" but a set of conventions to apply across the app.

### 2026-04-19 — lockdown: W14/W15/W16 approved — all 16 wireframes locked

- Menubar tab trio (Now / Projects / Sessions) reviewed after iteration 8 rework → all three locked.
- **All 16 v0.5 wireframes now ✅ locked.** Set is frozen; reopens must be explicitly logged.

### 2026-04-19 — iteration 8 (W12/W13 lock + W13 Delete-Project addition + W14 menubar reworked into 3 tabs)

- **W12 Settings (Global)** approved and **locked** — category content to be planned in detail later.
- **W13 Project Settings** — added a **Danger zone** section containing `[ Archive project ]` and a new `[ Delete project ]` button. Delete is permanent + destructive (SQLite record removal; does not touch repo on disk). Locked after the addition.
- **W14 Menubar dropdown reworked into 3 tabs:** `Now` (default — Active spaces + Quick + Usage), `Projects` (pinned + project list + Add repository), `Sessions` (flat recent-session list). Selected tab shown as `[*Label*]`, unselected as `[ Label ]` (same width to prevent layout shift). Header (Orpheus + live usage counter) and Quit row are **constant across tabs**. Added **W15** (Projects tab) and **W16** (Sessions tab). W14 title updated to `Menubar dropdown — Now tab (default)`.
- W14, W15, W16 remain 🔄 in review pending your pass.

### 2026-04-19 — iteration 7 (next batch: Settings + Project Settings + Menubar)

- Added **Wireframe 12** — Settings window (Global). 88-char separate macOS window (not an overlay). Left sidebar lists categories (General selected); right pane shows General content including the two creation-modal toggles from iteration 5, startup behavior, tab-strip preferences (from iteration 6), usage indicator, sidebar density.
- Added **Wireframe 13** — Project Settings window. Same 88-char shell, scoped to a single project (`Project Settings — <name>`). Categories: General, Spaces, Quick Actions, MCP / Skills, Git. General pane: name, repo path, logo source (mirrors W10 modal), default shell, pin-to-sidebar toggle, Archive project button.
- Added **Wireframe 14** — Menubar dropdown. 64-char popover from the macOS menu bar icon. Sections: Active now (live terminals), Recent sessions, Quick (new session / show / settings), Usage today, Quit. Live-updating; works when main window is hidden.

### 2026-04-19 — full v0.5 lockdown: all 11 wireframes ✅ locked

- W4, W6, W7, W8 (reopened in iteration 6) approved after the tab-strip rework → locked.
- W9 (command palette) approved on first review → locked.
- **All 11 wireframes ✅ locked.** v0.5 wireframe set is frozen; reopens must be explicitly logged going forward.

### 2026-04-19 — iteration 6 (tab-strip rework: separate Claude/Term buttons, session-title tab labels, toggle removed) — W4/W6/W7/W8 reopened

- **Problem (user feedback):** the tab strip had "weird buttons that just switch or create specific things." Specifically: `[+- Terminal]` / `[+- Chat]` 2-state toggle felt rigid; `[+]` flow-first-direct-Claude was hidden behind gestures; tab labels like `[ /claude ]` / `[ shell ]` were type-prefixed rather than content-driven.
- **Fixed:** Row A now has **two explicit create buttons on the right:** `[ + Claude ]` (primary — the tool is built for Claude Code; first-class surface) and `[ + Term ]` (secondary — shell/terminal). Tabs show **truncated session titles** (`[ CPU opt ]`, `[ fork ]`, `[ zsh ]`) instead of type prefixes. The `[+- Terminal]` / `[+- Chat]` toggle is **removed** from the tab strip.
- **Raw terminal view** (W6 state) is still reachable, but via keyboard (`⌘` + `` ` ``) or right-click → "Show raw terminal," not a persistent toggle button. W6 Row B now shows a `(raw view)` tag on the session-title row to mark the state.
- **Under the hood:** shells and Claude sessions are both just terminals running different commands (`zsh` vs `claude`). The distinct **create buttons** exist because the common-case creation intent differs (Claude is the priority for this app).
- **Reopened:** W4, W6, W7, W8 (affected by Row A rework). Statuses moved to 🔄 reopened pending re-approval.

### 2026-04-19 — iteration 5 (W10/W11 polish + core flexibility principle + full v0 lockdown)

- **W10** — renamed "Main" → "Default Space" in the First-space checkbox text.
- **W10 + W11** — both modals **gated by general settings** (`show_project_creation_modal`, `show_space_creation_modal`; both default `true`). When disabled, creation flows skip straight to sensible defaults (folder picker + auto-detect for project; auto-named space with default seed).
- **W11** — removed the "Initial terminals" radio (picking one of Claude/shell/empty was too restrictive). Replaced with **"Seed terminals" multi-select checkboxes** — seed with any combination or leave empty; further terminals added freely after creation.
- **Core flexibility principle captured** — Orpheus never restricts users to "one Claude session" or "one terminal" per space. UI and language reflect this (no "one of X" radios, no fixed-type rigidity). Documented in the file header.
- **Locked:** W10, W11. All 11 v0 wireframes now ✅ locked.
- **Open question flagged for next pass:** user noted "weird buttons which just let us switch or create specific things" — which specific affordances to rework is still TBD (see Open design decisions).

### 2026-04-19 — lockdown: W1–W8 approved

- W1 (Dashboard empty) was locked after iteration 3; remains locked.
- W2–W5 (iteration 3 final set: Dashboard populated, session picker, chat viewer, Sessions browser) → **locked**.
- W6–W8 (iteration 4 main-window set: terminal view, split H, split V) → **locked**.
- W9–W11 (iteration 4 overlays: command palette, new-project modal, new-space modal) **remain in review** pending further pass.

### 2026-04-19 — iteration 4 (terminal view, split terminals H/V, command palette, new-project/new-space modals)

- Added **Wireframe 6** — space active, terminal view (toggle from chat viewer via `[ +- Terminal ]`). Raw terminal emulation; same chrome + footer as Wireframe 4.
- Added **Wireframe 7** — split terminals horizontal (top/bottom panes). `═══` divider between panes; each pane has its own mini-header; Quick Actions target focused pane.
- Added **Wireframe 8** — split terminals vertical (side-by-side panes, 35 chars each). `║` column divider + `╬` intersection on Row B divider. Two pane headers share Row B.
- Added **Wireframe 9** — command palette (⌘K). 80-char overlay with fuzzy filter + type prefixes (`a:` / `p:` / `s:` / `q:`) across Actions, Projects, Sessions, Quick Actions groups.
- Added **Wireframe 10** — new-project modal. 72-char overlay: repo path + Browse, project name, logo source (GitHub / custom / identicon), optional first-space seed.
- Added **Wireframe 11** — new-space modal. 72-char overlay: space name, working directory (inherit / worktree-experimental), initial terminal seed.

### 2026-04-18 — iteration 3 (30d-only heatmap, cleaner project rows, split projects/sessions dashboard)

- Removed 7d period toggle; heatmap is always **last 30 days** (static label, no selector).
- Dashboard project-card grid **removed**. Replaced with a **split layout** below the heatmap: `Projects` list on the left, `Sessions (all)` list on the right.
- Sidebar project rows consolidated to **single-row format**: `[logo] <name>  (count)  <chevron>`. Chevron = `v` (expanded) / `>` (collapsed). Removed the previously-redundant second row that repeated the project name.
- Expanded project shows its spaces indented directly beneath without an extra header row.

### 2026-04-18 — iteration 2 (dashboard, logos, flow-first session creation, quick actions)

- Renamed `Workspaces` → `Dashboard` (top nav + main landing view).
- Dashboard showed GitHub + Claude Code activity heatmaps (period selector) plus recent sessions and project cards.
- Project logos added (`[g]` GitHub avatar / `[i]` custom upload / `[~]` generated identicon).
- Sidebar space activity indicator extended: spinner frames for Claude-mid-response, `*`/`o`/`.` for other states.
- Pinned section moved above Projects when ≥1 pinned; hidden entirely when empty.
- Flow-first session creation: `[+]` = direct new-Claude (no dropdown). `⌘T`/`⌘R` for shell/resume.
- Quick Actions footer added at bottom of main, adjacent to sidebar's `[+] Add repository`.
- Sessions browser redesigned with split-view preview.

### 2026-04-18 — iteration 1 (initial Superset-inspired structure)

- Adopted Superset's two-row tab strip.
- Adopted Superset's sidebar structure (top nav + project tree + Add repository at bottom).
- Chat viewer elevated to primary main-area surface.
- Tabs = UI switcher, not hierarchy entity.
- Noise cuts: back/forward/history, `[Open v]`, `^1` indicator, inline `+`, tool-use count, filter dropdowns.

---

## Wireframes index

| #   | Name                                                           | Status                |
| --- | -------------------------------------------------------------- | --------------------- |
| 1   | Main window — Dashboard (empty — no projects)                  | ✅ locked             |
| 2   | Main window — Dashboard (with projects + activity)             | ✅ locked             |
| 3   | Main window — empty space, session picker                      | ✅ locked             |
| 4   | Main window — space active, chat viewer + Quick Actions footer | ✅ locked             |
| 5   | Sessions browser (cross-project split view with preview)       | ✅ locked             |
| 6   | Main window — space active, terminal view                      | ✅ locked             |
| 7   | Main window — split terminals (horizontal)                     | ✅ locked             |
| 8   | Main window — split terminals (vertical)                       | ✅ locked             |
| 9   | Command palette (⌘K)                                           | ✅ locked             |
| 10  | New-project modal                                              | ✅ locked             |
| 11  | New-space modal                                                | ✅ locked             |
| 12  | Settings window — Global                                       | ✅ locked             |
| 13  | Project Settings window                                        | ✅ locked             |
| 14  | Menubar dropdown — Now tab (default)                           | ✅ locked             |
| 15  | Menubar dropdown — Projects tab                                | ✅ locked             |
| 16  | Menubar dropdown — Sessions tab                                | ✅ locked             |
| 17  | Main window — canvas mode                                      | ✅ locked             |
| 18  | Onboarding — first-run welcome                                 | ✅ locked             |
| 19  | State patterns reference (empty / loading / error)             | ✅ locked             |
| 20  | Voice HUD — Full (hovering overlay, expanded)                  | ✅ locked             |
| 21  | Diff viewer (diffs.com-style, collapsible files)               | ✅ locked             |
| 22  | Extensions browser (MCP / Skills / KB)                         | 📦 archived (post-v0) |
| 23  | Git surfaces (PRs / Issues / Actions / Branches)               | 📦 archived (post-v0) |
| 24  | Automations (Rules / Schedule / Running)                       | 📦 archived (post-v0) |
| 25  | Ideas Inbox (capture + scaffold)                               | 📦 archived (post-v0) |
| 26  | Voice HUD — Compact (toolbar chip, default)                    | ✅ locked             |

All Phase 0.5 surfaces now drafted. (Anything not yet listed that surfaces later goes into a new versioned file `wireframes-v0.6.md`.)

---

## Wireframe 1: Main window — Dashboard (empty — no projects)

**Status:** ✅ locked · 2026-04-18 (iteration 3)
**State conditions:** fresh install, no projects added yet.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   Dashboard                                                           │
│  [T]  Sessions             │                                                                       │
│  [+]  New Space      Cmd+N │                                                                       │
│                            │                                                                       │
│  -- Projects --            │             Welcome to Orpheus                                        │
│                            │                                                                       │
│     (none yet)             │             Create or open a project to start.                        │
│                            │                                                                       │
│                            │             [  + New project  ]    [  Open folder...  ]               │
│                            │                                                                       │
│                            │             Cmd+N for a new space                                     │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Toolbar:** traffic lights · sidebar toggle · centered search · user menu.
- **Sidebar top nav:** `[D] Dashboard` (selected), `[T] Sessions`, `[+] New Space`.
- **Sidebar Pinned section:** hidden (no pinned projects).
- **Sidebar Projects section:** placeholder `(none yet)`.
- **Bottom:** `[+] Add repository`. Quick Actions footer absent (no active terminal).
- **Main area:** centered welcome block with two CTAs and a keyboard hint.

---

## Wireframe 2: Main window — Dashboard (with projects + activity)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 3)
**State conditions:** user has one or more projects. Canonical Dashboard view.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   Dashboard                                         [  + Project  ]   │
│  [T]  Sessions             │                                                                       │
│  [+]  New Space      Cmd+N │   Activity (last 30 days)                                             │
│                            │                                                                       │
│  -- Pinned --              │   Claude Code                    GitHub                               │
│  [g] thoughts       (3) v  │   . . o o # # .                  . . . # # . o                        │
│      /  My Space           │   o # # o # . .                  o . # . # . .                        │
│      o  brainstorm-ide..   │   . o . o . o o                  . . . . o # .                        │
│      +  New space          │   # . . . o . .                  . # . . . . .                        │
│                            │   . o . # . . .                  . . . . . . .                        │
│  -- Projects --            │                                                                       │
│  [g] scaleup-studio (1) >  │   Projects                       Sessions (all)                       │
│  [g] portfolio      (0) >  │   [g] scaleup-studio   (1)       o  Identify CPU..       4m           │
│  [~] pare           (2) >  │   [g] portfolio        (0)       o  brainstorm-ide..     2h           │
│                            │   [g] thoughts         (3)       o  migrate-valorant.    1d           │
│                            │   [~] pare             (2)       o  phase-1-harbor       3d           │
│                            │                                  o  valorant-catalog     5d           │
│                            │                                  o  auth-rewrite-draft   1w           │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Sidebar Pinned** at top (thoughts is pinned; expanded with `v`). Nested spaces shown indented beneath. If no pinned projects, this section is hidden entirely.
- **Sidebar Projects list** — single-row per project: `[logo] <name>  (count)  <chevron>`. Collapsed shows `>`; expanded shows `v` and reveals nested spaces.
- **Main area Dashboard header:** title + `[ + Project ]` primary action.
- **Activity heatmap section:** title `Activity (last 30 days)` — static, no period toggle. Two heatmaps side-by-side: `Claude Code` (left) and `GitHub` (right). Each heatmap is a 5×7 grid of intensity cells (`.`, `o`, `#`, `@`) = rough 5 weeks × 7 days.
- **Split body below heatmap:**
  - **Left list — `Projects`:** all projects with logo + name + count (clickable → opens project).
  - **Right list — `Sessions (all)`:** cross-project recent sessions; `status-dot + truncated-title + time`. Clickable → resumes.

### Interaction

- Click project row (sidebar or main-area list) → opens project in its last-active space (Wireframe 4) OR session picker if no active terminals (Wireframe 3).
- Click `[ + Project ]` or `[+] Add repository` → new-project modal.
- Click session row → resumes directly.
- Click sidebar project chevron `>` → expands to show nested spaces (`v`) and vice versa.

---

## Wireframe 3: Main window — empty space, session picker

**Status:** ✅ locked · 2026-04-19 (approved after iteration 3)
**State conditions:** space is active but has no running terminals. Primary "start working" surface.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   [ + ]                                               [ +- Terminal ] │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │   My Space                                                            │
│                            │   ──────────────────────────────────────────────────────────────────  │
│  -- Pinned --              │                                                                       │
│  [g] thoughts       (3) v  │     Start a Claude session in this space                              │
│      *  My Space           │                                                                       │
│         no active terminals│     ┌───────────────────────────────────────────────────────────┐     │
│      o  brainstorm-ide..   │     │  +  New Claude session                         Cmd+Enter  │     │
│      +  New space          │     │     Fresh context in ~/code/projects/thoughts             │     │
│                            │     └───────────────────────────────────────────────────────────┘     │
│  -- Projects --            │                                                                       │
│  [g] scaleup-studio (1) >  │     Or resume a recent session in this project                        │
│  [g] portfolio      (0) >  │                                                                       │
│  [~] pare           (2) >  │     ┌───────────────────────────────────────────────────────────┐     │
│                            │     │  *  Identify CPU perf optimization..   4m   120k [Resume] │     │
│                            │     ├───────────────────────────────────────────────────────────┤     │
│                            │     │  o  brainstorm-ide-reframe             2h   48k  [Resume] │     │
│                            │     ├───────────────────────────────────────────────────────────┤     │
│                            │     │  o  migrate-valorant-companion         1d   12k  [Resume] │     │
│                            │     └───────────────────────────────────────────────────────────┘     │
│                            │                                                                       │
│                            │     [ View all sessions ]                                             │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Sidebar Pinned section at top** (thoughts pinned, expanded showing nested spaces; active space `*  My Space` with secondary "no active terminals" label).
- **Sidebar Projects section below Pinned**, collapsed project rows with `>` chevron.
- **Main area picker** unchanged from iteration 2.
- **No Quick Actions footer** (no active terminal yet).

### Interaction

- Click `New Claude session` (or `⌘Enter`) → spawns new Claude terminal in current space. Transitions to Wireframe 4.
- Click any `[Resume]` → resumes via `claude --resume <id>`. Transitions to Wireframe 4 with resumed session.
- `⌘T` = open plain shell (no picker).
- `⌘R` = open full resume picker (modal).

---

## Wireframe 4: Main window — space active, chat viewer + Quick Actions footer

**Status:** ✅ locked · 2026-04-19 (approved after iteration 6 rework)
**State conditions:** most common daily state. Space has ≥1 active terminal running `claude`. Chat viewer is primary. Quick Actions footer appears at bottom.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   [ CPU opt ]  [ zsh ]                  [ + Claude ]  [ + Term ]      │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │   /  Identify CPU perf optimization opportunities    [ |=| ]  [ x ]   │
│                            │   ──────────────────────────────────────────────────────────────────  │
│  -- Pinned --              │                                                                       │
│  [g] thoughts       (3) v  │    > Let's continue with Phase v0.5 wireframing                       │
│      /  My Space           │                                                                       │
│      o  brainstorm-ide..   │    Recalled 1 memory                                                  │
│      +  New space          │                                                                       │
│                            │    *  Explore (Find CPU hotspots in Pare)                             │
│  -- Projects --            │       └ Done (55 tool uses . 120k tokens . 4m 1s)                     │
│  [g] scaleup-studio (1) >  │                                                                       │
│  [g] portfolio      (0) >  │    Let me verify against current code before presenting...            │
│  [~] pare           (2) >  │                                                                       │
│                            │    Read 3 files                                                       │
│                            │       └ Loaded optimizers/CLAUDE.md                                   │
│                            │                                                                       │
│                            │    Here's what I found.                                               │
│                            │    1. PNG oxipng level -- optimizers/png.py:45-52                     │
│                            │    2. TIFF sequential compression -- optimizers/tiff.py:64-71         │
│                            │                                                                       │
│                            │    * Worked for 5m 41s                                                │
│                            │                                                                       │
│                            │    > _                                                                │
│  [+]  Add repository       │   [ /fork ]  [ /compact ]  [ /resume ]  [ ... ]       42k / $0.34     │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Tab strip Row A — tabs (left):** truncated session titles (`[ CPU opt ]`, `[ zsh ]`). **No type prefix** on the label; tab content type is inferred from the terminal's running command (`claude` vs shell). Multiple Claude sessions, shells, forks coexist freely — no "one of X" restriction.
- **Tab strip Row A — create buttons (right):** two explicit buttons — **`[ + Claude ]`** (primary; accent color in real UI; this app's priority action) and **`[ + Term ]`** (secondary; plain shell). Claude has first-class visual weight because Orpheus is built for Claude Code. No overloaded `[+]` gesture button; no view toggle.
- **Tab strip Row B:** `/` spinner + session title + `[|=|]` split + `[x]` close.
- **Sidebar Pinned** at top with expanded project tree; active space `/  My Space` showing spinner for mid-response Claude.
- **Sidebar Projects** below Pinned with single-row format (logo + name + count + chevron).
- **Main area chat viewer** — primary Claude-focused surface; collapsed tool-use summaries, inline file links, per-turn timing, cursor prompt. For shell tabs, the chat viewer falls back to a raw terminal rendering automatically (same as Wireframe 6).
- **Raw terminal view** (for Claude tabs) accessed via `⌘` + `` ` `` (backtick) or right-click tab → "Show raw terminal" (see Wireframe 6). No persistent toggle button in the strip.
- **Footer row (bottom):** sidebar side = `[+] Add repository`; main side = Quick Actions strip `[ /fork ]  [ /compact ]  [ /resume ]  [ ... ]` + ambient usage `42k / $0.34`. Actions inject slash-commands or perform orchestration per `docs/specs/quick-actions.md`.

### Interaction

- Click tab → switch focus; chat viewer re-renders for the focused terminal.
- Click **`[ + Claude ]`** → spawns a new terminal running `claude` in the current space. ⌘Enter = same action.
- Click **`[ + Term ]`** → spawns a new terminal running the default shell in the current space. ⌘T = same action.
- Right-click `[ + Claude ]` → menu with "Resume session..." (opens full picker; same as `⌘R`).
- `⌘` + `` ` `` → toggle raw terminal view for the focused tab.
- Click `[|=|]` (Row B) → fork current session into a side pane.
- Click `[x]` (Row B) → close tab (terminal goes dormant; its session can be resumed later).
- Click Quick Actions button → executes per spec (orchestration/inject/hybrid).
- Click file link in chat → opens code viewer at line.
- Click tool-use summary → expands to show I/O.

---

## Wireframe 5: Sessions browser (cross-project, split-view with preview)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 3)
**State conditions:** user clicks `[T] Sessions` in sidebar top nav. Main area → split-view: session list (left) + chat preview (right).

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   Sessions                                                            │
│  [T]  Sessions             │   [ Search... ]     project: all v   sort: recent v                   │
│  [+]  New Space      Cmd+N │   ───────────────────────────────┬─────────────────────────────────── │
│                            │   * Identify CPU perf opt..      │ Preview                            │
│  -- Pinned --              │   [g] thoughts / My Space        │ ────────────────────────────────── │
│  [g] thoughts       (3) v  │    120k . auth-rewrite  4m  >    │ > Let me verify against current    │
│      /  My Space           │   ───────────────────────────────┤   code before presenting...        │
│      o  brainstorm-ide..   │   o brainstorm-ide-reframe       │                                    │
│      +  New space          │   [g] thoughts / brainstorm      │ * Explore (Find CPU hotspots..)    │
│                            │    48k . main           2h       │   └ Done (55 tools . 120k . 4m)    │
│  -- Projects --            │   ───────────────────────────────┤                                    │
│  [g] scaleup-studio (1) >  │   o migrate-valorant-companion   │ Here's what I found.               │
│  [g] portfolio      (0) >  │   [g] thoughts / migrate         │                                    │
│  [~] pare           (2) >  │    12k . main           1d       │ Top CPU opportunities, ranked      │
│                            │   ───────────────────────────────┤                                    │
│                            │   o phase-1-harbor-implementation│ 1. PNG oxipng -- png.py:45-52      │
│                            │   [g] harbor / phase-1           │ 2. TIFF serial -- tiff.py:64-71    │
│                            │    98k . v0-phase-1     3d       │                                    │
│                            │   ───────────────────────────────┤ * Worked for 5m 41s                │
│                            │   o valorant-catalog-scaffold    │                                    │
│                            │   [~] radiant / catalog          │    [  Resume in My Space  ]        │
│                            │    22k . main           5d       │    [  Open in new space   ]        │
│  [+]  Add repository       │                                  │                                    │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Top bar:** `Sessions` title + search + project filter + sort.
- **Split main area:**
  - **Left (session list):** 2-line rows. Line 1: `status-dot + title + > (selected indicator)`. Line 2: `[logo] project/space . tokens . branch   time`. Virtualized scroll.
  - **Right (preview pane):** selected session's chat content (read-only, tool-use summaries collapsed). Bottom: two CTAs — `[ Resume in <current-space> ]` or `[ Open in new space ]`.

### Interaction

- Type in search → fuzzy filter across titles + first-prompt content + file references + branch.
- Project filter: `all` / per-project. Sort: recent / title / tokens / duration.
- Click session row → preview populates right pane (no navigation, no resume).
- Click `[ Resume in <current-space> ]` → closes browser, resumes in pre-browse space.
- Click `[ Open in new space ]` → creates new space in session's original project, resumes there.

---

## Wireframe 6: Main window — space active, terminal view

**Status:** ✅ locked · 2026-04-19 (approved after iteration 6 rework)
**State conditions:** user clicked `[ +- Terminal ]` from Wireframe 4 to swap chat viewer for raw terminal. Same PTY, different renderer.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   [ CPU opt ]  [ zsh ]                  [ + Claude ]  [ + Term ]      │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │   /  Identify CPU perf opt..  (raw view)             [ |=| ]  [ x ]   │
│                            │   ──────────────────────────────────────────────────────────────────  │
│  -- Pinned --              │   $ claude --resume c3f9-...                                          │
│  [g] thoughts       (3) v  │                                                                       │
│      /  My Space           │   > Let me verify against current code before presenting...           │
│      o  brainstorm-ide..   │                                                                       │
│      +  New space          │   [Using Explore]                                                     │
│                            │     Find CPU hotspots in Pare                                         │
│  -- Projects --            │                                                                       │
│  [g] scaleup-studio (1) >  │   [Using Read]                                                        │
│  [g] portfolio      (0) >  │     optimizers/png.py                                                 │
│  [~] pare           (2) >  │     optimizers/tiff.py                                                │
│                            │     optimizers/CLAUDE.md                                              │
│                            │                                                                       │
│                            │   Here's what I found.                                                │
│                            │   1. PNG oxipng level -- optimizers/png.py:45-52                      │
│                            │   2. TIFF sequential  -- optimizers/tiff.py:64-71                     │
│                            │                                                                       │
│                            │   [55 tool uses . 120k tokens . 4m 1s]                                │
│                            │                                                                       │
│                            │   > _                                                                 │
│  [+]  Add repository       │   [ /fork ]  [ /compact ]  [ /resume ]  [ ... ]       42k / $0.34     │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Tab strip Row A:** identical to Wireframe 4. No view toggle button.
- **Row B marker:** session title carries a `(raw view)` tag so the state is obvious at a glance.
- **Main body:** raw terminal emulation of the CC process. No rich tool-use summaries, no collapsed-accordion blocks, no memory callouts — just CC's stdout as you'd see it in a plain terminal.
- **Footer:** Quick Actions + token/cost counter remain. Actions still inject into the same PTY.

### Purpose

When the chat viewer's rich rendering hides something you need — raw stderr, shell interleaving, paste fidelity, debugging a weird render state. Also useful when running `claude` with `--output-format stream-json` to inspect the wire format. Intentionally a **secondary** view — not a first-class persistent toggle in the strip, since the app prioritizes the Claude-focused chat viewer.

### Access

- Keyboard: `⌘` + `` ` `` (backtick) toggles raw view for the focused tab.
- Right-click tab → "Show raw terminal" / "Show chat view."
- Shell tabs default to raw view automatically (chat viewer is Claude-specific).

### Interaction

- `⌘` + `` ` `` → toggle back to chat view.
- Typing always routes to the same PTY. Chat and terminal are two renderers over one session's output stream.

---

## Wireframe 7: Main window — space active, split terminals (horizontal)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 6 rework)
**State conditions:** user split the active tab horizontally. Two panes stacked top/bottom in the main area; each hosts a distinct terminal (common case: the original session + a fork).

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   [ CPU opt ]  [ fork ]  [ zsh ]            [ + Claude ]  [ + Term ]  │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │   /  Identify CPU perf opt..  (focus)                [ |=| ]  [ x ]   │
│                            │   ──────────────────────────────────────────────────────────────────  │
│  -- Pinned --              │    > Let's continue with Phase v0.5 wireframing                       │
│  [g] thoughts       (3) v  │                                                                       │
│      /  My Space           │    * Explore (Find CPU hotspots in Pare)                              │
│      o  brainstorm-ide..   │       └ Done (55 tool uses . 120k tokens . 4m 1s)                     │
│      +  New space          │                                                                       │
│                            │    > _                                                                │
│  -- Projects --            │   ══════════════════════════════════════════════════════════════════  │
│  [g] scaleup-studio (1) >  │   o  brainstorm-ide-reframe  (fork of /claude)      [ |=| ]  [ x ]    │
│  [g] portfolio      (0) >  │   ──────────────────────────────────────────────────────────────────  │
│  [~] pare           (2) >  │    > What if we split the brainstorm into scope A/B/C?                │
│                            │                                                                       │
│                            │    * Thinking...                                                      │
│                            │       └ Considering three scope options                               │
│                            │                                                                       │
│                            │    Let's explore Scope A first.                                       │
│                            │                                                                       │
│                            │    Scope A is pure capture: log what you see, no AI analysis.         │
│                            │                                                                       │
│                            │    > _                                                                │
│  [+]  Add repository       │   [ /fork ]  [ /compact ]  [ /resume ]  [ ... ]       42k / $0.34     │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Tab strip Row A:** shows every terminal in the space as a truncated session-title tab (`[ CPU opt ]`, `[ fork ]`, `[ zsh ]`). On the right: `[ + Claude ]` + `[ + Term ]` create buttons.
- **Upper pane header:** `/  Identify CPU perf opt..  (focus)` — the `(focus)` suffix marks the pane receiving input.
- **Horizontal divider:** `══════` (double-line) between panes — distinct from `──` which sits under each pane's own header.
- **Lower pane header:** `o  brainstorm-ide-reframe  (fork of /claude)` — lineage callout (lineage tracking itself is future-scope; the label is a placeholder for the data).
- **Footer:** Quick Actions + usage refer to the focused pane.

### Interaction

- Click anywhere in a pane → focus shifts; `(focus)` label moves.
- Click `[ + Claude ]` / `[ + Term ]` → spawns a new terminal in the space (not the pane — adds a new tab to Row A).
- `[ |=| ]` on a pane header → splits that pane again (nested split).
- `[ x ]` on a pane header → closes the pane; remaining pane expands to fill.
- Keyboard: `⌘]` / `⌘[` cycle pane focus.
- Typing always goes to the focused pane's terminal; Quick Actions inject into focused pane.

---

## Wireframe 8: Main window — space active, split terminals (vertical)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 6 rework)
**State conditions:** user split the active tab vertically. Two panes side-by-side within the 71-char main area (35 chars each + 1-char `║` divider).

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   [ CPU opt ]  [ fork ]  [ zsh ]            [ + Claude ]  [ + Term ]  │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │   /  CPU perf opt..  (focus) [|=|][x]║o  brainstorm-ide..  [|=|][x]   │
│                            │   ───────────────────────────────────╬──────────────────────────────  │
│  -- Pinned --              │                                      ║                                │
│  [g] thoughts       (3) v  │    > Let's continue with Phase       ║   > What if we split the       │
│      /  My Space           │      v0.5 wireframing                ║     brainstorm into A/B/C?     │
│      o  brainstorm-ide..   │                                      ║                                │
│      +  New space          │    * Explore (Find CPU hotspots)     ║   * Thinking...                │
│                            │       └ Done (55 tools . 120k)       ║      └ Considering three       │
│  -- Projects --            │                                      ║        scope options           │
│  [g] scaleup-studio (1) >  │    Here's what I found.              ║                                │
│  [g] portfolio      (0) >  │    1. PNG oxipng -- png.py:45-52     ║   Let's explore Scope A first. │
│  [~] pare           (2) >  │    2. TIFF serial -- tiff.py:64-71   ║                                │
│                            │                                      ║   Scope A is pure capture:     │
│                            │    * Worked for 5m 41s               ║   log what you see, no AI.     │
│                            │                                      ║                                │
│                            │    > _                               ║   > _                          │
│                            │                                      ║                                │
│                            │                                      ║                                │
│                            │                                      ║                                │
│  [+]  Add repository       │   [ /fork ]  [ /compact ]  [ /resume ]  [ ... ]       42k / $0.34     │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Tab strip Row A:** tabs with truncated session titles + `[ + Claude ]` / `[ + Term ]` create buttons on the right (same pattern as Wireframes 4 and 7).
- **Shared Row B:** left pane title (with `(focus)` + split/close icons) and right pane title (split/close icons) separated by `║`.
- **Row B divider line** uses `╬` at the intersection with the vertical `║`.
- **Vertical `║` column** runs the full height of the pane body.
- **Pane width ≈ 35 chars each** — tight but viable for chat-style content. Long lines wrap.
- **Footer:** spans full main width; targets focused pane.

### Purpose

Side-by-side comparison — original vs. fork, planning vs. implementation, two parallel explorations. Horizontal split (Wireframe 7) is better for long-form reading; vertical is better for contrast.

### Interaction

- Same focus / split / close / keyboard semantics as Wireframe 7.
- Drag `║` to resize panes (implementation detail; wireframe shows 50/50 default).
- Nested splits allowed — a vertical split can contain a horizontal split and vice versa.

---

## Wireframe 9: Command palette (⌘K)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 6)
**State conditions:** user pressed `⌘K`. Modal overlays the main window (centered, background dimmed). Width: 80 chars.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  >  _                                                                        │
│  ──────────────────────────────────────────────────────────────────────────  │
│                                                                              │
│   Actions                                                                    │
│   [+] New Claude session                                     Cmd+Enter       │
│   [+] New space                                              Cmd+N           │
│   [+] New project                                                            │
│   [R] Resume session...                                      Cmd+R           │
│   [F] Fork current session                                   Cmd+Shift+F     │
│                                                                              │
│   Projects                                                                   │
│   [g] thoughts                                                               │
│   [g] scaleup-studio                                                         │
│   [~] pare                                                                   │
│                                                                              │
│   Sessions                                                                   │
│   *  Identify CPU perf optimization..       thoughts / My Space              │
│   o  brainstorm-ide-reframe                  thoughts / brainstorm-ide-r..   │
│   o  migrate-valorant-companion              thoughts / migrate-valorant     │
│                                                                              │
│   Quick Actions                                                              │
│   [ /fork ]      Fork this Claude session into a new tab                     │
│   [ /compact ]   Compact the current conversation                            │
│   [ /plugins ]   Open Claude Code plugins list                               │
│                                                                              │
│   Tip: prefix query with type -- 'a:', 'p:', 's:', 'q:'                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Search input** — cursor starts here; typing filters all groups instantly.
- **Result groups:** `Actions` · `Projects` · `Sessions` · `Quick Actions`. Empty groups auto-hide when the query narrows them out.
- **Actions:** create / resume / fork / navigate — with keyboard shortcuts shown inline.
- **Projects:** opens the selected project (equivalent to clicking its sidebar row).
- **Sessions:** resumes the selected session in the current space.
- **Quick Actions:** executes immediately; mode-dispatch follows `docs/specs/quick-actions.md` (orchestration / inject / hybrid).
- **Type prefixes:** `a:` · `p:` · `s:` · `q:` restrict scope for power users.

### Interaction

- Opens via `⌘K` from anywhere in the app.
- `↑` / `↓` moves selection; `⏎` executes.
- `Esc` closes without action.
- Ranking uses fuzzy match + frecency (recently/frequently used).
- Quick Actions fire in the currently focused terminal (inherits acting context).

---

## Wireframe 10: New-project modal

**Status:** ✅ locked · 2026-04-19 (approved after iteration 5)
**State conditions:** user clicked `[ + Project ]` on Dashboard or `[+] Add repository` in sidebar bottom. Modal centered, background dimmed. Width: 72 chars.

```
┌──────────────────────────────────────────────────────────────────────┐
│  New project                                                   [ x ] │
│  ──────────────────────────────────────────────────────────────────  │
│                                                                      │
│   Repository path                                                    │
│   [  ~/code/projects/                                        ]       │
│   [  Browse folder...  ]                                             │
│                                                                      │
│   Project name                                                       │
│   [  (auto from folder)                                      ]       │
│                                                                      │
│   Logo                                                               │
│   (*) [g]  From GitHub remote (auto-detected if available)           │
│   ( ) [i]  Upload custom image                                       │
│   ( ) [~]  Generated identicon (fallback)                            │
│                                                                      │
│   First space                                                        │
│   [x] Create "Default Space" with a Claude session                   │
│                                                                      │
│                                              [ Cancel ]  [ Create ]  │
└──────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Title bar:** `New project` + close `[ x ]`.
- **Repository path:** text input + `Browse folder...` button (opens native `NSOpenPanel`).
- **Project name:** text input — empty default auto-derives from folder basename; user can override.
- **Logo source:** radio — `[g]` GitHub remote auto-fetch · `[i]` custom upload · `[~]` generated identicon fallback. Default `[g]` if repo has an `origin` GitHub remote, else `[~]`.
- **First space:** checkbox — when checked, creates a `Default Space` and seeds it with a Claude session (common flow-first path); unchecked = empty project shell (no spaces).
- **Footer:** `[ Cancel ]` · `[ Create ]`.

### Gating

- Controlled by general setting **`show_project_creation_modal`** (default: `true`). When disabled, `[ + Project ]` / `[+] Add repository` skip this modal: open native folder picker → auto-detect project name from folder basename → pick logo source automatically → create project with `Default Space` + Claude session seeded → land user in working state.
- Users can adjust project metadata (name, logo source, etc.) later via **right-click project → Settings** in the sidebar.

### Interaction

- `Esc` = Cancel. `⏎` = Create (when `Create` is enabled).
- `Create` disabled until path is set.
- On Create: register project row in SQLite · fetch GitHub logo if applicable · spawn `Default Space` + Claude session if checkbox is on · navigate to the new project (empty Dashboard if no space, space view if seeded).

---

## Wireframe 11: New-space modal

**Status:** ✅ locked · 2026-04-19 (approved after iteration 5)
**State conditions:** user clicked `[+] New Space` in sidebar top nav or used `⌘N`. Modal centered, background dimmed. Width: 72 chars. Scoped to the current project.

```
┌──────────────────────────────────────────────────────────────────────┐
│  New space — thoughts                                          [ x ] │
│  ──────────────────────────────────────────────────────────────────  │
│                                                                      │
│   Space name                                                         │
│   [  wireframe-v0-5                                          ]       │
│                                                                      │
│   Working directory                                                  │
│   (*) Inherit from project                                           │
│       ~/code/projects/thoughts                                       │
│   ( ) Use a worktree  (experimental)                                 │
│                                                                      │
│   Seed terminals  (optional)                                         │
│   [x] Claude session                                                 │
│   [ ] Shell                                                          │
│                                                                      │
│                                                                      │
│                                              [ Cancel ]  [ Create ]  │
└──────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Title bar:** `New space — <project>` + close `[ x ]`. Project name is contextual (whichever project is active).
- **Space name:** text input. Default suggestion derived from current branch / date / naming convention (detail TBD).
- **Working directory:** radio — `(*) Inherit from project` (default; same cwd as project root) · `( ) Use a worktree (experimental)` — worktree isolation is a future-scope item (see `docs/future-scope.md`); shown with disabled/experimental hint in v0 to signal the direction without committing to it.
- **Seed terminals (optional):** multi-select checkboxes — seed the space with any combination of `[ ] Claude session` / `[ ] Shell`. Default: `Claude session` checked. **Leave all unchecked** to start with an empty space (W3 session picker opens). **No "one of" restriction** — users can freely add any number of Claude sessions / shells / forks / splits after creation.
- **Footer:** `[ Cancel ]` · `[ Create ]`.

### Gating

- Controlled by general setting **`show_space_creation_modal`** (default: `true`). When disabled, `[+] New Space` (sidebar) and `⌘N` skip this modal: create space with auto-generated name, inherit cwd from project, seed with one Claude session, land user in working state.
- Users can rename and reconfigure the space later via **right-click space → Settings** in the sidebar.

### Interaction

- `Esc` = Cancel. `⏎` = Create (when name is non-empty).
- On Create: register `spaces` row under current project in SQLite · spawn one terminal per checked seed box · navigate to new space (W3 session picker if no seed was checked).
- Worktree radio option is visible-but-disabled in v0; clicking it surfaces a tooltip pointing at post-v0 roadmap.

---

## Wireframe 12: Settings window — Global

**Status:** ✅ locked · 2026-04-19 (approved after iteration 7; individual category content to be planned later)
**State conditions:** user pressed `⌘,` or chose **Orpheus → Preferences** from the app menu bar. Opens as a separate macOS window (not an overlay over the main window). Width: 88 chars.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Settings                                                                     [ x ]  │
├──────────────────────┬───────────────────────────────────────────────────────────────┤
│                      │                                                               │
│  General          >  │   General                                                     │
│  Appearance          │                                                               │
│  Voice               │   Creation modals                                             │
│  MCP / Skills / KB   │   [x] Show project-creation modal                             │
│  Shortcuts           │   [x] Show space-creation modal                               │
│  Usage & API         │                                                               │
│  Privacy             │   Startup                                                     │
│  About               │   (*) Restore last-open space                                 │
│                      │   ( ) Start at Dashboard                                      │
│                      │                                                               │
│                      │   Tab strip                                                   │
│                      │   [x] Show truncated session title in tabs                    │
│                      │   [x] Highlight [ + Claude ] with accent color                │
│                      │                                                               │
│                      │   Usage indicator                                             │
│                      │   [x] Show ambient counter in footer (42k / $0.34)            │
│                      │                                                               │
│                      │   Sidebar                                                     │
│                      │   [x] Auto-collapse inactive projects after 7 days            │
│                      │                                                               │
│                      │                                                               │
└──────────────────────┴───────────────────────────────────────────────────────────────┘
```

### Elements

- **Title bar:** `Settings` + close `[ x ]`. Native macOS window chrome (traffic lights + title; only close shown here for clarity).
- **Left sidebar — categories (22 chars):** `General` (selected, with `>`), `Appearance`, `Voice`, `MCP / Skills / KB`, `Shortcuts`, `Usage & API`, `Privacy`, `About`.
- **Right pane — General content (63 chars):** five grouped sections — `Creation modals`, `Startup`, `Tab strip`, `Usage indicator`, `Sidebar`.
- **Creation modals** — the two toggles from iteration 5: `show_project_creation_modal`, `show_space_creation_modal`. Both default `true`. Disabling skips the corresponding modal in favor of folder-picker-with-defaults (project) / auto-named-space (space).
- **Startup** — radio: `Restore last-open space` (default) vs. `Start at Dashboard`.
- **Tab strip** — toggles from iteration 6: session-title-in-tabs, `[ + Claude ]` accent highlight.
- **Usage indicator** — ambient token/cost counter in footer (off for privacy-conscious users).
- **Sidebar** — auto-collapse inactive projects after N days (keeps long project list manageable).
- **Other categories (placeholder content):** Appearance (theme + density + accent), Voice (mic + TTS; post-v0 substantive), MCP / Skills / KB (global browser + registration), Shortcuts (keyboard binding editor), Usage & API (Anthropic key + plan info), Privacy (telemetry + crash reports), About (version + credits).

### Interaction

- `⌘,` opens Settings from anywhere.
- Close `[ x ]` or `⌘W` closes.
- Changes persist immediately (no Save/Apply button — matches macOS System Settings pattern).
- Clicking a category on the left → right pane swaps to that category's content.

---

## Wireframe 13: Project Settings window

**Status:** ✅ locked · 2026-04-19 (approved after iteration 7 + Delete-Project addition)
**State conditions:** user right-clicked a project in the sidebar → Settings (or `⌘I` with the project selected). Same window shell as W12, scoped to a specific project. Width: 88 chars.

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  Project Settings — thoughts                                                  [ x ]  │
├──────────────────────┬───────────────────────────────────────────────────────────────┤
│                      │                                                               │
│  General          >  │   General                                                     │
│  Spaces              │                                                               │
│  Quick Actions       │   Name                                                        │
│  MCP / Skills        │   [  thoughts                                         ]       │
│  Git                 │                                                               │
│                      │   Repository path                                             │
│                      │   ~/code/projects/thoughts                                    │
│                      │   [  Change...  ]                                             │
│                      │                                                               │
│                      │   Logo                                                        │
│                      │   (*) [g]  From GitHub remote (amitray007/thoughts)            │
│                      │   ( ) [i]  Upload custom image                                │
│                      │   ( ) [~]  Generated identicon                                │
│                      │                                                               │
│                      │   Default shell                                               │
│                      │   [  /bin/zsh                                       v ]       │
│                      │                                                               │
│                      │   Pin to sidebar                                              │
│                      │   [x] Show above Projects section                             │
│                      │                                                               │
│                      │   Danger zone                                                 │
│                      │   [  Archive project  ]  [  Delete project  ]                 │
└──────────────────────┴───────────────────────────────────────────────────────────────┘
```

### Elements

- **Title bar:** `Project Settings — <project name>` + close `[ x ]`. Title interpolates the project name for clarity.
- **Left sidebar — project-scoped categories:** `General` (selected), `Spaces` (list + per-space overrides; some post-v0 per `future-scope.md`), `Quick Actions` (custom actions for this project; post-v0), `MCP / Skills` (per-project MCP config; post-v0), `Git` (per-project Git settings; future).
- **Right pane — General content:**
  - **Name** — editable text input (renaming updates sidebar and state).
  - **Repository path** — display of current path + `Change...` button (opens folder picker to rebase; rare action).
  - **Logo** — radio mirroring W10: GitHub auto-fetch (currently `amitray007/thoughts`), custom upload, identicon.
  - **Default shell** — dropdown (lists common shells + "Custom..." → text input).
  - **Pin to sidebar** — toggle for showing the project in the `-- Pinned --` section above `-- Projects --`.
  - **Danger zone** — grouped destructive actions: `[  Archive project  ]` hides from sidebar but preserves data; `[  Delete project  ]` removes the project and all its spaces/sessions permanently. Both require a confirmation sheet.

### Interaction

- Right-click project row → Settings; or `⌘I` when project is selected in sidebar.
- Changes persist immediately (matches W12 pattern).
- `[  Change... ]` → native `NSOpenPanel` for path rebase.
- `[  Archive project  ]` → confirmation sheet → archives on confirm. Un-archivable via future "Archived projects" view.
- `[  Delete project  ]` → **destructive confirmation sheet** (requires typing the project name or similar friction) → permanently removes project, spaces, sessions, scrollbacks, and associated artifacts from Orpheus's SQLite. Does **not** touch the underlying repository on disk — only Orpheus's record of it. Irreversible.

---

## Wireframe 14: Menubar dropdown — Now tab (default)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 8 rework)
**State conditions:** user clicked the Orpheus icon in the macOS menu bar. Popover anchored under the icon. Width: 64 chars. **Three tabs** switch content: `Now` (default), `Projects`, `Sessions`. Selected tab shown as `[*Label*]`, unselected as `[ Label ]` (same width so layout doesn't shift). Header and Quit row are constant across tabs.

```
┌──────────────────────────────────────────────────────────────┐
│  Orpheus                                    42k / $0.34      │
│  [*Now*]  [ Projects ]  [ Sessions ]                         │
│  ────────────────────────────────────────────────────────    │
│                                                              │
│   Active spaces                                              │
│   /  Identify CPU perf opt..   thoughts / My Space           │
│   *  dev-server                thoughts / My Space           │
│                                                              │
│   ────────────────────────────────────────────────────────   │
│                                                              │
│   Quick                                                      │
│   +  New Claude session                          Cmd+Enter   │
│   T  Show Orpheus                                Cmd+Shift+O │
│   ,  Settings...                                 Cmd+,       │
│                                                              │
│   ────────────────────────────────────────────────────────   │
│                                                              │
│   Usage today                                                │
│   Tokens:   42k / 200k                                       │
│   Cost:     $0.34 / $20.00 (Pro plan)                        │
│                                                              │
│   ────────────────────────────────────────────────────────   │
│   Quit Orpheus                                   Cmd+Q       │
└──────────────────────────────────────────────────────────────┘
```

### Elements

- **Header row (constant):** `Orpheus` + live usage counter `42k / $0.34` (mirrors main window footer).
- **Tab strip:** `[*Now*]  [ Projects ]  [ Sessions ]`. Three equal-weight tabs; asterisks bracket the selected tab.
- **Now tab content (three sections):**
  - **Active spaces:** currently-running terminals grouped by their state glyph (`/` = Claude mid-response spinner; `*` = idle-active; `.` = inactive). Shows truncated session title + `project / space` breadcrumb.
  - **Quick:** three most-common actions — `+  New Claude session` (⌘Enter), `T  Show Orpheus` (⌘Shift+O to raise the hidden window), `,  Settings...` (⌘,).
  - **Usage today:** tokens + cost vs. plan quota. Links to Settings → Usage & API for full detail.
- **Quit row (constant):** `Quit Orpheus` + ⌘Q at the bottom of every tab.

### Interaction

- Click menu bar icon → popover opens on `Now` tab by default.
- Click a tab → content swaps; header + Quit row stay.
- Click outside / press `Esc` → closes.
- Click a row in `Active spaces` → opens main window focused on that terminal.
- Click a row in `Quick` → executes (may raise main window if needed).
- Live-updates — counter, active-spaces list, usage stats all refresh as terminals run / Claude responds.

---

## Wireframe 15: Menubar dropdown — Projects tab

**Status:** ✅ locked · 2026-04-19 (approved after iteration 8)
**State conditions:** user clicked the `Projects` tab in the menubar popover. Same 64-char shell; content swaps to a condensed project/space tree.

```
┌──────────────────────────────────────────────────────────────┐
│  Orpheus                                    42k / $0.34      │
│  [ Now ]  [*Projects*]  [ Sessions ]                         │
│  ────────────────────────────────────────────────────────    │
│                                                              │
│   Pinned                                                     │
│   [g] thoughts                                           v   │
│       /  My Space                     2 terminals            │
│       o  brainstorm-ide-reframe       dormant                │
│       +  New space                                           │
│                                                              │
│   ────────────────────────────────────────────────────────   │
│                                                              │
│   Projects                                                   │
│   [g] scaleup-studio                                     >   │
│   [g] portfolio                                          >   │
│   [~] pare                                               >   │
│                                                              │
│   ────────────────────────────────────────────────────────   │
│                                                              │
│   [+] Add repository                                         │
│                                                              │
│   ────────────────────────────────────────────────────────   │
│   Quit Orpheus                                   Cmd+Q       │
└──────────────────────────────────────────────────────────────┘
```

### Elements

- **Pinned section:** projects the user pinned (same conditional display as sidebar — hidden if none pinned). Expanded by default here so the user sees spaces with one click; each space row shows status (`/ * o .`), name, and a right-aligned detail (terminal count or `dormant`). `+  New space` affordance at the bottom of an expanded project.
- **Projects section:** remaining projects. Collapsed by default with `>` chevron. Clicking a row expands (state persists per session).
- **Add repository:** same affordance as sidebar bottom. Opens project-creation flow (W10 or folder-picker-only per setting).

### Interaction

- Click a space row → opens main window in that space.
- Click project row → expands / collapses that project inline (no main-window open).
- Click `+ New space` under a project → opens W11 modal (or folder-picker-and-defaults per setting).
- Click `[+] Add repository` → opens W10 modal (or folder-picker-only per setting).

---

## Wireframe 16: Menubar dropdown — Sessions tab

**Status:** ✅ locked · 2026-04-19 (approved after iteration 8)
**State conditions:** user clicked the `Sessions` tab in the menubar popover. Same 64-char shell; content swaps to a flat cross-project recent-sessions list. Focused and tight — for "I want to resume something, now."

```
┌──────────────────────────────────────────────────────────────┐
│  Orpheus                                    42k / $0.34      │
│  [ Now ]  [ Projects ]  [*Sessions*]                         │
│  ────────────────────────────────────────────────────────    │
│                                                              │
│   Recent sessions                                            │
│                                                              │
│   *  Identify CPU perf opt..                     4m          │
│      thoughts / My Space                                     │
│                                                              │
│   o  brainstorm-ide-reframe                      2h          │
│      thoughts / brainstorm-ide-ref..                         │
│                                                              │
│   o  migrate-valorant-companion                  1d          │
│      thoughts / migrate-valorant                             │
│                                                              │
│   o  phase-1-harbor-implementation               3d          │
│      harbor / phase-1                                        │
│                                                              │
│   o  valorant-catalog-scaffold                   5d          │
│      radiant / catalog                                       │
│                                                              │
│   ────────────────────────────────────────────────────────   │
│                                                              │
│   [  View all sessions  ]                                    │
│                                                              │
│   ────────────────────────────────────────────────────────   │
│   Quit Orpheus                                   Cmd+Q       │
└──────────────────────────────────────────────────────────────┘
```

### Elements

- **Recent sessions:** 2-line rows (title + time on line 1; `project / space` breadcrumb on line 2). Ordered by recency (most recent first). Truncated after ~5 entries to keep the popover compact.
- **View all sessions:** button → opens main window on the Sessions browser (W5) for filtering / search / preview.

### Interaction

- Click a session row → opens main window + resumes via `claude --resume <id>` in the session's original space. (No "pick which space to resume into" prompt here — menubar is for speed; use Sessions browser W5 for more control.)
- Click `[ View all sessions ]` → navigates main window to `[T] Sessions` (W5).

---

## Wireframe 17: Main window — canvas mode

**Status:** ✅ locked · 2026-04-19 (approved after iteration 10 rework)
**State conditions:** user switched the current space's layout to **canvas mode** (`View → Layout → Canvas` or `⌘Shift+C`). Terminals render as **free-arranged tiles** within the main area instead of the default chat-viewer + tab-strip single-focus layout. Same sidebar and tab strip Row A; Row B marks `(canvas)` mode.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   /  My Space  (canvas)         [+ Claude]  [+ Term]  [ Exit canvas ] │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │                                                                       │
│                            │                                                                       │
│  -- Pinned --              │                                                                       │
│  [g] thoughts       (3) v  │   ┌─────────────────────┐    ┌─────────────────────┐                  │
│      /  My Space           │   │ / CPU opt      [x]  │    │ o fork         [x]  │                  │
│      o  brainstorm-ide..   │   │─────────────────────│    │─────────────────────│                  │
│      +  New space          │   │ > Let's continue    │    │ > what if we split  │                  │
│                            │   │   with Phase v0.5   │    │   the brainstorm..  │                  │
│  -- Projects --            │   │                     │    │                     │                  │
│  [g] scaleup-studio (1) >  │   │ * Explore (hotspots)│    │ * Thinking...       │                  │
│  [g] portfolio      (0) >  │   │   . Done (55 tools) │    │                     │                  │
│  [~] pare           (2) >  │   │                     │    │                     │                  │
│                            │   │ > _                 │    │ > _                 │                  │
│                            │   └─────────────────────┘    └─────────────────────┘                  │
│                            │                                                                       │
│                            │           ┌──────────────────────────────┐                            │
│                            │           │ $ zsh                   [x]  │                            │
│                            │           │──────────────────────────────│                            │
│                            │           │ $ npm run dev                │                            │
│                            │           │ Server started on :3000      │                            │
│                            │           │ $ _                          │                            │
│                            │           └──────────────────────────────┘                            │
│                            │                                                                       │
│  [+]  Add repository       │   [ /fork ]  [ /compact ]  [ /resume ]  [ ... ]       42k / $0.34     │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Merged header bar** (single row replacing Row A + Row B from default layout):
  - **Left:** `/  My Space  (canvas)` — space title + mode tag.
  - **Right:** `[+ Claude]  [+ Term]  [ Exit canvas ]` — create a new Claude terminal, create a new shell terminal, or switch back to list mode.
- **No tab strip.** Canvas doesn't need tabs because all terminals are visible simultaneously as tiles.
- **No split icon (`[|=|]`).** Splits belong to list mode only; canvas is its own spatial-arrangement primitive.
- **No top-level `[x]` close.** Each tile has its own `[x]` in its header; closing the whole space happens at the sidebar level (right-click space → Archive/Delete) or by closing the last tile.
- **Main body canvas:** 2D free-arrange surface where each terminal renders as a **tile**. Tile = mini-frame with status glyph + title + tile-level close `[x]` + divider + content.
- **Tile content:** Claude tiles show condensed chat view (latest turns); shell tiles show recent stdout. Scrollable inside the tile.
- **Free positioning:** users drag tiles anywhere within the canvas. Position persists per space (`spaces.layout_spec` in SQLite — see `architecture.md`).
- **No enforced layout grid:** tiles can overlap, align edge-to-edge, or float with gaps.
- **Quick Actions footer is type-aware (per focused tile):**
  - Claude tile focused → Claude-specific actions (`/fork`, `/compact`, `/resume`, `/plugins`, etc. per `docs/specs/quick-actions.md`). Wireframe shows this variant since the top-left Claude tile is focused by default.
  - Shell tile focused → shell-specific actions (placeholder set: `/clear`, `/copy-output`, `/restart`, `/pin`; full catalog TBD in a quick-actions spec update).
  - This type-awareness applies in **all** layout modes, not only canvas — same principle as `active_terminal.has_cc_session` predicate in the quick-actions spec.

### Use cases

- **Parallel exploration:** multiple Claude sessions visible at once, compared side-by-side.
- **Ambient monitoring:** `$ dev-server` tile runs in corner while Claude tiles do focused work.
- **Diagramming with terminals:** arrange tiles spatially to reflect how sessions relate (original + fork + experimental, etc.).

### Interaction

- `View → Layout → Canvas` menu item, or `⌘Shift+C`, switches current space to canvas mode.
- Click `[ Exit canvas ]` in the merged bar → returns to list-mode (chat-viewer + tab-strip). Same menu / keyboard shortcut also toggles back.
- Layout mode is **per-space** — different spaces can be in different modes simultaneously.
- Drag tile header → reposition.
- Drag tile edge → resize.
- Click tile → focus (Quick Actions + keyboard input target the focused tile; Quick Actions strip swaps to match the tile's type).
- Click `[x]` on tile → closes the terminal (same as closing a tab; session goes dormant).
- Click `[+ Claude]` / `[+ Term]` in the merged bar → adds a new tile at a default position (top-left or cascade); user drags to arrange.

### Not in v0 (flagged for later)

- Canvas zoom / minimap.
- Tile grouping (lasso + labels).
- Canvas export / share.
- Snap-to-grid or auto-arrange.

---

## Wireframe 18: Onboarding — first-run welcome

**Status:** ✅ locked · 2026-04-19 (approved after iteration 9)
**State conditions:** Orpheus launches for the first time — no projects exist, no spaces, no sessions. Full main window; sidebar shows only `(none yet)` under Projects. Center main area shows a 3-step welcome explainer + two CTAs.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                                                                  [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │                                                                       │
│  [T]  Sessions             │                                                                       │
│  [+]  New Space      Cmd+N │                         Welcome to Orpheus                            │
│                            │                                                                       │
│  -- Projects --            │              A Mac IDE built around Claude Code.                      │
│                            │                                                                       │
│     (none yet)             │                                                                       │
│                            │           1.  Add a repository                                        │
│                            │               Any git project; logo auto-fetched.                     │
│                            │                                                                       │
│                            │           2.  Orpheus creates a Default Space                         │
│                            │               With a Claude session seeded and ready.                 │
│                            │                                                                       │
│                            │           3.  Start chatting                                          │
│                            │               Your sessions are saved and resumable.                  │
│                            │                                                                       │
│                            │                                                                       │
│                            │                 [  + Add repository  ]  [  Open folder...  ]          │
│                            │                                                                       │
│                            │                 Cmd+,  to open Settings                               │
│                            │                                                                       │
│                            │                                                                       │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Toolbar:** no Search (nothing to search yet) — just traffic lights, sidebar toggle, and user menu.
- **Sidebar:** top nav (Dashboard/Sessions/New Space), Projects header with `(none yet)`, `[+] Add repository` at bottom. No Pinned section (nothing pinned).
- **Main area welcome block:**
  - **Title:** `Welcome to Orpheus` + tagline `A Mac IDE built around Claude Code.`
  - **3-step flow:** numbered list explaining what happens on add-repository. Each step = heading + one-line description.
  - **Two CTAs:** `[ + Add repository ]` (primary; opens W10 or folder picker per setting) and `[ Open folder... ]` (direct folder picker — treats any folder as a project, no git requirement).
  - **Keyboard hint:** `Cmd+,  to open Settings` — introduces the most common keyboard shortcut early.
- **Footer:** Quick Actions absent (no active terminal).

### When shown

- On **true first launch** (no `orpheus.sqlite` file exists, or the `projects` table is empty).
- Does **not** show on subsequent launches even if the user deletes all projects — after first launch, the regular empty Dashboard (W1) is shown.

### Interaction

- Click `[ + Add repository ]` → W10 new-project modal (if `show_project_creation_modal` is on) or direct folder picker (if off).
- Click `[ Open folder... ]` → native `NSOpenPanel` folder chooser. Treats any folder as a project, auto-detects name, creates Default Space with Claude session seeded, lands in W4.
- Clicking `[D] Dashboard` (already selected) → no-op, stays on welcome.
- After first project is created, welcome screen is dismissed and replaced by Dashboard (W2) or space view (W4).

---

## Wireframe 19: State patterns reference (empty / loading / error)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 9)
**State conditions:** not a single screen — a **reference document** defining the reusable visual patterns for empty lists, async loading, and errors. Widgets shown here are applied across many screens (Sessions browser, MCP list, Dashboard, etc.) without being their own wireframes.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ State patterns reference                                                                           │
├────────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                    │
│  Empty state  (for lists with no rows yet — Sessions browser, MCP list, etc.)                      │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐    │
│  │                                                                                            │    │
│  │                           No sessions yet.                                                 │    │
│  │                                                                                            │    │
│  │          Start a Claude session in any project and it will show up here.                   │    │
│  │                                                                                            │    │
│  │                      [  Start a Claude session  ]                                          │    │
│  │                                                                                            │    │
│  └────────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                                    │
│  Loading skeleton  (while async data loads — Dashboard, Sessions browser)                          │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐    │
│  │  ████████████████████████    ..... (shimmer animation)                                     │    │
│  │  ████████                                                                                  │    │
│  │                                                                                            │    │
│  │  ████████████████            ██████████████                                                │    │
│  │  ██████████████████████████  ██████                                                        │    │
│  │  ████████                    ██████████████████████                                        │    │
│  └────────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                                    │
│  Error toast  (transient; top-right of main window; auto-dismiss or manual)                        │
│                                     ┌────────────────────────────────────────────────────────┐     │
│                                     │ !  Claude session failed to resume.           [  x  ]  │     │
│                                     │    Session file not found.  [ Retry ] [ Details ]      │     │
│                                     └────────────────────────────────────────────────────────┘     │
│                                                                                                    │
│  Error banner  (persistent until resolved — top of affected surface)                               │
│  ┌────────────────────────────────────────────────────────────────────────────────────────────┐    │
│  │ !  Can't reach Anthropic API. Check your network or API key.  [ Retry ] [ Open Settings ]  │    │
│  └────────────────────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                                    │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Patterns

**Empty state** — used whenever a list has no rows yet:

- Centered message (title + one line of context) inside the list's container.
- Primary CTA button that kicks off the common path to populate the list.
- Never blank — always tell the user _what will go here_ and _how to get something_.

**Loading skeleton** — used while async data resolves (initial app load, Dashboard heatmap, Sessions browser list):

- Gray block placeholders matching the shape of the eventual content.
- Shimmer animation (left-to-right diagonal highlight) signals "loading, not broken."
- Prefer skeletons over spinners for list-like content — less jarring, preserves layout.
- Spinners (`*`/`/`/`-`/`\`/`|` cycle) still appropriate for single-item operations (e.g., tool invocations).

**Error toast** — transient, attention-getting, auto-dismissing:

- Top-right of main window; stacks if multiple.
- `!` glyph + one-line message + optional one-line context.
- 1-2 action buttons (`Retry`, `Details`) + explicit close `[ x ]`.
- Auto-dismiss after ~6s unless the user is interacting.

**Error banner** — persistent, context-scoped:

- Top of the affected surface (e.g., below toolbar if global; above a list if list-scoped).
- Stays visible until the condition is resolved.
- `!` glyph + message + 1-2 action buttons.
- Higher visual weight than toast (colored background, persistent border).

### Variants / edge cases (noted for future refinement)

- **Critical error full-page** — when Orpheus can't start at all (e.g., database corrupt). Shows an apology + diagnostic info + "Open support" / "Reset app data" actions.
- **Offline mode banner** — softer variant when network drops but Orpheus can still operate (cached sessions, dormant resume).
- **Success toast** — same shape as error toast but `✓` glyph (green in real UI); mostly for confirming destructive/long actions.

### Interaction

- All patterns are **purely visual conventions** — no unique affordances beyond the standard button behaviors.
- Toasts and banners never block input elsewhere; the user can continue working while they're visible.

---

## Wireframe 20: Voice HUD — Full (hovering overlay, expanded state)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 12 rework)
**State conditions:** user activated the voice loop AND chose to expand the **compact toolbar HUD** (Wireframe 26 — the default voice state) into the **full hovering HUD**. Floating overlay anchored within the main window's main area — bottom-centered over the chat viewer content. The HUD is ~60 chars wide; shown here in full-window context. Main window: 102 chars.

**Relation to W26:** voice activity starts in the compact toolbar chip (W26, default). User clicks the chip → expands to this full hovering HUD. User dismisses it → collapses back to compact.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   [ CPU opt ]  [ zsh ]                  [ + Claude ]  [ + Term ]      │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │   /  Identify CPU perf optimization opportunities    [ |=| ]  [ x ]   │
│                            │   ──────────────────────────────────────────────────────────────────  │
│  -- Pinned --              │                                                                       │
│  [g] thoughts       (3) v  │    > Let's continue with Phase v0.5 wireframing                       │
│      /  My Space           │                                                                       │
│      o  brainstorm-ide..   │    * Explore (Find CPU hotspots in Pare)                              │
│      +  New space          │       └ Done (55 tool uses . 120k tokens . 4m 1s)                     │
│                            │                                                                       │
│  -- Projects --            │    Let me verify against current code before presenting...            │
│  [g] scaleup-studio (1) >  │                                                                       │
│  [g] portfolio      (0) >  │      ┌──────────────────────────────────────────────────────────┐     │
│  [~] pare           (2) >  │      │  [mic on]  Listening...                        [ Stop ] │      │
│                            │      │  ──────────────────────────────────────────────────────  │     │
│                            │      │                                                          │     │
│                            │      │    . | | |  | | | |  | | |  | |  |  .                   │      │
│                            │      │    (live mic waveform)                                   │     │
│                            │      │                                                          │     │
│                            │      │   Transcript (streaming):                                │     │
│                            │      │     "Fork this session and try the other approach..."   │      │
│                            │      │                                                          │     │
│                            │      │   [ Cancel ]                     PTT: Fn (hold to talk)  │     │
│                            │      └──────────────────────────────────────────────────────────┘     │
│                            │                                                                       │
│  [+]  Add repository       │   [ /fork ]  [ /compact ]  [ /resume ]  [ ... ]       42k / $0.34     │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Header:** `[mic on]` state chip + current state label (`Listening...` / `Speaking...` / `Interrupted`) + `[ Stop ]` hard-stop button on the right.
- **Waveform:** live ASCII bars rendered from mic input (taller bar = louder). Scrolls left-to-right. Smooth animation (60fps) in the real UI.
- **Transcript (streaming):** Whisper-style on-device or cloud transcription accumulates in real time. Shown truncated; full text appears in the chat viewer after the turn ends.
- **Footer:** `[ Cancel ]` (drop the turn without sending) + PTT hint (which key/gesture holds the loop open).

### States (one HUD; three variants)

- **Listening** — mic open, waveform live, user speaking. Shown in this wireframe.
- **Speaking** — Claude's TTS is playing. `[mic on]` becomes `[speaker]`; waveform tracks TTS output amplitude; transcript shows Claude's response as it speaks. Cancel button becomes `[ Mute ]` to silence playback without stopping.
- **Interrupted** — user starts speaking mid-TTS. HUD briefly shows `Interrupted` state, cuts TTS instantly, returns to Listening. Per voice-loop design: interrupt is first-class.

### Interaction

- `PTT` key (configurable; default Fn) held → Listening state.
- Release PTT → ends turn, posts transcript as user message in active Claude terminal.
- `[ Stop ]` → aborts the loop immediately (cancels transcription and any pending TTS).
- `[ Cancel ]` → drops the current turn (transcript discarded).
- Clicking outside → collapses HUD to a menu-bar indicator (still active; expand again via PTT or menu-bar click).

### Not in v0 (flagged for later)

- Voice activity detection (VAD) auto-pause on silence.
- Multi-language transcription switching.
- Per-project voice profiles (different wake words, different TTS voices).
- Real-time TTS-voice selection in the HUD (for v0, set in Settings → Voice).

---

## Wireframe 21: Diff viewer (diffs.com-style, multi-file + unified/split toggle + collapsible files panel)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 13 collapsible-files update)
**State conditions:** user clicked a file link in the chat, a Claude proposal, or triggered a diff view via keyboard. Replaces main-area content with a **multi-file diff viewer** (diffs.com-inspired). Files panel on the left is **collapsible** (`[<<]` in its header) — collapse it to give the diff more horizontal space for code review. Width: 102 chars.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   Diff — thoughts                        [*Unified*]  [ Split ] [ x ] │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │   Proposed by: / Identify CPU perf opt.. (thoughts / My Space)        │
│                            │                                                                       │
│  -- Pinned --              │   Files (3)        [<<] │  optimizers/png.py                          │
│  [g] thoughts       (3) v  │   ──────────────────────┼────────────────────────────────────────     │
│      /  My Space           │   > png.py     +1 -1    │  @@ -40,10 +40,10 @@                        │
│      o  brainstorm-ide..   │     tiff.py    +4 -2    │     def optimize_png(path, out):            │
│      +  New space          │     CLAUDE.md  +2 -0    │         img = Image.open(path)              │
│                            │                         │         buf = io.BytesIO()                  │
│  -- Projects --            │                         │         img.save(buf, format='PNG')         │
│  [g] scaleup-studio (1) >  │                         │  -      level = 4                           │
│  [g] portfolio      (0) >  │                         │  +      level = 6  # higher compression     │
│  [~] pare           (2) >  │                         │         result = oxipng.optimize(           │
│                            │                         │             buf.getvalue(),                 │
│                            │                         │             level=level,                    │
│                            │                         │         )                                   │
│                            │                         │         return result                       │
│                            │   ──────────────────────┼────────────────────────────────────────     │
│                            │   Total  . +7 -3        │  [ Accept ] [ Reject ] [ Editor ]           │
│                            │   [ Prev ] [ Next ]     │  [ Accept and /compact ]                    │
│                            │                                                                       │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

**Collapsed variant** (user clicked `[<<]`; files panel shrinks to a re-expand chevron; diff takes full main-area width):

```
   Diff — thoughts                            [*Unified*]  [ Split ] [ x ]
   ─────────────────────────────────────────────────────────────────────
   [>>] Files (3)
   ─────────────────────────────────────────────────────────────────────
   optimizers/png.py   .   +1 -1
   @@ -40,10 +40,10 @@
      def optimize_png(path, out):
          img = Image.open(path)
          buf = io.BytesIO()
          img.save(buf, format='PNG')
   -      level = 4
   +      level = 6  # higher compression, slightly slower
          result = oxipng.optimize(buf.getvalue(), level=level)
          return result

   [ Prev file ]  [ Next file ]              [ Accept ] [ Reject ]
```

### Elements

- **Header row:** `Diff — <project-or-scope>` + **mode toggle** (`[*Unified*]  [ Split ]`) + close `[ x ]`. Toggle swaps the right-pane rendering between unified (`-/+` inline) and split (original | changed side-by-side).
- **Provenance line:** `Proposed by: <session status + title> (<project / space>)` — who suggested this change and where. Click → jumps to the chat context.
- **Left panel — Files (collapsible):** list of all files in the diff with per-file stats (`+adds -dels`). Selected file marked with `>`. **Narrower by default (~23 chars)** — filenames truncated to basename (`png.py` instead of `optimizers/png.py`) so the diff on the right gets more horizontal real estate. Full path shown on hover / as tooltip in real UI. Panel header includes a `[<<]` button that collapses it to a thin re-expand chevron.
- **Left panel actions (when expanded):** `[ Prev ]` / `[ Next ]` step through files without hunting the list. Total footer shows aggregate stats.
- **Right panel — Diff body (unified mode shown):** standard `@@` hunk format with context + `-` removed + `+` added lines. Syntax highlighting in real UI (TextKit 2 + SwiftTreeSitter per `architecture.md`). **Priority surface — diff gets the most horizontal space available**, especially in collapsed mode.
- **Right panel — Diff body (split mode, variant):** two columns side-by-side — original (left sub-column) + changed (right sub-column). Aligned line-by-line. Wireframe for split variant TBD; follows diffs.com convention. Combine with the collapsed-files state for the widest possible side-by-side view.
- **Actions row (right panel footer):** `[ Accept ]` applies edits for the selected file; `[ Reject ]` discards that file's proposal; `[ Editor ]` opens the file in the user's external editor; `[ Accept and /compact ]` applies + runs `/compact` in the originating terminal.

### Collapsed files panel

Clicking `[<<]` hides the files list and expands the diff body across the full main-area width (71 chars). The files panel leaves behind a short row: `[>>] Files (N)` that re-expands the panel on click. See the "Collapsed variant" ASCII above. This lets users focus entirely on the diff when reviewing dense code changes, while still having file navigation one click away.

### Interaction

- Click file row on left → selects; right pane re-renders the diff for that file.
- `[<<]` / `[>>]` → collapse / re-expand the files panel. State is sticky (per-app preference, remembers across sessions).
- `[*Unified*]` / `[ Split ]` toggle → swaps right-pane rendering. Setting is sticky.
- `[ Prev ]` / `[ Next ]` or `⌘↑` / `⌘↓` → navigate files without mouse (works in both expanded and collapsed modes).
- Click file link in chat → opens diff viewer scoped to that file (1 file in list) or the parent multi-file change set (if multiple files proposed).
- `[ Accept ]` → applies the **selected file's** edit; advances to next file. Single keyboard: `⌘.`
- `[ Accept All ]` (keyboard only for v0: `⌘⇧.`) — accepts every file in the set.
- `[ Reject ]` → discards and records in session log so Claude sees the rejection.
- `Esc` / `⌘W` → close diff viewer.

### Why diffs.com style

- Compact: file list + diff body in 102 chars, no wasted chrome.
- Scannable: per-file stats visible while diffing.
- Mode flexibility: unified (dense) or split (clearer for big rewrites).

### Variants (future, not v0)

- **Inline review annotations** — per-line comments / suggestions (post-v0; belongs with multi-agent review workflows).
- **Word-level intra-line diffs** (highlight changed substring within a line).
- **Image diffs** (visual compare of PNG / JPG changes).
- **PR-style review flow** — approve / request changes / comment per file. Overlaps with W23 Git surfaces.

---

## Wireframe 22: Extensions browser (MCP / Skills / KB)

**Status:** 📦 archived · 2026-04-19 (deferred post-v0 per iteration 12 — see `docs/future-scope.md` § "Post-launch feature wireframes")
**State conditions:** user navigated to Extensions (via command palette, menu, or Settings → MCP/Skills). Main-area view with three tabs + list/detail split.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   Extensions                                          [ + Install ]   │
│  [T]  Sessions             │   [*MCP*]  [ Skills ]  [ KB ]                                         │
│  [+]  New Space      Cmd+N │   ──────────────────────────────────────────────────────────────────  │
│                            │                                                                       │
│  -- Pinned --              │   [ Search... ]     scope: all v                                      │
│  [g] thoughts       (3) v  │   ────────────────────────────────┬──────────────────────────────     │
│      /  My Space           │   * linear        v1.2.0   [on]  >│ linear                            │
│      o  brainstorm-ide..   │   o github        v0.8.1   [on]   │ ──────────────────────────        │
│                            │   o playwright    v0.2.0  [off]   │ Linear issue + PR integration     │
│  -- Projects --            │   o filesystem    v1.0.3   [on]   │ v1.2.0  .  by linear.app          │
│  [g] scaleup-studio (1) >  │   o shell-utils   v0.4.0   [on]   │                                   │
│  [g] portfolio      (0) >  │   ────────────────────────────────┤ Scope                             │
│  [~] pare           (2) >  │                                   │ (*) Global                        │
│                            │                                   │ ( ) Project: thoughts             │
│                            │                                   │                                   │
│                            │                                   │ Tools exposed                     │
│                            │                                   │ . list_issues                     │
│                            │                                   │ . create_issue                    │
│                            │                                   │ . get_issue                       │
│                            │                                   │                                   │
│                            │                                   │ [ Disable ]  [ Uninstall ]        │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Top bar:** `Extensions` title + `[ + Install ]` primary action.
- **Tab strip:** `[*MCP*]` / `[ Skills ]` / `[ KB ]` — same tabbed pattern as menubar W14-W16.
- **Filter row:** search input + scope dropdown (`all` / `global` / project-specific).
- **Left list:** installed items — state glyph (`*` active, `o` idle, `.` disabled) + name + version + on/off toggle + `>` when selected. Click to select.
- **Right detail:** selected item's info — description, version, publisher, scope radio (global vs per-project), tools exposed (for MCP) / skill prompt preview (for Skills) / docs snippet (for KB), Disable/Uninstall buttons.

### Per-tab variation

- **MCP:** tools exposed, scope, server config.
- **Skills:** skill prompt preview, trigger keywords, allowed tools.
- **KB:** doc snippet, last-updated, source URL.

### Interaction

- Click `[ + Install ]` → install flow (from registry / file / URL; detail TBD).
- Click a row → selects; right pane populates.
- Toggle `[on]`/`[off]` inline → enables/disables without opening detail.
- Radio scope in detail → switches between global-install and per-project-install.
- `[ Uninstall ]` → confirmation sheet → removes.

---

## Wireframe 23: Git surfaces (PRs / Issues / Actions / Branches)

**Status:** 📦 archived · 2026-04-19 (deferred post-v0 per iteration 12 — see `docs/future-scope.md` § "Post-launch feature wireframes")
**State conditions:** user opened the Git surface for a project (sidebar right-click → Git, or keyboard shortcut). Main-area view; scoped to the current project. Four tabs + list/detail split.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   Git — thoughts                                                      │
│  [T]  Sessions             │   [*PRs*]  [ Issues ]  [ Actions ]  [ Branches ]                      │
│  [+]  New Space      Cmd+N │   ──────────────────────────────────────────────────────────────────  │
│                            │                                                                       │
│  -- Pinned --              │   [ Search... ]    state: open v   author: all v   [ + New PR ]       │
│  [g] thoughts       (3) v  │   ────────────────────────────────┬──────────────────────────────     │
│      /  My Space           │   # 142  Refactor sessions    >   │ PR #142                           │
│      o  brainstorm-ide..   │         amitray007 . 2h . draft    │ ─────────────────────────         │
│                            │   # 141  Fix typo in plan         │ Refactor sessions into modules    │
│  -- Projects --            │         amitray007 . 4h . open     │                                   │
│  [g] scaleup-studio (1) >  │   # 140  Add voice loop           │ + 342  . - 87  . 12 files         │
│  [g] portfolio      (0) >  │         amitray007 . 1d . merged   │                                   │
│  [~] pare           (2) >  │   # 139  Wireframe v0.5           │ Checks                            │
│                            │         amitray007 . 2d . merged   │ . CI          passed              │
│                            │   ────────────────────────────────┤ . lint        passed              │
│                            │                                   │ . tests       3 failed            │
│                            │                                   │                                   │
│                            │                                   │ [ Review ]  [ Ask Claude ]        │
│                            │                                   │ [ Check out ] [ Open in browser ] │
│                            │                                   │                                   │
│                            │                                   │                                   │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Top bar:** `Git — <project name>` + four tabs (`[*PRs*]` / `[ Issues ]` / `[ Actions ]` / `[ Branches ]`).
- **Filter row:** search + state (open/closed/merged/all) + author + `[ + New PR ]`.
- **Left list (PRs tab):** 2-line rows. Line 1: `# <num>  <title>` + selection `>`. Line 2: `author . age . state` indented.
- **Right detail:** title, stats (`+ adds . - dels . N files`), **checks** (CI / lint / tests with per-check status), action buttons (`[ Review ]` opens review UI; `[ Ask Claude ]` spawns a Claude session with PR context preloaded; `[ Check out ]` switches the project branch locally; `[ Open in browser ]` to GitHub).

### Per-tab variation

- **Issues:** list of issues (similar 2-line format); detail shows labels, assignees, linked PRs.
- **Actions:** list of recent CI runs; detail shows step log + rerun button.
- **Branches:** list of branches (local + remote); detail shows last commit + `[ Check out ]` / `[ Delete ]`.

### Interaction

- Click a PR row → detail populates in right pane.
- `[ Ask Claude ]` — new Claude session in current space with PR metadata + diff preloaded into context. Fast path for "explain this PR" / "review this PR."
- `[ Check out ]` — runs `git checkout <branch>` in an active terminal (or spawns one); updates sidebar's active branch indicator.

### Not in v0

- Multi-account / multi-repo (single project = single GitHub repo assumed).
- GitLab / Bitbucket support.
- Offline review (current design assumes online GitHub API).

---

## Wireframe 24: Automations (Rules / Schedule / Running)

**Status:** 📦 archived · 2026-04-19 (deferred post-v0 per iteration 12 — see `docs/future-scope.md` § "Post-launch feature wireframes")
**State conditions:** user navigated to Automations (sidebar right-click → Automations, or from command palette). Main-area view with three tabs + list/detail split.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   Automations                                         [ + New rule ]  │
│  [T]  Sessions             │   [*Rules*]  [ Schedule ]  [ Running ]                                │
│  [+]  New Space      Cmd+N │   ──────────────────────────────────────────────────────────────────  │
│                            │                                                                       │
│  -- Pinned --              │   Active rules                                                        │
│  [g] thoughts       (3) v  │   ────────────────────────────────┬──────────────────────────────     │
│      /  My Space           │   [on]  On dev-server crash    >  │ On dev-server crash               │
│      o  brainstorm-ide..   │        notify + restart          │ ──────────────────────────         │
│                            │   [on]  On PR opened              │ Trigger                           │
│  -- Projects --            │        run /prepare-review        │   process.name == 'dev-server'    │
│  [g] scaleup-studio (1) >  │   [off] Nightly plan digest       │   AND process.exit_code != 0      │
│  [g] portfolio      (0) >  │        cron: 0 22 * * *           │                                   │
│  [~] pare           (2) >  │   [on]  On  /fork                 │ Actions                           │
│                            │        archive parent after 1h    │ 1. Notify (banner)                │
│                            │                                   │ 2. Restart process                │
│                            │                                   │                                   │
│                            │                                   │ Last run: 4h ago (success)        │
│                            │                                   │ Runs today: 2                     │
│                            │                                   │                                   │
│                            │                                   │ [ Edit ]  [ Disable ]  [ Delete ] │
│                            │                                   │                                   │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Top bar:** `Automations` + `[ + New rule ]`.
- **Tab strip:** `[*Rules*]` (rules config) / `[ Schedule ]` (time-based rules visualized on a timeline) / `[ Running ]` (live view of currently executing automations).
- **Left list (Rules tab):** 2-line rows — line 1: on/off toggle + name + selection `>`; line 2: action summary indented.
- **Right detail:** trigger (human-readable or DSL preview) + actions list (numbered steps) + run history (last run timestamp + success/fail) + runs today count + Edit/Disable/Delete buttons.

### Per-tab variation

- **Schedule:** time-based rules visualized on a simplified timeline (day, week) showing upcoming fires.
- **Running:** live list of currently executing automation runs with real-time progress.

### Rule sources

Kickstart-inspired:

- **Event triggers:** process events, session events (`/fork`, `/compact`, session start/end), git events (PR opened/closed), file watcher events.
- **Time triggers:** cron-style schedules.
- **Manual triggers:** button in Quick Actions or command palette.

### Interaction

- `[ + New rule ]` → rule-creation flow (modal with trigger picker + actions builder; TBD detail).
- Click a row → detail populates.
- `[ Edit ]` → opens rule-editor modal.
- Toggle `[on]`/`[off]` inline → enable/disable without opening.

### Not in v0

- Complex conditional DSL (v0 supports simple `AND` / `OR` predicates only).
- Visual rule graph editor.
- Shared/forked rule marketplace.

---

## Wireframe 25: Ideas Inbox (capture + scaffold)

**Status:** 📦 archived · 2026-04-19 (deferred post-v0 per iteration 12 — see `docs/future-scope.md` § "Post-launch feature wireframes")
**State conditions:** user clicked Ideas Inbox (sidebar top-nav addition, or `⌘Shift+I` quick-capture). Main-area view with top capture input + list/detail split. Two sections in the list: Unsorted (captured) and Scaffolded (promoted).

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                        Search                                    [User v]            │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   Ideas Inbox                                                         │
│  [T]  Sessions             │   [  + Jot an idea...                                   Cmd+Shift+I]  │
│  [+]  New Space      Cmd+N │   ──────────────────────────────────────────────────────────────────  │
│                            │                                                                       │
│  -- Pinned --              │   Unsorted                                                            │
│  [g] thoughts       (3) v  │   ────────────────────────────────┬──────────────────────────────     │
│      /  My Space           │   . Voice-driven PR reviews   >   │ Voice-driven PR reviews           │
│      o  brainstorm-ide..   │     2h ago                        │ ──────────────────────────        │
│                            │   . Auto-tag sessions by topic    │ Captured: 2h ago                  │
│  -- Projects --            │     5h ago                        │                                   │
│  [g] scaleup-studio (1) >  │   . Custom MCP for Figma          │ Body                              │
│  [g] portfolio      (0) >  │     1d ago                        │   review PRs while cooking;       │
│  [~] pare           (2) >  │   . Heatmap by tool-use type      │   talk to Claude by voice;        │
│                            │     3d ago                        │   get audible summaries.          │
│                            │                                   │                                   │
│                            │   Scaffolded                      │ [ Scaffold into project ]         │
│                            │   ────────────────────────────────┤ [ Add to existing project  v ]    │
│                            │   . Split-pane fork lineage       │ [ Archive ]  [ Delete ]           │
│                            │     harbor-like bookmarks tool    │                                   │
│                            │   . Orpheus voice loop spec       │                                   │
│                            │                                                                       │
│  [+]  Add repository       │                                                                       │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Top capture input:** `[  + Jot an idea...  ]` + `⌘Shift+I` hint. One-line; press `⏎` to add (prepended to Unsorted); press `⌘⏎` to add + immediately scaffold.
- **List (two sections):**
  - **Unsorted** — newly captured ideas, newest-first. Each row: `.` glyph + title + age-indented line. `>` on selected.
  - **Scaffolded** — ideas that were promoted to projects (or appended to existing ones). Shows title + outcome indented.
- **Right detail:** title + capture time + full body + scaffold actions.
- **Scaffold actions:** `[ Scaffold into project ]` (creates a new project from the idea — generates initial structure + brainstorm prompt), `[ Add to existing project v ]` (dropdown of current projects; appends as a note or kickstart brief), `[ Archive ]` (stash without scaffolding), `[ Delete ]`.

### Purpose

Ambient capture for "I had a thought" moments without breaking flow. Lightweight. Heavy enough to become a project later but only when you invest the effort.

### Interaction

- `⌘Shift+I` from anywhere in Orpheus → opens Ideas Inbox with capture focused.
- Captured ideas persist locally (SQLite; `ideas` table — schema TBD).
- `[ Scaffold into project ]` → opens a lightweight wizard (project name + initial brainstorm prompt derived from idea body) → creates project + Default Space + seeded Claude session ready to brainstorm.
- `[ Add to existing project v ]` → dropdown of projects → idea body appended as a note (visible in the project's Dashboard section or in a future "Notes" panel).
- `[ Archive ]` → moves to Scaffolded with `archived` marker. Recoverable via filter.

### Not in v0

- Voice-captured ideas (post-v0, companion to voice loop).
- Smart grouping / tagging (auto-cluster ideas by topic).
- Cross-device capture (Mac only for v0).

---

## Wireframe 26: Voice HUD — Compact (toolbar chip, default state)

**Status:** ✅ locked · 2026-04-19 (approved after iteration 13)
**State conditions:** voice loop is active (PTT held, toggle on, wake-word trigger) but the user hasn't expanded to the full hovering HUD. The **compact chip** lives in the top toolbar between Search and `[User v]`, similar to a macOS screen-recording indicator. Default voice state. Main window: 102 chars.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [o o o]  [<|]                Search                    [ * 0:05  | | | | ]   [User v]              │
├────────────────────────────┬───────────────────────────────────────────────────────────────────────┤
│                            │                                                                       │
│  [D]  Dashboard            │   [ CPU opt ]  [ zsh ]                  [ + Claude ]  [ + Term ]      │
│  [T]  Sessions             │   ──────────────────────────────────────────────────────────────────  │
│  [+]  New Space      Cmd+N │   /  Identify CPU perf optimization opportunities    [ |=| ]  [ x ]   │
│                            │   ──────────────────────────────────────────────────────────────────  │
│  -- Pinned --              │                                                                       │
│  [g] thoughts       (3) v  │    > Let's continue with Phase v0.5 wireframing                       │
│      /  My Space           │                                                                       │
│      o  brainstorm-ide..   │    * Explore (Find CPU hotspots in Pare)                              │
│      +  New space          │       └ Done (55 tool uses . 120k tokens . 4m 1s)                     │
│                            │                                                                       │
│  -- Projects --            │    Let me verify against current code before presenting...            │
│  [g] scaleup-studio (1) >  │                                                                       │
│  [g] portfolio      (0) >  │    [Transcribing voice in background...]                              │
│  [~] pare           (2) >  │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│                            │                                                                       │
│  [+]  Add repository       │   [ /fork ]  [ /compact ]  [ /resume ]  [ ... ]       42k / $0.34     │
└────────────────────────────┴───────────────────────────────────────────────────────────────────────┘
```

### Elements

- **Toolbar chip — `[ * 0:05  | | | | ]`:**
  - `*` — red recording indicator (live-blinking in real UI; filled circle `●` in non-ASCII UI).
  - `0:05` — elapsed recording time (mm:ss).
  - `| | | |` — compact mic-level waveform (4-6 bars; animated in real UI).
  - Placement: between `Search` and `[User v]` — naturally anchored with the user-menu cluster.
- **Main area** stays entirely unchanged. The chat viewer keeps its current content; a small inline note `[Transcribing voice in background...]` appears in the chat stream at the current cursor position so the user knows a voice turn is forming.
- **Chip is the default voice surface.** No modal, no overlay, no hovering HUD — by design. Minimal disruption; keeps the chat viewer fully readable while you talk.
- **Expand action:** clicking the chip opens the **full hovering HUD** (Wireframe 20) for users who want the larger waveform + full transcript + explicit controls.

### Why default compact

- **Non-intrusive:** Speaking to Claude shouldn't take over the screen. The chat viewer continues to show the conversation in progress; the voice chip just confirms "I'm listening and recording."
- **Matches macOS screen-recording chip pattern** — familiar affordance.
- **Expandable on demand:** power users or complex turns can open the full HUD; for quick utterances the chip is enough.

### Interaction

- Voice loop starts (PTT, toggle, wake-word) → chip appears in toolbar.
- Voice loop ends (PTT release, explicit stop, utterance complete) → chip disappears; transcript is posted as a user message in the active Claude terminal.
- Click chip → opens full hovering HUD (W20).
- Click chip's `*` recording indicator (future: context menu) → quick options (mute, cancel).
- Right-click chip (future) → `[ Pause ]`, `[ Mute TTS ]`, `[ Open Voice Settings ]`.

### States (3 variants of the chip)

- **Listening** — `[ * 0:05  | | | | ]` (red `*`, mic waveform).
- **Speaking** (Claude TTS playing) — `[ ♪ 0:12  | | | | ]` (note glyph or similar; bars track TTS output amplitude).
- **Interrupted** (user starts speaking mid-TTS) — `[ * 0:01  | |   ]` (returns to Listening; TTS cut; brief flash / color change in real UI).

### Not in v0

- Chip-level keyboard shortcuts beyond click-to-expand.
- Per-terminal voice routing visible in chip (for now the chip refers to the focused Claude terminal).
- Custom chip position (always between Search and `[User v]` in v0).

---

## Removed from canonical flow (preserved conceptually)

### `[+]` dropdown (was iteration 1 Wireframe 5 — DEPRECATED in iteration 2)

Original dropdown dropped in favor of flow-first session creation.

### Flow-first `[+]` single button (DEPRECATED in iteration 6)

Iteration 2's `[+]` = single button that spawned a Claude session directly (with `⌘T` / `⌘R` / right-click menu for alternate types) was dropped because it overloaded one affordance. Replaced with **two explicit buttons** in Row A:

- `[ + Claude ]` (primary; accent color; first-class visual weight for the app's priority action)
- `[ + Term ]` (secondary; plain shell)

Keyboard shortcuts still exist (`⌘Enter` = new Claude, `⌘T` = new shell, `⌘R` = resume picker) but the explicit buttons give both surfaces equal discoverability while preserving Claude's visual priority.

### `[ +- Terminal ]` / `[ +- Chat ]` view toggle (DEPRECATED in iteration 6)

Two-state toggle was too rigid. Raw terminal view is now a **secondary** access mode:

- Keyboard: `⌘` + `` ` `` toggles raw view for the focused tab.
- Right-click tab → "Show raw terminal" / "Show chat view."
- Shell tabs default to raw view automatically (chat viewer is Claude-specific).

Wireframe 6 (terminal view) is preserved as a wireframe representing the raw-view state, but it is reached via keyboard / right-click rather than a persistent toggle button.

---

## Open design decisions (to resolve in iteration 7+)

- Forking flow placement (Row B split icon vs. right-click vs. keyboard).
- Tool-use summary expansion (inline accordion vs. side drawer).
- Session title source (first-prompt truncated vs. user-named).
- Dormant-session visibility in sidebar (currently only via Sessions browser).
- Project logo generation algorithm (seed-from-name vs. user-picked style).
- Heatmap longer periods (90d / year) — deferred past v0.
- Preview pane behavior when no session selected — show instructions, empty, or most-recent by default?
- Project count semantics — `(3)` = total sessions / active terminals / live spaces. Pick one semantics for v0 and document.
