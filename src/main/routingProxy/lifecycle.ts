// ---------------------------------------------------------------------------
// src/main/routingProxy/lifecycle.ts
//
// Spawn/supervise/kill the CLIProxyAPI child process. Owns two distinct
// per-run secrets, both generated fresh (crypto random) on every start() and
// handed to the child ONLY via env — never written to config.yaml, never
// logged:
//   - MANAGEMENT_PASSWORD: gates CLIProxyAPI's /v0/management/* routes.
//   - the ANTHROPIC_AUTH_TOKEN a routed Claude-CLI client sends as a Bearer
//     token — this is modelRouting.ts's getRoutingAuthToken() runtime value
//     (see setRuntimeRoutingAuthToken there), kept distinct from
//     MANAGEMENT_PASSWORD so a compromised client-side token can't reach the
//     management API and vice versa.
// ---------------------------------------------------------------------------

import * as crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { setRuntimeRoutingAuthToken } from '../modelRouting'

let child: ChildProcess | null = null
let managementSecret: string | null = null
let lastError: string | null = null

/** Per-run management-API secret. Regenerated on every start(); never persisted. */
export function getManagementSecret(): string | null {
  return managementSecret
}

export function getLastError(): string | null {
  return lastError
}

export function isRunning(): boolean {
  return child !== null && child.exitCode === null && !child.killed
}

export interface StartOptions {
  binaryPath: string
  configPath: string
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  onLog?: (line: string) => void
}

/**
 * Start the managed proxy child process, if not already running. Sets
 * MANAGEMENT_PASSWORD (freshly generated, per-run) in the child's env so the
 * management API (auth-files, etc.) is usable without a secret ever being
 * written to config.yaml on disk. Never logs the secret value itself — only
 * onLog(line) callbacks for the child's own stdout/stderr, which CLIProxyAPI
 * does not echo the secret back into.
 */
export function startRoutingProxy(options: StartOptions): { managementSecret: string } {
  if (isRunning()) {
    return { managementSecret: managementSecret ?? '' }
  }
  lastError = null
  managementSecret = crypto.randomBytes(24).toString('hex')
  const clientAuthToken = crypto.randomBytes(24).toString('hex')
  setRuntimeRoutingAuthToken(clientAuthToken)

  const proc = spawn(options.binaryPath, ['-config', options.configPath], {
    env: {
      ...process.env,
      MANAGEMENT_PASSWORD: managementSecret,
      // Client-facing bearer token — see the module doc block above. Passed
      // via env (never written to config.yaml) so it never touches disk,
      // mirroring MANAGEMENT_PASSWORD's own handling.
      ANTHROPIC_AUTH_TOKEN: clientAuthToken
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  proc.stdout?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) options.onLog?.(line)
    }
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) options.onLog?.(line)
    }
  })
  proc.on('error', (err) => {
    lastError = err.message
  })
  proc.on('exit', (code, signal) => {
    child = null
    setRuntimeRoutingAuthToken(null)
    if (code !== 0 && code !== null) {
      lastError = `CLIProxyAPI exited with code ${code}`
    }
    options.onExit?.(code, signal)
  })

  child = proc
  return { managementSecret }
}

/** Stop the managed proxy, if running. SIGTERM first, SIGKILL after a grace period. */
export function stopRoutingProxy(): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      child = null
      resolve()
      return
    }
    const proc = child
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
    }, 5000)
    proc.once('exit', () => {
      clearTimeout(killTimer)
      resolve()
    })
    proc.kill('SIGTERM')
  })
}

/** Wired into app quit (see index.ts's will-quit handler, mirroring notifyServer/commandServer cleanup). */
export function killRoutingProxySync(): void {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL')
  }
  child = null
  setRuntimeRoutingAuthToken(null)
}
