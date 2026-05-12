# Deferred / Pending Work

Living tracker of everything we've decided to defer in earlier sessions. Update as items move out (when completed) or shift priority. Most recent comprehensive sweep: 2026-05-13. Last shipped-items pass: 2026-05-13 (restart chip + per-workspace overrides).

**Priority legend:**

- **P1** — small + obvious next step, ready to pick up
- **P2** — moderate scope, useful but not blocking
- **P3** — large, speculative, or requires upstream changes

---

## 1. Claude Settings — sections still placeholder

| Item | Priority | Notes |
|---|---|---|
| **Claude → Hooks** section | P3 | Phase 3 per `project_settings_architecture.md`. Needs JSON event-handler editor. Users can edit `~/.claude/settings.json` directly until UI lands. |
| **Claude → Auth → Provider-specific config** | P2 | Sub-fields under the provider radio: Bedrock (workspace ID, AWS region), Vertex (GCP project ID, location), Foundry (resource URL). Currently a `ComingSoonChip` placeholder inside `ClaudeAuthSection`. |

## 2. Claude Settings — wired but with small gaps in `composeClaudeLaunch`

| Field | Gap | Notes |
|---|---|---|
| `browserIntegration: false` → `--no-chrome` flag | Commented stub | Couldn't verify exact CLI flag in published claude docs. Likely correct; needs confirmation. |
| `toolConcurrency` | Commented stub | No documented `settings.json` key found for parallel tool calls. Field persists in DB but doesn't compose. |
| `experimentalForkedSubagents` | No-op at compose | No documented mechanism in claude docs. Field persists for future. |

## 3. Orpheus Settings — sections still placeholder

| Item | Priority | Notes |
|---|---|---|
| **Orpheus → Appearance** | P3 | Theme (Dark/Light/System), accent color picker, font scale. Light theme is its own project — most of the renderer uses dark-only tokens. Significant scope. |
| **Orpheus → Updates** | P3 | Auto-update channel + check-now button. No auto-updater built yet (no electron-updater wiring). |
| **Orpheus → Window → Launch at login** | P2 | Needs `app.setLoginItemSettings`. Single Toggle wire. |
| **Orpheus → Window → Global hotkey** | P2 | Needs `globalShortcut.register` + a key-capture input. |
| **Orpheus → Sidebar → Hover controls toggle** | P3 | Skipped per `5bfac0f` — current always-show-on-hover is the right default. Revisit only if a UX gap appears. |

## 4. Native addon / terminal

| Item | Priority | Notes |
|---|---|---|
| **Mouse click-to-position cursor in TUI apps** | P2 | `mouseDown:` makes view first responder; doesn't forward click position for TUI apps (vim, fzf) that read mouse position from a single click. Forward via `ghostty_surface_mouse_button` on PRESS without RELEASE for click-to-position. |
| **CJK / dead-key IME composition** | P2 | `setMarkedText:` / `ghostty_surface_preedit` / `ghostty_surface_ime_point` are stubbed. Required for Japanese/Chinese/Korean and macOS dead-key combos (option-e, etc.). |
| **`flagsChanged:` modifier press/release** | P3 | Isolated Shift/Cmd/Ctrl press events. Ghostty handles internally; only needed if a TUI app cares (rare). |
| **Touch Bar, magnify gesture, force-touch** | P3 | `ghostty_surface_mouse_pressure` exists; not wired. Low priority. |
| **Surface-config live reload (font / theme / scrollback)** | P3 | Display-side settings (font family/size, theme, scrollback) could hot-reload via `ghostty_surface_update_config` without restarting the surface. Currently moot — no such settings are exposed in the UI yet. Wire the substrate when font/theme settings land. The Claude-side restart chip (commit `3b3af83`) covers what was previously in scope here. |
| **Mouse selection range visualization** | P3 | We forward mouse events; Ghostty handles selection rendering. But copy-on-select / triple-click word-select / drag-to-extend feel less polished than native terminals. Investigate. |

## 5. Surface lifecycle

| Item | Priority | Notes |
|---|---|---|
| **Surface persistence across Orpheus restart** | P3 | Claude sessions die when Orpheus quits. Persistence would require a checkpoint/restore mechanism — likely impossible since claude+shell are child processes. Tradeoff: accept session loss on app quit, or use libghostty's surface serialization if it exists. |
| **Surface eviction (memory cap)** | P3 | Each surface costs ~30–60 MB. 20 workspaces ≈ 600 MB-1.2 GB. No eviction in v1; revisit if it becomes a problem. |
| **Reconnect / reload terminal in place** | P3 | If claude crashes, the surface dies. A "reload" affordance would help. |

## 6. Dashboard home

| Item | Priority | Notes |
|---|---|---|
| **Activity heatmap** | P2 | Original agenda item — never built. Would aggregate CC session `.jsonl` mtimes and/or git activity into a calendar-style heatmap. |
| **Recent Projects card** | P1 | 3–5 most-recently-opened projects, sorted by `projects.last_opened_at`. Data already in SQLite. Trivial. |
| **Recent Sessions card** | P1 | 3–5 most-recent sessions across all projects via `sessions:listAll`. Data already in SQLite. Trivial. |

## 7. Per-workspace settings overrides

| Item | Priority | Notes |
|---|---|---|
| **More override-able fields beyond model / permissionMode / effort** | P3 | Shipped in commit `bedc064` (schema v15) but only for the same three fields as project overrides. Extending to other settings (output style, thinking, debug, etc.) is straightforward; do it when a concrete use case appears. |

## 8. Auth flows

| Item | Priority | Notes |
|---|---|---|
| **OAuth login wizard for Anthropic** | P2 | Static API key path works; OAuth would be a guided flow that captures `ANTHROPIC_OAUTH_TOKEN`. Likely involves opening a browser window. |
| **API key validation** | P2 | "Test connection" button that calls a minimal claude API to verify the key works. |

## 9. Custom slash commands / subagents UIs

| Item | Priority | Notes |
|---|---|---|
| **Per-entry enable/disable for slash commands / subagents** | P3 | Read-only list shipped in commit `ee9daf1`. claude doesn't currently expose a per-command or per-agent disable mechanism via settings — would require a different approach (e.g., moving files to a `.disabled/` shadow folder or symlink-toggling). Defer until claude exposes this natively or a concrete need appears. |
| **Frontmatter inspector / preview** | P3 | The list shows name, description, and a few chips. A click-to-expand view that displays full frontmatter + the first paragraph of the body would be useful for spot-checking what a command/agent does. |

## 10. Multi-workspace UX

| Item | Priority | Notes |
|---|---|---|
| **Multi-workspace side-by-side** | P3 | Currently one workspace visible at a time. Could split-view two workspaces. Requires layout work + careful surface lifecycle. |
| **Workspace tabs within a project** | P2 | The workspace nav exists in the sidebar. Tabs at top of the WorkspaceView would speed switching for a 3+ workspace project. |

## 11. Claude settings surface NOT yet exposed

From the research catalog — these aren't even placeholder sections:

| Field | Mechanism | Priority |
|---|---|---|
| **Sandbox config** | `settings.json` `sandbox.{filesystem, network}` | P3 |
| **Notification preferences** | `settings.json` `preferredNotifChannel` | P2 |
| **Plugin management** | `settings.json` `enabledPlugins`, `extraKnownMarketplaces` | P3 |
| **Status line config** | `settings.json` status line | P3 |
| **Output styles custom location** | `~/.claude/output-styles/` | P3 |
| **Session cleanup period** | `settings.json` | P3 |
| **Minimum version requirement / version pinning** | `settings.json` | P3 |
| **Extra body JSON** (raw API tweaks) | `settings.json` `extraBody` | P3 |

## 12. UI polish — small lingering items

| Item | Priority | Notes |
|---|---|---|
| **Git status as branch icon vs `+N −M` chip** | P3 | User's reference design used a branch icon; we shipped a chip. Could add the branch glyph alongside the chip. |
| **Settings highlight bug residue** | P3 | Agent A's `.blur()` workaround on Settings button click. Watch for recurrence. |
| **About section polish** | P2 | Claude About + Orpheus About sections are functional but visually plain. Live data is shown but layout is utilitarian. |
| **Compact / spacious sidebar density toggle** | P3 | Sidebar width is configurable; a density preset (compact/comfortable/cozy) would compose multiple sizing decisions at once. |

## 13. Build / distribution

| Item | Priority | Notes |
|---|---|---|
| **Code signing with Developer ID** | P2 | Currently ad-hoc signed. Real distribution needs an Apple Developer account + signing identity. |
| **Notarization** | P2 | Goes hand-in-hand with signing. `electron-builder.yml` has `notarize: false`. |
| **macOS App Store distribution** | P3 | Would require sandbox compliance + signing + entitlements — Ghostty's NSView mounting may not be App-Store-compatible. |
| **Auto-update via electron-updater** | P3 | Pairs with the Updates settings section. Needs a release feed. |
| **Universal binary** (Intel + Apple Silicon) | P2 | Currently arm64-only. Adding x86_64 needs an x86_64 slice from Lakr233's prebuilt and the native addon rebuilt. |

## 14. Testing / quality

| Item | Priority | Notes |
|---|---|---|
| **Renderer tests** | P3 | No test infrastructure for the React side. Vitest or similar. |
| **Main process tests** | P3 | No test infra for IPC handlers, SQLite layer, or addon. |
| **Native addon integration tests** | P3 | Spike-style smoke tests would catch addon regressions. |
| **E2E tests** | P3 | Playwright-electron or Spectron-style. |
| **CI** | P2 | No GitHub Actions config. `bun run build:unpack` works locally; needs to run in CI for PRs. |

## 15. Documentation

| Item | Priority | Notes |
|---|---|---|
| **README** | P2 | Currently auto-generated by electron-vite scaffold. Needs Orpheus-specific intro, install instructions, architecture overview. |
| **CONTRIBUTING.md** | P3 | If we open this up to anyone. |
| **CHANGELOG.md** | P3 | Currently git log serves. |
| **Architecture diagram** | P3 | Renderer → IPC → main → SQLite + addon + claude. |

---

## When new items get deferred

Add them here with a one-line description, priority guess, and a link to the commit/comment where the deferral was decided. Keep this doc within reach of any settings or feature work — many of these will get folded into other commits naturally.
