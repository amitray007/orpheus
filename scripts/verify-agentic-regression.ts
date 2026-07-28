import { spawnSync } from 'node:child_process'
import process from 'node:process'

const CHILD_TIMEOUT_MS = 120_000

const verifiers = [
  'verify-control-plane.ts',
  'verify-control-plane-phase2.ts',
  'verify-phase2-read-adapters.ts',
  'verify-runtime-leases.ts',
  'verify-runtime-main-integration.ts',
  'verify-command-action.ts',
  'verify-workspace-orchestration-foundation.ts',
  'verify-workspace-orchestration-main.ts',
  'verify-cli-phase3-compat.ts',
  'verify-workspace-renderer-actions.ts',
  'verify-review-mcp-mutation.ts',
  'verify-workbench-reducer.ts',
  'verify-workbench-pane-control.ts',
  'verify-pane-layout-deletion.ts',
  'verify-terminal-observability.ts',
  'verify-terminal-launch-env.ts',
  'verify-control-plane-phase6.ts',
  'verify-control-tool-exposure.ts',
  'verify-agent-tools-settings-ui.ts',
  'verify-durable-automations.ts',
  'verify-automation-management.ts',
  'verify-automation-management-mcp.ts',
  'verify-automation-management-wiring.ts',
  'verify-automations-settings.ts',
  'verify-agentic-integration.ts',
  'verify-log-redaction.ts',
  'verify-mcp-bridge.ts'
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

// The two bundled transports are shared by multiple verifiers. Build each once
// for the whole suite instead of hiding duplicate builds inside focused tests.
run('build agent transports', ['bun', 'run', 'build:agents'])
for (const verifier of verifiers) {
  run(verifier, ['bun', 'run', `scripts/${verifier}`])
}

console.log(`\nAgentic regression suite passed (${verifiers.length} focused verifiers).`)
