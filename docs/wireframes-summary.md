> **TL;DR**
> - 26 wireframes total (W1–W26). 22 locked, 4 archived (W22–W25).
> - The 3–5 most foundational surfaces to lock first in the Electron revamp:
>   **W1/W2** (Dashboard, the landing view), **W4** (space active + chat viewer — the daily-driver state),
>   **W3** (session picker — entry point into a space), **W18** (onboarding — first-run), **W9** (command palette — global escape hatch).
> - Archived post-launch: Extensions browser (W22), Git surfaces (W23), Automations (W24), Ideas Inbox (W25).
> - Biggest assumption tension: all wireframes assume native macOS materials (Liquid Glass, `NSOpenPanel`,
>   `NSOutlineView`, AppKit window chrome, system accent colors, SF Symbols). These have **no 1:1 Electron
>   equivalent** and every assumption will need a deliberate web-stack replacement decision.

---

## 1. Overview

`wireframes-v0.5.md` is the **locked, canonical Phase 0.5 wireframe set** for Orpheus, drafted on 2026-04-18–19 across 13 iterations. It covers all main-window states, overlays, modals, settings windows, menubar dropdowns, onboarding, voice surfaces, and a diff viewer — 26 wireframes in total. The file doubles as its own iteration log; every change is recorded in "Iteration history" above the wireframes index. Status notation: `✅ locked` / `🔄 in review` / `📦 archived`. All 22 active surfaces reached locked status on 2026-04-19. Four surfaces (W22–W25) were explicitly archived to post-v0 in iteration 12. No wireframes are in a partial or draft state. The doc references two companion specs: `docs/specs/design-principles.md` (LOCKED design tokens) and `docs/specs/quick-actions.md` (action dispatch logic), neither of which was reviewed in this reading.

---

## 2. Per-wireframe summary

### W1 — Main window: Dashboard (empty)
**Surface:** main-window / dashboard
**Status:** Locked
**What it shows:** Full window with toolbar (traffic lights, sidebar toggle, centered Search, user menu), left sidebar showing top nav (Dashboard/Sessions/New Space) and an empty Projects section, and a centered main-area welcome block with two CTAs: `[+ New project]` and `[Open folder...]`.
**Key design choice:** No Quick Actions footer when no active terminal exists.

---

### W2 — Main window: Dashboard (populated)
**Surface:** main-window / dashboard
**Status:** Locked
**What it shows:** Sidebar with Pinned section (if any), Projects list (single-row format: logo + name + count + chevron); main area has a 5×7 activity heatmap for both Claude Code and GitHub (last 30 days, no period toggle), then a split Projects list + Sessions list below.
**Key design choice:** Pinned section is hidden entirely when empty; heatmap period is fixed at 30d.

---

### W3 — Main window: empty space, session picker
**Surface:** main-window / session-picker
**Status:** Locked
**What it shows:** When a space exists but has no running terminals — centered picker with a primary "New Claude session" card (⌘Enter) and a scrollable list of resumable recent sessions (status + title + token count + age + `[Resume]`), plus `[ View all sessions ]` link.
**Key design choice:** Flow-first — the most common action (new Claude session) gets the most prominent card.

---

### W4 — Main window: space active, chat viewer + Quick Actions footer
**Surface:** main-window / chat-viewer (primary daily-driver state)
**Status:** Locked
**What it shows:** Two-row tab strip: Row A has session-title tabs on the left + `[ + Claude ]` / `[ + Term ]` create buttons on the right; Row B has spinner + session title + split `[|=|]` + close `[x]`; main area is the Claude chat viewer (collapsed tool-use accordions, inline file links, turn timing, cursor); footer has Quick Actions strip (`/fork /compact /resume [...]`) + ambient token/cost counter.
**Key design choice:** Two distinct create buttons (not a single overloaded `[+]`); tab labels are truncated session titles, not type prefixes; raw terminal view accessed only via `⌘` + backtick or right-click, not a persistent toggle.

---

### W5 — Sessions browser (cross-project split view)
**Surface:** main-window / sessions browser
**Status:** Locked
**What it shows:** Clicking `[T] Sessions` in sidebar opens a split view: left = virtualized session list with 2-line rows (title + project/space/tokens/branch/age), right = read-only chat preview of the selected session with two CTAs (`[Resume in current space]` / `[Open in new space]`). Filter: search + project + sort.

---

### W6 — Main window: space active, terminal view (raw)
**Surface:** main-window / terminal-view (secondary / escape-hatch state)
**Status:** Locked
**What it shows:** Identical chrome to W4 but main area shows unfiltered PTY stdout for the running `claude` process instead of the structured chat viewer. Row B carries a `(raw view)` marker. Quick Actions footer persists.
**Key design choice:** Raw view is a secondary access mode; no persistent toggle in the strip.

---

### W7 — Main window: split terminals (horizontal)
**Surface:** main-window / split-H
**Status:** Locked
**What it shows:** Two panes stacked vertically, separated by a double-line `══` divider. Each pane has its own mini-header (status + title + focused marker + `[|=|]` + `[x]`). Tab strip Row A aggregates all terminals across panes. Quick Actions footer targets the focused pane.
**Key design choice:** `(focus)` suffix marks the active pane; `⌘]` / `⌘[` cycle focus.

---

### W8 — Main window: split terminals (vertical)
**Surface:** main-window / split-V
**Status:** Locked
**What it shows:** Two panes side-by-side (≈35 chars each) separated by a `║` column divider with `╬` intersection on Row B. Row B hosts both pane headers. Allows nested splits in either direction.

---

### W9 — Command palette (⌘K)
**Surface:** overlay / command-palette
**Status:** Locked
**What it shows:** 80-char centered modal with a fuzzy filter input and four result groups: Actions (create/resume/fork with inline shortcuts), Projects (open by name), Sessions (resume cross-project), Quick Actions (inject/orchestrate). Empty groups auto-hide. Type prefixes `a:` / `p:` / `s:` / `q:` scope results.
**Key design choice:** Frecency-based ranking; Quick Actions fire in the focused terminal.

---

### W10 — New-project modal
**Surface:** overlay / creation-modal
**Status:** Locked
**What it shows:** 72-char modal with repo path input + `Browse folder...`, auto-derived project name, logo source radio (GitHub avatar / custom upload / identicon), and a checkbox to seed a Default Space with a Claude session.
**Key design choice:** Modal is gated by `show_project_creation_modal` setting (default on); disabled = skip to folder picker + auto-defaults.

---

### W11 — New-space modal
**Surface:** overlay / creation-modal
**Status:** Locked
**What it shows:** 72-char modal with space name input, working directory radio (inherit from project vs. worktree — worktree shown as disabled/experimental), and multi-select checkboxes to seed terminals (Claude / Shell / neither).
**Key design choice:** Multi-select checkboxes replace a "one-of" radio — reinforces the no-restriction principle; worktree option visible but disabled in v0.

---

### W12 — Settings window: Global
**Surface:** settings-window (separate macOS window, not overlay)
**Status:** Locked
**What it shows:** 88-char window with a left category sidebar (General / Appearance / Voice / MCP-Skills-KB / Shortcuts / Usage & API / Privacy / About) and a right content pane. General pane shows: creation modal toggles, startup behavior radio, tab strip preferences, usage indicator toggle, sidebar auto-collapse.
**Key design choice:** Settings apply immediately (no Save/Apply button); most non-General categories are placeholder at v0.

---

### W13 — Project Settings window
**Surface:** settings-window (separate macOS window, project-scoped)
**Status:** Locked
**What it shows:** Same 88-char shell as W12, scoped to a project. Categories: General, Spaces, Quick Actions, MCP/Skills, Git. General pane: name, repo path, logo source, default shell, pin toggle, Danger zone (`[Archive project]` / `[Delete project]`). Delete is permanent (SQLite record); does not touch the repo on disk.
**Key design choice:** Delete requires friction confirmation (type project name); all non-General categories noted as post-v0 substance.

---

### W14 — Menubar dropdown: Now tab (default)
**Surface:** menubar / popover
**Status:** Locked
**What it shows:** 64-char popover anchored to the menu bar icon. Constant header (`Orpheus` + live usage counter) and constant Quit row. Three tabs: `[*Now*]` / `[Projects]` / `[Sessions]`. Now tab shows: Active spaces (live terminals with status + project/space breadcrumb), Quick actions (New Claude session / Show Orpheus / Settings), Usage today (tokens + cost vs. plan quota).
**Key design choice:** Tab widths fixed so the layout doesn't shift on switch; header/Quit are constant across all tabs.

---

### W15 — Menubar dropdown: Projects tab
**Surface:** menubar / popover
**Status:** Locked
**What it shows:** Same shell as W14 with Projects tab content: Pinned section (expanded by default, shows spaces with status + terminal count), Projects section (collapsed by default), `[+] Add repository` at bottom.

---

### W16 — Menubar dropdown: Sessions tab
**Surface:** menubar / popover
**Status:** Locked
**What it shows:** Same shell as W14 with Sessions tab content: flat recent-sessions list (2-line rows: title + age; project/space breadcrumb), truncated to ~5 entries, plus `[View all sessions]` button that opens W5.
**Key design choice:** No "pick resume space" prompt in the menubar — speed is the priority; use W5 for more control.

---

### W17 — Main window: canvas mode
**Surface:** main-window / canvas-mode (alternate layout)
**Status:** Locked
**What it shows:** All terminals in a space rendered as free-floating, draggable tiles in the main area (no tab strip). Merged header bar has space title + `(canvas)` tag + `[+ Claude]` / `[+ Term]` / `[Exit canvas]`. Each tile has a mini-header (status + title + `[x]`) and scrollable content. Quick Actions footer is type-aware (Claude tile focused → Claude actions; shell tile focused → shell actions).
**Key design choice:** No enforced grid; no split icon; no top-level close; canvas-to-list toggle is per-space.

---

### W18 — Onboarding (first-run welcome)
**Surface:** main-window / onboarding
**Status:** Locked
**What it shows:** Shown only on true first launch (empty projects table). Centered 3-step explainer (Add repo → Default Space created → Start chatting) with two CTAs: `[+ Add repository]` and `[Open folder...]`. No Search in toolbar (nothing to search). After first project created, replaced by W2/W4 permanently.

---

### W19 — State patterns reference
**Surface:** reference / system-wide
**Status:** Locked
**What it shows:** Not a navigable screen — a pattern library defining four reusable widgets: empty state (centered message + CTA inside any list container), loading skeleton (shimmer gray blocks), error toast (top-right transient, auto-dismiss, 1-2 action buttons), error banner (persistent, top-of-surface, colored background).
**Key design choice:** Never blank on empty — always explain what will go here and how to populate it.

---

### W20 — Voice HUD: Full (hovering overlay, expanded)
**Surface:** overlay / voice-HUD (expanded)
**Status:** Locked
**What it shows:** ~60-char floating overlay sitting bottom-centered over the main chat area (not a modal — background stays interactive). Header: `[mic on]` state chip + state label (Listening / Speaking / Interrupted) + `[Stop]`. Body: live ASCII waveform + streaming transcript. Footer: `[Cancel]` + PTT key hint.
**Key design choice:** Three states (Listening/Speaking/Interrupted); compact chip W26 is the default — this HUD only shown when chip is clicked.

---

### W21 — Diff viewer (diffs.com-style, multi-file + collapsible files panel)
**Surface:** main-window / diff-viewer (replaces chat area when active)
**Status:** Locked
**What it shows:** Split layout within main area. Left panel: changed-files list (~23 chars, basename-only, with per-file `+adds -dels` stats) + `[Prev]` / `[Next]` navigation + aggregate total + `[<<]` collapse toggle. Right panel: unified diff body with `@@` hunk format + provenance line (which Claude session proposed this). Mode toggle `[*Unified*]` / `[Split]`. Actions: `[Accept]` / `[Reject]` / `[Editor]` / `[Accept and /compact]`. Files panel fully collapsible to give diff body the full main-area width.
**Key design choice:** Priority is horizontal space for code; filenames truncated to basename to achieve it.

---

### W22 — Extensions browser (MCP / Skills / KB)
**Surface:** main-window / extensions
**Status:** Archived (post-v0)
**What it shows:** Three-tab main-area view (MCP / Skills / KB) with left list (installed items, version, on/off toggle) and right detail (scope, tools exposed, Disable/Uninstall). Scope: global or per-project.

---

### W23 — Git surfaces (PRs / Issues / Actions / Branches)
**Surface:** main-window / git
**Status:** Archived (post-v0)
**What it shows:** Four-tab main-area view (PRs default). Left list: PR rows (number + title + author + age + state). Right detail: diff stats, CI checks, action buttons including `[Ask Claude]` (spawns Claude session with PR context) and `[Check out]`.

---

### W24 — Automations (Rules / Schedule / Running)
**Surface:** main-window / automations
**Status:** Archived (post-v0)
**What it shows:** Three-tab main-area view (Rules default). Left list: automation rules with on/off toggle + name + action summary. Right detail: trigger DSL preview, actions list, run history, Edit/Disable/Delete buttons.

---

### W25 — Ideas Inbox (capture + scaffold)
**Surface:** main-window / ideas-inbox
**Status:** Archived (post-v0)
**What it shows:** Top capture input (`⌘Shift+I`), then a split list (Unsorted / Scaffolded sections) + right detail with scaffold actions: `[Scaffold into project]`, `[Add to existing project]`, `[Archive]`, `[Delete]`.

---

### W26 — Voice HUD: Compact (toolbar chip, default)
**Surface:** toolbar chip (inline, non-modal)
**Status:** Locked
**What it shows:** While voice is active, a compact chip appears in the toolbar between Search and `[User v]`: `[ * 0:05  | | | | ]` — red recording indicator + elapsed time + mini waveform. Main area stays fully intact; a small inline `[Transcribing voice in background...]` note appears in the chat stream. Three chip states: Listening / Speaking / Interrupted. Click chip → expands to W20 full HUD.
**Key design choice:** Non-intrusive by default; modeled on the macOS screen-recording chip pattern.

---

## 3. Open questions raised in the doc

- Forking flow placement: Row B split icon vs. right-click vs. dedicated keyboard shortcut.
- Tool-use summary expansion: inline accordion vs. side drawer.
- Session title source: first-prompt truncated vs. user-named.
- Dormant-session visibility in sidebar: currently only via Sessions browser (W5); should dormant sessions surface anywhere in the sidebar?
- Project logo generation algorithm: seed-from-name vs. user-picked style.
- Heatmap longer periods (90d / year): explicitly deferred past v0.
- Preview pane default when no session selected in W5: show instructions, blank, or most-recent auto-selected?
- Project count semantics: `(3)` next to a project = total sessions? Active terminals? Live spaces? One must be chosen for v0.
- W21 split mode wireframe: the unified variant is shown; the split (side-by-side columns) variant is TBD.
- Space name default in W11: exactly how is it derived (branch name, date, convention)?
- Quick Actions catalog for shell tiles: `/clear`, `/copy-output`, `/restart`, `/pin` are placeholders; full catalog deferred to a quick-actions spec update.

---

## 4. Architectural assumptions baked into the wireframes

The following assumptions are Swift/AppKit-native and will need explicit Electron equivalents:

**Material / rendering:**
- Assumes Liquid Glass materials on the sidebar, toolbar, and overlays (translucency, vibrancy, backdrop blur). Web equivalent: CSS `backdrop-filter` or a flat design decision.
- Assumes AppKit window chrome (traffic lights `[o o o]` are real native controls, not rendered buttons).
- Assumes native macOS title bar integration and sidebar translucency.

**Native components:**
- "Browse folder..." buttons assume `NSOpenPanel` (native file picker). Electron: `dialog.showOpenDialog`.
- Sidebar expand/collapse state assumes `NSOutlineView`-style behavior. Web: a custom tree component.
- Settings window assumed as a separate macOS `NSWindow`, not a panel within the main window. Electron: `BrowserWindow` + possible `panel` window type.
- Menubar popover assumes macOS `NSStatusItem` + `NSPopover`. Electron: `Tray` + BrowserWindow popover equivalent.

**Terminal rendering:**
- All terminal panes (chat viewer, raw view, splits, canvas tiles) assume libghostty rendering as a native `NSView` embedded in the app. In Electron, this becomes a `<webview>` or IPC-bridged xterm.js / ghostty-wasm instance — latency, scrollback, and font rendering will differ.
- The rich chat viewer (collapsed tool-use accordions, inline file links) is a custom renderer layered over the PTY stream. This layer must be reimplemented in React/DOM regardless of stack.

**Typography / iconography:**
- Assumes SF Symbols for all glyphs (`[D]`, `[T]`, `[g]`, `[i]`, `[~]`, etc.). Web: SVG icon set (Lucide, Heroicons, or custom).
- Assumes SF Pro / system font stack and macOS native font rendering. Web: CSS font stack with potential rendering differences.

**Density / spacing:**
- Wireframe column widths are fixed: `sidebar = 28 chars`, `main = 71 chars`, `total = 102 chars`. These are ASCII layout coordinates, not pixels. The actual pixel density is unspecified and assumed to follow macOS HIG defaults. Electron will need an explicit design-token pass to map these to real px/rem values.
- Settings windows at 88 chars wide; overlays at 72 or 80 chars wide — same translation needed.

**Platform affordances:**
- `⌘K`, `⌘N`, `⌘T`, `⌘,`, `⌘Enter`, `⌘Shift+C`, `⌘Shift+I`, `⌘W`, Fn-key PTT — all assume standard macOS key bindings. Electron can bind these but must ensure they don't conflict with browser defaults or Chromium shortcuts.
- Right-click context menus assume native `NSMenu`. Electron: `Menu.buildFromTemplate`.
- Canvas mode tile drag-and-drop assumes a smooth 60fps native drag. Web: `react-dnd` or pointer-events equivalent.
- Voice: W20/W26 assume on-device or cloud Whisper transcription and TTS playback. Electron has `MediaDevices` API but requires explicit mic-permission handling.

**State persistence:**
- All session/space/project state stored in `orpheus.sqlite` (referenced in architecture). In Electron, SQLite via `better-sqlite3` or similar is a direct equivalent, so this assumption is safe.
- Canvas tile positions stored in `spaces.layout_spec`. Serialization format TBD (JSON blob in SQLite, noted but not specified).
