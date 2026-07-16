# Orpheus Architecture

## Overview

Orpheus is a macOS-only Electron application that wraps the `claude` CLI (Claude Code) in a project and workspace management UI. Instead of running `claude` in an ordinary system terminal, Orpheus embeds a native **libghostty** terminal surface — a prebuilt `NSView` parented directly onto Electron's `BrowserWindow` native handle — so each claude session gets a persistent, GPU-accelerated terminal that lives for the lifetime of the workspace, not just the lifetime of a tab.

**Tech stack at a glance:**

| Layer          | Technology                                                                 |
| -------------- | -------------------------------------------------------------------------- |
| Electron shell | Electron 39, Node 22, TypeScript                                           |
| Renderer       | React 19, Tailwind v4, Geist font                                          |
| Terminal       | libghostty via a NAPI C++ addon (`packages/ghostty-surface`)               |
| Persistence    | `better-sqlite3` at `~/Library/Application Support/Orpheus/orpheus.sqlite` |
| Build tooling  | electron-vite, Bun, node-gyp                                               |
| Bundled vendor | `vendor/GhosttyKit.xcframework` (prebuilt, SHA-256 verified)               |

---

## Three-Process Model

Orpheus follows the standard Electron process split with strict type-safe boundaries between each layer.

### Main process — `src/main/`

Runs in Node 22 under Electron 39. This process owns all privileged operations:

- **SQLite database** — opened at startup, holds projects, workspaces, sessions, and all settings.
- **Native terminal addon** — loads `packages/ghostty-surface/ghostty_native.node` and manages the lifecycle of libghostty surfaces (one per workspace).
- **IPC handlers** — cross-cutting handlers are wired directly in `src/main/index.ts` (the central entry point), while per-domain handlers live in `src/main/ipc/*.ts` modules (e.g. `git.ts`, `mcp.ts`, `updates.ts`), each registered from `index.ts` via a typed `registerXxxIpc(deps)` call. All handlers go through the typed `handle()` wrapper in `src/main/ipc/handle.ts`, which is generic over the channel map in `src/shared/ipc.ts` — an unmapped channel is a compile error.
- **Hook server** — a Unix-domain socket server that receives events from a small shim (`resources/bin/orpheus-notify`) installed as a claude hook.
- **Workspace activity watcher** — `src/main/sessionState.ts` monitors `~/.claude/sessions/` for live session status files written by claude.

Key modules in `src/main/`:

| File                                            | Responsibility                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `index.ts`                                      | Entry point; wires cross-cutting IPC handlers and delegates per-domain handlers to `ipc/*.ts` modules |
| `claudeSettings.ts`                             | `composeClaudeLaunch()` — the central settings-to-CLI abstraction                                     |
| `db/`                                           | Declarative schema (`schema.ts`) + migration engine (diff/rebuild/cutover/backup)                     |
| `ipc/`                                          | Per-domain typed IPC handler modules, registered from `index.ts` via `registerXxxIpc(deps)`           |
| `sessionState.ts`                               | File-watching loop for workspace activity status                                                      |
| `orpheusNotify.ts`                              | Status dispatch, OS notifications, hook socket server                                                 |
| `claudeAuth.ts`                                 | Auth env composition (API key / OAuth token)                                                          |
| `projects.ts` / `workspaces.ts` / `sessions.ts` | Domain CRUD helpers                                                                                   |
| `updates.ts`                                    | In-app update check via `brew outdated` / `brew upgrade`                                              |

### Preload — `src/preload/`

`src/preload/index.ts` is the context-bridge layer. It exposes a typed `window.api.*` object to the renderer. `src/preload/index.d.ts` is a thin (~7-line) shim that derives the `Window.api` type as `typeof api` from the preload module — the authoritative IPC contract is the typed `InvokeChannelMap` / `RendererPushMap` in `src/shared/ipc.ts`, which the preload's `invoke()`/`subscribe()` helpers are generic over. No IPC channel names or payload shapes are duplicated — the renderer only calls methods on `window.api`, never `ipcRenderer` directly.

### Renderer — `src/renderer/src/`

A single-page React 19 application styled with Tailwind v4 and the Geist typeface. Boot sequence: `main.tsx` → `App.tsx` (runs a doctor check for the `claude` CLI) → `components/dashboard/Dashboard.tsx`.

**Path aliases** (configured in `electron.vite.config.ts`):

- `@renderer/*` and `@/*` both resolve to `src/renderer/src/*`
- `@shared/*` resolves to `src/shared/*`

The renderer has three primary view kinds controlled by `AppUiState.lastViewKind`: `sessions` (workspace list for a project), `project` (project settings), and `workspace` (the active terminal surface).

### Shared types — `src/shared/types.ts` and `src/shared/ipc.ts`

`types.ts` is the single source of truth for every IPC payload shape, database record type, and settings draft type. Both the main process and the renderer import from here. If a type is used across the boundary it lives in this file.

`ipc.ts` is the companion typed channel map: `InvokeChannelMap` (request/response, driven via `ipcMain.handle`/`ipcRenderer.invoke`) and `RendererPushMap` + the `PUSH_CHANNELS` const (main → renderer push channels). It imports only from `./types`, enforced by dependency-cruiser rules, so it stays a leaf shared module.

---

## Core Domain Model

### Project

A **project** is a working directory (`cwd`) registered in the Orpheus SQLite database. It corresponds one-to-one with a claude project directory at `~/.claude/projects/<encoded-cwd>/` (path encoding: forward slashes become dashes). The JSONL transcript files that claude writes live there.

### Workspace

A **workspace** is an isolated unit of exploration scoped to a project. Key properties:

- Each workspace owns **exactly one persistent libghostty surface**, keyed by its `workspaceId`. The surface is created when the workspace is first mounted and kept alive until the workspace is archived or removed.
- Each workspace maps to **one claude session**. The `claude_session_id` is pre-assigned by Orpheus (passed as `--session-id`) and is stable across `--resume`, so the session can be re-attached after an app restart.
- **Navigation hides surfaces, it does not destroy them.** Switching away calls `addon.hide`; returning calls `addon.mount`. `addon.destroy` is reserved for permanent teardown (archive or project removal).

### Session

A **session** row is sourced from the JSONL transcript that claude writes to disk under the encoded project directory. Orpheus reads these files to populate the session list and mirrors lightweight metadata into the SQLite DB (via `claude_session_id`). The JSONL file is the authoritative content record; the DB row is a metadata cache.

---

## Claude Launch Composition

The central abstraction for how UI settings become a running claude process lives in `src/main/claudeSettings.ts`.

### Entry point

The native terminal surface runs `resources/orpheus-claude.sh` as its shell command. The script reads two environment variables injected by the main process at mount time:

- `ORPHEUS_CLAUDE_FLAGS` — whitespace-delimited CLI flags forwarded to the `claude` invocation.
- `ORPHEUS_CLAUDE_SETTINGS_JSON` — inline JSON passed via `claude --settings`, covering all settings that claude accepts in that form.

The script also `unset`s inherited Claude Code session variables (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, and related) so each workspace process registers as a top-level session in claude's session registry rather than being treated as a nested sub-session.

### `composeClaudeLaunch(projectId, workspaceId)`

This function in `src/main/claudeSettings.ts` is called whenever a workspace is mounted. It returns `{ flags, settingsJson, env }` and is the single source of truth for translating stored settings into the runtime environment. Settings are layered in this order, with later layers winning on conflict:

```
global settings          (claude_global_settings table)
  → project overrides    (claude_project_settings.overrides_json)
  → workspace overrides  (claude_workspace_settings.overrides_json)
  → auth env             (API key / OAuth token — always wins)
```

### Dirty detection

When any settings layer changes while a workspace is mounted, `recomputeDirty()` in `src/main/index.ts` compares a snapshot of the launch configuration captured at mount time against the freshly composed values. If they differ, the workspace is marked dirty and the UI shows a "Restart to apply" indicator.

---

## Native Terminal Addon

The native terminal is implemented as a NAPI C++ addon in `packages/ghostty-surface/addon.mm`. It wraps the prebuilt `GhosttyKit.xcframework` from `vendor/` and bridges it into the Electron main process.

### NAPI surface

The addon exports four primary functions, all of which must be called from the Electron main thread:

| Function                                 | Purpose                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `mount(workspaceId, parentHandle, opts)` | Create or re-attach a libghostty `NSView` parented onto the Electron window's native handle |
| `hide(workspaceId)`                      | Detach the surface from the window hierarchy without destroying state                       |
| `resize(workspaceId, bounds)`            | Notify the surface of new dimensions                                                        |
| `destroy(workspaceId)`                   | Permanently tear down the surface and free resources                                        |

Two callback registration functions fan events back to JavaScript: `setTitleCallback` (terminal title changes) and `setActionTraceCallback` (internal action traces used for diagnostics).

### Drawing

A `CVDisplayLink` drives the render loop. The display link callback dispatches `ghostty_surface_draw` back onto the main queue so drawing stays on the main thread.

### Shell integration resources

Ghostty's terminfo definitions and shell integration scripts are bundled under `resources/ghostty/` and are placed at `Contents/Resources/terminfo/` and `Contents/Resources/ghostty/` by electron-builder. The `GHOSTTY_RESOURCES_DIR` environment variable is set in `loadTerminalAddon()` before the `.node` module is `require`'d, allowing ghostty's resource auto-walk to function in both packaged and unpackaged development layouts.

---

## SQLite Schema and Migrations

`src/main/db/` implements a **declarative schema + migration engine**, replacing the old imperative `db.ts`.

- **`schema.ts`** is the single source of truth for the desired schema — every table declared once as a structured `TableDef` (columns, types, `CHECK` enums, indexes, explicit `dropColumns`).
- **`introspect.ts`** reads the live DB's actual table/column/index shape.
- **`diff.ts`** compares the live shape against `schema.ts` and produces an ordered plan (create table, add/drop column, add/drop index, or a full rebuild when a change touches a `CHECK` constraint, column type, or `NOT NULL`).
- **`engine.ts`** applies that plan (delegating full-table rebuilds to `rebuild.ts`, which performs SQLite's 12-step rebuild dance), while `backup.ts` snapshots the DB via `VACUUM INTO` before any destructive step and verifies row counts after.
- **`cutover.ts`** is the ordered first-boot entry point that takes any DB — fresh install or a legacy DB from the old version-ladder — and reconciles it to the `schema.ts` desired state, then runs `data-steps.ts` (named, ledger-tracked, run-once data transforms).
- **`index.ts`** exposes the public surface (`getDb()` / `migrate()`) unchanged for callers elsewhere in main.

To add a column: edit the table's `TableDef` in `schema.ts`; the engine adds it on the next boot. No more CREATE-block + defensive-ALTER double-declaration, no version bump. To add a data transform, append a named step to `data-steps.ts`.

Verified by `scripts/verify-migration-engine.ts`, run via `bun run test:db` — exercises render/introspect/diff/rebuild/backup/engine/schema-fresh/convergence/data-steps/cutover.

---

## Workspace Activity Status

Workspaces surface a live status to the UI (`in_progress` / `attention` / `awaiting_input` / `idle`), driven by a file-authoritative model rather than hooks.

### Source of truth: `~/.claude/sessions/<pid>.json`

Every running `claude` process writes a JSON file into this directory containing its `status` (`busy` / `idle` / `waiting`), a `waitingFor` field (`permission prompt` / `input needed`), its `sessionId`, and a `statusUpdatedAt` timestamp. This is the same registry that `claude agents --json` reads.

### Watcher: `src/main/sessionState.ts`

This module uses `fs.watch` on the sessions directory (plus a periodic interval backstop) to detect file changes. On each change it runs a debounced, single-flight `reconcile` pass that:

1. Reads all session files in the directory.
2. Matches each live session to a workspace by `claude_session_id`.
3. Maps the raw status to an Orpheus activity level: `busy → in_progress`, `waiting → attention`, `idle → awaiting_input` (or `idle` after a configurable stale timeout), file-absent or dead PID → `idle`.

Torn reads (partial writes) and dead PIDs are tolerated gracefully.

### Dispatch: `src/main/orpheusNotify.ts`

Status changes flow through `orpheusNotify.dispatch`, which:

- Persists the new status to SQLite via `setWorkspaceStatus`.
- Broadcasts a `workspace:activityBatch` IPC event to the renderer, where `activityStore` applies the update.
- Fires macOS user notifications via `osNotifications.notifyForTransition` (with copy sourced from the session file — attention messages use the `waitingFor` text; "Claude finished" messages include elapsed time from an internal `busySince` timer).
- Arms an idle watchdog (transitions `awaiting_input → idle` after inactivity) and an auto-close watchdog.

### Hook infrastructure (dormant)

`orpheusNotify.ts` still runs the Unix-domain socket server and installs a shim (`resources/bin/orpheus-notify`) as a managed claude hook, with `ORPHEUS_WORKSPACE_ID` injected for attribution. However, hooks no longer drive workspace status — that role was migrated to the file-watching approach described above. The only active hook behavior is `SessionStart → onSessionStart`, which dismisses the workspace loading overlay. The remaining hook event handlers are wired no-ops, retained for potential future use.

---

## Distribution

Orpheus ships via a **Homebrew tap** backed by a `.dmg` built in CI. There is no `electron-updater`; the in-app update check calls `brew outdated` and `brew upgrade` against the tap cask, pulling fresh tap definitions from git before checking.

**Local development** always builds the isolated **`Orpheus Dev.app`** variant (separate bundle ID, app name, and data directory at `~/Library/Application Support/Orpheus Dev/`). The dev build never touches the production install. The standard local build command is `bun run build:unpack`, which chains the native addon rebuild, the vite bundle, and electron-builder installation of `Orpheus Dev.app`.

The bundle is **ad-hoc codesigned** (no Developer ID) because macOS 15+ rejects frameworks with mismatched Team IDs left behind by electron-builder; `scripts/install-mac.mjs` re-signs the entire bundle after installation. Quarantine removal is handled by Homebrew on install.

---

## Repository Layout

```
orpheus/
├── src/
│   ├── main/           # Electron main process — IPC, SQLite, terminal addon, hooks
│   │   ├── ipc/        # Per-domain typed IPC handler modules (registerXxxIpc)
│   │   └── db/         # Declarative schema + migration engine
│   ├── preload/        # Context bridge (window.api.*) and its type contract (index.d.ts)
│   ├── renderer/src/   # React 19 + Tailwind v4 renderer
│   └── shared/         # types.ts (cross-process types) + ipc.ts (typed channel map)
│
├── packages/
│   └── ghostty-surface/ # NAPI C++ addon (addon.mm) wrapping libghostty
│
├── resources/
│   ├── orpheus-claude.sh   # Shell entry point for each claude workspace session
│   ├── bin/orpheus-notify  # Claude hook shim (Unix socket client)
│   └── ghostty/            # Terminfo + shell integration resources for libghostty
│
├── vendor/
│   └── GhosttyKit.xcframework  # Prebuilt libghostty framework (SHA-256 verified)
│
├── scripts/            # Build helpers: install-mac.mjs, fetch-libghostty.sh, release.mjs, etc.
├── electron-builder.yml         # Production build configuration
├── electron-builder-dev.yml     # Dev build configuration (Orpheus Dev.app)
└── electron.vite.config.ts      # Vite + electron-vite configuration and path aliases
```
