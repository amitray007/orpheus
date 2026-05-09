# Phase 0.5 Lore — conversational + decision context from 13 iterations

**Purpose:** preserve the non-obvious context, reasoning, and implicit conventions from the Phase 0.5 wireframing sessions (2026-04-17 through 2026-04-19) that would otherwise be lost if a new session picks up the project. The wireframes file and session logs capture *what* — this file captures *why*, *how we got here*, and *what a new session would miss*.

---

## 1. Decision chains — why we landed where we did

Non-obvious calls where the final design is the result of a reversal or multi-step refinement. If you reopen a wireframe without knowing these, you might re-introduce a problem we already solved.

### Tab-strip affordances — three rewrites

- **Iteration 1**: `[+]` in Row A opened a dropdown with New Claude / New Shell / Resume. **Rejected** as too much friction for the common case (creating a new Claude session).
- **Iteration 2 → 5**: `[+]` directly spawns a new Claude session. `⌘T` = shell, `⌘R` = resume picker, right-click `[+]` = dropdown alt. "Flow-first" — single click to working state. Approved and locked.
- **Iteration 6**: user flagged "[+] as weird button that creates specific things" + "tab labels like `[ /claude ] [ shell ]` are type-prefixed." Reopened W4/W6/W7/W8. Rewrote Row A to:
  - Two explicit create buttons on the right: **`[ + Claude ]`** (primary, accent color) and **`[ + Term ]`** (secondary). Claude gets visual priority because the app is built for Claude Code.
  - Tabs show **truncated session titles** (`[ CPU opt ]`, `[ fork ]`, `[ zsh ]`) — not type prefixes.
  - Removed the `[+- Terminal]` / `[+- Chat]` view toggle; raw terminal view reached via `⌘`` or right-click (W6 still exists, but as a secondary view).
- **Lesson**: the user strongly prefers explicit, first-class affordances over single-button-with-alt-gestures. Claude gets visual priority everywhere.

### "Main space" → "Default Space"

- **Iteration 4**: W10 new-project modal had `[x] Create "Main" space with one Claude session`.
- **Iteration 5**: renamed to `"Default Space"` per user. The word "Default" signals "this is what you get unless you change it" better than "Main."
- Applies everywhere the auto-seeded first space is referenced.

### Initial-terminals radio → seed-terminals checkboxes

- **Iteration 4**: W11 new-space modal had `(*) One Claude session / ( ) One shell / ( ) Empty (add later)`.
- **Iteration 5**: user flagged "we will never restrict users to create only one claude, or one terminal session for this." Changed to `[x] Claude session / [ ] Shell` (multi-select checkboxes). Empty = leave both unchecked. Text label `Seed terminals (optional)` reinforces "add more any time after."
- **Principle captured**: no "one of X" restrictions at any layer.

### Creation modals → gated by settings

- **Iteration 5**: user flirted with "skip the W10 modal entirely, just use folder picker + defaults." Settled on: **modal visible by default, toggleable via general setting**. Two toggles:
  - `show_project_creation_modal` (default `true`) — W10
  - `show_space_creation_modal` (default `true`) — W11
- When disabled: skip modal, use sensible defaults (folder picker only + auto-detect; auto-named space with default seed).
- Settings can be edited later via right-click project/space → Settings.
- Both toggles live in W12 Settings → General.

### Menubar dropdown — flat → tabbed (3 tabs)

- **Iteration 7**: single scrolling dropdown with sections (Active now, Recent sessions, Quick, Usage, Quit).
- **Iteration 8**: user said "we can have tabs in the menu bar such that first the default one would show Active spaces, Quick options, Usage Today. 2nd Tab would be Projects list / spaces. 3rd Tab would be to show only sessions list."
- Rewrote as **3 tabs** with a constant header (Orpheus + usage) and constant Quit row:
  - W14 — Now (default) — Active spaces + Quick + Usage today
  - W15 — Projects — pinned + project list + Add repository
  - W16 — Sessions — flat recent-sessions list + View all
- Tab selection shown as `[*Now*]` / `[*Projects*]` / `[*Sessions*]` (asterisks in brackets; same width as unselected `[ Label ]` so layout doesn't reflow).

### Voice HUD — single full → two variants (compact + full)

- **Iteration 11 → 12**: W20 standalone HUD (80 chars). User said "show it in complete desktop UI." Redrew as composite overlay in main window (102 chars with HUD floating).
- **Iteration 13**: user said "we should have two versions. 1st the current one (approved). 2nd smaller compact beside the User in toolbar. Recording style. Default is compact. The full should be hovering."
- **Added W26** — **Compact Voice HUD** (toolbar chip: `[ * 0:05  | | | | ]`) as the **default** voice state. Lives between Search and `[User v]`. Non-intrusive; chat viewer stays visible.
- **W20** is the expanded variant — click the chip to open it.
- **Two-variant HUD model**: W26 is default; W20 is opt-in expansion. Both reflect the same underlying voice-loop state.

### Canvas mode — chrome diet

- **Iteration 9**: W17 canvas mode with same chrome as default (tabs + Row B with split icon + top-level `[x]` + `[+- Terminal]` toggle).
- **Iteration 10**: user said "canvas doesn't need the top tabs bar, the split thingy, or X icon at top. Merge the two bars." Rewrote to:
  - **Single merged header bar**: `/ My Space (canvas)    [+ Claude]  [+ Term]  [ Exit canvas ]`.
  - No tab strip (redundant — tiles are the canvas).
  - No split icon.
  - No top-level `[x]` (tiles have their own close; space-level closure is sidebar-level right-click → Archive/Delete).
  - `[ Exit canvas ]` button added inline to return to list mode.
- **Quick Actions become type-aware per focused tile**: Claude tile → Claude actions; shell tile → shell actions (`/clear`, `/copy-output`, `/restart`, `/pin` placeholder set). Principle applies in **all** layout modes, not canvas-only.

### W22-W25 archived (not in v0)

- **Iteration 12**: user said "we will think of MCP/Skills/KB / Git surfaces / Automations / Ideas Inbox later. Save the design, mark as archived." Explicit scope framing: "once we launch our base and few features, we'll come back."
- All four wireframes preserved in the doc (status `📦 archived`); rationale in `docs/future-scope.md` § "Post-launch feature wireframes." **Do not re-activate without user go-ahead.**

### Diff viewer — W21

- **Iteration 11**: single-file unified-diff view.
- **Iteration 12**: user said "use diffs.com UI + file view for changed files + unified/split toggle." Rewrote as diffs.com-inspired: left panel (file list + per-file stats + Prev/Next) + right panel (diff body) + `[*Unified*]  [ Split ]` toggle in header. Multi-file.
- **Iteration 13**: user said "files panel should be collapsible so we get more space to read diffs. Prioritize diff space." Added `[<<]` collapse button in files-panel header; narrowed file list to ~23 chars (basenames only, full path on hover); documented collapsed variant as a mini-ASCII inline in the wireframe. Collapsed state is **sticky** (per-app preference).

### Delete Project added (W13)

- **Iteration 8**: user requested a Delete Project button alongside Archive. Added a **Danger zone** section in W13. Delete is permanent (removes SQLite record; does NOT touch repo on disk). Requires destructive-confirmation sheet (type project name).

### Notifications → future-scope

- **Iteration 10**: user flagged macOS native notifications as a concern after W14-W16 menubar work. Added entry in `docs/future-scope.md` § Notifications. Not in v0 — v0 covers in-app surfaces (main window, menubar, W19 toasts/banners). Revisit when users report missing events, or when automations feature lands.

---

## 2. ASCII conventions reference

Every glyph / tag / width / divider pattern used across the 26 wireframes, consolidated so future work stays consistent.

### Widths (pipes at specific columns)

- **Main window**: 102 chars total. Pipes at cols 1, 30, 102. Sidebar = cols 2-29 (28 chars). Main area = cols 31-101 (71 chars).
- **Modals**:
  - 72 — W10 new-project, W11 new-space
  - 80 — W9 command palette
  - 88 — W12 global Settings, W13 project Settings
- **Overlays in main area**:
  - 60 — Voice HUD (full) inside main area (W20)
  - 64 — Menubar dropdown (W14/W15/W16)
  - 80 — Voice HUD standalone (original W20, now composite)

### Inner-area layouts

- **Chat viewer main area** (71 chars): 3 leading + content.
- **Split-view list/detail** (like W5 Sessions browser, W22 Extensions, W23 Git, W24 Automations, W25 Ideas):
  - 3 leading + 32-char list + 1 `│` + 30-char detail + 5 trailing = 71
  - Divider row: `   ────────────────────────────────┬──────────────────────────────     ` with `┬` at col 36
- **Diff viewer** (W21): 3 leading + 22-char file list + 1 `│` + 1 space + 36-char diff + 8 trailing = 71 (approx — adjust to fit content)
- **Split terminals**:
  - Horizontal (W7): `══════` double-line divider between stacked panes
  - Vertical (W8): 35-char pane + 1 `║` + 35-char pane. Row B divider uses `╬` at the intersection.

### Glyphs

- `o o o` — traffic-light window controls (three dots)
- `<|` — sidebar toggle
- `[D]` `[T]` `[+]` — sidebar nav icons (Dashboard / Sessions / New Space)
- `[g]` `[i]` `[~]` — project logo stand-ins (GitHub auto / uploaded custom / generated identicon)
- `[ + Claude ]` / `[ + Term ]` — create-terminal buttons (Claude primary)
- `*` `o` `.` — active steady / dormant / inactive status glyphs
- `/` `-` `\` `|` — spinner cycle (Claude mid-response)
- `#` `@` — heatmap intensity (heavy / max)
- `v` `>` — chevron expanded / collapsed
- `+-` / `|=|` / `x` — toggle / split / close icons
- `└` — tree-branch line
- `!` — error / warning glyph
- `✓` — success glyph (used in future variants)
- `████` — loading-skeleton placeholder block
- `[ * 0:05 | | | | ]` — compact Voice HUD chip (red rec dot + time + mini waveform)

### State / mode tags (appended to space titles / tab titles)

- `(focus)` — marks the focused pane in a split view
- `(raw view)` — W6 raw terminal mode
- `(canvas)` — W17 canvas layout mode
- `(fork of X)` — lineage callout on forked sessions (placeholder for future lineage tracking)

### Tab selection convention

- Selected: `[*Label*]` — asterisks **inside** the brackets
- Unselected: `[ Label ]`
- **Widths match** so switching doesn't reflow (`[*Now*]` = `[ Now ]` = 7 chars; `[*Projects*]` = `[ Projects ]` = 12 chars)

### Form element conventions

- `[x]` / `[ ]` — checkbox
- `(*)` / `( )` — radio
- `[  value                ]` — text input
- `[  value              v ]` — dropdown (value + chevron at end)
- `[  Action  ]` — button
- `[ Action ]` — compact button (less padding)

### Section dividers

- `──────` (single) — within a wireframe (below headers, inside panels)
- `══════` (double) — split-pane boundary (horizontal split)
- `║` / `╬` — split-pane boundary (vertical split + intersection)

---

## 3. Product principles (the non-negotiables)

Surfaced during iteration; captured at the top of `wireframes-v0.5.md` but worth re-stating:

1. **Unrestricted multi-session.** A space holds **any number** of Claude sessions, shells, splits, forks. UI never forces "one of X" at creation or operation time.
2. **Flow-first creation.** Single-click to working state for common paths. Explicit buttons, not overloaded gestures.
3. **Gated creation modals.** Project- and space-creation modals are visible by default but gated by general settings. Disabling skips the modal in favor of folder-picker-and-defaults.
4. **Type-aware Quick Actions.** Claude terminals get Claude actions; shell terminals get shell actions. Applies in every layout mode.
5. **Claude gets visual priority.** This tool is built for Claude Code. `[ + Claude ]` is the accent-color primary; `[ + Term ]` is secondary; chat viewer is the primary surface over raw terminal.
6. **Content over chrome.** Collapse, hide, or minimize chrome when it competes with primary content (diff viewer files panel collapse, compact voice HUD default, raw terminal view via keyboard not a toggle button).
7. **Voice non-intrusive by default.** Compact chip in toolbar; full HUD on opt-in expansion.
8. **Sessions are first-class.** Session management is THE daily pain; Orpheus is built around solving it — hence W5 Sessions browser, sidebar `[T] Sessions` top nav, Sessions menubar tab, resume affordances everywhere.
9. **Symmetry of agency.** Every UI action has a CLI equivalent (`orpheus` binary); every CLI capability surfaces in Quick Actions or the command palette. See `docs/specs/quick-actions.md`.

---

## 4. Cross-wireframe relationships

Changing one wireframe often means updating others. These groups share structure:

### Tab strip Row A + Row B (W4 / W6 / W7 / W8)
All four use the same tab strip:
- Row A: tab list + `[ + Claude ]` + `[ + Term ]`
- Row B: focused session title + Row B controls (or per-pane headers in splits)
If you change Row A or B in one, propagate to the others.

### Menubar tabs (W14 / W15 / W16)
- Shared: header (`Orpheus` + usage), tab strip `[ Now ] [ Projects ] [ Sessions ]`, Quit row at bottom.
- Only the **middle content** changes between tabs.
- Change the header or Quit row → touches all three.

### Modal shell (W10 / W11)
- Same 72-char centered overlay shell.
- Header: `<Title>` + `[ x ]` close.
- Footer: `[ Cancel ]  [ Create ]`.
- Gated by matching settings.

### Settings window shell (W12 / W13)
- Same 88-char separate window structure.
- Left sidebar (categories) + right pane (selected category content).
- Change persistence: immediate (no Save/Apply button; matches macOS System Settings).

### Voice HUD two-variant (W20 / W26)
- **Not parallel wireframes.** They are one surface in two states:
  - W26 = compact (default)
  - W20 = full (opt-in expansion)
- Click the compact chip → expands to full. Dismiss full → collapses to compact.

### W19 state patterns — applies everywhere
Empty, loading skeleton, error toast, error banner patterns are **conventions**, not a screen. Any list/view that can be empty/loading/error uses these. Update W19 → implicit update to the rendering guidance for every list screen.

### Diff viewer collapsed ↔ expanded (W21)
- Two states of one surface, not two wireframes.
- Collapsed state is shown inline in W21 as a mini-ASCII.
- State is sticky (per-app preference).

---

## 5. Unresolved ambiguities / spec gaps

Things the wireframes reference but don't fully define. Flag these for the Phase when they become load-bearing.

| Question | Where it matters | Suggested Phase to resolve |
|---|---|---|
| Project count semantics `(3)` — total sessions? active terminals? live spaces? | Sidebar project rows (W2+), project cards | Phase 1 (Core Foundation — when data model lands) |
| Project logo generation algorithm (identicon seed — from name? full path? hash?) | W10 new-project, W13 per-project settings | Phase 1 or Phase 4 (Dashboards, when logos render) |
| Session title source — first-prompt truncated? user-named? which wins? | Sidebar sessions, W5 Sessions browser, Command palette | Phase 3 (chat viewer) |
| Tool-use summary expansion UX — inline accordion vs. side drawer | W4 chat viewer | Phase 3 (chat viewer mechanics spec) |
| Forking flow placement — Row B split icon vs. right-click vs. keyboard | W4+ | Phase 3 (probably combine with `[|=|]` split spec) |
| Dormant-session visibility in sidebar — currently only via Sessions browser; should dormant sessions appear nested under spaces too? | W2+, sidebar | Phase 3 or 4 |
| Preview pane default when no session selected (W5) — instructions / empty / most-recent? | W5 Sessions browser | Phase 3 |
| Heatmap longer periods (90d / year) | W2 Dashboard | Post-v0 |
| Split-view "split-v" shortcut icon placement | Tab strip Row B | Phase 2 / 3 |
| Canvas layout-spec persistence format | W17, `spaces.layout_spec` column | Phase 1 (data model) + Phase 4 (canvas render) |
| Worktree-per-space isolation option (future-scope) | W11 (visible-disabled in v0) | Post-v0 |
| Shell-specific Quick Actions catalog — full set | Quick Actions for shell terminals (canvas + split + list) | Phase 4 (extend quick-actions.md) |

---

## 6. Terminology glossary

Precise meanings — diverging from these creates confusion in the code + specs.

- **Terminal** — the primitive. A PTY running a command.
- **Claude session** — a terminal running `claude` (with `--session-id`, `--resume`, or `--fork-session`). Its `cc_session_id` ties it to a JSONL file under `~/.claude/projects/`.
- **Shell** — a terminal running the user's default shell (zsh / bash / fish / etc.).
- **Chat viewer** — the rich renderer over a terminal's stream (tool-use accordions, inline file links, per-turn timing). Claude-specific.
- **Raw terminal view** — the plain stdout renderer over the same PTY. Available for any terminal (Claude or shell); automatic for shells; on-demand for Claude tabs (W6 / keyboard `⌘``).
- **Same-PTY rule**: chat viewer and raw terminal are **two renderers over one stream**. They're not two separate sessions.
- **Space** — holds N terminals. Has its own layout mode (list or canvas) stored in `spaces.layout_spec`.
- **Project** — holds N spaces. Bound to a git repository path (or arbitrary folder).
- **Fork** — a new Claude session started from an existing one via `claude --resume <id> --fork-session`. Preserves history to the fork point; diverges after.
- **Layout mode (per-space)** — either **list mode** (chat viewer + tab strip, the default) or **canvas mode** (free-arranged tiles).
- **Type-aware quick action** — a quick action whose catalog depends on the focused terminal's type (Claude vs shell).
- **Symmetry of agency** — every UI action has a CLI equivalent (`orpheus` binary on PATH); every CLI capability surfaces in quick actions or command palette. Keeps user + Claude-self-driving at parity.
- **Self-drive CLI** — the `orpheus` binary that Claude can invoke from inside any hosted terminal to drive Orpheus (e.g., `orpheus spaces create`, `orpheus session fork --current`).
- **Dormant** (`o`) — a session that exists but has no active terminal. Can be resumed.
- **Active steady** (`*`) — terminal is alive but idle (no Claude response in progress).
- **Mid-response** (`/` `-` `\` `|` spinner) — Claude is currently generating a response in this terminal.
- **Default Space** — the auto-created first space in a new project. Previously called "Main space"; renamed in iteration 5.
- **Compact HUD** (W26) — default voice state; toolbar chip.
- **Full HUD** (W20) — opt-in expanded voice state; hovering overlay.
- **Canvas tile** — a terminal rendered as a free-positioned mini-frame inside a canvas-mode space.

---

## 7. Iteration history — one-liners

Compressed timeline of the 13 iterations. Full detail in `docs/wireframes/wireframes-v0.5.md` → "Iteration history" section.

1. **Initial Superset-inspired structure** — two-row tab strip, sidebar with top nav + project tree + add repository, chat viewer as primary main-area surface, tabs as UI switcher (not hierarchy entity).
2. **Dashboard rework + flow-first + logos + quick actions footer** — Workspaces → Dashboard (with heatmaps + project cards + recent sessions), per-project logos, spinner activity indicators, pinned section conditional, `[+]` = direct new-Claude, Quick Actions footer strip.
3. **30d-only heatmap + cleaner sidebar rows + split dashboard** — heatmap period toggle removed, sidebar project rows consolidated to single row, Dashboard replaced project card grid with split Projects-list + Sessions-list layout.
4. **Terminal view + splits H/V + command palette + new-project/new-space modals** — filled out the chrome/navigation story (W6-W11).
5. **W10/W11 polish + core flexibility principle + W10/W11 locked** — "Main" → "Default Space," initial-terminals radio → multi-select checkboxes, modal-visibility toggles added, unrestricted-multi-session principle captured in file header.
6. **Tab strip rework** — `[+]` single button replaced with `[ + Claude ]` + `[ + Term ]` (Claude primary). Tab labels became session titles (not type prefixes). View toggle removed. W4/W6/W7/W8 reopened, then re-locked.
7. **Settings + Project Settings + Menubar (first draft)** — W12, W13, W14 drafted.
8. **W12/W13 locked + Delete Project + Menubar tabbed** — W14 reworked into 3 tabs (Now / Projects / Sessions); W15, W16 added. Danger zone (Archive + Delete) added to W13.
9. **State surfaces batch** — W17 canvas, W18 onboarding, W19 state patterns reference.
10. **Canvas mode reworked + notifications to future-scope** — W17 merged the top two bars, removed split icon + top-level close, added `[ Exit canvas ]`. Type-aware Quick Actions principle captured. macOS notifications added to future-scope.
11. **Final batch of 6 specialized surfaces** — W20 voice, W21 diff, W22 extensions, W23 git, W24 automations, W25 ideas.
12. **W20 composite + W21 diffs.com rework + W22-W25 archived to post-v0** — W20 redrawn as desktop overlay, W21 multi-file with unified/split toggle; four surfaces moved to future-scope.
13. **W20 locked as Full; W26 Compact Voice HUD added as default; W21 files panel made collapsible** — two-variant voice HUD, diff viewer prioritizes diff space.

**Final lockdown**: all 22 active v0 wireframes locked. 4 archived. Phase 0.5 complete.

---

## 8. Product insights surfaced during iteration

Things I didn't know before the iterations that shaped the design. Useful context if you're restarting and wondering "why is it like this?"

### Session management IS the daily pain
Orpheus is built around the observation that Claude Code's CLI is excellent, but session management (which session for which project? how to resume? where did that conversation go?) is a daily frustration. The entire Phase 0.5 wireframe set reflects this — `[T] Sessions` is a top-level nav item, W5 Sessions browser is first-class, menubar has a dedicated Sessions tab (W16), resume affordances appear in multiple places (W3 empty-space picker, W5, W16, command palette W9).

### Everything is a terminal (but Claude is special)
The clean mental model is: a terminal is a PTY running a command. Claude sessions are terminals running `claude`. Shells are terminals running zsh. This lets UI components treat them uniformly at the low level — **but** the product intentionally gives Claude visual priority (primary create button, primary chat viewer, default rich rendering) because the app exists for Claude Code specifically. If someone argued "these should all be the same button / same renderer," they'd be technically right but missing the product point.

### Symmetry of agency is a first-class principle
The `orpheus` binary on PATH is designed so Claude Code (running inside Orpheus) can drive Orpheus — spawn new spaces, fork sessions, open the sessions browser, etc. This symmetry is why many UI affordances have corresponding CLI commands in `docs/specs/architecture.md` § Self-Drive CLI. When adding new surfaces, ask "does Claude need a way to trigger this from inside a terminal?" If yes, it belongs in the self-drive CLI + command palette + quick actions.

### Chat ↔ raw terminal is a rendering distinction, not a session distinction
Originally the wireframes suggested terminal view and chat viewer were separate things. They're not — they're two renderers over the same PTY stream. This means:
- Input routing always goes to the same PTY regardless of which view is active.
- Switching views (⌘`) doesn't touch the underlying session.
- Rich rendering only applies when it's Claude output; for shell output, the chat viewer auto-falls-back to raw.

This distinction matters for Phase 3 (chat viewer implementation) — there's one input layer and one data stream; the renderer is a view concern, not a state concern.

### Wireframe alignment drift is a real problem
During iterations 1-3 we repeatedly had "the wireframe has spacing inconsistencies so it's hard to visualize." Root cause: Unicode glyphs (●○🜛⌘⊙📌) rendered at inconsistent widths across monospace fonts. Fix: pure ASCII inside cells, box-drawing only for borders, **Python width verification** before every commit. The width verifier script lives at `/tmp/orpheus-wireframes/verify.py` and the pattern is in every iteration's session file. If future iterations add wireframes, keep the Python verification.

### Superset-style for structure, but product-specific for detail
Early iterations referenced Apache Superset's layout (two-row tab strip, sidebar structure). User was clear: "I only care about Superset Design, lets learn from them." Don't clone — distill patterns and adapt. The tab strip, sidebar layout, and chat-viewer-primary decisions came from that distillation. Don't revisit Superset as a reference for anything else (it's a BI tool; we're not).

### Ambient vs. intrusive signals
Multiple iterations landed on the pattern: live state should be **ambient** (footer usage counter, menubar chip, sidebar activity dots) — always visible, never demanding attention. Intrusive signals (modals, overlays, toasts) should be rare and earned. The compact Voice HUD (W26) is the canonical example: voice recording is always-visible ambient (chip in toolbar) rather than always-intrusive (full HUD overlay).

### "Flow" is a measurable constraint
"Don't break my flow" was repeated by the user across sessions. It became a design constraint: single-click to working state, no dropdown-to-confirm for common actions, keyboard-first where possible, settings-gated modals for users who want zero-friction creation. When evaluating a new affordance, ask: does it cost a flow-break? If yes, is the flow-break earned?

### Lineage / forking is ergonomically tricky
Fork-to-side-pane was identified early as important but lineage tracking (this session forked from that session — 3 levels deep?) is genuinely unsolved. Iteration 6 added a placeholder `(fork of /claude)` label on forked tabs but real lineage tracking is deferred. If forking becomes heavily used, lineage UX will need its own pass.

### macOS-native where it fits, custom everywhere else
We use macOS-native patterns for Settings (separate window, no Apply button, categories in left sidebar) and menubar (popover). We go fully custom for tab strip, chat viewer, command palette, voice HUD, modals. The discipline: **never stock SwiftUI controls** extends to UX patterns too — if stock macOS UX fits, use it; if it's generic or dated, replace it.

---

## How to use this file

- **If you're reopening the project after a long gap:** skim sections 1 (decisions), 3 (principles), 7 (iterations), 8 (insights). Refresh the mental model before opening any wireframe.
- **If you're adding a new wireframe to v0.6+:** read section 2 (ASCII conventions), section 3 (principles), section 4 (cross-wireframe relationships), section 6 (terminology). Honor the conventions; don't re-establish new ones.
- **If a user asks "why does X work this way?":** search section 1 (decision chains) first, section 8 (insights) second. If not there, it may be a spec-file detail.
- **If you need to resolve an ambiguity:** check section 5 (spec gaps). These are the known open questions.
- **If you're writing a behavior spec:** section 6 (terminology) is the glossary to honor.

This file is meant to be long-lived but not exhaustive. Update it when:
- A major design reversal happens (add to section 1).
- A new ASCII convention or width is introduced (add to section 2).
- A principle gets explicitly reframed (section 3).
- A new spec gap is surfaced (section 5).
- A new term-of-art emerges (section 6).

Do not update it with minor tweaks — those belong in the wireframes file's iteration history.
