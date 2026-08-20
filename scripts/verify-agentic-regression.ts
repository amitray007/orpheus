import { spawnSync } from 'node:child_process'
import process from 'node:process'

const CHILD_TIMEOUT_MS = 120_000

const verifiers = [
  'verify-control-plane.ts',
  'verify-control-plane-phase2.ts',
  'verify-phase2-read-adapters.ts',
  'verify-runtime-leases.ts',
  'verify-runtime-main-integration.ts',
  'verify-session-state-observation.ts',
  'verify-command-action.ts',
  'verify-project-add.ts',
  'verify-workspace-orchestration-foundation.ts',
  'verify-workspace-orchestration-main.ts',
  'verify-cli-phase3-compat.ts',
  'verify-workspace-renderer-actions.ts',
  'verify-review-mcp-mutation.ts',
  'verify-workbench-reducer.ts',
  'verify-workbench-pane-control.ts',
  'verify-pane-layout-deletion.ts',
  'verify-renderer-idle-performance.ts',
  'verify-native-idle-activity.ts',
  'verify-terminal-observability.ts',
  'verify-terminal-launch-env.ts',
  'verify-control-plane-phase6.ts',
  'verify-control-tool-exposure.ts',
  'verify-agent-tools-settings-ui.ts',
  'verify-durable-automations.ts',
  'verify-production-automation-operations.ts',
  'verify-automation-management.ts',
  'verify-automation-management-mcp.ts',
  'verify-automation-management-wiring.ts',
  'verify-automations-settings.ts',
  'verify-agentic-integration.ts',
  'verify-log-redaction.ts',
  'verify-mcp-bridge.ts',
  'verify-cli-autolaunch.ts',
  'verify-routing.ts',
  'verify-cli-flags.ts',
  'verify-aliases.ts',
  'verify-effort-levels.ts',
  'verify-session-status.ts',
  'verify-non-claude-launch-behavior.ts',
  'verify-model-picker.ts',
  // Harness-selector rebuild of the "+ new workspace" popover
  // (support-multi-harness) — decideHarnessCreateAction/isHarnessRowDisabled
  // (a harness chip click both selects and creates) plus the shared
  // submenu-flip/phantom-hover/hover-intent logic newWorkspaceMenuLogic.ts
  // still carries for ChipGroupedDropdown.tsx's own flyout. Was previously
  // written but never wired into this suite — see this file's own header
  // comment for why an unwired harness is indistinguishable from no harness.
  'verify-new-workspace-menu.ts',
  'verify-harness-registry.ts',
  'verify-doctor.ts',
  'verify-harness-launch.ts',
  'verify-harness-curated.ts',
  'verify-harness-actions.ts',
  // C4 (support-multi-harness) — pure gating decisions in
  // src/shared/harness/capabilityGating.ts, consumed by Sidebar.tsx/
  // WorkspacesView.tsx/WorkspacesTab.tsx/WorkspaceTitleBar.tsx, plus the
  // fallback-fix half of the unit (harnessStore.ts's loading/unknown-id
  // fallback must grant no capabilities). No SQLite/native dependency —
  // runs under plain bun like verify-harness-curated.ts above.
  'verify-harness-capability-gating.ts',
  // Runs under plain node, not bun — see verify-harness-settings.ts's own
  // header comment: it uses node:sqlite's DatabaseSync for a real in-memory
  // DB, and node:sqlite has no bun equivalent ("Could not resolve:
  // 'node:sqlite'" under `bun run`, verified empirically). Listed as a
  // [label, command] tuple rather than a bare string so runVerifier() below
  // can dispatch it to `node --experimental-strip-types` instead of the
  // uniform `bun run scripts/<name>` every other entry uses.
  ['verify-harness-settings.ts', ['node', '--experimental-strip-types']],
  // Same node:sqlite/DatabaseSync constraint as verify-harness-settings.ts
  // above (this harness needs a real, working DB — see its own header
  // comment for why the throws-if-called stub verify-harness-launch.ts uses
  // doesn't suffice here) — dispatched via the same [label, command] tuple
  // form to run under plain node instead of bun.
  ['verify-harness-claude-launch.ts', ['node', '--experimental-strip-types']],
  // Phase B (multi-harness migration) — codex/{curated,launch}.ts, the
  // Codex CLI descriptor's launch emitter. Same node:sqlite/DatabaseSync
  // constraint as verify-harness-claude-launch.ts directly above (needs a
  // real, working harness_settings + claude_workspace_settings DB, not a
  // throws-if-called stub) — dispatched via the same [label, command] tuple
  // form to run under plain node instead of bun.
  ['verify-harness-codex-launch.ts', ['node', '--experimental-strip-types']],
  // C5 (support-multi-harness) — codex/session.ts: the discoverer that
  // binds a Codex workspace to its real Codex session id (rollout-file
  // scanning, thread_source/cwd/mount-floor filtering) plus codexSessionArgs
  // (the resume-argv builder). Two layers of fixtures: real temp-dir rollout
  // files for the pure discoverer, plus the same node:sqlite/DatabaseSync
  // `workspaces` table technique as verify-harness-session.ts (getWorkspace/
  // setWorkspaceClaudeSessionId need a real DB, not a throws-if-called stub)
  // — dispatched under plain node for the same reason as the entries above.
  ['verify-harness-codex-session.ts', ['node', '--experimental-strip-types']],
  // U5 — session.ts's claudeSessionArgs. Same node:sqlite/DatabaseSync
  // constraint (getWorkspace needs a real, working `workspaces` table, not
  // a throws-if-called stub) — dispatched under plain node for the same
  // reason as the two entries above. See verify-harness-session.ts's own
  // header for why resolveHarness is ALSO intercepted here (not for a DB
  // dependency, but to make the capability-gating scenarios test-controllable).
  ['verify-harness-session.ts', ['node', '--experimental-strip-types']],
  // U7 THE PARITY GATE — drives BOTH launch emitters against the same
  // fixtures and asserts byte-equality over the surface they share. Needs a
  // real DB (claude_global_settings + harness_settings + workspaces), so the
  // same node:sqlite constraint as the three entries above applies.
  ['verify-harness-launch-parity.ts', ['node', '--experimental-strip-types']],
  // U8 — the harness settings UI's pure logic module (isSecretLikeKey/
  // moveRow/resolveProvenance). No SQLite/native dependency, so this runs
  // under plain bun like the majority of this suite's entries — see
  // verify-harness-settings-ui.ts's own header for why it doesn't need the
  // node:sqlite dispatch the harness-settings/-claude-launch/-session/-parity
  // entries above require.
  'verify-harness-settings-ui.ts',
  // H1 (support-multi-harness) — the project Settings drawer's pure core
  // (src/shared/harness/projectDrawerSettings.ts): which harness the drawer
  // edits, the tri-state model/effort/permissionMode merge, and the honest
  // override-chip decision. No SQLite/native dependency (pure TS transforms
  // over plain objects), so plain bun like the entry above.
  'verify-project-drawer-settings.ts',
  // H1 follow-up (support-multi-harness) — per-harness worktree directory
  // derivation (src/shared/harness/worktreePaths.ts): `.<harness>/worktrees`
  // instead of a hardcoded `.claude/worktrees`. No SQLite/native dependency,
  // plain bun like the entry above.
  'verify-worktree-paths.ts',
  // C1 (support-multi-harness) — createWorkspace()'s new harnessId param,
  // the write-side half of the migration (workspaces.harness_id existed
  // since Phase 1.3 but nothing could ever write a non-default value until
  // this unit). Same node:sqlite/DatabaseSync constraint as the harness-
  // settings/-claude-launch/-session/-parity entries above (needs a real,
  // working `workspaces`/`projects` schema, not a throws-if-called stub) —
  // dispatched via the same [label, command] tuple, mirroring
  // verify-harness-launch-parity.ts's register()-hook technique (electron +
  // ./db short-circuited to inline stub modules) rather than mock.module(),
  // which is Bun-only and cannot combine with node:sqlite in any one
  // runtime — see verify-workspace-harness-create.ts's own header.
  ['verify-workspace-harness-create.ts', ['node', '--experimental-strip-types']],
  // C5 (support-multi-harness) — the per-harness footer-action SEEDING half
  // of the unit: footerActions.ts's seedDefaultFooterActions/
  // seedDefaultFooterActionsForHarness/seedDefaultFooterActionsForAllHarnesses,
  // the new harness_id provenance column, and the terminal.sendInput
  // provenance gate, exercised end-to-end through listMerged() against a
  // real footer_actions_global/_project/_workspace + workspaces + projects
  // schema. Same node:sqlite/DatabaseSync constraint as the other
  // node-dispatched entries above (needs a real DB with a working
  // db.transaction() shim — see this file's own header for why
  // filterActionsForHarness's pure GATING logic is covered separately by
  // verify-harness-actions.ts, which stays on the plain-bun path since it
  // never touches SQLite).
  ['verify-footer-actions.ts', ['node', '--experimental-strip-types']],
  // CALL-SITE fix for tmuxHost.ts's hostWorkspace() — it composed the tmux
  // session launch via claudeSettings.ts's composeClaudeLaunch (the stale,
  // pre-cutover claude_global_settings emitter) instead of
  // orpheusSurfaceAdapter.ts's composeLaunchForMount (the harness registry,
  // reading harness_settings) that every other launch path already used.
  // Since tmux hosting is the DEFAULT path, this meant most users' `claude`
  // process ran with settings the Settings UI no longer showed as current.
  // Drives the REAL exported hostWorkspace() end-to-end against a real
  // throwaway tmux server, seeded with DELIBERATELY DIVERGING
  // --permission-mode values in harness_settings vs. claude_global_settings,
  // and asserts the composed new-session env reflects harness_settings —
  // see this harness's own header for why verify-harness-launch-parity.ts
  // (which compares the two emitters against each other, never calling
  // hostWorkspace() at all) cannot catch a call-site bug like this one.
  // Same node:sqlite/DatabaseSync + electron/./db register()-hook
  // constraints as the other node-dispatched entries above, plus a
  // node:child_process intercept (passthrough — real tmux still runs) to
  // observe the composed launch without racing scrubSecretEnvironment's
  // post-creation cleanup of the session's stored environment table.
  ['verify-tmux-host-composition.ts', ['node', '--experimental-strip-types']],
  // support-multi-harness follow-up — settingsSectionGating.ts's pure
  // decision (isSectionIdApplicable/filterSectionGroup/
  // resolveActiveSectionId), consumed by SettingsView.tsx to hide Claude-
  // only settings sections for a harness that doesn't declare them. Uses
  // mock.module() (Bun-only) to import the REAL registry.ts HARNESSES array
  // for the Claude regression net — same technique/constraint as
  // verify-harness-actions.ts and verify-harness-capability-gating.ts
  // above, so this stays on the plain-bun dispatch path, not the
  // node:sqlite tuple form the surrounding entries use.
  'verify-settings-section-gating.ts',
  // support-multi-harness harness-neutral-chrome unit — ActionChip.tsx's
  // failure-tooltip regression: main already returns a harness-neutral
  // busy message ('Workspace is busy', src/main/actions/terminal.ts), but
  // the renderer discarded it and substituted a hardcoded 'Claude is busy'
  // literal. Fixed via actionChipMessages.ts's pure actionFailureMessage.
  // No electron/DB dependency at all, so this stays on the plain-bun
  // dispatch path.
  'verify-action-chip-messages.ts',
  // support-multi-harness CLI/TUI harness-selection follow-up — `orpheus ws
  // new --harness <id>` client plumbing (commands/ws-new.ts's
  // buildCreateArgs, plus the registered usage/flags/--help surface). No
  // client-side membership check against a hardcoded harness-id list — the
  // server (commandServer.ts's isKnownHarnessId) is the sole validator; see
  // this file's own header for why. No SQLite/native dependency, plain bun
  // like the entry above.
  'verify-ws-new-harness.ts',
  'verify-harness-create-threading.ts',
  'verify-inherited-pane-env.ts',
  'verify-models-dev-cache.ts',
  'verify-effort-chip-restart.ts',
  // support-multi-harness bug fix — the "Starting workspace" overlay's
  // capability-gated dismiss decision (loadingOverlay.ts's
  // shouldWaitForSessionReadiness, consumed by index.ts's
  // handlePostMountOverlay): a harness with no structured-status source
  // (e.g. Codex) previously ALWAYS rode the Claude-tuned fixed 10s fallback
  // timer, since isWorkspaceSessionReady can never return true for it. Was
  // already covered by scripts/verify-loading-overlay.ts (package.json's
  // `test:overlay`) but that harness was NOT wired into this CI-gated
  // suite — an unwired harness is indistinguishable from no harness (see
  // this file's own header rule). No electron/DB dependency (loadingOverlay
  // ts is a leaf module with a fake-clock test hook), plain bun like the
  // entries above.
  'verify-loading-overlay.ts',
  // support-multi-harness bug fix — the sidebar's per-workspace provider
  // icon rendered nothing for a Codex workspace because
  // useWorkspaceProviderIcon resolves a providerId only from the
  // workspace's effective MODEL (via the Claude-routing-only selectable-
  // model list), which a Codex model never matches. Fixed by
  // WorkspaceProviderIcon.tsx's resolveWorkspaceProviderIconId: prefer the
  // model-derived provider, fall back to the workspace's own harness icon
  // (already computed by Sidebar.tsx's WorkspaceSubRow for other capability
  // gating — no new fetch). No electron/DB dependency, plain bun like the
  // entries above.
  'verify-workspace-provider-icon.ts'
] as const

function run(label: string, command: readonly [string, ...string[]]): void {
  const startedAt = performance.now()
  console.log(`\n▶ ${label}`)
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    timeout: CHILD_TIMEOUT_MS,
    killSignal: 'SIGTERM'
  })
  if (result.error != null) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      console.error(`✗ ${label} exceeded ${CHILD_TIMEOUT_MS / 1_000}s and was terminated`)
      process.exit(124)
    }
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  console.log(`✓ ${label} (${Math.round(performance.now() - startedAt)} ms)`)
}

function runVerifier(entry: (typeof verifiers)[number]): void {
  if (typeof entry === 'string') {
    run(entry, ['bun', 'run', `scripts/${entry}`])
    return
  }
  const [label, command] = entry
  run(label, [...command, `scripts/${label}`] as [string, ...string[]])
}

// The two bundled transports are shared by multiple verifiers. Build each once
// for the whole suite instead of hiding duplicate builds inside focused tests.
run('build agent transports', ['bun', 'run', 'build:agents'])
for (const verifier of verifiers) {
  runVerifier(verifier)
}

console.log(`\nAgentic regression suite passed (${verifiers.length} focused verifiers).`)
