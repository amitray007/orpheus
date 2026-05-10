# Orpheus — Implementation Plan

**Status:** Drafted 2026-04-18 (session `2026-04-18-HHmm-plan-v0-phased-buildout.md`)
**Register:** Product / design / technical-choice level. No code, no API signatures, no file-level implementation details. This plan is a roadmap a build agent will later translate into actual implementation work.
**Companion specs:**
- `docs/specs/architecture.md` — stack and layer decisions
- `docs/specs/design-principles.md` — design system philosophy and principles
- `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-17-0351-brainstorm-product-scope-foundation.md` — locked scope + feature set
- `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-04-18-0121-decide-architecture-native-stack.md` — architecture + design lock

---

## Overview

Orpheus v0 is a **9-phase build** (Phases 0 through 7, with a Phase 0.5 for wireframes inserted between the design-system foundation and the rest). It starts from `OrpheusDesign` as a pre-feature foundation and ends with polish + beta readiness. The phases are dependency-ordered; skipping or re-ordering breaks the model.

The plan names ~75–85 discrete tasks across the 9 phases (the ~30–40 wireframes in Phase 0.5 dominate the count). Each task is a deliverable ("what exists when done"), not an instruction on how to build it.

**Philosophy of this plan:**
- Design-system-first. Phase 0 has to complete before any feature-facing surface is built. This is non-negotiable — the design discipline we committed to rewards itself only if the system exists first.
- **Foundation before features.** Data model, persistence, subprocess orchestration, session registry — all exist before anyone sees a beautiful UI.
- **Terminal-first.** Once foundation is real, getting one great terminal working takes precedence over polishing dashboards.
- **Vertical slices after foundation.** Each later phase ships a user-visible capability end-to-end, not a cross-cutting layer.
- **Open decisions marked explicitly.** Each phase lists the design/technical choices that must be resolved before it starts. No phantom "we'll figure it out" gates.

---

## Non-goals (reminder, not being built in v0)

- Cross-platform (Linux / Windows)
- ACP / multi-agent portability
- Daemon mode with mobile / web clients
- WKWebView panels
- Tauri / Electron / Rust core
- Commissioned custom typeface
- Full Orpheus-as-brand with multiple agentic-tool layers

---

## Gate model

Each phase has **gate criteria** — the specific state that must be true before the next phase begins. Gates are not dates; they are truth-statements about deliverables. We do not advance past a gate until it is met.

Phases can be worked on in parallel only where the dependency graph explicitly allows. The graph below tells you what can overlap.

---

## Dependency graph

```
Phase 0  →  Phase 0.5  →  Phase 2  →  Phase 3  →  Phase 4  →  Phase 5  →  Phase 6  →  Phase 7
(Design)   (Wireframes)   (Shell +    (Self-drive (Quick       (Git +       (Voice +    (Polish)
                           Terminal)  + Rich)     Actions +    Automations   Ideas)
                                                   Dashboards) + MCP)
                                ↑
Phase 1 (Core) ─────────────────┘
(parallelizable with Phase 0 + Phase 0.5; headless core)
```

- Phase 0 blocks everything visible AND blocks Phase 0.5 (wireframes use design-system tokens).
- Phase 0.5 produces the screen layouts that Phase 2+ needs. Without wireframes locked, Phase 2 doesn't know what to build.
- Phase 1 is independent of Phase 0 and 0.5 — can run in parallel to both since it's core plumbing, not UI. (Caveat: no UI is shown until 0 + 0.5 complete.)
- Phase 2 requires Phase 0, Phase 0.5, and Phase 1.
- Phases 3–7 are strict linear from there.

---

## Phase 0 — Design-System Foundation (`OrpheusDesign`)

**Status as of 2026-05-09:** ✅ DONE. See `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-05-09-2128-review-phase-0-design-system-build.md`. One spec gap raised: light `text.inverted` on `accent.primary` measures 2.93:1 (fails AA); recorded as a regression baseline pending a design-side resolution.

### Goal
Every token category exists. Core component set is specified with preview samples. Any new feature work after this phase starts from `OrpheusDesign` and never touches stock SwiftUI controls.

### Deliverables
- **Typography system** — 6-step type ramp (display / title / heading / body / caption / mono) applied to selected sans + mono typefaces
- **Color palette** — full semantic token set (surface, text, accent, semantic, terminal, code-highlight) with dark + light values
- **Material tokens** — custom-tuned `sidebar`, `palette`, `toolbar`, `overlay` materials layered on Liquid Glass
- **Spacing + radius scales** — 4px base grid, documented token catalog
- **Motion tokens** — `quick`, `standard`, `settle`, `dramatic` spring presets
- **Iconography system** — SF Symbol curation rules + placeholder custom-icon slots for Orpheus-specific concepts (project, space, terminal, fork, self-drive)
- **Core component catalog** — Button, Toggle, TextField, TextArea, List, Row, Menu, SplitView, SpaceSwitcher, Sidebar, CommandPalette, QuickAction, StatusBadge, Tooltip, Modal, Sheet
- **Motion + feedback components** — Spinner, ProgressBar, Skeleton, Toast
- **Preview gallery** — every component has `#Preview` samples showing all variants
- **Design-discipline documentation** — the discipline rules from `design-principles.md` encoded as README guidance

### Open decisions that MUST be resolved before Phase 0 starts
- [x] Final typeface pair (sans + mono) — **LOCKED: Satoshi + Commit Mono**
- [x] Accent color direction + provenance story — **LOCKED: Lyre Gold ("the color of Orpheus's lyre")**
- [x] Baseline dark-mode palette hex values — **LOCKED (see `docs/specs/design-principles.md` "LOCKED v0 dark-mode starter values")**
- [x] Baseline light-mode palette hex values — **LOCKED (see `docs/specs/design-principles.md` "LOCKED v0 light-mode starter values")**
- [x] Material tuning starter values (blur radii, tints) — **LOCKED (see `docs/specs/design-principles.md` "LOCKED v0 material tuning starter values")**

### Open decisions DEFERRED past Phase 0
- Final logotype + logomark (design session later)
- Terminal ANSI color scheme (locked in Phase 2)
- Full custom-drawn icon catalog (polished in Phase 7)

### Dependencies
None, but requires **a dedicated design session** to land the typeface + accent direction first.

### Size
**L** (2–4 focused weeks of design system work per reference — Raycast-style discipline).

### Gate criteria
- [ ] Every token category locked with values
- [ ] Core component set compiles with preview samples
- [ ] Dark + light palettes both complete at the token level
- [ ] No stock SwiftUI controls referenced in the design-system package

---

## Phase 0.5 — Wireframes & Flows

### Goal
Every user-visible screen in v0 is wireframed using markdown ASCII, locked through iterative to-and-fro review. Phase 2 onward cannot start without concrete screen layouts in hand; this phase produces them.

### Tooling
**Markdown ASCII wireframes** committed to `docs/wireframes/` as the source format. This is the v0 approach because the user's own `easel` (AI-first wireframing) project isn't yet shippable; once easel ships, later wireframes could be generated through it. Each wireframe is a markdown file containing an ASCII-art layout block plus annotations (element names, state notes, interaction notes, design-token references).

### Iteration pattern
Each wireframe goes through a to-and-fro cycle:
1. Agent proposes ASCII wireframe with annotations
2. User reviews, tweaks, requests changes
3. Agent revises
4. Repeat until user confirms "locked"
5. Committed to `docs/wireframes/<area>.md`

No wireframe advances to locked without explicit user approval. No Phase 2 work begins on a surface whose wireframe is still in-flight.

### Deliverables — ~30–40 wireframes organized by feature area

**Main window states (~7–9 wireframes):**
- Empty state (app open, no project selected)
- Project open, single terminal, sidebar shown
- Project open, multi-terminal horizontal split
- Project open, multi-terminal vertical split
- Project open, canvas mode (free-arranged terminals)
- Sidebar expanded vs. collapsed
- Space switcher UI
- Space switcher UI (replaces the former tab strip concept)
- Multi-space navigation

**Overlays & modals (~6–8 wireframes):**
- Command palette (⌘K) opened with fuzzy-search results
- Session picker overlay
- Quick-action palette
- Settings (global scope)
- Settings (per-project scope)
- Voice HUD — PTT recording
- Voice HUD — TTS streaming
- Voice HUD — mid-turn interrupt state

**Rich content panels (~4–5 wireframes):**
- Chat viewer layout (position, structure, tool-call toggles)
- Diff viewer (unified multi-file)
- Code viewer + file tree layout
- Fork-to-side-pane interaction flow (before / during / after)

**Dashboards (~5 wireframes):**
- Usage dashboard (ccusage-style)
- Contribution heatmap
- MCP browser
- Skills browser
- Knowledge base browser

**Git (~4–5 wireframes):**
- PR creation flow
- PR review UI
- Actions status view
- Issue creation
- Issue list

**Menubar (~2 wireframes):**
- Menubar icon states (idle / active / streaming / error)
- Menubar dropdown (live usage, active session, quick actions)

**Automations (~3 wireframes):**
- Automation config UI
- Scheduler editor
- "What's running" status panel

**Ideas-inbox (~2 wireframes):**
- Inbox capture UI
- Scaffold-in-progress state

**Onboarding & edge cases (~4–6 wireframes):**
- First-launch onboarding flow
- Empty states (no CC session, no MCPs, no custom actions)
- Error states (CC binary missing, permissions denied, network issues)
- Loading skeletons

### Open decisions
None blocking. Iteration happens organically — each wireframe may surface layout questions that get resolved during the to-and-fro.

### Dependencies
Phase 0 substantially complete (design-system tokens available for wireframe annotations — "sidebar = 240pt, surface.raised background, accent focus ring at 2pt").

### Size
**L** — ~30–40 wireframes iterated across multiple sessions.

### Gate criteria
- [ ] All ~30–40 v0 screens wireframed in markdown ASCII
- [ ] Each wireframe marked "locked" (no outstanding user change requests)
- [ ] Organized by feature area under `docs/wireframes/`
- [ ] Cross-referenced from relevant design-principles sections where applicable

---

## Phase 1 — Core Foundation

**Status as of 2026-05-10:** ✅ DONE. See `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-05-10-0654-review-phase-1-core-foundation-build.md`.

### Goal
The plumbing that every feature depends on. Data model persists, settings load, session state is readable, `claude` can be spawned as a subprocess. No UI — headless core logic only.

### Deliverables
- **Data model** — Project, Space, Terminal entities with stable IDs, strict parent/child relationships, CRUD + event stream semantics (Tabs removed in 2026-04-18 simplification; spaces own layout directly)
- **Persistence layer (SQLite via GRDB + FTS5)** — tables for projects/spaces/terminals/scrollback/sessions-index/app-state; WAL mode; crash-safe writes
- **Config system** — JSON files (global `~/.orpheus/config.json`, per-project `<root>/.orpheus/config.json`); hot-reload on FSEvents; project-overrides-global precedence
- **Session registry** — reads `~/.claude/projects/` at startup and reactively; parses JSONL metadata (header + last line only); maps project-cwd → sessions[]
- **JSONL watcher** — FSEvents-based, publishes session-update events
- **Subprocess manager** — spawns `claude` with the right flag combinations (`--session-id`, `--resume`, `--fork-session`, `--bare`, etc.); owns stdio piping, lifecycle, exit-code handling
- **Settings merging engine** — deterministic rule for combining global + project settings

### Open technical decisions
- SQLite schema migration strategy (pure Swift migrations vs external tool)
- Scrollback chunk size and ring-buffer bounds
- Settings hot-reload debounce strategy

### Dependencies
Can be built alongside Phase 0 since nothing here is user-visible.

### Size
**L**

### Gate criteria
- [ ] Data model persisted and round-trips through SQLite cleanly
- [ ] `claude` can be spawned and exit-code-handled from core
- [ ] Session registry populates and updates reactively
- [ ] Settings merge predictably across global + project scopes

---

## Phase 2 — Shell + Terminal

**Phase 2A (libghostty FFI) status as of 2026-05-10:** ✅ DONE. See `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-05-10-1801-review-phase-2a-libghostty-ffi-build.md`.

**Phase 2B (app shell + sidebar) status as of 2026-05-10:** ✅ DONE. See `/Users/maverick/code/projects/thoughts/projects/orpheus/sessions/2026-05-10-1930-review-phase-2b-app-shell-build.md`.

### Goal
Orpheus is an application you launch. You see a window styled by OrpheusDesign. You click to open a project. A terminal opens inside the window running `claude`. The terminal is smooth, fast, libghostty-quality. The full Project ▸ Space ▸ Terminal hierarchy is wired end-to-end. On force-close + relaunch, everything comes back exactly as it was.

### Deliverables
- **AppKit window shell** — main window, sidebar, main pane, toolbar, using OrpheusDesign tokens
- **libghostty integration** — `OrpheusTerminalView` hosts libghostty via Swift bindings; GPU-accelerated Metal rendering confirmed working
- **Project sidebar** — auto-discovered projects from `~/.claude/projects/` + user-pinned; search/filter; lifecycle states (active/paused/archived/pinned) visible
- **Space management** — multiple spaces per project; drag-reorder; rename; archive; auto-create "My Space" on new project with 1 shell terminal at project root
- **Multi-terminal per space** — default one, splittable H/V, further subdividable; layout owned by the space itself
- **Canvas mode** — alternate space layout where terminals can be free-arranged (optional polish; can move to Phase 7 if tight on time)
- **Auto-restore on launch** — every open terminal at last-close time reopens in the same layout, scrollback rehydrated, CC session reattached or respawned
- **Force-close survival** — state-saving writes are continuous, not just on graceful shutdown
- **Terminal styled via OrpheusDesign** — font, color scheme, ANSI palette tokens applied

### Open design/technical decisions
- Terminal ANSI color scheme (locks here)
- libghostty binding strategy (extract from Ghostty's Swift code / hand-write Swift bindings / contribute upstream)
- Terminal-drag UX pattern across splits within a space; cross-space terminal migration behavior
- Default layout when user opens a brand-new project

### Dependencies
Phase 0 (needs OrpheusDesign), Phase 1 (needs core plumbing).

### Size
**XL** — this is the most technically heavy phase. libghostty integration alone is substantial work.

### Gate criteria
- [ ] A user can launch Orpheus, open a project, open a terminal, type in it, see Claude Code respond, all smoothly
- [ ] Multi-terminal splits work with H/V arrangements
- [ ] Force-close + relaunch restores everything
- [ ] Terminal font + colors honor OrpheusDesign tokens

---

## Phase 3 — Self-Drive CLI + Rich Content

### Goal
Claude running inside any hosted terminal can invoke `orpheus` commands to manipulate the IDE state. In parallel, the rich-content primitives exist so a chat viewer, diff viewer, and code viewer can live alongside the terminal.

### Deliverables
- **`orpheus` binary on PATH** — separate Swift target, same Xcode workspace; installer writes to `/usr/local/bin` or similar
- **Unix socket daemon** — listens at `~/.orpheus/orpheus.sock`; JSON-RPC 2.0 protocol; file-permission auth
- **Full CLI command surface** — projects, spaces (with layout creation), terminals (with send + scrollback), sessions, actions
- **MCP skill registration** — orpheus exposes itself as a skill Claude discovers conversationally, so every hosted session automatically knows about it
- **Machine-readable JSON output** — every command returns structured JSON by default; `--human` for pretty CLI output
- **OrpheusMarkdownView** — native markdown renderer via `AttributedString`
- **OrpheusCodeView** — syntax-highlighted code via TextKit 2 + SwiftTreeSitter
- **OrpheusDiffView** — custom diff rendering with gutter, line-level highlighting, accept/reject affordances
- **Chat viewer panel** — reads session JSONL in real time, renders each message using OrpheusMarkdownView / OrpheusCodeView / OrpheusDiffView; toggles for tool calls + code changes; streaming-token support

### Open design/technical decisions
- Code syntax highlighting theme palette
- Diff-view visual language (unified vs side-by-side default)
- Chat-viewer layout (side panel, tab, overlay?)
- JSON-RPC error model + protocol versioning

### Dependencies
Phase 2.

### Size
**XL**

### Gate criteria
- [ ] Claude inside a hosted terminal can run `orpheus space create --split vertical --terminals 2` and it works
- [ ] Chat viewer renders a live session with toggles functional
- [ ] OrpheusDiffView, OrpheusCodeView, OrpheusMarkdownView each compile standalone with preview samples

---

## Phase 4 — Quick-Actions + Dashboards

### Goal
Every interaction has a quick, keyboard-reachable button. Usage visibility is first-class — menubar shows live state, dashboard shows trends.

### Deliverables
- **Quick-actions engine** — declarative config schema for actions; context-detection logic (active terminal, session state, project type); invocation surfaces (toolbar, palette, keyboard)
- **Default action catalog** — fork / continue / resume / compact / clear / new-terminal-here / rename / archive
- **Custom per-project actions** — users can define actions via per-project settings
- **Command palette** — ⌘K overlay with fuzzy search across actions, sessions, projects, settings
- **Keyboard shortcut binding system** — global + per-context bindings; configurable
- **Usage dashboard** — ccusage-style daily / monthly / session / per-model breakdown; cost tracking; burn rate; renders via OrpheusDesign charts
- **Contribution heatmap** — GitHub-style grid combining CC sessions + GitHub contributions; drill-in for detail
- **Menubar app** — live usage display + active session indicator; quick-action hotkey to open palette from menubar

### Open design/technical decisions
- Action config schema
- Default keyboard shortcut catalog (what defaults feel "right"?)
- Heatmap aggregation rules (what counts as a contribution?)
- GitHub auth UX for heatmap data

### Dependencies
Phase 3.

### Size
**L**

### Gate criteria
- [ ] ⌘K opens a command palette with fuzzy search
- [ ] Usage dashboard shows real cost data pulled from CC JSONL
- [ ] Menubar shows live session + usage continuously
- [ ] Custom per-project actions can be defined and invoked

---

## Phase 5 — Git + Automations + MCP Manager

### Goal
Three major feature areas land together: full Git integration (diff / PR / issue / Actions), declarative automations (kickstart-inspired), and in-app browsing of MCPs / Skills / Knowledge Base.

### Deliverables
- **Git integration**
  - Local git diff view (reuses OrpheusDiffView; styled like `@pierre/diffs`)
  - git setup flows (init, add remote, branch)
  - Create PR, create issue via `gh` or GitHub API
  - PR review UI
  - GitHub Actions status visualization
- **Automations**
  - Per-project automation config (declarative; kickstart-inspired schema)
  - Scheduler (cron-compatible expressions)
  - Trigger types: time-based, git event, file watch, task complete, Claude hook
  - Dev-server one-click run/stop (matches Kickstart's pattern)
  - Always-know-what's-running status panel across all projects
- **MCP / Skills / Knowledge-base manager**
  - Browse installed MCPs (per-project + global scope)
  - Browse available skills (bundled + user + project)
  - Knowledge-base viewer
  - Read-only in v0; install / edit / manage deferred to later

### Open design/technical decisions
- gh CLI vs GitHub API direct for Git flows
- Actions polling strategy (webhook? poll? CLI?)
- Automation config schema details
- Scheduler precision (second? minute?)
- KB storage format

### Dependencies
Phase 3 (rich content primitives), Phase 4 (palette for invocation).

### Size
**L**

### Gate criteria
- [ ] Create a PR from inside Orpheus without leaving the app
- [ ] Run and stop a dev server via a one-click action
- [ ] View installed MCPs for the active project in a panel

---

## Phase 6 — Voice + Ideas-Inbox

### Goal
Orpheus speaks and listens. You can dump an idea into an inbox and it becomes a live project with a session attached.

### Deliverables
- **Voice loop**
  - PTT mic capture via AVFoundation / AVAudioEngine
  - STT streaming via chosen provider
  - Streaming TTS out via Cartesia-class provider
  - Response preprocessor (strip markdown, collapse tool calls, jargon pronunciation dict)
  - Mid-turn interrupt (cancel TTS playback + model inference on PTT re-press)
  - PTT global key binding
- **Ideas-inbox**
  - Capture UI (menubar quick-capture or main-window inbox panel)
  - Scaffold pipeline (folder creation, `git init`, preloaded prompt)
  - Optional template system for common project types
  - New project appears in sidebar automatically after scaffold

### Open design/technical decisions
- STT provider (Deepgram vs Groq Whisper vs Whisper.cpp local)
- TTS provider (Cartesia default; fallback to `say` for offline?)
- PTT key-binding mechanism (Karabiner vs native global `NSEvent` monitor)
- Preprocessor's pronunciation dictionary starting set
- Inbox capture UX (menubar quick-capture? Raycast-style overlay? main-window pane?)
- Template catalog (what's v0? None? Ship 3 defaults?)

### Dependencies
Phase 3 (chat viewer tells voice what is being read; scaffold needs subprocess + data model).

### Size
**L**

### Gate criteria
- [ ] Press PTT → speak → Claude answers in voice AND text
- [ ] Mid-turn interrupt via PTT re-press works cleanly
- [ ] Dump an idea in the inbox → new project exists in sidebar within ~30 seconds

---

## Phase 7 — Polish + Beta Readiness

### Goal
Orpheus is a daily-driver you're proud to use. Performance tuned. Accessibility in place. Final branding and design polish locked. Shipped as a beta build.

### Deliverables
- **Performance profiling + fixes** — terminal latency < N ms, app launch < X seconds, memory footprint target, scrollback scroll smoothness benchmarked
- **Accessibility pass** — VoiceOver support, Dynamic Type, high-contrast palette variants, keyboard-only navigation end-to-end
- **Final design polish**
  - Logotype + logomark locked
  - Full custom-drawn icon catalog finished
  - Final accent color with provenance story locked
  - Final material tuning across all surfaces
  - Empty-state designs
  - Loading skeletons
  - Error states
  - Onboarding flow for first-time users
- **Beta build** — notarized, DMG distribution, auto-update channel set up

### Open decisions resolved here
- Final logotype + logomark design
- Final accent hex value + provenance paragraph
- Full custom icon catalog
- Onboarding UX

### Dependencies
All prior phases.

### Size
**L**

### Gate criteria
- [ ] Terminal input latency measured and meets target
- [ ] VoiceOver can navigate the full UI
- [ ] First-time user onboarding completes without confusion
- [ ] Beta build installable on a fresh Mac

---

## Deferred to post-v0

The following are acknowledged features that do not land in v0 but are part of the long-term Orpheus vision:

- Cross-platform (Linux, Windows)
- ACP / multi-agent adapter
- Daemon mode with mobile + web clients
- Orpheus-as-brand hosting additional agentic-tool layers beyond Claude Code
- Install / edit / manage flows for MCPs and Skills (v0 is browse-only)
- Commissioned custom typeface (v0 uses off-the-shelf branded fonts)
- Multi-user / team features

---

## Success criteria for v0 (definition of "Orpheus works")

You, the user, open Orpheus in the morning and never think about it as "the app" — you think about your work. Specifically:

1. **Session recall is effortless.** You never hunt for a session. Whatever you were doing yesterday, the right session is just there at launch.
2. **Terminal never lags.** libghostty-quality typing, scrolling, resizing. You notice its smoothness for the first week, then stop noticing — which is the goal.
3. **Claude can drive the IDE.** You ask Claude to "open a new terminal in the frontend space" and it happens via `orpheus ...`. Symmetry of agency is real.
4. **Voice conversations work.** You hold a key, talk, Claude responds in voice, you can interrupt. It feels like a conversation, not a gimmick.
5. **Fork-to-side-pane works.** You hit a button, your current session forks into a new pane; both are alive.
6. **Ideas-inbox → scaffold closes the loop.** Thought → running agent in 30 seconds.
7. **Dashboards are useful, not decoration.** You check usage before starting a long session; you check the heatmap weekly.
8. **Git + automations + MCPs feel native to the IDE.** You don't leave Orpheus for PR creation, issue filing, dev-server starts, or MCP browsing.
9. **The app feels yours.** Typography, color, motion, materials are distinctive. Not a reskin; an identity.

---

## What happens next

This plan is ready to serve two audiences:

1. **You** — to iterate on shape, push back on sequencing, add/remove phases based on subsequent design discussions.
2. **A future build agent** — which will translate each phase into actual implementation tasks (file-level, code-level work). The agent consumes this plan + the two specs as its context.

Before Phase 0 can start, the **open design decisions blocking Phase 0** must be resolved:
- Final typeface pair
- Accent color direction + provenance story
- Baseline dark-mode palette values
- Baseline light-mode palette values
- Material tuning starter values

That's the next session: **design discussion**, targeting these specific unknowns.
