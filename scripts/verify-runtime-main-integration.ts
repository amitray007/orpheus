// ---------------------------------------------------------------------------
// scripts/verify-runtime-main-integration.ts
//
// Offline guardrails for the Phase 2 main-process composition seams. This
// intentionally does not import Electron, open SQLite, bind the real command
// socket, or launch a terminal surface.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildManagedMcpFlagTokens } from '../src/main/controlPlane/managedMcpLaunch.ts'

const repoRoot = path.resolve(import.meta.dirname, '..')
const readRepoFile = (relativePath: string): string =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const indexSource = readRepoFile('src/main/index.ts')
const adapterSource = readRepoFile('src/main/orpheusSurfaceAdapter.ts')
const commandServerSource = readRepoFile('src/main/commandServer.ts')
const sessionStateSource = readRepoFile('src/main/sessionState.ts')

// Managed MCP launch remains ephemeral: one --mcp-config pair, an absolute
// bundled command, and no strict mode, config-file writes, env, or secrets.
{
  const resourcesPath = '/Applications/Orpheus Dev.app/Contents/Resources'
  const [flag, inlineConfig] = buildManagedMcpFlagTokens(resourcesPath)
  assert.equal(flag, '--mcp-config')
  const config = JSON.parse(inlineConfig) as {
    mcpServers: Record<string, { command: string; args: unknown[]; type: string; env?: unknown }>
  }
  assert.deepEqual(Object.keys(config.mcpServers), ['orpheus-control'])
  assert.equal(config.mcpServers['orpheus-control']?.command, `${resourcesPath}/bin/orpheus-mcp`)
  assert.equal(config.mcpServers['orpheus-control']?.type, 'stdio')
  assert.deepEqual(config.mcpServers['orpheus-control']?.args, [])
  assert.equal(config.mcpServers['orpheus-control']?.env, undefined)
  assert.equal(inlineConfig.includes('runtime-secret'), false)
}

// Runtime env is appended after auth/custom layers, and the build variant
// preserves the independent worktree data directory.
//
// Phase 0 (multi-harness migration) deleted the launch-side routing overlay
// (`Object.assign(env, computeRoutingEnv(...))`) from buildMountEnv — see
// commit d14115fb. That deletion is now itself the load-bearing invariant:
// re-introducing it would silently reroute non-Claude-model workspaces
// through CLIProxyAPI again ahead of schedule (routing returns harness-aware
// in Phase 6). So this asserts the OPPOSITE of what it used to: the routing
// call must be ABSENT.
//
// A bare "string is absent" check would also pass if this file were
// renamed, gutted, or moved, so it's paired with positive assertions that
// adapterSource still contains real, expected content — the file wasn't
// merely emptied out from under this check.
{
  assert.ok(adapterSource.length > 0, 'orpheusSurfaceAdapter.ts must not be empty')
  assert.ok(
    adapterSource.includes('function buildMountEnv'),
    'buildMountEnv must still be defined in orpheusSurfaceAdapter.ts'
  )
  assert.equal(
    adapterSource.includes('Object.assign(env, computeRoutingEnv'),
    false,
    'RE-LAND(routing): the launch-side routing overlay must stay absent from buildMountEnv until Phase 6'
  )
  assert.ok(
    adapterSource.includes('ORPHEUS_RUNTIME_CONTEXT_VERSION'),
    'runtime env constant must still be present'
  )
  // The old check ordered runtimeEnvIndex > routingIndex (routing, then
  // runtime env, applied last). With the routing call gone there is nothing
  // to order against; re-anchor on the invariant the comment at
  // orpheusSurfaceAdapter.ts's Phase-0 note calls out instead — auth env
  // (`...authEnv`) must still be spread into `env` BEFORE the runtime
  // identity block (which sets ORPHEUS_RUNTIME_CONTEXT_VERSION) overwrites
  // it, since runtime identity must win over anything upstream, including
  // auth-provided vars, and never the reverse. indexOf on single-line,
  // semantically-meaningful tokens — deliberately NOT a multi-line literal
  // with hard-coded indentation, which prettier (run via lint-staged on
  // every commit) could reflow and break for a reason unrelated to the
  // actual invariant.
  const authEnvSpreadIndex = adapterSource.indexOf('...authEnv, // auth env wins on conflict')
  const runtimeAssignIndex = adapterSource.indexOf('ORPHEUS_RUNTIME_CONTEXT_VERSION')
  assert.ok(authEnvSpreadIndex >= 0, 'authEnv spread must still be present')
  assert.ok(runtimeAssignIndex >= 0, 'runtime identity constant must still be present')
  assert.ok(
    runtimeAssignIndex > authEnvSpreadIndex,
    'runtime identity env must still be merged AFTER authEnv, so it always wins on conflict'
  )
  for (const envName of [
    'ORPHEUS_RUNTIME_ID',
    'ORPHEUS_RUNTIME_KIND',
    'ORPHEUS_SURFACE_ID',
    'ORPHEUS_PROJECT_ID',
    'ORPHEUS_WORKSPACE_ID',
    'ORPHEUS_CLAUDE_CONVERSATION_ID',
    'ORPHEUS_RUNTIME_LEASE_TOKEN'
  ]) {
    assert.ok(adapterSource.includes(envName), `missing server-owned env: ${envName}`)
  }
  // The variant ladder lives in a module-level DATA_VARIANT constant (extracted
  // so buildMountEnv stays under the cognitive-complexity cap); assert on the
  // constant's definition plus the fact that the env still reads from it.
  assert.match(
    adapterSource,
    /const DATA_VARIANT =\s*isWorktreeBuild\s*\?\s*'wt'\s*:\s*isNightly\s*\?\s*'nightly'\s*:\s*isDev\s*\?\s*'dev'\s*:\s*'prod'/
  )
  assert.match(adapterSource, /ORPHEUS_DATA_VARIANT:\s*DATA_VARIANT/)
  assert.ok(adapterSource.includes('buildManagedMcpFlagsString(process.resourcesPath)'))
  assert.match(
    adapterSource,
    /const managedMcpFlags = runtimeLease\s*\?\s*buildManagedMcpFlagsString/
  )
  assert.ok(
    adapterSource.includes('...(cmdServer ? { ORPHEUS_CMD_SOCK: cmdServer.sockPath } : {})')
  )
  assert.ok(adapterSource.includes('...(cmdServer ? { ORPHEUS_CMD_TOKEN: cmdServer.token } : {})'))
}

// The command socket must be listening and chmodded before the first renderer
// window can mount. A failed ready promise is handled before createWindow.
{
  const readyAwaitIndex = indexSource.indexOf('await startedCommandServer.ready')
  const startupWindowIndex = indexSource.indexOf('\n        createWindow()', readyAwaitIndex)
  assert.ok(readyAwaitIndex >= 0)
  assert.ok(startupWindowIndex > readyAwaitIndex)
  assert.ok(commandServerSource.includes('ready: Promise<void>'))
  const chmodIndex = commandServerSource.indexOf('fs.chmodSync(sockPath, 0o600)')
  const readyResolveIndex = commandServerSource.indexOf('resolveReady()', chmodIndex)
  assert.ok(chmodIndex >= 0)
  assert.ok(readyResolveIndex > chmodIndex)
  assert.ok(commandServerSource.includes('rejectReady(err)'))
}

// Command-server startup is additive. When it failed before the first window,
// normal Claude mounts omit command/runtime/MCP additions; when available, the
// same path still issues a lease and supplies the managed launch context.
{
  const mountStart = indexSource.indexOf('function prepareMountControl(')
  const mountEnd = indexSource.indexOf('function handlePostMountOverlay(', mountStart)
  const mountSource = indexSource.slice(mountStart, mountEnd)
  assert.ok(mountStart >= 0 && mountEnd > mountStart)
  assert.ok(mountSource.includes('if (activeCommandServer == null)'))
  assert.ok(mountSource.includes('return { activeCommandServer: null, leaseIssue: null }'))
  assert.ok(mountSource.includes('leaseIssue: issueRuntimeLeaseForMount(workspace, addon)'))
  assert.ok(mountSource.includes('activeCommandServer ?? undefined'))
  assert.ok(mountSource.includes('leaseIssue == null'))
  assert.ok(
    mountSource.includes(
      '[terminal] control server unavailable; launching Claude without managed MCP'
    )
  )
  assert.equal(
    mountSource.includes('Orpheus control server is unavailable; runtime mount was blocked.'),
    false
  )
}

// /control has its own runtime credential, filtered discovery, and invocation.
// It never calls the legacy-token authenticator or downgrades on failure.
{
  const controlStart = commandServerSource.indexOf('function handleControl(')
  const subscribeStart = commandServerSource.indexOf('// POST /subscribe', controlStart)
  const controlSource = commandServerSource.slice(controlStart, subscribeStart)
  assert.ok(controlStart >= 0 && subscribeStart > controlStart)
  assert.ok(controlSource.includes("req.headers['x-orpheus-runtime-lease']") === false)
  assert.ok(commandServerSource.includes("req.headers['x-orpheus-runtime-lease']"))
  assert.ok(controlSource.includes('resolveRuntimeLease(req, res, deps.runtimeLeases)'))
  assert.equal(controlSource.includes('authenticate(req, res, token)'), false)
  assert.ok(controlSource.includes('deps.listControl(context)'))
  assert.ok(controlSource.includes('deps.invokeControl({'))
  assert.ok(commandServerSource.includes("principal: { type: 'workspace-agent'"))
  assert.ok(commandServerSource.includes("consumer: 'mcp'"))
  assert.ok(commandServerSource.includes("req.url === '/control'"))
}

// Mount and teardown lifecycle retains leases on hide but revokes every
// destructive or failed path, including PID/session disappearance and quit.
{
  assert.ok(indexSource.includes('runtimeLeases.issueOrReuseClaude({'))
  assert.ok(indexSource.includes('runtimeLeases.revokeByWorkspace(workspaceId)'))
  assert.ok(indexSource.includes('runtimeLeases.revokeBySurface(workspaceId)'))
  assert.ok(indexSource.includes("binding.state === 'live'"))
  assert.ok(indexSource.includes('runtimeLeases.revokeAll()'))

  const hideStart = indexSource.indexOf("handle('terminal:hide'")
  const destroyStart = indexSource.indexOf("handle('terminal:destroy'", hideStart)
  const hideSource = indexSource.slice(hideStart, destroyStart)
  assert.equal(hideSource.includes('runtimeLeases.revoke'), false)

  assert.ok(sessionStateSource.includes('setRuntimeSessionObserver'))
  assert.ok(sessionStateSource.includes('result.statusUpdatedAt = session.statusUpdatedAt'))
  assert.ok(sessionStateSource.includes("availability: 'available' | 'unavailable'"))
}

console.log('Runtime main-process integration verification passed.')
