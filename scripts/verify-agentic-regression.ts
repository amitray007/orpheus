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
  'verify-harness-registry.ts',
  'verify-harness-launch.ts',
  'verify-harness-curated.ts',
  'verify-harness-actions.ts',
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
  ['verify-harness-launch-parity.ts', ['node', '--experimental-strip-types']]
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
