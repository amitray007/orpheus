# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## IMPORTANT: Orchestration model (always follow)

For any non-trivial code work in this repo (features, fixes, refactors, performance
work), **the top-level/main agent acts only as an orchestrator**: it researches,
brainstorms, plans, and reviews — but it does **not** write or edit feature/fix code
itself. **All code building, fixes, and edits MUST be delegated to subagents running
the SONNET model.** Spawn Sonnet subagents (via the Agent tool or Workflow with
`model: 'sonnet'`) to do the actual implementation. The orchestrator guides them,
verifies their output, and integrates — it never does the hands-on coding directly.

(Trivial conversational answers and pure research don't require delegation; the rule
applies to substantive code changes.)

## What this is

Orpheus is a **source-available macOS Electron app** that wraps `claude` (the Claude Code CLI) in a project/workspace UI. The renderer is React + Tailwind v4; the main process is TypeScript on Node; the terminal is rendered by a native NAPI addon that embeds prebuilt **libghostty** (`vendor/GhosttyKit.xcframework`) as an `NSView` parented onto Electron's `BrowserWindow` native handle. Persistence is `better-sqlite3` at `~/Library/Application Support/Orpheus/orpheus.sqlite`.

## Git workflow (branching)

**All work happens on the `staging` branch.** Features, fixes, chores — everything
is committed to `staging`. We do **not** create per-feature/per-task branches and we
do not work off `main` directly. There is one long-lived working branch: `staging`.

Releases ship by raising a PR from `staging` → `main`. `main` is the release branch;
`staging` is where development lands first. So:

- Build/commit new work on `staging`.
- When it's time to release, open a PR `staging` → `main`.
- Don't spin up extra topic branches unless explicitly asked.

**ALWAYS merge `staging` → `main` with a real merge commit — never squash or
rebase.** Versioning is owned by **release-please**, which reads the individual
conventional-commit messages off `main` to compute the version + CHANGELOG.
Squashing collapses the 80+ commits into one non-conventional commit and breaks
that detection. Do not hand-bump `package.json#version` — release-please opens a
release PR on `main` that does the bump; merge that release PR (also a merge
commit) to publish.

**Versioning policy — PATCH-ONLY while private (the current state).** The repo
is in private/pre-share development, so `release-please-config.json` sets
`"versioning": "always-bump-patch"`: **every release is a patch bump**
(`0.5.0 → 0.5.1 → 0.5.2 …`) regardless of commit type — even `feat:` and
breaking changes only bump patch. This is deliberate: the version is just a
"newer build" marker right now, and we don't want minor/major inflation from
routine feature work. Commit prefixes (`feat:`/`fix:`/`refactor:`/`chore:`) are
still used — they drive **CHANGELOG grouping only** while private, NOT the
version size — so keep writing accurate conventional-commit subjects.

**When Orpheus goes public**: remove the
`"versioning": "always-bump-patch"` line from `release-please-config.json` to
restore default SemVer (`feat:` → minor, `feat!:`/`BREAKING CHANGE` → major,
`fix:` → patch). At that point, reserve `feat:` for genuine new user-facing
capability so the version stays meaningful. Until then: **all patches.**

## Build + verify loop (the only one that matters)

Local builds **always build the DEV variant** (`Orpheus Dev.app`). Production
(`Orpheus.app`) is owned by the Homebrew cask / CI release pipeline — never built
or installed locally. The dev and prod variants coexist: separate app name, bundle
id, icon, and data dir (`~/Library/Application Support/Orpheus Dev/`), so the dev
build never touches your real production install.

```bash
osascript -e 'tell application "Orpheus Dev" to quit' 2>/dev/null; sleep 1
pkill -x "Orpheus Dev" 2>/dev/null; true
bun run build:unpack         # → build:dev: build:native → ORPHEUS_MODE=development build → electron-builder-dev.yml --dir → install Orpheus Dev.app
open "/Applications/Orpheus Dev.app"
```

- **Never run the production build locally.** `build:unpack` is an alias for `build:dev` and installs `Orpheus Dev.app`. The prod path (`build:mac` / `install:mac-prod`) is guarded — `install-mac.mjs` refuses to overwrite `/Applications/Orpheus.app` unless `ORPHEUS_ALLOW_PROD_INSTALL=1` is set explicitly. The agent never sets that flag; production ships only via `release.yml` + Homebrew.
- **Do not run `bun run dev`.** Icon, bundle, signing all diverge from shipped — wastes time on dev-only artifacts. Use the dev _build_ (`build:unpack`/`build:dev`), not `electron-vite dev`.
- `bun run build:unpack` chains everything (native addons → vite bundle → electron-builder → re-sign + install `Orpheus Dev.app`). Don't shortcut to `bun run build` if native code changed — it skips the addon rebuild.
- The user has standing consent to auto-close + relaunch around builds; don't ask.
- After each build, sanity-check: `pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1`.

### Other commands

| Command                    | What it does                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run typecheck`        | Runs both `typecheck:node` (main + preload + shared) and `typecheck:web` (renderer) against composite tsconfigs.                                                                                                                                                                                                                             |
| `bun run lint`             | ESLint over the workspace (flat config, `.eslintcache` enabled). CI runs `bunx eslint . --max-warnings=146` — a ratchet that only goes DOWN as warnings are fixed; don't add new ones.                                                                                                                                                       |
| `bun run format`           | Prettier-format the workspace. Enforced by `husky` `pre-commit` (lint-staged Prettier) and `pre-push` (`prettier --check`).                                                                                                                                                                                                                  |
| `bun run check`            | Aggregate gate: `typecheck` + `lint` + `check:dup` + `check:arch`. Run before considering non-trivial work done.                                                                                                                                                                                                                             |
| `bun run check:dup`        | `jscpd` duplication scan over `src` + `packages/orpheus-cli`, threshold 2.4%.                                                                                                                                                                                                                                                                |
| `bun run check:arch`       | `depcruise` (dependency-cruiser) over `src` + `packages/orpheus-cli` — enforces no circular imports plus layer rules (e.g. `src/shared/ipc.ts` may only import from `./types`).                                                                                                                                                              |
| `bun run check:dead`       | `knip` dead-code/unused-export scan. Advisory, not a hard CI gate.                                                                                                                                                                                                                                                                           |
| `bun run test:db`          | Runs `scripts/verify-migration-engine.ts` — the DB migration engine's assertion harness. CI-gated on changes under `src/main/db/**`; run and extend it whenever you touch that directory.                                                                                                                                                    |
| `bun run build:native`     | Rebuild `packages/ghostty-surface` (`node-gyp` against the installed Electron ABI).                                                                                                                                                                                                                                                          |
| `bun run fetch:libghostty` | Re-fetch `vendor/GhosttyKit.xcframework` + `vendor/ghostty` source pin (SHA-256-verified). Runs as `postinstall`.                                                                                                                                                                                                                            |
| `bun run release`          | **Manual fallback only** (release-please owns the normal path — see release-pipeline section). Build `.dmg`, publish a `vX.Y.Z` GitHub release, render `scripts/orpheus-cask.template.rb`, commit + push the cask in `../homebrew-tap` (override path with `ORPHEUS_TAP_PATH`). Do NOT hand-bump `package.json#version` for the normal flow. |

**Enforcement gates.** Husky hooks run automatically: `pre-commit` (lint-staged ESLint + Prettier on staged files), `commit-msg` (commitlint), `pre-push` (`typecheck` + `eslint --max-warnings=146` + `prettier --check`). In CI, `typecheck`, `lint` (146 ratchet), `format`, `check:dup`, and `check:arch` are hard gates; `check:dead` is advisory; `test:db` is a hard gate but path-filtered to run only when `src/main/db/**` changes.

There is no general/renderer test runner — don't invent one for feature code. The DB migration engine is the one exception: it has a real assertion harness, `scripts/verify-migration-engine.ts`, run via `bun run test:db` (see the SQLite section below).

## Architecture

### Three-process model (Electron)

- **Main** (`src/main/`) — Node 22 / Electron 39. Owns SQLite, native addon, IPC handlers, hook server. Entry: `src/main/index.ts` (2700+ lines) wires cross-cutting handlers directly and delegates per-domain handlers to `src/main/ipc/*.ts` modules (`claudeAgents.ts`, `claudeAuth.ts`, `claudeHooks.ts`, `footerActions.ts`, `ghosttySettings.ts`, `git.ts`, `keepAwake.ts`, `mcp.ts`, `misc.ts`, `orpheusConfig.ts`, `shell.ts`, `system.ts`, `updates.ts`), each registered from `index.ts` via a `registerXxxIpc(deps)` call.
- **Preload** (`src/preload/index.ts`) — typed `window.api.*` bridge. `index.d.ts` is a thin shim (`OrpheusApi = typeof api`) that hangs the type off `Window`; the renderer types against it.
- **Renderer** (`src/renderer/src/`) — React 19 + Tailwind v4 + Geist. Boot path: `main.tsx` → `App.tsx` (runs doctor) → `components/dashboard/Dashboard.tsx`. Path aliases: `@renderer/*`, `@/*` → `src/renderer/src/*`; `@shared/*` → `src/shared/*`.
  - Cross-component state lives in `src/renderer/src/lib/` as external stores via `useSyncExternalStore`, not component-local state. Per-workspace data uses the `createPerKeyStore` factory (`gitStore`, `prStore`, `titleStore`, `activityStore`, `activityTimeStore`, `sleepStore`); app-wide UI state is `uiStateStore` (via the `useUiState` hook); reusable hooks include `useDebouncedValue`, `useOverlayHoverCard`, `useInlineRename`. Check for an existing store/hook before adding new component-local state.
- **Shared types** (`src/shared/types.ts`) — single source of truth for all IPC payloads, DB record types, draft types. Both main and renderer import from here. `src/shared/ipc.ts` is the companion typed channel map (see "Adding an IPC channel" below).

### Adding an IPC channel (typed + strict)

IPC is no longer raw `ipcMain.handle(...)` calls scattered through `index.ts` — it's a typed, strict system anchored in `src/shared/ipc.ts`:

1. **Request/response channels** must be added to `InvokeChannelMap` in `src/shared/ipc.ts` first, as `'channel:name': { req: [...]; res: ... }`. The `handle()` wrapper (`src/main/ipc/handle.ts`) is generic over `keyof InvokeChannelMap`, so registering a channel name that isn't in the map — or a handler whose args/return don't match — is a **compile error**, not a runtime surprise.
2. **Implement** via `handle('channel:name', (e, ...args) => ...)` from `src/main/ipc/handle.ts` inside the matching `src/main/ipc/<domain>.ts` module's `registerXxxIpc(deps)` function (or a new module wired into `index.ts`) — never call raw `ipcMain.handle`. The wrapper auto-times the handler and logs slow/failing calls.
3. **Expose in preload** (`src/preload/index.ts`) via the typed `invoke()` helper, added to the `api` object.
4. **Push channels** (main → renderer, fire-and-forget) must be added to BOTH `RendererPushMap` and the `PUSH_CHANNELS` const in `src/shared/ipc.ts` — an exhaustiveness type-check (`_PushChannelsCoverAllKeys`) fails to compile if they drift apart. Send via `webContents.send`, consume in preload via `subscribe(PUSH_CHANNELS.xxx, cb)`.
5. **New `ipc/` modules receive index.ts-owned state via their `registerXxxIpc(deps)` parameter** (e.g. `registerMiscIpc({ getProject })`), never by importing `index.ts` directly — that would create a circular dependency.

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

Schema lives in `src/main/db/` (a directory, not a monolith). `schema.ts` is the single declarative source of truth — every table is declared once as a structured `TableDef`. `engine.ts` introspects the live DB, diffs it against `schema.ts`, and reconciles the difference (add column / add index / or a full SQLite 12-step table rebuild when a change touches a `CHECK` constraint, column type, or `NOT NULL`). `data-steps.ts` holds ordered, named, run-once data transforms tracked in an `applied_data_steps` ledger (named, not integer-versioned, so steps can't collide). `cutover.ts` is the ordered first-boot entry point; `index.ts` exposes the unchanged public surface (`getDb()` / `migrate()`).

**To add a column:** edit the table's `TableDef` in `schema.ts` — add the column once. The engine adds it on the next boot. No more CREATE-block + defensive-ALTER double-declaration, no `catch {}`, no version bump.

**To add a data transform:** append a named `DataStep` to `data-steps.ts` — it runs once and is recorded in the ledger by name.

**CHECK/enum evolution is automatic:** change the shared enum array in `schema.ts` and the engine rebuilds the table, with `normalizeOnRebuild` coercing legacy values into the new constraint. The old `healWorkspacesCheck` / `healProjectsArchivedAt` boot-time healers are gone — the reconciler subsumes them.

**Column drops are explicit** — a `dropColumns: [...]` array on the `TableDef` — never inferred from a column's absence, so a typo in `schema.ts` can't cause silent data loss.

Never write destructive migrations by hand; the engine's rebuild path backs up via `VACUUM INTO` before any rebuild and verifies row counts after. Verification harness: `bun run test:db` (dev-only, under `scripts/`, not shipped) exercises render/introspect/diff/rebuild/backup/engine/schema-fresh/convergence/data-steps/cutover.

### Native terminal addon

`packages/ghostty-surface/addon.mm` exports four NAPI functions (`mount` / `hide` / `resize` / `destroy`) called only from the Electron main thread, plus `setTitleCallback` / `setActionTraceCallback` for events fanned back to JS. Surface lifecycle = workspace lifecycle (one entry per `workspace.id`). `CVDisplayLink` drives drawing; the callback dispatches `ghostty_surface_draw` back to the main queue.

The shell-integration resources (terminfo + integration scripts) live under `resources/ghostty/` and are bundled to `Contents/Resources/{terminfo,ghostty}/` by `electron-builder.yml`. `GHOSTTY_RESOURCES_DIR` is set in `loadTerminalAddon()` before the `.node` is `require`'d so ghostty's auto-walk can find them in both packaged and dev layouts.

### Workspace activity status (file-authoritative)

Workspaces get a live status (`in_progress` / `attention` / `awaiting_input` / `idle`) shown by `Dashboard/ActivityIndicator.tsx`. **Claude's own on-disk session registry is the single source of truth — not hooks** (this changed in the Phase 2 cutover).

1. Every running `claude` writes `~/.claude/sessions/<pid>.json` (`status`: `busy`/`idle`/`waiting`; `waitingFor`: `permission prompt`/`input needed`; `sessionId`; `statusUpdatedAt`). `claude agents --json` is just a reader of these files. Workspace claude must register here, which requires `resources/orpheus-claude.sh` to `unset` inherited Claude Code session vars (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, …) — otherwise it's treated as a nested session and skips registration.
2. `src/main/sessionState.ts` watches that dir (`fs.watch` + debounced single-flight `reconcile` + interval backstop), matches each live session to a workspace by `claude_session_id` (pre-assigned via `--session-id`, stable across `--resume`), and drives status through `setStatusFromFile` → `orpheusNotify.dispatch`: `busy → in_progress`, `waiting → attention`, `idle → awaiting_input` (or `idle` when idle longer than `staleAfterMinutes`), file-gone/dead-pid → `idle`. Dead pids and torn reads are tolerated; transitions are gated via `lastRawActed`.
3. `dispatch` (`orpheusNotify.ts`) persists via `setWorkspaceStatus`, broadcasts through `activitySink` (`workspace:activityBatch` IPC → renderer `activityStore`), fires OS notifications via `osNotifications.notifyForTransition`, and arms the idle-watchdog (`awaiting_input → idle`) + auto-close watchdog. `WorkspaceActivityDetail` is `working` / `attention` / `ready` / `idle` / `archived`.
4. OS notification **content** is also file-sourced (`sessionState.getWorkspaceFileInfo`): attention copy from `waitingFor`, "Claude finished" elapsed from a `busySince` timer.

**Hooks are dormant enrichment, not the status driver.** `orpheusNotify.ts` still runs the Unix-domain socket server + shim (`resources/bin/orpheus-notify`), still installs managed hooks into `~/.claude/settings.json`, and `ORPHEUS_WORKSPACE_ID` is still injected so the shim can attribute events — but `handleHookEvent` no longer decides status. The only live hook behavior is `SessionStart → onSessionStart` (loading-overlay dismissal); other cases are wired no-ops kept revivable. (A future phase could re-home the overlay and remove the hook stack entirely.)

### Renderer view kinds

`AppUiState.lastViewKind` is one of `sessions | project | workspace` (also accepts the legacy string `dashboard` for older DBs — coerced to sessions on read; there is no dashboard page). The sidebar persists which view to open at launch. **Don't reintroduce a dashboard/home page** — it was deliberately removed.

### Distribution

Ships exclusively via **public Homebrew tap** (`amitray007/homebrew-tap` cask; the dmg is hosted on a release on that public repo — see the release-pipeline section above). Brew installs strip macOS quarantine so the ad-hoc-signed bundle launches. There is no `electron-updater`; auto-publish IS wired (release-please on merge to `main` — not `scripts/release.mjs`, which is the rarely-used manual fallback). The in-app updates check (`src/main/updates.ts` → `OrpheusUpdatesSection.tsx`) uses `brew outdated`/`brew upgrade` against the tap cask (refreshing the tap first).

Ad-hoc codesigning is re-applied to the whole bundle in `scripts/install-mac.mjs` because electron-builder leaves inner frameworks with mismatched Team IDs and macOS 15+ refuses to load them. **Do not store secrets in macOS Keychain** until proper Developer ID signing exists — ad-hoc re-sign reshuffles ACLs on every build. Plaintext SQLite columns are intentional (`auth_api_key`, `auth_token`, etc.).

#### Release pipeline architecture (read before touching ANY release workflow)

There are **two** GitHub Actions release workflows plus a local script. They are
easy to confuse and have burned releases — here is the ground truth.

- **`.github/workflows/release-please.yml` — THE automatic release path (single owner).**
  Triggers on `push: main`. Opens/updates a Release PR (version + CHANGELOG from
  conventional commits). When that Release PR is merged it creates the git tag +
  GitHub release on `amitray007/orpheus`, then its `build-and-attach` job (runs
  only when `release_created == true`) builds the `.dmg`, and **publishes the dmg
  to a RELEASE on `amitray007/homebrew-tap`** + renders/pushes the cask. This is
  the only workflow that should run on a normal release.
- **`.github/workflows/release.yml` — MANUAL break-glass only (`workflow_dispatch`).**
  Must NOT auto-trigger. (It historically ran on `push: main`, which double-fired
  alongside release-please.yml — that's what corrupted releases. Do not re-add a
  push/tag trigger.)
- **`scripts/release.mjs` (`bun run release`)** — local one-off, rarely used.

**THE LOAD-BEARING INVARIANT — where the dmg lives must match the cask URL.**
The cask (`scripts/orpheus-cask.template.rb`) hard-codes the download URL to a
release on the **homebrew-tap** repo:
`https://github.com/amitray007/homebrew-tap/releases/download/orpheus-v#{version}/orpheus-#{version}.dmg`.
So the publishing job MUST `gh release create orpheus-v<tag> --repo amitray007/homebrew-tap`

- `gh release upload ... --repo amitray007/homebrew-tap --clobber`. Uploading the
  dmg only to the _source_ `amitray007/orpheus` release leaves the cask pointing at a
  non-existent tap release → `brew` 404. The cask `sha256` and the uploaded dmg are
  rendered/uploaded in the **same job from the same build**, so they always match;
  `--clobber` is unconditional so the asset can never be a stale one from a prior run.

**Failure modes already hit (do not repeat):**

1. _Double-run / SHA mismatch_ — two workflows (or two main-push triggers) each
   build a **non-deterministic** dmg (ad-hoc signed, `notarize: false` → different
   bytes every build). The tap ends with run A's dmg but run B's cask SHA →
   `brew upgrade` fails the SHA-256 check. Fix: ONE owner builds + publishes
   atomically.
2. _Split-brain dmg location_ — release-please.yml uploaded the dmg to the source
   release while the cask pointed at the tap release → 404. Fix: publish to the
   tap release (above).
3. _Stale local tap on the update check_ — `brew outdated --fetch` does NOT pull
   new cask definitions from the tap git repo; the in-app check must
   `git -C <tap> pull --ff-only` first (`src/main/updates.ts`).
4. _Version drift staging↔main_ — release-please bumps `package.json` on `main`;
   that bump is never merged back to `staging`, so the next `staging→main` PR would
   REVERT the version. Always `git merge origin/main` into staging before opening
   the release PR (verify `package.json` is NOT in the staging→main diff).
5. _Bot-created tags don't trigger workflows_ — GitHub suppresses workflow triggers
   from `GITHUB_TOKEN`-created refs (anti-recursion). So `push: tags: v*` will NOT
   fire when release-please creates the tag. Don't rely on a tag trigger for the
   auto path; release-please.yml's own `build-and-attach` job is the trigger.

Releases `v0.3.0` and `v0.3.1` are abandoned (broken cask SHA / 404 respectively);
the first clean release after these fixes is `v0.3.2`.

## Conventions specific to this repo

- **Bun is the package manager.** `bun.lock` is committed; `package.json#packageManager` is not pinned but the husky hook uses `bunx`.
- **Strict layering of secrets.** Auth env (`getClaudeAuthEnv()`) is merged AFTER the launch env so `ANTHROPIC_API_KEY` always wins. `SECRET_KEYS` in `terminal:mount` redacts values from the `[terminal] mount …` log line. Never log raw `authEnv` values.
- **No hardcoded paths or URLs.** Derive from `os.homedir()`, `process.env.SHELL`, `app.getPath(...)`, or read from the DB. `getUserShellPath()` in `index.ts` spawns the user's login+interactive shell once to capture their real `$PATH` (Finder-launched Electron apps get a stripped PATH).
- **Workspace surfaces are sticky.** `hide` ≠ `destroy`. Renderer navigation must call `terminal:hide` then `terminal:mount` again on return; never `destroy` unless the workspace is being archived/removed.
- **Settings are layered.** Any UI control that maps to claude settings must compose through `composeClaudeLaunch` and carry a `mapsTo` chip pointing to the env var or settings key it produces.
- **Commits use Conventional Commits, no emoji.** `feat(scope):`, `fix(scope):`, `chore(scope):`. No `Co-Authored-By: Claude` lines unless explicitly requested. While private, prefixes drive CHANGELOG grouping only — versioning is patch-only regardless of prefix (see the versioning policy in the Git-workflow section).
  - **Enforced in CI by commitlint** (`commitlint.config.mjs` → `.github/workflows/commitlint.yml`, `wagoid/commitlint-github-action`). It runs on PRs to `staging` (contributor PRs) and is intentionally skipped on the `staging → main` release PR (`branches-ignore: [main]`).
  - **Allowed types (`type-enum`):** `feat`, `fix`, `chore`, `refactor`, `docs`, `perf`, `build`, `ci`, `style`, `test`, `revert`. A type outside this list fails the check. The format is `type(scope): subject` — scope is **optional** and unrestricted (`keep-awake`, `diag`, etc. all pass).
  - **Deliberate relaxations** (so the project's own style isn't flagged): `header-max-length` is **off** (long subjects are fine), `subject-case` is **off** (any casing), and `scope-empty`/`scope-case` are off. Merge commits are auto-ignored by commitlint's `defaultIgnores`. Keep subjects accurate and conventionally prefixed; don't rely on the relaxations as license for sloppy messages.
- **Audit env vars before adding new settings.** The `.claude/agents/audit-claude-env-vars.md` agent diffs `https://code.claude.com/docs/en/env-vars.md` against `.claude/snapshots/env-vars.json` — run it (or invoke it as a subagent) before guessing whether something is already wired.
