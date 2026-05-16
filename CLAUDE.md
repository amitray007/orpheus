# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Orpheus is a **closed-source macOS Electron app** that wraps `claude` (the Claude Code CLI) in a project/workspace UI. The renderer is React + Tailwind v4; the main process is TypeScript on Node; the terminal is rendered by a native NAPI addon that embeds prebuilt **libghostty** (`vendor/GhosttyKit.xcframework`) as an `NSView` parented onto Electron's `BrowserWindow` native handle. Persistence is `better-sqlite3` at `~/Library/Application Support/Orpheus/orpheus.sqlite`.

## Build + verify loop (the only one that matters)

The user only ships via real production builds. There is no dev workflow.

```bash
osascript -e 'tell application "Orpheus" to quit' 2>/dev/null; sleep 1
pkill -x Orpheus 2>/dev/null; true
bun run build:unpack         # build:native → typecheck → electron-vite build → electron-builder --dir → install-mac
open /Applications/Orpheus.app
```

- **Do not run `bun run dev`.** Icon, bundle, signing all diverge from shipped — wastes time on dev-only artifacts.
- `bun run build:unpack` chains everything (native addons → vite bundle → electron-builder → re-sign + install to `/Applications/Orpheus.app`). Don't shortcut to `bun run build` if native code changed — it skips the addon rebuild.
- The user has standing consent to auto-close + relaunch around builds; don't ask.
- After each build, sanity-check: `pgrep -lf "Orpheus.app/Contents/MacOS/Orpheus" | head -1`.

### Other commands

| Command                    | What it does                                                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run typecheck`        | Runs both `typecheck:node` (main + preload + shared) and `typecheck:web` (renderer) against composite tsconfigs.                                                                                                                                 |
| `bun run lint`             | ESLint over the workspace (flat config, `.eslintcache` enabled).                                                                                                                                                                                 |
| `bun run format`           | Prettier-format the workspace. Enforced by `husky` `pre-commit` (lint-staged Prettier) and `pre-push` (`prettier --check`).                                                                                                                      |
| `bun run build:native`     | Rebuild `packages/ghostty-native` (`node-gyp` against the installed Electron ABI).                                                                                                                                                               |
| `bun run fetch:libghostty` | Re-fetch `vendor/GhosttyKit.xcframework` + `vendor/ghostty` source pin (SHA-256-verified). Runs as `postinstall`.                                                                                                                                |
| `bun run release`          | Build `.dmg`, publish a `vX.Y.Z` GitHub release on `amitray007/orpheus`, render `scripts/orpheus-cask.template.rb`, commit + push the cask file in `../homebrew-tap` (override path with `ORPHEUS_TAP_PATH`). Bump `package.json#version` first. |

There is no test runner wired up. There are no unit tests. Don't invent one.

## Architecture

### Three-process model (Electron)

- **Main** (`src/main/`) — Node 22 / Electron 39. Owns SQLite, native addon, IPC handlers, hook server. Entry: `src/main/index.ts`. Every domain module hangs off `index.ts` via `ipcMain.handle(...)`.
- **Preload** (`src/preload/index.ts`) — typed `window.api.*` bridge. `index.d.ts` is the contract the renderer types against.
- **Renderer** (`src/renderer/src/`) — React 19 + Tailwind v4 + Geist. Boot path: `main.tsx` → `App.tsx` (runs doctor) → `components/dashboard/Dashboard.tsx`. Path aliases: `@renderer/*`, `@/*` → `src/renderer/src/*`; `@shared/*` → `src/shared/*`.
- **Shared types** (`src/shared/types.ts`) — single source of truth for all IPC payloads, DB record types, draft types. Both main and renderer import from here.

### Core domain model

- **Project**: a `cwd` registered in `~/Library/.../orpheus.sqlite`. Maps to a `~/.claude/projects/<encoded-cwd>/` dir (claude's transcript store; slashes become dashes).
- **Workspace**: an isolated unit of exploration scoped to a project. Each workspace owns **exactly one persistent libghostty surface** keyed by `workspaceId`. Each workspace = one `claude` session (captured via the `.jsonl` written under the encoded project dir, then passed back as `--resume <sessionId>`). Navigation **hides** the surface (`addon.hide`), never destroys it; full teardown only happens on archive or project removal.
- **Session**: a row sourced from claude's on-disk `.jsonl` transcript, joined to the workspace via `claude_session_id`. The DB row mirrors metadata; the JSONL is authoritative content.

### Claude launch composition (the central abstraction)

The terminal is `libghostty` running `resources/orpheus-claude.sh`. The shell wrapper reads two env vars set by `terminal:mount`:

- `ORPHEUS_CLAUDE_FLAGS` — whitespace-split CLI flags
- `ORPHEUS_CLAUDE_SETTINGS_JSON` — inline JSON for `claude --settings`

Both are produced by `composeClaudeLaunch(projectId, workspaceId)` in `src/main/claudeSettings.ts`. That function returns `{ flags, settingsJson, env }` and is the **single source of truth** for how UI settings → CLI/env. It layers:

```
global (claude_global_settings)
  → project overrides (claude_project_settings.overrides_json)
  → workspace overrides (claude_workspace_settings.overrides_json)
  → auth env (claudeAuth.ts) merged LAST so secrets win on conflict
  → custom env vars (user-defined) — merged AFTER typed emissions so they can override
```

When **any** layer mutates, `recomputeDirty()` in `src/main/index.ts` compares the snapshot taken at `terminal:mount` time against the freshly composed launch. If they differ, the workspace is marked `dirty` and a "Restart to apply" chip appears in the UI.

**When wiring a new claude setting:** see `.claude/agents/audit-claude-env-vars.md` — it is the canonical procedure (schema column → type field → row→record mapping → BOOLEAN_KEYS/validator → `composeClaudeLaunch` emission **before the `customEnvVars` merge** → UI `SettingRow` with `mapsTo` chip → `.claude/snapshots/env-vars.json` flipped to `wired: true`).

### SQLite schema + migrations

`src/main/db.ts` is migrations-as-code. `CURRENT_VERSION` is the source of truth. Pattern for additive changes is **non-destructive**: add the column to the `CREATE TABLE` block for fresh installs, then append a defensive `try { db.exec("ALTER TABLE ... ADD COLUMN ...") } catch {}` migration at the bottom. Never write destructive migrations. Bump `CURRENT_VERSION` so the migration block runs once.

### Native terminal addon

`packages/ghostty-native/addon.mm` exports four NAPI functions (`mount` / `hide` / `resize` / `destroy`) called only from the Electron main thread, plus `setTitleCallback` / `setActionTraceCallback` for events fanned back to JS. Surface lifecycle = workspace lifecycle (one entry per `workspace.id`). `CVDisplayLink` drives drawing; the callback dispatches `ghostty_surface_draw` back to the main queue.

The shell-integration resources (terminfo + integration scripts) live under `resources/ghostty/` and are bundled to `Contents/Resources/{terminfo,ghostty}/` by `electron-builder.yml`. `GHOSTTY_RESOURCES_DIR` is set in `loadTerminalAddon()` before the `.node` is `require`'d so ghostty's auto-walk can find them in both packaged and dev layouts.

### Hook activity pipeline

Workspaces get a live status (`in_progress` / `attention` / `awaiting_input` / `idle`) driven by claude's hooks:

1. `src/main/orpheusNotify.ts` starts a Unix-domain socket server on app launch and idempotently installs managed hooks (`SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PreCompact`, `SubagentStop`) into `~/.claude/settings.json` — each hook is a shell command that runs `resources/bin/orpheus-notify` (the shim) which posts to the socket.

- `ORPHEUS_WORKSPACE_ID` is injected as an env var for the wrapper script so the shim can attribute events.
- A watchdog demotes `in_progress` → `awaiting_input` after `inProgressWatchdogSec` (default 120s, longer while compacting). OSC 0/2 title updates from the spinner glyph also count as heartbeats.
- The status maps to a `WorkspaceActivityDetail` (`thinking` / `tool` / `compacting` / `asking` / `ready` / `idle` / `archived` / `attention`) that the renderer renders via `Dashboard/ActivityIndicator.tsx`.

### Renderer view kinds

`AppUiState.lastViewKind` is one of `sessions | project | workspace` (also accepts the legacy string `dashboard` for older DBs — coerced to sessions on read; there is no dashboard page). The sidebar persists which view to open at launch. **Don't reintroduce a dashboard/home page** — it was deliberately removed.

### Distribution

Ships exclusively via **private Homebrew tap** (`amitray007/homebrew-tap` cask, binary release on `amitray007/orpheus`). Brew installs strip macOS quarantine so the ad-hoc-signed bundle launches. There is no `electron-updater` and no auto-publish — see `scripts/release.mjs`. The in-app updates check (`src/main/updates.ts` → `OrpheusUpdatesSection.tsx`) polls GitHub releases for a newer tag and triggers `brew upgrade`.

Ad-hoc codesigning is re-applied to the whole bundle in `scripts/install-mac.mjs` because electron-builder leaves inner frameworks with mismatched Team IDs and macOS 15+ refuses to load them. **Do not store secrets in macOS Keychain** until proper Developer ID signing exists — ad-hoc re-sign reshuffles ACLs on every build. Plaintext SQLite columns are intentional (`auth_api_key`, `auth_token`, etc.).

## Conventions specific to this repo

- **Bun is the package manager.** `bun.lock` is committed; `package.json#packageManager` is not pinned but the husky hook uses `bunx`.
- **Strict layering of secrets.** Auth env (`getClaudeAuthEnv()`) is merged AFTER the launch env so `ANTHROPIC_API_KEY` always wins. `SECRET_KEYS` in `terminal:mount` redacts values from the `[terminal] mount …` log line. Never log raw `authEnv` values.
- **No hardcoded paths or URLs.** Derive from `os.homedir()`, `process.env.SHELL`, `app.getPath(...)`, or read from the DB. `getUserShellPath()` in `index.ts` spawns the user's login+interactive shell once to capture their real `$PATH` (Finder-launched Electron apps get a stripped PATH).
- **Workspace surfaces are sticky.** `hide` ≠ `destroy`. Renderer navigation must call `terminal:hide` then `terminal:mount` again on return; never `destroy` unless the workspace is being archived/removed.
- **Settings are layered.** Any UI control that maps to claude settings must compose through `composeClaudeLaunch` and carry a `mapsTo` chip pointing to the env var or settings key it produces.
- **Commits use Conventional Commits, no emoji.** `feat(scope):`, `fix(scope):`, `chore(scope):`. No `Co-Authored-By: Claude` lines unless explicitly requested.
- **Audit env vars before adding new settings.** The `.claude/agents/audit-claude-env-vars.md` agent diffs `https://code.claude.com/docs/en/env-vars.md` against `.claude/snapshots/env-vars.json` — run it (or invoke it as a subagent) before guessing whether something is already wired.
