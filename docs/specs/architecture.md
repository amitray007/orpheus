# Orpheus — Architecture Specification

**Status:** Locked 2026-04-18 (session `2026-04-18-HHmm-decide-architecture-native-stack.md`)
**Supersedes:** none (first architecture lock)
**Scope:** v0 architecture commitments. Cross-platform, ACP portability, daemon/mobile/web are explicit future-phase concerns.

---

## Guiding commitments

These are non-negotiable constraints that shape every downstream choice.

1. **Closed-source, Mac-native.** No AGPL fork, no ELv2 fork. Fresh build. Mac-first; cross-platform possibly later, not a v0 constraint.
2. **Terminal is the center of gravity.** It must never feel laggy or clunky. Terminal fidelity beats every other axis of convenience.
3. **Claude Code only for v0.** ACP / multi-agent support deferred.
4. **Symmetry of agency.** Any action the user can take, Claude can take through the self-drive CLI.
5. **Everything custom, nothing framework-forced.** Every visual decision intentional. No stock SwiftUI defaults in user-facing code. A custom `OrpheusDesign` Swift Package is the only source of styled components.
6. **Fully native across all surfaces.** No WKWebView panels. Chat viewer, diff viewer, dashboards, charts, heatmap — all built in SwiftUI/AppKit with a custom native stack. No web escape hatch in v0.
7. **Strict hierarchy.** Project ▸ Space ▸ Terminal. A terminal cannot live outside a space. Tabs are NOT a hierarchy level — removed in the 2026-04-18 simplification; Spaces are the primary unit of work context.
8. **Terminal persistence is critical.** Scrollback persists across restarts; force-close survival; auto-reopen of all open terminals on relaunch.

---

## Stack

```
┌────────────────────────────────────────────────────────────────┐
│ Shell:   AppKit (NSWindow, NSWindowController, layout)         │
│          + SwiftUI via NSHostingView / NSHostingController     │
│          + AppKit-in-SwiftUI via NSViewRepresentable           │
├────────────────────────────────────────────────────────────────┤
│ Design:  OrpheusDesign Swift Package (mandatory — no stock)    │
│          • DesignTokens (typography, colors, spacing, radii,   │
│            materials, motion)                                  │
│          • Custom ButtonStyle / ToggleStyle / MenuStyle / etc. │
│          • Iconography system                                  │
│          • Chart primitives (Swift Charts tuned)               │
│          • Motion primitives (spring tokens)                   │
├────────────────────────────────────────────────────────────────┤
│ Terminal: libghostty in NSView (Swift/C FFI bindings)          │
│          Metal-accelerated, native font rendering, low latency │
│          Handles PTY internally (no portable-pty)              │
├────────────────────────────────────────────────────────────────┤
│ Rich     OrpheusMarkdownView  — AttributedString markdown      │
│ content  OrpheusCodeView      — TextKit 2 + SwiftTreeSitter    │
│ (native) OrpheusDiffView      — TextKit 2 + custom gutter      │
│          OrpheusChart         — Swift Charts tuned with tokens │
│          OrpheusHeatmap       — custom Canvas drawing          │
│          No WKWebView panels. Full rendering stack purity.     │
├────────────────────────────────────────────────────────────────┤
│ Core:    Swift (single language)                               │
│          • Session registry (reads ~/.claude/projects/)        │
│          • JSONL watcher (FSEvents)                            │
│          • Subprocess manager (spawn `claude` with flags)      │
│          • SQLite persistence (GRDB.swift + FTS5)              │
│          • JSON config files (global + per-project)            │
│          • Unix socket daemon for self-drive CLI               │
├────────────────────────────────────────────────────────────────┤
│ Voice:   AVFoundation (native)                                 │
│          • AVAudioEngine for mic capture                       │
│          • AVPlayer/AVAudioPlayer for streaming TTS            │
│          • Mid-turn interrupt via cancellation                 │
├────────────────────────────────────────────────────────────────┤
│ CLI:     `orpheus` binary (separate Swift target, same project)│
│          JSON-RPC over unix socket at                          │
│          ~/.orpheus/orpheus.sock                               │
└────────────────────────────────────────────────────────────────┘
```

---

## Layers in detail

### 1. Shell — AppKit + SwiftUI interop

**Pattern:** AppKit as the foundation for window management, advanced controls, and hosting libghostty. SwiftUI for declarative subviews composed inside AppKit windows via `NSHostingView` / `NSHostingController`. For the rare case where AppKit needs to live inside a SwiftUI tree, `NSViewRepresentable` / `NSViewControllerRepresentable`.

**Why both, not SwiftUI-only:** libghostty needs an `NSView` for Metal rendering. Custom window chrome (hidden title bar, custom traffic-light positioning) is cleaner in AppKit. Complex text rendering uses TextKit 2 through AppKit. SwiftUI is great for declarative panels and state-driven subviews but not the full stack.

**Window model:** one `NSWindow` per Orpheus window. Multi-window support via standard AppKit. Window state (position, size, full-screen) persisted per-project.

---

### 2. Terminal — libghostty

**Library:** [libghostty](https://ghostty.org/) (Mitchell Hashimoto's terminal emulator exposed as a C library). MIT licensed. GPU-accelerated via Metal on macOS.

**Integration:** Swift bindings to libghostty's C ABI (either existing Swift bindings from Ghostty's macOS app if extractable, or hand-written). Hosted inside an `NSView` subclass (`OrpheusTerminalView`). Receives key events, handles font rendering, manages PTY lifecycle internally.

**What libghostty owns:** PTY spawning/piping, character grid, scrollback buffer, ANSI/CSI/OSC parsing, font shaping, glyph atlas, Metal rendering, cursor, selection, mouse handling, link detection, image protocols (Kitty graphics).

**What Orpheus owns around it:** window layout, split management within a space, scrollback persistence hooks, session attachment, quick-action injection (sending text to PTY stdin), theme tokens.

**Fallback:** if libghostty integration hits blockers, SwiftTerm + custom Metal renderer is the escape hatch. Not planned.

---

### 3. Rich content — fully native

All rich content surfaces are native SwiftUI/AppKit components styled by `OrpheusDesign`. No WKWebView in v0.

| Surface | Implementation | Reference |
|---|---|---|
| Chat viewer | `TextKit 2` + `AttributedString` markdown rendering + inline code blocks + tool-call toggles + streaming token rendering | Raycast's AI conversation UI |
| Code view | `TextKit 2` + `SwiftTreeSitter` for syntax highlighting + custom theme | Xcode, Ghostty's preferences editor |
| Diff viewer | `TextKit 2` + custom gutter drawing + custom line-level highlighting | Cursor 3's unified multi-file diff |
| Dashboards | Swift Charts (tuned with `OrpheusDesign` tokens) | Apple Fitness, Xcode Instruments |
| Heatmap | Custom `Canvas` drawing (GitHub-style grid) | GitHub profile, Linear analytics |
| MCP / Skills / KB browser | `OrpheusList` + custom detail views | Raycast extensions store |
| Automations config | `OrpheusForm` + scheduler primitives | Shortcuts.app, Raycast scripts |
| Settings | SwiftUI `Form` wrapped with custom styles | Ghostty preferences |
| Command palette | Custom SwiftUI overlay with fuzzy search | Raycast launcher |

**Escape hatch (NOT planned, documented for completeness):** a single `WKWebView` for syntax highlighting (Shiki-based) if the Tree-sitter path hits an unresolvable wall. Use only if forced.

---

### 4. Core — Swift

Single language across UI and core. No FFI between core and UI (no Rust↔Swift bridge).

**Modules:**

- **`SessionRegistry`** — reads `~/.claude/projects/`, parses JSONL metadata (header + last line per file), builds in-memory index of (project-cwd → sessions[]), updates reactively via FSEvents.
- **`JSONLWatcher`** — FSEvents-based file watcher on `~/.claude/projects/`. Publishes `SessionUpdate` events.
- **`SubprocessManager`** — spawns `claude` with the right flags (`--session-id`, `--resume`, `--fork-session`, `--bare`, `--output-format stream-json` where applicable). Manages process lifecycle, stdin/stdout/stderr piping, exit-code handling.
- **`Persistence`** — `GRDB.swift` on top of SQLite with FTS5 enabled. Stores app state tree (projects/spaces/terminals), session index (cross-project search), terminal scrollback (chunked blobs), lifecycle states.
- **`Settings`** — JSON config files (`~/.orpheus/config.json` global, `<project>/.orpheus/config.json` per-project). Hot-reload via FSEvents. Merging precedence: project → global.
- **`SelfDriveDaemon`** — unix socket listener at `~/.orpheus/orpheus.sock`. JSON-RPC 2.0 protocol. Handles commands from the `orpheus` CLI.

---

### 5. Voice — AVFoundation

**STT (input):** `AVAudioEngine` for mic capture. Stream to STT provider (Deepgram / Groq Whisper / local Whisper.cpp) via WebSocket or streaming HTTP. Push-to-talk binding via `NSEvent` global monitor (Karabiner-rebindable key is the default).

**TTS (output):** Stream text from Claude responses through a preprocessor (strip markdown, collapse tool calls, jargon pronunciation dict) into a streaming TTS provider (Cartesia for low-latency streaming). Audio playback via `AVAudioPlayerNode` / `AVPlayer` with low-buffer streaming.

**Mid-turn interrupt:** cancel both TTS playback (`stop()` on audio node) and any in-flight model inference (inject interrupt signal through CC's stream). Resume listening for the next PTT press.

**Preprocessor rules (initial, to refine):**
- Strip markdown (headers, bullets, backticks, asterisks)
- Collapse tool calls to one-line summaries (e.g. "Read 3 files, edited `config.ts`, ran tests — 12 passed")
- Pronunciation dict: MCP, tmux, shadcn, Ghostty, Postgres, libghostty, SQLite, etc.

---

### 6. Self-drive CLI — `orpheus` binary

Separate Swift target in the same Xcode workspace. Installed on PATH via a small installer in the main app.

**Protocol:** JSON-RPC 2.0 over unix domain socket at `~/.orpheus/orpheus.sock`. File permissions ensure single-user access.

**Command surface (initial):**
- `orpheus projects list | open | archive | pin`
- `orpheus spaces list | create | switch | rename`
- `orpheus spaces list | create [--terminals N] | switch | rename | archive` (no tabs — spaces own layout directly)
- `orpheus terminals list | open | close | focus | send "text" | scrollback`
- `orpheus sessions list | resume | fork | archive`
- `orpheus actions <name>` — invoke a configured quick action by name

**Machine-readable output:** always JSON by default. `--human` flag for pretty output when invoked by a user.

**Claude integration:** exposed as an Orpheus skill so Claude can invoke commands conversationally. Orpheus registers itself with each hosted `claude` session so the skill is always available.

---

### 7. Persistence

**Config:** JSON files.
- `~/.orpheus/config.json` — global (user-wide)
- `<project-root>/.orpheus/config.json` — per-project
- Precedence: project overrides global.
- Schema-validated, hot-reloaded.

**App state + scrollback:** SQLite at `~/.orpheus/orpheus.db` via GRDB.swift.

Tables (initial):
- `projects` — `id, name, root_path, lifecycle_state, tags, created_at, updated_at`
- `spaces` — `id, project_id, name, description, layout_spec (JSON), order, lifecycle_state, created_at, updated_at` (spaces own layout directly now that tabs are removed)
- `terminals` — `id, space_id, cwd, command, status, cc_session_id?, layout_position, created_at`
- `terminal_scrollback` — `terminal_id, chunk_index, bytes (BLOB)` — bounded ring
- `sessions_index` — FTS5 virtual table over CC session metadata (cwd, name, gitBranch, lastUpdated) — powers cross-project search
- `app_state` — key-value store for window geometry, last-open layout, pinned spaces, etc.

**Auto-restore:** on launch, reconstruct the full Project/Space/Terminal tree from DB. For each terminal, rehydrate scrollback into libghostty, then attempt to reattach to the CC session (or re-spawn if detached). Force-close survival achieved via continuous writes (WAL mode, small transactions).

---

### 8. Design system — `OrpheusDesign` Swift Package

Local Swift Package in the same workspace. Imported by every UI module.

**Module surface:**
- `OrpheusDesign.Tokens` — typography, color, spacing, radius, material, motion tokens
- `OrpheusDesign.Components` — `OrpheusButton`, `OrpheusToggle`, `OrpheusTextField`, `OrpheusList`, `OrpheusRow`, `OrpheusMenu`, `OrpheusSplitView`, `OrpheusSpaceSwitcher`, `OrpheusSidebar`, `OrpheusCommandPalette`, `OrpheusQuickAction`, `OrpheusStatusBadge`
- `OrpheusDesign.Icons` — curated SF Symbol + custom icon catalog with per-context styling
- `OrpheusDesign.Charts` — `OrpheusChart`, `OrpheusHeatmap`, `OrpheusBar`, `OrpheusLine` — Swift Charts wrappers tuned with tokens
- `OrpheusDesign.Motion` — spring presets, timing curves, interruption helpers

**Discipline rules (enforced by convention; reviewable):**
1. Never import stock SwiftUI `Button`, `Toggle`, `TextField`, `List`, `Menu` in user-facing code.
2. Never use raw hex colors — always `OrpheusDesign.Colors.xxx`.
3. Never use raw px values for spacing — always `OrpheusDesign.Spacing.xxx`.
4. Never use system font — always `OrpheusDesign.Typography.xxx`.
5. Never use default SF Symbol color — always specify weight and color token.
6. Every animation uses `OrpheusDesign.Motion.spring()` or documented exception.

See `docs/specs/design-principles.md` for typography / color / material details.

---

## Directory layout (proposed)

```
orpheus/                    # Xcode workspace root
├── Orpheus.xcworkspace
├── App/                    # Main app target (AppKit + SwiftUI)
│   ├── Orpheus.swift
│   ├── AppDelegate.swift
│   ├── WindowController/
│   ├── Menubar/
│   ├── Views/              # SwiftUI views hosted in AppKit
│   └── AppKit/             # AppKit-specific controllers + views
├── OrpheusCLI/             # `orpheus` binary target
│   └── main.swift
├── Packages/
│   ├── OrpheusDesign/      # local Swift Package — design system
│   ├── OrpheusCore/        # local Swift Package — core (registry, persistence, subprocess, daemon)
│   ├── OrpheusTerminal/    # local Swift Package — libghostty bindings
│   └── OrpheusVoice/       # local Swift Package — voice pipeline
├── Scripts/
│   ├── build-libghostty.sh
│   └── install-cli.sh      # installs `orpheus` binary on PATH
└── Resources/
    ├── Fonts/              # branded typefaces
    └── Assets.xcassets
```

---

## Key data flows

**1. User types in terminal:**
```
Key event → NSView → OrpheusTerminalView → libghostty
          → PTY stdin → claude process
          → Claude inference → stream chunks
          → PTY stdout → libghostty → rendered on-screen
          (Simultaneously: JSONL updates → FSEvents → SessionRegistry → UI badges refresh)
```

**2. Quick action click ("Fork current session"):**
```
Click → OrpheusDesign.QuickAction → command dispatcher
      → SelfDriveDaemon (in-process) or SubprocessManager
      → Spawns `claude --resume <id> --fork-session` in new terminal
      → New terminal renders as a new split in current space layout (or new space per config)
```

**3. Self-drive from Claude inside a terminal:**
```
Claude emits `orpheus space create --terminals 2 --split h` in tool call
→ Tool runs `orpheus` binary → JSON-RPC to ~/.orpheus/orpheus.sock
→ SelfDriveDaemon → core state mutation → UI re-renders
→ JSON-RPC response → `orpheus` binary stdout → Claude sees result
```

**4. Session reattach on launch:**
```
Launch → read SQLite app_state → reconstruct Project/Space/Terminal tree
→ for each terminal: rehydrate scrollback into libghostty
→ if cc_session_id present: spawn `claude --resume <id>` attached
→ UI renders, terminals appear in same layout as before
```

**5. Cross-project session search:**
```
User types in command palette → FTS5 query over sessions_index
→ results ordered by recency + match score
→ click → opens new terminal attached to that session
```

---

## Decisions with rationale

| Decision | Choice | Why | Alternatives rejected |
|---|---|---|---|
| UI framework | SwiftUI + AppKit interop | Best native craft, libghostty integration, custom design freedom | Tauri (web ceiling on terminal/voice), Electron (bundle + memory + default feel), AppKit-only (SwiftUI speeds declarative work) |
| Terminal | libghostty | GPU-accelerated, native, lowest latency, Mitchell-engineered | xterm.js (web boundary, slower), SwiftTerm (less tuned), WezTerm-term (no native Mac renderer) |
| Core language | Swift | Single-language simplicity, no FFI to UI, mature SQLite bindings | Rust (added FFI cost for no v0 benefit), Go (less Mac-native feel) |
| Rich content | Fully native (no WKWebView) | Philosophy alignment, single design system, consistent animations, tight terminal coupling | Hybrid WKWebView (maintenance tax, animation mismatch, stack split) |
| Persistence | JSON + SQLite (GRDB) | Human-readable config + fast binary state with FTS5 search | JSON-only (slow on scrollback), SQLite-only (config not diff-friendly), Property lists (Mac-locked) |
| CLI IPC | Unix domain socket + JSON-RPC 2.0 | Fast, localhost-only, standard Unix pattern, clean auth via file perms | HTTP (port management, overhead), named pipe (Windows-portable later but not needed), filesystem queue (high latency) |
| CC integration | PTY + JSONL watching | Matches user's "CC as subprocess" mental model, simplest API, no SDK dep | stream-json primary (not interactive), SDK (no Rust/Swift SDK; TS/Python only) |
| Design system | Custom `OrpheusDesign` package, fully native, no shadcn-equivalent | Philosophy alignment, long-term consistency | Stock SwiftUI (premature feel), web-styled via WKWebView (two systems), commissioned design system at v0 (premature cost) |

---

## Explicitly out of scope for v0

- Cross-platform (Linux / Windows) — defer. Design hints: keep `OrpheusCore` free of Mac-only APIs where feasible; `OrpheusTerminal`, `OrpheusVoice`, and the shell are Mac-specific.
- ACP / multi-agent portability — defer. If adopted later, build as an adapter layer on top of CC-native.
- Daemon mode for mobile/web clients — defer. v0 is single-user, single-machine.
- WKWebView panels — excluded by design.
- Tauri / Electron — rejected.
- AGPL-licensed forks (Paseo, Opcode) — excluded by closed-source commitment.
- Cross-session voice, channels, remote-control integration — defer behind core feature set.
- Commissioned custom typeface — future consideration, v0 uses off-the-shelf branded fonts.

---

## Future phases (outline only)

**v0.5:** Voice loop → polish, pronunciation dict refinement, latency tuning.
**v1.0:** Daemon mode with mobile/web clients (reuse core via WebSocket bridge).
**v1.5:** ACP adapter layer for multi-agent portability.
**v2.0:** Cross-platform (Linux first, via Tauri shell reusing OrpheusCore).
**v2.0+:** Orpheus-the-brand — additional agentic-tool layers inside the same shell.

---

## Open technical questions (to resolve during build)

- libghostty Swift binding strategy: extract from Ghostty's Swift code, hand-write, or contribute upstream?
- STT provider for voice (Deepgram vs Groq Whisper vs Whisper.cpp local)
- TTS provider (Cartesia for low-latency confirmed as default; fallback to macOS `say` for offline)
- Push-to-talk global key binding mechanism (Karabiner integration vs native `NSEvent` global monitor)
- Precise SQLite schema migrations strategy
- Scrollback chunk size + ring buffer bounds
- Default keyboard shortcut catalog
