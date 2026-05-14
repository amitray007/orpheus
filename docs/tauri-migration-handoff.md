# Orpheus — Electron → Tauri migration (continuation from prior session)

## Project context

**Orpheus** is a closed-source macOS IDE built around Claude Code. Mac-only v0. Repo at `/Users/maverick/code/projects/orpheus` (private, `github.com/amitray007/orpheus`). Currently on Electron 39 + React 19 + TypeScript 5 + bun 1.3 + better-sqlite3, native libghostty terminal via an ObjC++ N-API addon. Main branch is `main`, last commit `7036aad`. SQLite schema is at v31.

**Read these auto-memory files FIRST**:
- `/Users/maverick/.claude/projects/-Users-maverick-code-projects-orpheus/memory/MEMORY.md` (index)
- `/Users/maverick/.claude/projects/-Users-maverick-code-projects-orpheus/memory/project_orpheus_revamp.md` (direction lock)
- `/Users/maverick/.claude/projects/-Users-maverick-code-projects-orpheus/memory/feedback_use_sonnet_subagents.md` (delegation rule)
- All `feedback_*.md` files (production-builds-only, commit-as-you-go, no-hardcoding, auto-close-reopen, etc.)

## Why we're migrating

We spent a long session trying to make libghostty render claude's continuous animations (cursor blink, spinner, progress reports, compaction updates) in our Electron-hosted setup. After **9 different fixes** — display-link contention, `GHOSTTY_ACTION_RENDER` routing, focus state, TSFN blocking, `wantsLayer` override, layer-hosting view-attachment ordering, `setHidden` instead of `removeFromSuperview`, etc. — none restored continuous rendering. Diagnosis converged on:

**Chromium's compositor owns Electron's contentView layer tree.** When libghostty's `IOSurfaceLayer` lives inside Chromium's compositor topology, CoreAnimation doesn't autonomously schedule `display` passes for it — only incidental main-runloop activity (key events) triggers presents. The smoking gun was that a *500ms main-thread NSTimer broke previously-working keyDown-driven renders*, confirming CoreAnimation isn't doing autonomous display passes in this topology.

A WKWebView-based shell (Tauri) doesn't have this problem because the window's `contentView` is a plain AppKit `NSView` — WKWebView is just one subview. We can put libghostty's surface as a sibling subview, and CoreAnimation will run normal display passes the way it does in Ghostty.app.

All render-fix attempts were reverted to baseline state at commit `7036aad` (= state of `dcbd1f9` for `addon.mm`). Activity/notification/settings work above that commit is intact.

## Migration goals

1. **Replace Electron with Tauri 2.x.** Rust backend, WKWebView frontend.
2. **Keep the React UI 1:1.** Every component in `src/renderer/src/components/` should still render the same. Don't redesign anything.
3. **libghostty surface lives as a sibling NSView under the window contentView**, NOT inside the WKWebView. This is the whole point — outside the web compositor.
4. **Preserve every feature**: 17 settings sections, the Settings search bar, projects/workspaces/sessions, claude hooks editor, activity status tracking (in_progress / awaiting_input / attention / asking / etc.), native notifications, persistent attention reminders, watchdog, drag-reorder, dark theme, layered settings (global → project → workspace), schema migrations, etc.
5. **Persistence stays SQLite** (schema v31). Rust will use `rusqlite` (or `sqlx`) instead of `better-sqlite3`. Existing migrations need porting; data files at `~/Library/Application Support/Orpheus/orpheus.sqlite` must remain readable.
6. **The bash hook shim (`resources/bin/orpheus-notify`)** stays as-is — it talks to a Unix socket the backend exposes. We just port the socket server to Rust.

## Non-goals

- Don't redesign the UI.
- Don't change the SQLite schema unless forced.
- Don't introduce a JS terminal library (xterm.js etc.) as a stopgap — explicitly off-the-table per `project_orpheus_revamp.md`.
- Don't migrate to anything other than Tauri 2.x.

## Architecture target

```
NSWindow (Tauri-managed)
└── contentView (plain AppKit NSView, NOT in WKWebView's compositor)
    ├── WKWebView (Tauri webview) ← renders the React UI (sidebar, dashboard, drawer, settings, etc.)
    │     • shows an empty <div data-terminal-slot> where the terminal would be
    │     • sends rect (x,y,w,h,scale) of that <div> to backend via Tauri command
    │
    └── libghostty NSView ← sibling, positioned over the placeholder <div>
          • created by our Rust code via objc2 / cocoa-foundation
          • libghostty surface attached normally
          • CoreAnimation runs autonomously — animations actually update
          • we sync position/size on every layout change from the frontend
```

## Phased plan (suggested chunks — each ends with a working app + a commit)

### Phase 0: spike (don't merge yet)
- Create `tauri-spike/` branch off `main`.
- Scaffold a Tauri 2 app (`bun create tauri-app` or `cargo create-tauri-app`).
- Goal: prove libghostty can be embedded as a sibling NSView under contentView, with autonomous animations working. Build the simplest possible app: one window, one workspace, one libghostty surface spawning `claude`. If cursor blinks and claude's spinner animates, the architecture is proven.

### Phase 1: Rust scaffold
- New Rust crate replacing `src/main/` (TypeScript). Modules:
  - `src/main.rs` — Tauri entrypoint
  - `src/db.rs` — SQLite via `rusqlite`, port schema migrations from `src/main/db.ts`
  - `src/projects.rs`, `src/workspaces.rs`, `src/sessions.rs`
  - `src/claude_settings.rs`, `src/claude_auth.rs`, `src/claude_hooks.rs`, `src/claude_agents.rs`, `src/claude_project_settings.rs`, `src/claude_workspace_settings.rs`
  - `src/ui_state.rs`
  - `src/orpheus_notify.rs` — Unix socket server (port from current Node/TS)
  - `src/os_notifications.rs` — macOS native notifications via `objc2` / `notify-rust`
  - `src/git.rs` — git status via `git2` or `Command`
  - `src/mcp.rs`, `src/context_menu.rs`

### Phase 2: libghostty native binding
- New crate `crates/ghostty-native/` with bindgen against `vendor/GhosttyKit.xcframework/macos-arm64_x86_64/Headers/ghostty.h`.
- Rust-side NSView creation via `objc2` + `objc2-app-kit`.
- Surface mount/hide/destroy commands exposed to JS via Tauri `#[tauri::command]`.

### Phase 3: IPC layer
- Map every existing `window.api.*` call (see `src/preload/index.ts` + `src/preload/index.d.ts`) to a Tauri command or event.
- Tauri's `invoke` for request/response; `listen`/`emit` for streams (title changes, activity changes, dirty changes).

### Phase 4: Renderer adaptation
- `src/renderer/` mostly unchanged — but `window.api` becomes a thin wrapper around `@tauri-apps/api/core` `invoke` and `event` modules.
- Build a `src/renderer/src/api.ts` shim that exports the exact same surface as today's `window.api`, calling Tauri under the hood. This lets every component file stay untouched.

### Phase 5: Build pipeline
- Replace `electron-builder` with Tauri's bundler.
- Migrate `scripts/install-mac.mjs` — Tauri produces an `.app`; we still need the post-build ad-hoc re-sign + install to `/Applications/Orpheus.app`.
- Keep `bun run build:unpack` as the user-facing alias.
- Ship `resources/bin/orpheus-notify` into the bundle's `Contents/Resources/bin/`.

### Phase 6: Cutover
- Bring `tauri-spike/` to feature parity with `main`.
- One-time DB migration test: copy a real user's `orpheus.sqlite`, open in Tauri build, verify all data reads correctly.
- Merge.

## Resources

- **Cloned upstream Ghostty** at `/tmp/orpheus-research/ghostty/` — read `src/apprt/embedded.zig`, `src/renderer/Metal.zig`, `macos/Sources/Ghostty/Surface View/SurfaceView_AppKit.swift`. These are authoritative for libghostty embedding.
- **Cloned `libghostty-spm`** at `/tmp/orpheus-research/libghostty-spm/` — Swift wrapper around the same xcframework we link against.
- **Tauri 2 docs**: https://v2.tauri.app/ — especially the Plugin system (for native NSView access) and the macOS-specific guidance.
- **`objc2` crate** (https://github.com/madsmtm/objc2) — current best Rust-ObjC bridge. We'll use `objc2-app-kit` for NSView, NSWindow, etc.
- **`tauri-runtime-wry`** — Tauri's macOS runtime; window-handle access for sibling-view trickery.

## Current state of `main`

Commit `7036aad` — addon.mm rolled back to dcbd1f9 baseline. Everything else (notifications, activity sub-states, hooks editor, settings search, sidebar polish, schema v31) intact and working. Type-to-unstick rendering is the known issue; everything else is fine.

## Standing rules (from auto-memory — read those for full context)

- **Production builds only**: never `bun run dev` (or the Tauri equivalent dev mode). Always full bundle + install to `/Applications/Orpheus.app`.
- **Auto-close + reopen Orpheus around builds** without asking. The user expects this.
- **Commit + push per logical chunk** to `origin/main` (or to `tauri-spike` during migration). Use clear conventional commit subjects.
- **No hardcoding** of paths/URLs/lists. Use `app.getPath()` / `process.resourcesPath` / `dirs` crate / etc. Curated keyword catalogs (for search) are fine.
- **Use sonnet subagents for non-trivial work**. Brief them with full context; they don't see the parent conversation.
- **No emoji** in code or commits.
- **No comments unless genuinely non-obvious.** No multi-line docstrings.
- **No external deps** beyond what's necessary. Vet every crate.

## First task to start with

**Phase 0 spike**: prove libghostty animations work in Tauri before touching the rest of the codebase.

Concretely:
1. Create branch `tauri-spike` off `main`.
2. In a sibling directory (`/Users/maverick/code/projects/orpheus-tauri-spike/` or similar — keep it OUT of `orpheus/`), scaffold a minimal Tauri 2 app.
3. Add a `crates/ghostty-native/` Rust crate that:
   - Links against the existing `vendor/GhosttyKit.xcframework` in the parent Orpheus repo (or vendors a copy).
   - Exposes one `#[tauri::command] async fn spawn_terminal(window: tauri::Window, rect: Rect) -> Result<()>` that:
     - Gets the NSWindow from the Tauri window.
     - Gets the contentView.
     - Creates an NSView at the given rect.
     - Calls `ghostty_init` / `ghostty_app_new` / `ghostty_surface_new` with that NSView.
     - addSubview's it under contentView (as a SIBLING of the WKWebView).
     - Returns.
4. In the Tauri frontend (a single HTML page is fine for the spike — no React yet), draw a placeholder `<div>` where the terminal goes, call `spawn_terminal` with its bounding rect.
5. Build and run. Type into the terminal. Watch the cursor.
6. **Success criterion**: cursor blinks autonomously. Run a `for i in 1..1000; do echo $i; sleep 0.01; done` — output streams without keypress. Run `claude` — its spinner animates while it thinks.

Report back with the spike's status — if it works, we proceed to Phase 1. If it doesn't, we go even more native (custom Cocoa shell, or back to the child-NSWindow-overlay approach in Electron).

## What I expect from this session

Don't touch the main Orpheus repo's `src/` or `packages/` yet. Stay in the spike directory until libghostty's animations work in Tauri. Once proven, we'll plan the migration in detail.

If anything in this brief is ambiguous, ask before starting.
