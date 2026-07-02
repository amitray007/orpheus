# Code quality audit — 2026-07-02

Multi-agent audit of the full repo at staging tip `db0bd33`. Five wave-1 dimensions
(CI/quality gates, duplication/structure, performance, error handling, open-source
readiness) plus a wave-2 deep dive on code-quality patterns (appended below as it
lands). Every finding carries a stable ID so fixes/PRs can reference them.

Severity: **H** = high (user-visible harm, correctness, or gate-level gap),
**M** = medium (real cost, not urgent), **L** = low (hygiene).
Status: `open` until a fix lands; update in place.

Baseline at audit time: `bun run typecheck` ✅ clean · `bun run lint` ❌ **fails**
(1 error + 233 warnings — see ACT-1).

---

## 1. Actively broken / costing right now

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| ACT-1 | H | `bun run lint` fails on the current tree: 1 error + 233 warnings, nearly all from `docs/brainstorms/2026-07-02-panes-mockups/` which ESLint should never lint. Proof of the enforcement gap (CI-1/CI-10). | `docs/brainstorms/2026-07-02-panes-mockups/shared.js:101` (no-unused-vars error) + ~230 prettier warnings in same dir | open |
| ACT-2 | H | Unthrottled `console.warn` per session file per reconcile tick. `KNOWN_GOOD_VERSIONS = {'2.1.190'}` but installed claude is 2.1.198, so the warning fires N-files × (every fs event + every 2.5 s), continuously — thousands of synchronous stdout writes/hour on the main thread. `knownBadSessionFiles` dedups parse errors only, not version warnings. | `src/main/sessionState.ts:27`, `:330-334`, interval `:182` | open |
| ACT-3 | H | Dormant hook stack has machine-wide runtime cost: 9 hooks installed into global `~/.claude/settings.json` (incl. PreToolUse/PostToolUse) but 8 of 9 `handleHookEvent` cases are immediate no-op returns. Every tool call in **every** claude session on the machine spawns the `orpheus-notify` shim + Unix-socket roundtrip whose payload is discarded. Only `notification` does anything. The `session-start` case is a no-op — contradicting CLAUDE.md's claim that SessionStart→overlay-dismissal is still live (it's file-driven now). | `src/main/orpheusNotify.ts:25-35` (HOOK_EVENT_MAP), `:242-279` (dead switch), `:342-419` (install) | open |
| ACT-4 | M | Native addon takes `NSActivityUserInitiated \| NSActivityLatencyCritical \| NSActivityIdleSystemSleepDisabled` into a `__strong static` on first mount and never ends it — idle **system** sleep disabled for process lifetime once any terminal mounts, bypassing the careful opt-in policy in `src/main/powerAwake.ts` (`shouldHold()` auto mode). Real battery cost on laptops at idle. | `packages/ghostty-surface/addon.mm:2436-2441` | open |
| ACT-5 | M | `git:listCommits` is the one remaining `execFileSync` (with `--shortstat`, which forces per-commit diff computation; timeout 3 s) — blocks ALL main-thread work (IPC, reconcile, ghostty tick) while it runs. Every sibling in `git.ts` is already async `execFile`. | `src/main/git.ts:216,222`; IPC wire `src/main/index.ts:1987` | open |
| ACT-6 | M | First footer-chip fetch per workspace cold-builds the usage accumulator by reading + `JSON.parse`-ing the **entire** JSONL transcript synchronously on the main thread (transcripts can be tens of MB → hundreds of ms block). Incremental follow-ups and the 30 s TTL cache are fine; only the cold build (per workspace per app launch, and after eviction) is the problem. | `src/main/actions/session.ts:314-390` (`advanceAccumulator`), cache `:51` | open |

## 2. CI, automation, and quality gates

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| CI-1 | H | Direct pushes to `staging` run **zero** CI, yet staging is the sole working branch and receives direct commits (e.g. `db0bd33`). ci.yml triggers on `pull_request` + `push: main` only. | `.github/workflows/ci.yml:3-6` | open |
| CI-2 | H | `noImplicitAny` silently OFF despite `strict: true`: the extended `@electron-toolkit/tsconfig` sets `strict: true` then `noImplicitAny: false`; neither tsconfig re-enables it. ESLint `no-explicit-any: error` catches explicit `any` but not implicit. | `tsconfig.node.json`, `tsconfig.web.json` (both extend `@electron-toolkit/tsconfig`) | open |
| CI-3 | H | Native addon changes never compile-checked in CI: `native-build-check.yml` paths-filter covers only `scripts/fetch-libghostty.sh`; ci.yml installs with `--ignore-scripts`. An Obj-C++ syntax error in `addon.mm` merges green and fails at release-build time. | `.github/workflows/native-build-check.yml:16-19`; `ci.yml:31-35` | open |
| CI-4 | H | No tests and no test runner. Highest-value seams, in order: (a) `composeClaudeLaunch` (`src/main/claudeSettings.ts`) — pure layering with documented precedence invariants; (b) db migrations — `scripts/smoke-db-migrations.ts` exists but see CI-5; (c) status mapping in `src/main/sessionState.ts`; (d) settings validators/BOOLEAN_KEYS. `bun test` needs zero new deps. | no `*.test.*` anywhere; `ci.yml:57` comment acknowledges | open |
| CI-5 | M | DB-migration smoke test runs only at release time, **after** the tag exists (`build-and-attach`), not in PR/staging CI. A migration regression is caught post-release. | `.github/workflows/release-please.yml:200-206` | open |
| CI-6 | M | All release-quality gates (typecheck, vite build, smoke) run AFTER release-please created the tag + GitHub release; a failure leaves a half-published release requiring manual `release.yml` repair. Mitigate via CI-1/CI-5 running pre-merge. | `release-please.yml:158-206` | open |
| CI-7 | M | Break-glass `release.yml` builds default-branch HEAD, not the requested tag — checkout has `fetch-depth: 0` but no `ref: ${{ inputs.tag }}`; the version sanity gate passes in the common case, so a rebuild can silently include post-tag commits. | `.github/workflows/release.yml:48-50`, gate `:62-67` | open |
| CI-8 | M | No security scanning at all: no CodeQL, no dependency-audit job, no secret scanning. Notable for a source-available Electron app storing auth tokens. | `.github/workflows/` (six files, none security) | open |
| CI-9 | M | Actions pinned by mutable major tags (`actions/checkout@v7`, `oven-sh/setup-bun@v2`, `wagoid/commitlint-github-action@v6`, `googleapis/release-please-action@v5`) — third-party actions run in workflows holding `HOMEBREW_TAP_TOKEN`/`RELEASE_PLEASE_TOKEN`. Pin SHAs; dependabot keeps them fresh. | all workflows | open |
| CI-10 | M | Local hooks enforce Prettier only: lint-staged = prettier, pre-push = prettier --check. ESLint and typecheck enforced nowhere locally; no `commit-msg` commitlint hook (conventional-commit format unchecked for direct staging pushes). | `.husky/pre-commit`, `.husky/pre-push`, `package.json` lint-staged block | open |
| CI-11 | M | `bun-version: latest` floats the toolchain in every CI/release run — a bun regression can break a release with no repo change. | `ci.yml:29`, `native-build-check.yml:35`, `release-please.yml:187`, `release.yml:74`, `bump-libghostty.yml:29` | open |
| CI-12 | L | `scripts/check-overlay-discipline.mjs` and `scripts/verify-contrast.mjs` are quality guards nothing runs (not in CI, package.json, or husky). Both are pure-Node and `--ignore-scripts`-compatible. | grep across `.github/`, `package.json`, `.husky/` | open |
| CI-13 | L | CI check job runs on macOS (10× cost) with no dependency caching; `.eslintcache` never persists. ci.yml's own comment concedes ubuntu would do. | `ci.yml:21` | open |
| CI-14 | L | Tap publish can half-fail: plain `git push` after the immutable tap release is created, no rebase/retry on divergence → tap release exists with stale cask. | `release-please.yml:275-283` vs `:261-265` | open |
| CI-15 | L | Stale comment: release-please.yml claims the checkout "sees the bumped package.json + CHANGELOG.md" but config sets `"skip-changelog": true` and no CHANGELOG.md exists. | `release-please.yml:181-183`, `release-please-config.json` | open |
| CI-16 | M | ESLint is recommended-tier, not type-aware: no `no-floating-promises` / `no-misused-promises` — in a main process full of fire-and-forget async IPC handlers. Switch `src/main/**` to the type-checked config at minimum. | `eslint.config.mjs` | open |

Verified fine: PRs to staging DO run typecheck+lint+format; concurrency groups correct; dependabot covers npm + actions; release.yml has no auto trigger (the historical double-fire is fixed); commitlint relaxations are documented-deliberate.

## 3. Duplication, dead code, structure

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| DUP-1 | H | Whole-file twin: `claudeProjectSettings.ts` vs `claudeWorkspaceSettings.ts` — both 110 lines, **zero diff** after project/workspace substitution. Should be one generic `overridesStore(table, idColumn)` factory. | `src/main/claudeProjectSettings.ts`, `src/main/claudeWorkspaceSettings.ts` | open |
| DUP-2 | H | Whole-file twin: `ClaudeSubagentsSection.tsx` (626) vs `ClaudeSlashCommandsSection.tsx` (630) — identical skeleton at near-identical line numbers; only ~276 of ~1256 lines diverge. Extract a generic frontmatter-file collection editor (list+group+form+CRUD) parameterized by field schema. | `src/renderer/src/components/dashboard/settings/` | open |
| DUP-3 | H | The IPC contract is stringly-typed and maintained in triplicate: 129 channel strings independently in main (`handle()` wrapper erases to `(...args:any[])=>any`), preload invoke wrappers, and the 428-line `index.d.ts`. A typo or payload drift compiles clean. Biggest structural win: shared typed `ChannelMap` in `src/shared/types.ts`, derive preload from it. | `src/main/index.ts:1017-1049`, `src/preload/index.ts`, `src/preload/index.d.ts` | open |
| DUP-4 | M | `ProjectRow` type + row→record mapper duplicated verbatim (incl. the `// v37` comment) between projects.ts and workspaces.ts — new project column requires 4 edits. | `src/main/projects.ts:14-48`, `src/main/workspaces.ts:~35-50,91-108` | open |
| DUP-5 | M | Settings-section load/optimistic-patch scaffold copy-pasted across 10+ section components (44 `let cancelled` hits renderer-wide). Extract `useGlobalSettings()` / `useUiState()` hooks (fetch + optimistic patch + reconcile). | `ClaudeGeneralSection.tsx:22-49`, `ClaudeMemorySection.tsx:14-37`, `OrpheusAppearanceSection.tsx:70`, +8 more | open |
| DUP-6 | M | Preload event-listener boilerplate ×24 (`ipcRenderer.on` + removeListener closure) alongside 129 hand-written invoke wrappers, mirrored again in index.d.ts. `subscribe<T>(channel)` helper; ideally solved together with DUP-3. | `src/preload/index.ts` (~78-84, ~110-118, ×24) | open |
| DUP-7 | L | `searchIndex.ts` (1,864 lines) hand-syncs every setting's label/description/mapsTo/keywords — guaranteed drift from the actual `SettingRow`s. Co-locate search metadata with setting declarations and build the index. | `src/renderer/src/components/dashboard/settings/searchIndex.ts` | open |
| DEAD-1 | H | (= ACT-3) Dormant hook stack: ~350 lines servicing one `broadcastDetailIfChanged`. Trim installed hooks to Notification-only or delete the stack. | `src/main/orpheusNotify.ts` | open |
| DEAD-2 | M | 78 exported symbols never imported elsewhere. Top removals: ~35 unused exports in `dotmatrix-core-lib.ts` (668 lines); `dotm-square-12.tsx` (component unused); `dotmatrix-factory.tsx` `createPathWaveComponent`; `activitySink.ts:43-52` legacy fan-out loop iterating a **provably empty** listener set (`onActivityChange` imported nowhere); `overlayDevTest.ts` (133 lines); `getWorkspaceForkedFromSessionId`, `parseBrewLine`, `serializeGhosttyConfig`, `fetchStatusSnapshot`, CLI `EXIT_CODES`/`ENV_VARS`. (Some are internal-use — only the `export` keyword is dead.) | script scan over src + packages | open |
| STR-1 | H | God files: `src/main/index.ts` 3,217 lines / 129 `ipcMain.handle` registrations (sectioned but not modular; only `actions/terminal.ts` self-registers). Split into per-domain `registerXxxIpc(deps)` modules. | `src/main/index.ts` | open |
| STR-2 | M | God components: `Dashboard.tsx` 1,502 lines (13 useState, 22 useEffect, 78 `window.api` sites — routing + terminal rects + activity + settings + dirty-chip), `Sidebar.tsx` 1,458 (21 useState; drag-reorder + pinning + context menus + IPC inline), `ClaudeToolsSection.tsx` 945, `ClaudeDeveloperSection.tsx` 908, `WorkspaceView.tsx` 823. | `src/renderer/src/components/dashboard/` | open |
| STR-3 | M | Type-safety leak clusters (repo discipline otherwise good: 2 `: any`, 3 `as any`, 2 `@ts-ignore`, 19 `as unknown as`): (a) DUP-3's IPC erasure; (b) 45 `.get() as` + 21 `.all() as` sqlite casts against per-file Row types; (c) all 8 overlay kinds round-trip props through `Record<string,unknown>` + `as unknown as XProps` both directions (`overlayClient.ts` casts ×9) — wants a discriminated `OverlayKindPropsMap` in shared types. | `overlay/kinds/*.tsx:~21`, `overlayClient.ts:248-536` | open |

## 4. Performance

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| PERF-1 | H | = ACT-2 (version-warning spam on hot reconcile path). | `sessionState.ts:330` | open |
| PERF-2 | H | = ACT-5 (`execFileSync` listCommits blocks main thread ≤3 s). | `git.ts:222` | open |
| PERF-3 | M | = ACT-4 (process-lifetime NSActivity defeats powerAwake policy). Scope to "≥1 surface attached and not occluded" (addon already tracks both) or drop `IdleSystemSleepDisabled`. | `addon.mm:2436` | open |
| PERF-4 | M | = ACT-6 (sync whole-transcript cold read for usage chips). Chunk with `setImmediate` yields (pattern exists in sessions.ts) or bound the cold read like the sessions scanner's 200 KB head/tail. | `actions/session.ts:314-390` | open |
| PERF-5 | M | Shared-repo git refresh duplicates work N×: `refreshGitForDir` awaits `getGitStatus(cwd)` **per client**, but all clients of a watcher entry share the same resolved cwd; each call spawns 4 git subprocesses → 4K spawns per debounced change with K workspaces on one repo. Compute once, fan out. | `src/main/git.ts:293-336`, dedup key `:405`, spawns `:41-56` | open |
| PERF-6 | L | Fixed 2.5 s reconcile interval runs `readdirSync` + per-file `readFileSync` + a DB query forever, even with a healthy watcher and backgrounded app. Back off (10–30 s) when watcher alive, like claudeStatus.ts blur backoff. | `sessionState.ts:182-184` | open |
| PERF-7 | L | `[perf] eventloop` console.log every 10 s forever in production; self-described temporary instrumentation. Gate behind dev/diag flag. | `src/main/index.ts:2722-2731` | open |
| PERF-8 | L | `knownBadSessionFiles` prune is O(bad×files) via `files.includes` in a loop (use a Set); `deadPidReported` and LiveChip `chipValueCache` (module Map keyed actionId:workspaceId) never evict — clear alongside Dashboard's per-workspace purges on archive. | `sessionState.ts:320`, `:82`; `LiveChip.tsx:89`; `Dashboard.tsx:361-368` | open |

Verified fine (don't "fix"): sessions.ts JSONL scanning (bounded 200 KB reads, mtime guard, in-flight dedup, yields, single-transaction); 16 ms-coalesced activity IPC batches; per-key `useSyncExternalStore` stores + sharedTicker; ref-counted watcher lifecycles with archive teardown; hidden/occluded surfaces gate-stop the display link and the 10 Hz timer early-returns at idle; WAL + NORMAL + proper indexes; startup work deferred post-first-paint.

## 5. Error handling and robustness

Posture: a real diagnostics pipeline exists (in-memory ring → SQLite w/ retention → user-facing `diag:export`; renderer onerror/unhandledrejection captured; every IPC handler logs+rethrows via the `handle()` wrapper). The gaps are the paths that bypass it.

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| ERR-1 | H | Startup failure is fully silent: `app.whenReady().then(...)` has no `.catch`; the `unhandledRejection` listener (log-only) suppresses Node's default fatal exit; a `getDb()` throw (corrupt/locked sqlite, failed migration) → no window, no dialog, and the diag flush needs the same broken DB, so no persisted log either. Add `.catch` → `dialog.showErrorBox` + plaintext crash file under userData + `app.exit(1)`. | `src/main/index.ts:2698`, `:659-668`; `src/main/db.ts:399-418` | open |
| ERR-2 | H | `uncaughtException` handler converts main-process crashes into silent zombie state; its comment claims it "does NOT alter Electron's default crash handling" — registering the listener does exactly that. Rethrow/exit for fatal, or surface once; fix the comment. | `src/main/index.ts:648-658` | open |
| ERR-3 | H | Two-tier logging: ~25 real warn/error paths log via `console.*` only — invisible in the packaged app, absent from diag export. Includes the exact `setWorkspaceStatus` swallow that historically froze workspaces at "Claude is thinking" (memorialized at `db.ts:51-55`), watcher-fell-back-to-polling, hook install/parse failures, launch-settings failures. Route through `logDiagMain`. | `orpheusNotify.ts:213,357,472,487,552`; `sessionState.ts:250,257,289,399`; `index.ts:2796` | open |
| ERR-4 | H | Renderer has no user-visible error surface: no toast system exists; 35× `.catch(() => {})` + 70× `.catch(console.error)` in renderer. Failed archive/rename/add-project/mount → nothing visible. Generic `terminal:mount` failure = permanently blank pane (worktree errors DO get an error card — reuse that pattern). | `Dashboard.tsx:1223,1113-1115,1059-1062,932-933`; `WorkspaceView.tsx:440-442` (vs card `:203-271`) | open |
| ERR-5 | H | Archive flow destroys state optimistically BEFORE the fallible IPC: `terminal.destroy` (kills live claude) + purge of activity/title/git/PR/footer caches all run before `await workspaces.archive`; catch only console.errors. Failure → workspace still listed, session dead, no error. Main already destroys the surface post-archive (`index.ts:578`) — the renderer pre-destroy is redundant; reorder. | `Dashboard.tsx:1084-1115` | open |
| ERR-6 | M | Corrupt `overrides_json` silently degrades a workspace's launch: parse-catch → treated as empty, **no log**, and `recomputeDirty` compares two snapshots that both lack the overrides so even the "Restart to apply" chip can't fire. Diag-log with project/workspace id. | `claudeProjectSettings.ts:22-28`, `claudeWorkspaceSettings.ts:22-28`; `index.ts:586` | open |
| ERR-7 | M | Session-list DB writes swallow per-row failures inside transactions with no count/log — systematic failure (schema drift; precedent at db.ts:51-55) = silently empty/stale sessions list, indistinguishable from "no sessions". Emit one anomaly event when failures > 0 per batch. | `src/main/sessions.ts:663-687`, `:819-825`, `:900+`, `:642` | open |
| ERR-8 | M | commandServer outer catch swallows handler-plumbing errors with zero log (inner dispatch errors are returned `{ok:false}` — fine). CLI client hangs/drops with no app-side record. | `src/main/commandServer.ts:1208-1212` | open |
| ERR-9 | M | `isWorktreeDirty` treats git timeout/lock-contention as "clean" (any failure → `false`). Actual deletion is still guarded by `git worktree remove` w/o `--force`, but the phase-2 removal loop in projects:remove catches-and-continues (console-only) then cascade-deletes rows → orphaned dirty worktree dirs with their workspace rows gone. Distinguish ENOENT (clean) from timeout/error (dirty); diag-log phase-2 failures. | `src/main/worktrees.ts:227-237`; `index.ts:1195-1220` | open |
| ERR-10 | M | No top-level React error boundary: `main.tsx` renders `<App/>` bare (only the overlay window has one). Render throw → React unmounts the root → permanent white window over a still-alive native terminal. | `src/renderer/src/main.tsx:17-19`; contrast `overlay/OverlayErrorBoundary.tsx` | open |
| ERR-11 | L | `ensureManagedHooks` can clobber a valid-JSON-but-non-object `~/.claude/settings.json` (array/string top-level → treated as `{}` → atomic write replaces file with hooks-only object). Bail like the parse-failure path. | `orpheusNotify.ts:347-362`, write `:415-417` | open |
| ERR-12 | L | brew/git update spawns have no kill timeout (missing-binary and exit-code semantics ARE handled) — a stalled network mount leaves the update check in `checking` forever, no cancel. ~60 s timer. | `src/main/updates.ts:76-100,118,258` | open |

Verified fine: torn-read handling of session files (last-good map, deduped anomaly events) is exemplary; secrets never logged (keys-only mount log, redacting audit log, settingsJson verified secret-free); `execFile` everywhere with timeouts on git/claude probes; SHELL validated before spawn; worktree-create rollback on DB failure; multi-step writes transactional; loading-overlay 10 s fallback with anomaly event.

## 6. Open-source readiness / docs

| ID | Sev | Finding | Evidence | Status |
|---|---|---|---|---|
| OSS-1 | H | LICENSE forbids the product's own distribution model: clause 1 restricts to "personal evaluation of the source code", clause 2 prohibits copying — yet the app ships via a public brew tap for people to *run*. Every brew user technically violates the license. Add an explicit grant to run official binary releases. | `LICENSE:11-13` vs `README.md:26-31` + cask pipeline | open |
| OSS-2 | H | README has no end-user install section: brew is the only channel and the `brew install --cask` command appears nowhere; no screenshots either (single highest-leverage README addition for a GUI app). | `README.md` | open |
| OSS-3 | H | Fresh clones can break through no fault of the user: postinstall `fetch-libghostty.sh` downloads from a third party's rotating "storage" releases that 404 weekly (repo's own CI comment admits it). Mirror the pinned zip to an amitray007-owned release; document the `--ignore-scripts` escape hatch. | `scripts/fetch-libghostty.sh:25-27`; `.github/workflows/ci.yml:18-20,33-34` | open |
| OSS-4 | M | SECURITY.md says distribution is via a "**private** Homebrew tap" — it's public. | `SECURITY.md:49` | open |
| OSS-5 | M | `.codex/agents/audit-claude-env-vars.toml` is tracked and visibly corrupted by a global Claude→Codex find/replace: `https://code.Codex.com/docs/en/env-vars.md`, `.Codex/snapshots/…`, "run `Codex --help`". | `.codex/agents/audit-claude-env-vars.toml` | open |
| OSS-6 | M | GPL-3.0 ghostty shell-integration scripts bundled inside an all-rights-reserved app — TPN discloses it, but the aggregation-not-derivative rationale is unexamined in-repo. Document the position. | `THIRD_PARTY_NOTICES.md:15`; `resources/ghostty/ghostty/shell-integration/` | open |
| OSS-7 | M | No `engines` field, no pinned bun (`packageManager` absent; CI floats `latest`, CI-11); scripts invoke bare `node`, stack assumes Node 22/Electron 39 ABI. | `package.json` | open |
| OSS-8 | L | THIRD_PARTY_NOTICES stale: references `packages/ghostty-native` (actual: `ghostty-surface`); lists `@floating-ui/react` + `@electron-toolkit/preload` which are not dependencies. | `THIRD_PARTY_NOTICES.md:11,17,23` | open |
| OSS-9 | L | Personal-machine path in a tracked comment: `/Users/maverick/.claude/worktrees/xterm-experiment`. | `src/main/claudeProjectDir.ts:6-7` | open |
| OSS-10 | L | Dep placement: `react`/`react-dom` in devDeps while renderer-only `@phosphor-icons/react`, `geist`, `minidenticons`, `@web-kits/audio` sit in `dependencies` (needlessly packed into asar node_modules — electron-vite externalizes `dependencies` for main only). Dead `pnpm.onlyBuiltDependencies` block in a bun repo. | `package.json:50-58,80-81,86-91` | open |
| OSS-11 | L | Issue templates are legacy `.md` (no forms, no `config.yml` → blank issues allowed, no security-contact link); no CODEOWNERS (optional, single maintainer). Intel support claimed in README but never CI-tested (xcframework slice is arm64+x86_64). | `.github/ISSUE_TEMPLATE/`; `README.md:30` | open |
| OSS-12 | L | Stale private-era framing in tracked files: `.impeccable.md` ("personal, single-user tool… deferred until share-ready"); `docs/learnings/overlay-child-window-macos.md` references a gitignored plan doc (dead link publicly). | `.impeccable.md`; `docs/learnings/overlay-child-window-macos.md:3-5` | open |

Verified fine: LICENSE/SECURITY/CONTRIBUTING/CoC/TPN/templates/FUNDING/dependabot all exist and are substantive; no secrets in tracked files (grep sweep for token/key patterns clean); ARCHITECTURE.md is an accurate human-facing companion to CLAUDE.md; deps are current-gen with no unused entries; naming ("Orpheus" prose / `orpheus` identifiers) consistent.

---

## Suggested order of attack

1. **Quick wins (≤1 day, each immediately felt):** eslint-ignore `docs/` (ACT-1) · dedup version warning (ACT-2) · async `listCommits` (ACT-5) · `staging` in ci.yml push triggers (CI-1) · `.catch`+dialog on whenReady (ERR-1) · SECURITY.md/TPN/codex-toml/username fixes (OSS-4/5/8/9).
2. **CI hardening:** eslint in lint-staged + commit-msg hook (CI-10) · native path filter (CI-3) · migration smoke in CI (CI-5) · `noImplicitAny: true` (CI-2) · pin bun + action SHAs (CI-9/11) · first `bun test` over `composeClaudeLaunch` (CI-4) · type-aware ESLint for src/main (CI-16).
3. **Structural debt (dedicated efforts):** typed IPC ChannelMap (DUP-3/6) · merge twins (DUP-1/2/4) · `useGlobalSettings`/`useUiState` hooks (DUP-5) · split index.ts / Dashboard.tsx (STR-1/2) · trim hook stack (ACT-3) · delete dead exports (DEAD-2) · renderer error surface + boundary (ERR-4/10) · archive-flow reorder (ERR-5).
4. **Before going public:** LICENSE grant (OSS-1) · README install + screenshots (OSS-2) · mirror libghostty artifact (OSS-3) · GPL rationale (OSS-6).

---

## Wave 2 — code-quality deep dive

_In progress: async/race correctness, React & renderer patterns, main-process/DB
craftsmanship, conventions/comments/naming. Findings appended when verified._
