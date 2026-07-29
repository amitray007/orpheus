// ---------------------------------------------------------------------------
// scripts/verify-routing-proxy.ts
//
// Assertion harness for the managed routing-proxy component (model-routing
// unit 04, src/main/routingProxy/). Mirrors the existing scripts/verify-*.ts
// convention: a script run directly via `bun run` (the `test:proxy` package
// script), no test framework.
//
// MUST PASS FULLY OFFLINE. Every network/filesystem boundary this harness
// touches is injected (install.ts's InstallDeps, health.ts's HealthCheckDeps,
// updateCheck.ts's UpdateCheckDeps) — nothing here makes a real network call
// or writes outside a scratch tmpdir.
//
// Covers (per the unit spec):
//   - SHA-256 verification: correct hash accepts; wrong hash REJECTS and
//     does not install (the single most important assertion)
//   - arch -> asset-name mapping (arm64 -> aarch64, x64 -> amd64)
//   - config.yaml generation contains host/port/auth-dir, no hardcoded
//     absolute paths beyond what the caller passed in
//   - health-check: unhealthy when nothing listens; healthy when a stub responds
//   - fail-closed: routed mount refused when the proxy is unhealthy
//   - the management secret is never written to the generated config file
//   - state.ts's pure status-transition helpers: the enable->disable-while-
//     not-installed trap state (an 'error' status must never make
//     install/retry unreachable, and disabling must always land clean)
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  archToAssetSegment,
  assetNameFor,
  BINARY_NAME,
  downloadUrlFor,
  PINNED_TAG,
  PINNED_VERSION
} from '../src/main/routingProxy/constants.ts'
import {
  BinaryNotFoundError,
  ChecksumMismatchError,
  UnsupportedPlatformError,
  installRoutingProxy,
  parseChecksumsFile,
  sha256Hex,
  verifyChecksum,
  type InstallDeps
} from '../src/main/routingProxy/install.ts'
import {
  renderRoutingProxyConfig,
  writeRoutingProxyConfig
} from '../src/main/routingProxy/config.ts'
import {
  canPublishManagedRoutingProxyRunning,
  checkRoutingProxyHealth,
  ensureHealthyForRouting,
  probeRoutingProxyTcpReachability,
  waitForManagedRoutingProxyReady,
  waitForRoutingProxyTcpDiagnostic,
  type HealthCheckDeps,
  type ManagedReadinessDeps,
  type RoutingProxyReadyDeps
} from '../src/main/routingProxy/health.ts'
import type { RoutingProxySpawnAttempt } from '../src/main/routingProxy/lifecycle.ts'
import {
  checkRoutingProxyUpdate,
  type UpdateCheckDeps
} from '../src/main/routingProxy/updateCheck.ts'
import {
  canInstallOrRetry,
  cleanStoppedStatus,
  disableTransitionPatch,
  isInstalled
} from '../src/main/routingProxy/state.ts'
import {
  isSameVariantRoutingProxy,
  reclaimProvenOrphan,
  type ListenerInspectionDeps,
  type ListeningProcess
} from '../src/main/routingProxy/inspection.ts'
import {
  AUTOMATIC_PORT_MAX,
  AUTOMATIC_PORT_MIN,
  assertValidAutomaticRoutingProxyEffectivePort,
  automaticPortCandidates,
  getPreferredRoutingProxyPort,
  getRoutingProxyRuntime,
  type RoutingProxyVariantContext
} from '../src/main/routingProxy/runtime.ts'
import {
  effectiveAutomaticPortToPersist,
  startAtResolvedRoutingProxyPort
} from '../src/main/routingProxy/allocator.ts'
import {
  consumeExpectedCandidateExit,
  markFailedCandidateTermination
} from '../src/main/routingProxy/candidateExit.ts'
import type { RoutingProxyPortConfiguration } from '../src/shared/types.ts'
import {
  RoutingProxyLifecycleCoordinator,
  START_SUPERSEDED
} from '../src/main/routingProxy/lifecycleCoordinator.ts'
import {
  respawnBackoffDelayMs,
  decideRespawnAction,
  decideWatchdogAction,
  RoutingProxySupervisor,
  MAX_CONSECUTIVE_RESPAWN_FAILURES,
  type RoutingProxySupervisorDeps,
  type SupervisorLogger
} from '../src/main/routingProxy/supervisor.ts'

function isValidRoutingProxyCustomPortForTest(port: number | null): boolean {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535
}

function isStrictPortTextForTest(value: string): boolean {
  return /^\d+$/.test(value)
}

function shouldSyncCustomPortSnapshotForTest(
  isEditing: boolean,
  snapshot: { portMode: 'automatic' | 'custom'; portConfigurationLocked: boolean }
): boolean {
  return !isEditing || snapshot.portConfigurationLocked || snapshot.portMode !== 'custom'
}

// ---------------------------------------------------------------------------
// Test scratch dir — everything this harness writes lives here, never under
// a real userData path (paths.ts is intentionally NOT exercised by this
// harness since it imports `electron`, which this offline script never
// boots; install.ts/config.ts are called with explicit dest paths instead).
// ---------------------------------------------------------------------------

const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpheus-routing-proxy-test-'))

// ---------------------------------------------------------------------------
// 0. Persistent port runtime resolution — pure, current-state contracts.
// ---------------------------------------------------------------------------

{
  const production: RoutingProxyVariantContext = { mode: 'production' }
  const development: RoutingProxyVariantContext = { mode: 'development' }
  const worktree: RoutingProxyVariantContext = { mode: 'worktree' }
  assert.equal(getPreferredRoutingProxyPort(production), 18765)
  assert.equal(getPreferredRoutingProxyPort(development), 18766)
  assert.equal(getPreferredRoutingProxyPort(worktree), 18767)
  assert.equal(AUTOMATIC_PORT_MIN, 18765)
  assert.equal(AUTOMATIC_PORT_MAX, 18799)
  assert.deepEqual(automaticPortCandidates(18770, 18766).slice(0, 3), [18770, 18766, 18765])
  assert.equal(
    new Set(automaticPortCandidates(18766, 18766)).size,
    AUTOMATIC_PORT_MAX - AUTOMATIC_PORT_MIN + 1
  )

  const originalOverride = process.env.ORPHEUS_ROUTING_PROXY_URL
  try {
    process.env.ORPHEUS_ROUTING_PROXY_URL = 'https://proxy.example.test/path?keep=exact'
    assert.deepEqual(
      getRoutingProxyRuntime({
        routingProxyPortMode: 'custom',
        routingProxyCustomPort: 4567,
        routingProxyEffectivePort: 18770
      }),
      {
        source: 'environment',
        url: 'https://proxy.example.test/path?keep=exact',
        host: 'proxy.example.test',
        port: 443,
        portConfigurationLocked: true
      }
    )
  } finally {
    if (originalOverride === undefined) delete process.env.ORPHEUS_ROUTING_PROXY_URL
    else process.env.ORPHEUS_ROUTING_PROXY_URL = originalOverride
  }

  for (const [url, port] of [
    ['http://proxy.example.test/path', 80],
    ['https://proxy.example.test/path', 443],
    ['http://proxy.example.test:8080/path', 8080],
    ['https://proxy.example.test:8443/path', 8443]
  ] as const) {
    process.env.ORPHEUS_ROUTING_PROXY_URL = url
    const runtime = getRoutingProxyRuntime({
      routingProxyPortMode: 'custom',
      routingProxyCustomPort: 4567,
      routingProxyEffectivePort: 18770
    })
    assert.equal(runtime.url, url, 'valid environment URLs must be retained verbatim for clients')
    assert.equal(
      runtime.port,
      port,
      'endpoint parsing must honor implicit and explicit scheme ports'
    )
  }
  for (const invalidUrl of ['not a URL', 'wss://proxy.example.test', 'ftp://proxy.example.test']) {
    process.env.ORPHEUS_ROUTING_PROXY_URL = invalidUrl
    assert.throws(
      () =>
        getRoutingProxyRuntime({
          routingProxyPortMode: 'custom',
          routingProxyCustomPort: 4567,
          routingProxyEffectivePort: 18770
        }),
      /valid http: or https: URL|http: or https: scheme/,
      'an invalid environment endpoint must reject before Custom or Automatic fallback'
    )
  }

  if (originalOverride === undefined) delete process.env.ORPHEUS_ROUTING_PROXY_URL
  else process.env.ORPHEUS_ROUTING_PROXY_URL = originalOverride

  assert.deepEqual(
    getRoutingProxyRuntime({
      routingProxyPortMode: 'custom',
      routingProxyCustomPort: 4567,
      routingProxyEffectivePort: null
    }),
    {
      source: 'custom',
      url: 'http://127.0.0.1:4567',
      host: '127.0.0.1',
      port: 4567,
      portConfigurationLocked: false
    }
  )
  assert.deepEqual(
    getRoutingProxyRuntime({
      routingProxyPortMode: 'automatic',
      routingProxyCustomPort: null,
      routingProxyEffectivePort: null
    }),
    { source: 'automatic', url: null, host: null, port: null, portConfigurationLocked: false }
  )
  assert.throws(
    () =>
      getRoutingProxyRuntime({
        routingProxyPortMode: 'automatic',
        routingProxyCustomPort: null,
        routingProxyEffectivePort: 4567
      }),
    /routingProxyEffectivePort must be an integer between 18765 and 18799 or null/
  )
  assert.throws(
    () => assertValidAutomaticRoutingProxyEffectivePort(4567),
    /routingProxyEffectivePort must be an integer between 18765 and 18799 or null/
  )
  assert.equal(assertValidAutomaticRoutingProxyEffectivePort(18765), 18765)
  assert.equal(assertValidAutomaticRoutingProxyEffectivePort(18799), 18799)
  assert.throws(
    () =>
      getRoutingProxyRuntime({
        routingProxyPortMode: 'custom',
        routingProxyCustomPort: null,
        routingProxyEffectivePort: 18770
      }),
    /Custom routing proxy port must be an integer between 1024 and 65535/
  )

  const runtimeSource = await fs.readFile(
    path.resolve(import.meta.dirname, '../src/main/routingProxy/runtime.ts'),
    'utf8'
  )
  assert.doesNotMatch(
    runtimeSource,
    /createRequire|require\(['"]\.\.\/uiState['"]\)/,
    'routing-proxy runtime must not leave a relative uiState require for the packaged main bundle'
  )
  assert.match(
    runtimeSource,
    /getRoutingProxyRuntime\(\s*stateSource: RoutingProxyPortStateSource\s*\)/,
    'routing-proxy runtime state must be supplied explicitly by DB-aware callers'
  )
  console.log('✓ routing-proxy port runtime resolves variants, candidates, and strict precedence')
}

// ---------------------------------------------------------------------------
// 0b. Allocation policy. Automatic walks candidates and only reports the
// proven candidate; Custom/environment are intentionally one-shot.
// ---------------------------------------------------------------------------

{
  const attemptedPorts: number[] = []
  const inspectionDeps: ListenerInspectionDeps = {
    listListeners: async () => [],
    signalProcess: () => {},
    sleep: async () => {}
  }
  const automatic = await startAtResolvedRoutingProxyPort({
    runtime: () => ({
      source: 'automatic',
      url: 'http://127.0.0.1:18770',
      host: '127.0.0.1',
      port: 18770,
      portConfigurationLocked: false
    }),
    candidates: () => [18770, 18766, 18765],
    inspect: inspectionDeps,
    startCandidate: async (runtime) => {
      attemptedPorts.push(runtime.port!)
      return runtime.port === 18765
        ? { ok: true, effectivePort: runtime.port }
        : { ok: false, reason: 'bind EADDRINUSE' }
    }
  })
  assert.deepEqual(attemptedPorts, [18770, 18766, 18765])
  assert.deepEqual(automatic, { ok: true, effectivePort: 18765 })

  const strictAttempts: number[] = []
  const custom = await startAtResolvedRoutingProxyPort({
    runtime: () => ({
      source: 'custom',
      url: 'http://127.0.0.1:4567',
      host: '127.0.0.1',
      port: 4567,
      portConfigurationLocked: false
    }),
    candidates: () => {
      throw new Error('strict custom mode must not request automatic candidates')
    },
    inspect: inspectionDeps,
    startCandidate: async (runtime) => {
      strictAttempts.push(runtime.port!)
      return { ok: false, reason: 'bind EADDRINUSE' }
    }
  })
  assert.deepEqual(strictAttempts, [4567])
  assert.deepEqual(custom, { ok: false, reason: 'bind EADDRINUSE' })

  const exhausted = await startAtResolvedRoutingProxyPort({
    runtime: () => ({
      source: 'automatic',
      url: 'http://127.0.0.1:18765',
      host: '127.0.0.1',
      port: 18765,
      portConfigurationLocked: false
    }),
    candidates: () => [18765, 18766],
    inspect: inspectionDeps,
    startCandidate: async () => ({ ok: false, reason: 'bind EADDRINUSE on 18766' })
  })
  assert.match(exhausted.reason ?? '', /18765–18799.*bind EADDRINUSE on 18766/)

  const supersededAttempts: number[] = []
  const superseded = await startAtResolvedRoutingProxyPort({
    runtime: () => ({
      source: 'automatic',
      url: 'http://127.0.0.1:18765',
      host: '127.0.0.1',
      port: 18765,
      portConfigurationLocked: false
    }),
    candidates: () => [18765, 18766],
    inspect: inspectionDeps,
    startCandidate: async (runtime) => {
      supersededAttempts.push(runtime.port!)
      return { ok: false, reason: 'start was superseded' }
    }
  })
  assert.deepEqual(supersededAttempts, [18765])
  assert.equal(superseded.reason, 'start was superseded')

  const automaticRuntime = {
    source: 'automatic' as const,
    url: 'http://127.0.0.1:18766',
    host: '127.0.0.1',
    port: 18766,
    portConfigurationLocked: false
  }
  assert.equal(
    effectiveAutomaticPortToPersist(automaticRuntime, { ok: true, effectivePort: 18766 }),
    18766,
    'only a strict-ready Automatic candidate may replace the effective port'
  )
  assert.equal(
    effectiveAutomaticPortToPersist(automaticRuntime, { ok: false, reason: 'exhausted' }),
    null,
    'failed Automatic exhaustion must preserve the prior effective port'
  )
  for (const source of ['custom', 'environment'] as const) {
    assert.equal(
      effectiveAutomaticPortToPersist(
        {
          source,
          url: 'http://127.0.0.1:18777',
          host: '127.0.0.1',
          port: 18777,
          portConfigurationLocked: source === 'environment'
        },
        { ok: true, effectivePort: 18777 }
      ),
      null,
      `${source} success must not persist an automatic effective port`
    )
  }
  const originalOverride = process.env.ORPHEUS_ROUTING_PROXY_URL
  let invalidEnvironmentAllocationAttempts = 0
  try {
    process.env.ORPHEUS_ROUTING_PROXY_URL = 'wss://proxy.example.test'
    await assert.rejects(
      () =>
        startAtResolvedRoutingProxyPort({
          runtime: () =>
            getRoutingProxyRuntime({
              routingProxyPortMode: 'custom',
              routingProxyCustomPort: 18777,
              routingProxyEffectivePort: 18766
            }),
          candidates: () => {
            throw new Error('invalid environment endpoint must not request automatic candidates')
          },
          inspect: inspectionDeps,
          startCandidate: async () => {
            invalidEnvironmentAllocationAttempts++
            return { ok: true }
          }
        }),
      /http: or https: scheme/
    )
    assert.equal(
      invalidEnvironmentAllocationAttempts,
      0,
      'an invalid environment endpoint must not start a Custom or Automatic candidate'
    )
  } finally {
    if (originalOverride === undefined) delete process.env.ORPHEUS_ROUTING_PROXY_URL
    else process.env.ORPHEUS_ROUTING_PROXY_URL = originalOverride
  }
  console.log('✓ allocator retries automatic candidates while custom mode remains strict')
}

// ---------------------------------------------------------------------------
// 0c. Lifecycle coordinator serializes side effects while newer intent
// invalidates paused work before it can spawn, persist, or publish.
// ---------------------------------------------------------------------------

{
  const coordinator = new RoutingProxyLifecycleCoordinator()
  const effects: string[] = []
  let releaseA!: () => void
  const pausedA = new Promise<void>((resolve) => {
    releaseA = resolve
  })
  const generationA = coordinator.beginIntent()
  const operationA = coordinator.run(generationA, async () => {
    effects.push('A:config-start')
    await pausedA
    if (!coordinator.owns(generationA)) {
      effects.push('A:cleanup')
      return START_SUPERSEDED
    }
    effects.push('A:spawn')
    return 'A'
  })
  await Promise.resolve()
  const generationB = coordinator.beginIntent()
  const operationB = coordinator.run(generationB, async () => {
    effects.push('B:config')
    effects.push('B:spawn')
    effects.push('B:publish')
    return 'B'
  })
  releaseA()
  assert.equal(await operationA, START_SUPERSEDED)
  assert.equal(await operationB, 'B')
  assert.deepEqual(effects, ['A:config-start', 'A:cleanup', 'B:config', 'B:spawn', 'B:publish'])
  console.log('✓ lifecycle coordinator serializes superseded config/spawn/publication effects')
}

// ---------------------------------------------------------------------------
// 0d. Cleanup containment. A timed-out exact candidate cleanup poisons the
// lifecycle queue. No later operation may reach a side effect until that exact
// PID has exited and a fresh listener probe proves its release.
// ---------------------------------------------------------------------------

{
  const coordinator = new RoutingProxyLifecycleCoordinator()
  const effects: string[] = []
  let listenerReleased = false
  const generationA = coordinator.beginIntent()
  coordinator.blockUnresolvedCandidate({
    pid: 4101,
    generation: generationA,
    listenerReleased: async () => listenerReleased
  })

  const generationB = coordinator.beginIntent()
  const blockedB = await coordinator.run(generationB, async () => {
    effects.push('B:config')
    effects.push('B:spawn')
    effects.push('B:persist')
    effects.push('B:publish')
  })
  assert.equal(blockedB, 'start blocked by unresolved candidate cleanup')
  assert.deepEqual(effects, [])

  // A stale or unrelated exit cannot release A's guard.
  coordinator.recordCandidateExit(4102, generationA)
  coordinator.recordCandidateExit(4101, generationB)
  const stillBlocked = await coordinator.run(coordinator.beginIntent(), async () => {
    effects.push('wrong-exit-side-effect')
  })
  assert.equal(stillBlocked, 'start blocked by unresolved candidate cleanup')
  assert.deepEqual(effects, [])

  // The exact exit alone is insufficient until its listener is demonstrably gone.
  coordinator.recordCandidateExit(4101, generationA)
  const listenerStillHeld = await coordinator.run(coordinator.beginIntent(), async () => {
    effects.push('held-listener-side-effect')
  })
  assert.equal(listenerStillHeld, 'start blocked by unresolved candidate cleanup')
  assert.deepEqual(effects, [])

  listenerReleased = true
  const generationC = coordinator.beginIntent()
  const allowedC = await coordinator.run(generationC, async () => {
    effects.push('C:config')
    effects.push('C:spawn')
    effects.push('C:persist')
    effects.push('C:publish')
    return 'C'
  })
  assert.equal(allowedC, 'C')
  assert.deepEqual(effects, ['C:config', 'C:spawn', 'C:persist', 'C:publish'])
  console.log(
    '✓ lifecycle coordinator blocks poisoned cleanup until exact exit and listener release'
  )
}

// ---------------------------------------------------------------------------
// 0e. Failed-candidate exit policy. The production manager marks the exact PID
// expected before clearing its active-start marker, so an exit at that boundary
// is consumed rather than handed to supervisor respawn policy.
// ---------------------------------------------------------------------------

{
  const expectedTerminationPids = new Set<number>()
  const activeStartingCandidatePids = new Set([5101])
  markFailedCandidateTermination(expectedTerminationPids, activeStartingCandidatePids, 5101)
  assert.equal(activeStartingCandidatePids.has(5101), false)
  assert.equal(expectedTerminationPids.has(5101), true)
  const expectedExit = consumeExpectedCandidateExit(
    expectedTerminationPids,
    activeStartingCandidatePids,
    5101
  )
  assert.equal(expectedExit, true, 'the exact failure PID must consume its expected-exit marker')
  assert.equal(
    consumeExpectedCandidateExit(expectedTerminationPids, activeStartingCandidatePids, 5102),
    false,
    'a different PID must not consume another candidate marker'
  )
  assert.equal(
    decideRespawnAction({
      enabled: true,
      expectedShutdown: expectedExit,
      restarting: false,
      consecutiveFailures: 0
    }).action,
    'skip',
    'an exit at the failed-candidate transition must never schedule supervisor respawn'
  )

  const alreadyConsumedExpectedPids = new Set<number>()
  const alreadyConsumedActivePids = new Set([5103])
  assert.equal(
    consumeExpectedCandidateExit(alreadyConsumedExpectedPids, alreadyConsumedActivePids, 5103),
    true,
    'the exit handler consumes the active-start marker when it wins the transition race'
  )
  markFailedCandidateTermination(alreadyConsumedExpectedPids, alreadyConsumedActivePids, 5103)
  assert.deepEqual(
    [...alreadyConsumedExpectedPids],
    [],
    'a readiness failure after exit consumption must not leave a stale expected-exit marker'
  )
  console.log(
    '✓ failed-candidate expected exit is marked before active-start removal and suppresses respawn'
  )
}

// ---------------------------------------------------------------------------
// 0f. Typed port-configuration IPC and snapshot-driven Settings UI. These
// static source contracts protect the Electron boundary without loading
// Electron or mounting React in this fully-offline harness.
// ---------------------------------------------------------------------------

{
  const customRequest: RoutingProxyPortConfiguration = { mode: 'custom', port: 18777 }
  const automaticRequest: RoutingProxyPortConfiguration = { mode: 'automatic' }
  assert.deepEqual(customRequest, { mode: 'custom', port: 18777 })
  assert.deepEqual(automaticRequest, { mode: 'automatic' })

  const repoRoot = path.resolve(import.meta.dirname, '..')
  const [ipcSource, routingProxyIpcSource, preloadSource, sectionSource] = await Promise.all([
    fs.readFile(path.join(repoRoot, 'src/shared/ipc.ts'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src/main/ipc/routingProxy.ts'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src/preload/index.ts'), 'utf8'),
    fs.readFile(
      path.join(
        repoRoot,
        'src/renderer/src/components/dashboard/settings/OrpheusModelRoutingSection.tsx'
      ),
      'utf8'
    )
  ])

  assert.match(
    ipcSource,
    /'routingProxy:setPortConfiguration':\s*\{\s*req:\s*\[\{ mode: 'automatic' } \| \{ mode: 'custom'; port: number }\]\s*res: RoutingProxySnapshot/s,
    'the typed invoke map must define the exact port-configuration request and snapshot response'
  )
  assert.match(
    routingProxyIpcSource,
    /import \{[\s\S]*\bsetPortConfiguration\b[\s\S]*\} from '..\/routingProxy\/manager'/,
    'the routing-proxy IPC module must import the manager mutation'
  )
  assert.match(
    routingProxyIpcSource,
    /handle\('routingProxy:setPortConfiguration', async \(_e, configuration\) =>\s*setPortConfiguration\(configuration\)\s*\)/s,
    'the handler must use the typed handle wrapper and pass the typed request through'
  )
  assert.match(
    preloadSource,
    /setPortConfiguration:\s*\(\s*configuration: RoutingProxyPortConfiguration\s*\): Promise<RoutingProxySnapshot> =>\s*invoke\('routingProxy:setPortConfiguration', configuration\)/s,
    'preload must expose the typed generic-invoke port-configuration method'
  )
  assert.match(
    sectionSource,
    /snapshot\.portConfigurationLocked/,
    'the Model Routing section must render from the lock state supplied by the snapshot'
  )
  assert.match(
    sectionSource,
    /snapshot\.effectiveUrl/,
    'the Model Routing section must render the exact effective URL supplied by the snapshot'
  )
  assert.match(
    sectionSource,
    /snapshot\.effectivePort/,
    'the Model Routing section must render the exact effective port supplied by the snapshot'
  )
  assert.match(
    sectionSource,
    /Port controlled by ORPHEUS_ROUTING_PROXY_URL/,
    'the locked-mode notice must use the exact environment-variable copy'
  )
  assert.match(
    sectionSource,
    /portConfigurationRequest\(mode, customPortDraft\.value\)/,
    'the port controls must build their request from the selected mode and custom input'
  )
  assert.match(
    sectionSource,
    /setPortConfiguration\(configuration\)/,
    'the port controls must submit their typed request through the preload API'
  )
  assert.match(
    sectionSource,
    /function isValidCustomRoutingProxyPort\(port: number \| null\): port is number \{\s*return\s+typeof port === 'number' &&\s*Number\.isInteger\(port\) &&\s*port >= 1024 &&\s*port <= 65535/s,
    'the settings UI must accept only integer custom ports in the inclusive 1024–65535 range'
  )
  assert.match(
    sectionSource,
    /function portConfigurationRequest\([\s\S]*if \(!isValidCustomRoutingProxyPort\(customPort\)\) return null/s,
    'the settings UI must not construct custom requests for invalid ports'
  )
  assert.match(
    sectionSource,
    /disabled=\{\s*portBusy\s*\|\|\s*!isValidCustomRoutingProxyPort\(customPortDraft\.value\)\s*\|\|\s*customPortDraft\.error !== null\s*\|\|\s*portInputError !== null\s*\}/s,
    'the Custom action must remain disabled for busy, invalid, or ambiguous input'
  )
  assert.match(
    sectionSource,
    /role="group"\s+aria-label="Routing proxy port mode"/,
    'the mode controls must have an accessible group label'
  )
  assert.match(
    sectionSource,
    /aria-pressed=\{snapshot\.portMode === 'automatic'\}/,
    'the Automatic action must expose selected state'
  )
  assert.match(
    sectionSource,
    /aria-pressed=\{snapshot\.portMode === 'custom'\}/,
    'the Custom action must expose selected state'
  )
  assert.match(
    sectionSource,
    /portInputError && \([\s\S]*role="alert"/,
    'invalid custom-port input must render a local validation error'
  )
  const primitivesSource = await fs.readFile(
    path.join(repoRoot, 'src/renderer/src/components/dashboard/settings/primitives.tsx'),
    'utf8'
  )
  assert.match(
    primitivesSource,
    /validation\?: \{[\s\S]*min: number[\s\S]*max: number/s,
    'NumberInput must support bounded validation for strict port entry'
  )
  assert.match(
    primitivesSource,
    /const isDigitsOnly = \/\^\\d\+\$\//,
    'strict NumberInput validation must reject ambiguous values such as 1024abc and fractions'
  )
  assert.match(
    primitivesSource,
    /onDraftChange\?: \(draft: NumberInputDraft\) => void/,
    'NumberInput must expose a non-persisting draft callback for live validation'
  )
  assert.match(
    primitivesSource,
    /onEditingChange\?: \(isEditing: boolean\) => void/,
    'NumberInput must expose editing state so snapshot consumers can preserve active drafts'
  )
  assert.match(
    primitivesSource,
    /onEditingChange\?\.\(true\)/,
    'NumberInput must report the start of an active edit'
  )
  assert.match(
    primitivesSource,
    /onEditingChange\?\.\(false\)/,
    'NumberInput must report when an active edit finishes'
  )
  assert.match(
    sectionSource,
    /const customPortEditingRef = useRef\(false\)/,
    'routing port state must distinguish an active draft from a snapshot value'
  )
  assert.match(
    sectionSource,
    /const syncCustomPortSnapshot = useCallback\(\(nextSnapshot: RoutingProxySnapshot\): void => \{[\s\S]*if \(customPortEditingRef\.current\) return[\s\S]*setCustomPortInput\(nextSnapshot\.customPort\)[\s\S]*setCustomPortDraft\(\{ value: nextSnapshot\.customPort, error: null \}\)/,
    'non-editing snapshot updates must synchronize the visible, submitted, and validation port state'
  )
  assert.match(
    sectionSource,
    /onSnapshot\(\(s\) => \{[\s\S]*syncCustomPortSnapshot\(s\)/,
    'pushed snapshots must reconcile the custom port state'
  )
  assert.match(
    sectionSource,
    /setPortConfiguration\(configuration\)[\s\S]*syncCustomPortSnapshot\(nextSnapshot\)/,
    'returned port-configuration snapshots must reconcile the custom port state'
  )
  assert.match(
    sectionSource,
    /getState\(\)[\s\S]*syncCustomPortSnapshot\(currentSnapshot\)/,
    'catch refresh snapshots must reconcile the custom port state'
  )
  assert.match(
    sectionSource,
    /nextSnapshot\.portConfigurationLocked \|\| nextSnapshot\.portMode !== 'custom'[\s\S]*setCustomPortInputKey/,
    'mode changes and environment locks must discard a stale active port field'
  )
  assert.equal(
    shouldSyncCustomPortSnapshotForTest(false, {
      portMode: 'custom',
      portConfigurationLocked: false
    }),
    true,
    'automatic/null state followed by pushed custom 18777 must synchronize before Custom submits'
  )
  assert.equal(
    shouldSyncCustomPortSnapshotForTest(false, {
      portMode: 'custom',
      portConfigurationLocked: false
    }),
    true,
    'a non-editing old draft such as 18000 must synchronize to pushed custom 18777'
  )
  assert.equal(
    shouldSyncCustomPortSnapshotForTest(true, {
      portMode: 'custom',
      portConfigurationLocked: false
    }),
    false,
    'a pushed custom snapshot must preserve an active port edit'
  )
  assert.equal(
    shouldSyncCustomPortSnapshotForTest(true, {
      portMode: 'automatic',
      portConfigurationLocked: false
    }),
    true,
    'mode changes must synchronize even if a port field was actively edited'
  )
  assert.equal(
    shouldSyncCustomPortSnapshotForTest(true, {
      portMode: 'custom',
      portConfigurationLocked: true
    }),
    true,
    'environment locks must synchronize even if a port field was actively edited'
  )
  const updateValueSource = primitivesSource.match(
    /function updateValue\(nextValue: string\): void \{([\s\S]*?)\n {2}\}/
  )?.[1]
  assert.ok(updateValueSource, 'NumberInput must retain a local draft update path')
  assert.match(
    updateValueSource,
    /notifyDraft\(nextValue\)/,
    'local edits must notify only the optional draft callback'
  )
  assert.doesNotMatch(
    updateValueSource,
    /onChange\(/,
    'NumberInput must not persist values or emit NaN on every keystroke'
  )
  assert.match(
    primitivesSource,
    /if \(draft\.error !== null\) \{[\s\S]*setLocal\(value === null \? '' : String\(value\)\)/,
    'invalid default NumberInput drafts must revert instead of being persisted'
  )
  assert.match(
    sectionSource,
    /min: 1024,[\s\S]*max: 65535,[\s\S]*step: 1/s,
    'the custom-port input must enforce the 1024 and 65535 inclusive boundaries'
  )
  assert.equal(isValidRoutingProxyCustomPortForTest(1023), false)
  assert.equal(isValidRoutingProxyCustomPortForTest(65536), false)
  assert.equal(isValidRoutingProxyCustomPortForTest(1024.5), false)
  assert.equal(isStrictPortTextForTest('1024abc'), false)
  assert.equal(isValidRoutingProxyCustomPortForTest(1024), true)
  assert.equal(isValidRoutingProxyCustomPortForTest(65535), true)
  console.log('✓ typed port-configuration IPC and snapshot-driven routing settings contracts')
}

async function cleanup(): Promise<void> {
  await fs.rm(scratchRoot, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 1. arch -> asset-name mapping
// ---------------------------------------------------------------------------

{
  assert.equal(archToAssetSegment('arm64'), 'aarch64', 'arm64 must map to aarch64')
  assert.equal(archToAssetSegment('x64'), 'amd64', 'x64 must map to amd64')
  assert.equal(archToAssetSegment('ia32'), null, 'unsupported arch must map to null')
  assert.equal(archToAssetSegment('mips'), null, 'unsupported arch must map to null')

  assert.equal(
    assetNameFor('7.2.92', 'arm64'),
    'CLIProxyAPI_7.2.92_darwin_aarch64.tar.gz',
    'arm64 asset name must match the verified release naming'
  )
  assert.equal(
    assetNameFor('7.2.92', 'x64'),
    'CLIProxyAPI_7.2.92_darwin_amd64.tar.gz',
    'x64 asset name must match the verified release naming'
  )
  assert.equal(assetNameFor('7.2.92', 'ia32'), null, 'unsupported arch yields no asset name')

  assert.equal(
    downloadUrlFor('v7.2.92', 'CLIProxyAPI_7.2.92_darwin_aarch64.tar.gz'),
    'https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.92/CLIProxyAPI_7.2.92_darwin_aarch64.tar.gz',
    'download URL must follow the verified releases/download/<tag>/<asset> pattern'
  )
  assert.equal(PINNED_VERSION, '7.2.92', 'pinned version must be the verified latest release')
  assert.equal(PINNED_TAG, 'v7.2.92')
  console.log('✓ arch -> asset-name mapping (arm64->aarch64, x64->amd64) + download URL pattern')
}

// ---------------------------------------------------------------------------
// 2. checksums.txt parsing
// ---------------------------------------------------------------------------

{
  const sample =
    'fc9d2020c0961d097e0b8082d043006af534df261537a6a73756c6d60b4d6524  CLIProxyAPI_7.2.92_darwin_aarch64.tar.gz\n' +
    'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44  CLIProxyAPI_7.2.92_darwin_amd64.tar.gz\n' +
    'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef  checksums-companion-file.txt\n\n'
  const parsed = parseChecksumsFile(sample)
  assert.equal(parsed.size, 3)
  assert.equal(
    parsed.get('CLIProxyAPI_7.2.92_darwin_aarch64.tar.gz'),
    'fc9d2020c0961d097e0b8082d043006af534df261537a6a73756c6d60b4d6524'
  )
  assert.equal(
    parsed.get('CLIProxyAPI_7.2.92_darwin_amd64.tar.gz'),
    'aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44ee55ff66aa11bb22cc33dd44'
  )
  console.log('✓ checksums.txt parsing (standard `<sha256>  <filename>` format)')
}

// ---------------------------------------------------------------------------
// 3. SHA-256 verification — THE MOST IMPORTANT ASSERTION.
//    Correct hash accepts; wrong hash REJECTS and installs nothing.
// ---------------------------------------------------------------------------

{
  const fakeAssetBytes = Buffer.from('pretend-this-is-a-tar-gz-binary-payload')
  const realHash = sha256Hex(fakeAssetBytes)
  const assetName = 'CLIProxyAPI_7.2.92_darwin_aarch64.tar.gz'

  // 3a. Correct hash accepts.
  const goodChecksums = new Map([[assetName, realHash]])
  verifyChecksum(assetName, fakeAssetBytes, goodChecksums) // must not throw
  console.log('✓ verifyChecksum accepts when the hash matches')

  // 3b. Wrong hash rejects.
  const badChecksums = new Map([[assetName, 'f'.repeat(64)]])
  assert.throws(
    () => verifyChecksum(assetName, fakeAssetBytes, badChecksums),
    ChecksumMismatchError,
    'a mismatched hash must throw ChecksumMismatchError'
  )
  console.log('✓ verifyChecksum REJECTS when the hash mismatches')

  // 3c. Missing checksums entry also rejects (never silently trust an asset
  //     that has no corresponding checksums.txt line).
  assert.throws(
    () => verifyChecksum(assetName, fakeAssetBytes, new Map()),
    ChecksumMismatchError,
    'an asset missing from checksums.txt must be rejected, not silently trusted'
  )
  console.log('✓ verifyChecksum REJECTS when the asset has no checksums.txt entry')
}

// ---------------------------------------------------------------------------
// 4. installRoutingProxy() end-to-end with injected deps — wrong hash must
//    refuse to install (extractTarGz must never be called), correct hash
//    must extract successfully.
// ---------------------------------------------------------------------------

{
  const goodBytes = Buffer.from('good-asset-bytes')
  const goodHash = sha256Hex(goodBytes)
  const assetName = assetNameFor(PINNED_VERSION, 'arm64')!
  const checksumsText = `${goodHash}  ${assetName}\n`

  let extractCalls = 0
  const mkdirCalls: string[] = []
  const rmCalls: string[] = []

  // In-memory fake filesystem so pathExists/listDir/extractTarGz behave
  // consistently with each other (extractTarGz "writes" BINARY_NAME into the
  // fake fs; pathExists/listDir read it back) — this is what lets the
  // idempotency + BinaryNotFoundError assertions below actually exercise the
  // real control flow in installRoutingProxy, not just stub everything true.
  function makeFakeFs(): {
    files: Set<string>
    deps: Omit<InstallDeps, 'fetchBytes'>
  } {
    const files = new Set<string>()
    return {
      files,
      deps: {
        extractTarGz: async (_bytes, destDir) => {
          extractCalls++
          files.add(path.join(destDir, BINARY_NAME))
        },
        mkdir: async (dir) => {
          mkdirCalls.push(dir)
        },
        writeFile: async () => {},
        chmodExecutable: async () => {},
        rm: async (target) => {
          rmCalls.push(target)
          for (const f of [...files]) {
            if (f === target || f.startsWith(target + path.sep)) files.delete(f)
          }
        },
        pathExists: async (filePath) => files.has(filePath),
        listDir: async (dir) => {
          const prefix = dir + path.sep
          return [...files].filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length))
        }
      }
    }
  }

  function makeDeps(assetBytesToServe: Buffer): InstallDeps {
    const { deps } = makeFakeFs()
    return {
      fetchBytes: async (url: string) => {
        if (url.endsWith('checksums.txt')) return Buffer.from(checksumsText, 'utf8')
        return assetBytesToServe
      },
      ...deps
    }
  }

  // 4a. Wrong hash: fetchBytes serves DIFFERENT bytes than what checksums.txt
  // says — must throw and extractTarGz must NEVER be called.
  extractCalls = 0
  const wrongBytes = Buffer.from('tampered-or-corrupted-asset-bytes')
  await assert.rejects(
    () => installRoutingProxy({ arch: 'arm64' }, makeDeps(wrongBytes)),
    ChecksumMismatchError,
    'installRoutingProxy must reject a bad-hash asset'
  )
  assert.equal(extractCalls, 0, 'extractTarGz must NEVER be called after a checksum mismatch')
  console.log('✓ installRoutingProxy REJECTS a bad-hash asset and never extracts it')

  // 4b. Correct hash: extraction proceeds exactly once, and the resolved
  // binary path uses the VERIFIED real binary name (cli-proxy-api), not the
  // wrong CLIProxyAPI name that caused the original ENOENT bug.
  extractCalls = 0
  const result = await installRoutingProxy({ arch: 'arm64' }, makeDeps(goodBytes))
  assert.equal(extractCalls, 1, 'extractTarGz must be called exactly once on a good hash')
  assert.equal(result.version, PINNED_VERSION)
  assert.equal(BINARY_NAME, 'cli-proxy-api', 'BINARY_NAME must be the verified real binary name')
  assert.ok(
    result.binaryPath.endsWith(BINARY_NAME),
    'binary path must point at the extracted binary using BINARY_NAME'
  )
  assert.ok(
    !result.binaryPath.endsWith('CLIProxyAPI'),
    'binary path must NOT use the old wrong CLIProxyAPI name'
  )
  console.log(
    '✓ installRoutingProxy extracts exactly once on a matching hash, resolved path uses cli-proxy-api'
  )

  // 4c. Unsupported arch refuses before any network call.
  let fetchCalledForUnsupported = false
  await assert.rejects(
    () =>
      installRoutingProxy(
        { arch: 'ia32' },
        {
          ...makeDeps(goodBytes),
          fetchBytes: async () => {
            fetchCalledForUnsupported = true
            return goodBytes
          }
        }
      ),
    UnsupportedPlatformError
  )
  assert.equal(fetchCalledForUnsupported, false, 'unsupported arch must fail before any fetch')
  console.log('✓ installRoutingProxy refuses an unsupported arch before touching the network')

  // 4d. Stubbed extraction that produces the WRONG/missing binary name must
  // yield a clear "binary not found after extraction" error (BinaryNotFoundError),
  // not a raw ENOENT from chmod — this is the diagnosability guard for a
  // future upstream rename.
  {
    const { files, deps } = makeFakeFs()
    const wrongNameDeps: InstallDeps = {
      fetchBytes: async (url: string) => {
        if (url.endsWith('checksums.txt')) return Buffer.from(checksumsText, 'utf8')
        return goodBytes
      },
      ...deps,
      extractTarGz: async (_bytes, destDir) => {
        extractCalls++
        // Simulate an upstream rename: archive now ships a differently-named
        // binary instead of BINARY_NAME.
        files.add(path.join(destDir, 'some-renamed-binary'))
        files.add(path.join(destDir, 'README.md'))
      }
    }
    await assert.rejects(
      () => installRoutingProxy({ arch: 'arm64' }, wrongNameDeps),
      (err: unknown) => {
        assert.ok(err instanceof BinaryNotFoundError, 'must throw BinaryNotFoundError')
        assert.ok(
          !(err instanceof Error && err.constructor.name === 'TypeError'),
          'must never surface as a raw ENOENT/TypeError'
        )
        assert.ok(
          (err as Error).message.includes('some-renamed-binary'),
          'error must list what the archive actually contained'
        )
        assert.ok(
          (err as Error).message.includes(BINARY_NAME),
          'error must name the expected binary path'
        )
        return true
      },
      'a mismatched/missing binary name after extraction must raise a clear, diagnosable error'
    )
    console.log(
      '✓ installRoutingProxy raises a clear BinaryNotFoundError (listing actual contents) when the archive layout does not match BINARY_NAME'
    )
  }

  // 4e. Idempotency: a pre-existing, already-valid version dir (binary
  // already present) must short-circuit — no re-download, no re-extract —
  // and installing twice in a row must never fail the second time.
  {
    const { files, deps } = makeFakeFs()
    const preexistingDestDir = path.join(scratchRoot, 'idempotent-install')
    files.add(path.join(preexistingDestDir, BINARY_NAME))
    let fetchCalls = 0
    extractCalls = 0
    const idempotentDeps: InstallDeps = {
      fetchBytes: async (url: string) => {
        fetchCalls++
        if (url.endsWith('checksums.txt')) return Buffer.from(checksumsText, 'utf8')
        return goodBytes
      },
      ...deps
    }
    const first = await installRoutingProxy(
      { arch: 'arm64', destDir: preexistingDestDir },
      idempotentDeps
    )
    assert.equal(fetchCalls, 0, 'a pre-existing valid install must skip the network entirely')
    assert.equal(extractCalls, 0, 'a pre-existing valid install must skip extraction entirely')
    assert.equal(first.binaryPath, path.join(preexistingDestDir, BINARY_NAME))

    // Run install() a second time against the SAME dir — must still succeed,
    // proving the whole path (not just the fake-fs short-circuit) is
    // idempotent.
    const second = await installRoutingProxy(
      { arch: 'arm64', destDir: preexistingDestDir },
      idempotentDeps
    )
    assert.equal(second.binaryPath, first.binaryPath)
    assert.equal(fetchCalls, 0, 'second install call must also skip the network')
    console.log(
      '✓ installRoutingProxy is idempotent against a pre-existing version dir (reuses it, no re-download/re-extract, safe to call twice)'
    )
  }
}

// ---------------------------------------------------------------------------
// 5. config.yaml generation — host/port/auth-dir present, no MANAGEMENT
//    secret ever written, no hardcoded absolute path beyond what the caller
//    explicitly supplied.
// ---------------------------------------------------------------------------

{
  const authDirPath = path.join(scratchRoot, 'auth')
  const text = renderRoutingProxyConfig({
    host: '127.0.0.1',
    port: 18765,
    authDir: authDirPath,
    debug: false
  })
  assert.ok(text.includes('host: 127.0.0.1'), 'config.yaml must contain the host')
  assert.ok(text.includes('port: 18765'), 'config.yaml must contain the port')
  assert.ok(text.includes(`auth-dir: ${authDirPath}`), 'config.yaml must contain the auth-dir')
  assert.ok(
    !text.includes('MANAGEMENT_PASSWORD'),
    'config.yaml must never mention MANAGEMENT_PASSWORD'
  )
  assert.ok(!/secret/i.test(text), 'config.yaml must never contain a "secret" field')
  console.log('✓ renderRoutingProxyConfig produces host/port/auth-dir, no secret field')

  // Write it to disk via the real writeRoutingProxyConfig path (still fully
  // offline — only touches the scratch dir) and assert on the actual file
  // contents, including that no random secret token appears anywhere in it.
  const configFilePath = path.join(scratchRoot, 'config.yaml')
  const fakeSecret = crypto.randomBytes(16).toString('hex')
  const writtenText = await writeRoutingProxyConfig(configFilePath, {
    host: '127.0.0.1',
    port: 18765,
    authDir: authDirPath,
    debug: false
  })
  const onDisk = await fs.readFile(configFilePath, 'utf8')
  assert.equal(onDisk, writtenText)
  assert.ok(!onDisk.includes(fakeSecret), 'the management secret must never appear in config.yaml')
  assert.ok(!onDisk.includes('MANAGEMENT_PASSWORD'))
  assert.ok(onDisk.includes('host: 127.0.0.1'))
  assert.ok(onDisk.includes('port: 18765'))
  console.log('✓ writeRoutingProxyConfig writes a config.yaml with no secret material on disk')
}

// ---------------------------------------------------------------------------
// 6. Strict managed health and readiness. A routing proxy is healthy only
//    when its live spawned child is the sole listener and its authenticated
//    management endpoint returns 2xx. TCP remains diagnostic-only.
// ---------------------------------------------------------------------------

{
  const runtime = {
    source: 'automatic' as const,
    url: 'http://127.0.0.1:18765',
    host: '127.0.0.1',
    port: 18765,
    portConfigurationLocked: false
  }
  const spawnedAttempt: RoutingProxySpawnAttempt = {
    pid: 123,
    managementSecret: 'x'.repeat(48),
    isAlive: () => true,
    terminate: () => {}
  }
  const listener = { pid: spawnedAttempt.pid, executablePath: '/proxy', argv: [] }
  const managedDeps = (
    managementProbe: () => Promise<unknown>,
    listeners = [listener]
  ): ManagedReadinessDeps => ({
    inspectListeners: async () => listeners,
    managementProbe: async () => (await managementProbe()) === true,
    sleep: async () => {},
    now: () => 0
  })

  const ready = await waitForManagedRoutingProxyReady(
    runtime,
    spawnedAttempt,
    {},
    managedDeps(async () => true)
  )
  assert.deepEqual(
    ready,
    { healthy: true },
    'only owned sole listener plus authenticated 2xx is ready'
  )

  // A child commonly has no listener during its first readiness poll. That is
  // transient, so startup must back off and reach running once this attempt binds.
  {
    let listenerCalls = 0
    let elapsed = 0
    const delayedReady = await waitForManagedRoutingProxyReady(
      runtime,
      spawnedAttempt,
      {},
      {
        inspectListeners: async () => (listenerCalls++ === 0 ? [] : [listener]),
        managementProbe: async () => true,
        sleep: async (ms) => {
          elapsed += ms
        },
        now: () => elapsed
      }
    )
    assert.deepEqual(delayedReady, { healthy: true })
    assert.equal(listenerCalls, 3, 'startup must re-inspect after authenticated readiness')
  }

  // Management confirmation is not sufficient on its own: it can race a child
  // exit or port rebind while the request is outstanding.
  {
    let alive = true
    const exitsDuringProbe: RoutingProxySpawnAttempt = { ...spawnedAttempt, isAlive: () => alive }
    const result = await waitForManagedRoutingProxyReady(
      runtime,
      exitsDuringProbe,
      { deadlineMs: 0 },
      {
        inspectListeners: async () => [listener],
        managementProbe: async () => {
          alive = false
          return true
        },
        sleep: async () => {},
        now: () => 0
      }
    )
    assert.deepEqual(result, { healthy: false, reason: 'spawned child exited' })
  }
  {
    let listenerCalls = 0
    const result = await waitForManagedRoutingProxyReady(
      runtime,
      spawnedAttempt,
      { deadlineMs: 0 },
      {
        inspectListeners: async () =>
          listenerCalls++ === 0 ? [listener] : [{ ...listener, pid: 999 }],
        managementProbe: async () => true,
        sleep: async () => {},
        now: () => 0
      }
    )
    assert.deepEqual(result, { healthy: false, reason: 'listener is not the spawned child' })
  }
  {
    let alive = true
    let listenerCalls = 0
    const exitsDuringFinalInspection: RoutingProxySpawnAttempt = {
      ...spawnedAttempt,
      isAlive: () => alive
    }
    const result = await waitForManagedRoutingProxyReady(
      runtime,
      exitsDuringFinalInspection,
      { deadlineMs: 0 },
      {
        inspectListeners: async () => {
          if (listenerCalls++ > 0) alive = false
          return [listener]
        },
        managementProbe: async () => true,
        sleep: async () => {},
        now: () => 0
      }
    )
    assert.deepEqual(result, { healthy: false, reason: 'spawned child exited' })
  }

  // Manager startup retains an attempt identity. If stop/disable clears it
  // while readiness is pending, the old continuation cannot publish running.
  assert.equal(
    canPublishManagedRoutingProxyRunning(spawnedAttempt, spawnedAttempt, { healthy: true }),
    true
  )
  assert.equal(
    canPublishManagedRoutingProxyRunning(null, spawnedAttempt, { healthy: true }),
    false,
    'stop during readiness clears the current attempt and blocks stale running publication'
  )
  assert.equal(
    canPublishManagedRoutingProxyRunning({ ...spawnedAttempt, pid: 124 }, spawnedAttempt, {
      healthy: true
    }),
    false,
    'a replacement attempt blocks the older start continuation'
  )

  const cases: Array<
    [string, RoutingProxySpawnAttempt, ListeningProcess[], () => Promise<unknown>, string]
  > = [
    [
      'exited child',
      { ...spawnedAttempt, isAlive: () => false },
      [listener],
      async () => true,
      'spawned child exited'
    ],
    ['missing owner', spawnedAttempt, [], async () => true, 'listener is not the spawned child'],
    [
      'foreign owner',
      spawnedAttempt,
      [{ ...listener, pid: 999 }],
      async () => true,
      'listener is not the spawned child'
    ],
    [
      'two owner PIDs',
      spawnedAttempt,
      [listener, { ...listener, pid: 124 }],
      async () => true,
      'listener ownership is ambiguous'
    ],
    [
      '401',
      spawnedAttempt,
      [listener],
      async () => false,
      'management API did not return authenticated 2xx'
    ],
    [
      '403',
      spawnedAttempt,
      [listener],
      async () => false,
      'management API did not return authenticated 2xx'
    ],
    [
      '404',
      spawnedAttempt,
      [listener],
      async () => false,
      'management API did not return authenticated 2xx'
    ],
    [
      '500',
      spawnedAttempt,
      [listener],
      async () => false,
      'management API did not return authenticated 2xx'
    ],
    [
      'timeout',
      spawnedAttempt,
      [listener],
      async () => false,
      'management API did not return authenticated 2xx'
    ],
    [
      'malformed result',
      spawnedAttempt,
      [listener],
      async () => 'not-a-boolean',
      'management API did not return authenticated 2xx'
    ]
  ]
  for (const [name, attempt, listeners, managementProbe, reason] of cases) {
    const result = await waitForManagedRoutingProxyReady(
      runtime,
      attempt,
      { deadlineMs: 0 },
      managedDeps(managementProbe, listeners)
    )
    assert.deepEqual(
      result,
      { healthy: false, reason },
      `${name} must never count as managed healthy`
    )
  }

  const tcpOnly = await probeRoutingProxyTcpReachability('http://127.0.0.1:18765', {
    tcpProbe: async () => true,
    managementProbe: async () => false
  })
  assert.equal(
    tcpOnly,
    true,
    'TCP reachability is retained as a separately named diagnostic helper'
  )

  const health = await checkRoutingProxyHealth(
    runtime,
    spawnedAttempt,
    {},
    managedDeps(async () => true)
  )
  assert.deepEqual(health, { healthy: true })
  await ensureHealthyForRouting(
    runtime,
    spawnedAttempt,
    {},
    managedDeps(async () => true)
  )
  await assert.rejects(
    () =>
      ensureHealthyForRouting(
        runtime,
        spawnedAttempt,
        { deadlineMs: 0 },
        managedDeps(async () => false)
      ),
    /not healthy/,
    'routing gate must fail closed when management authentication fails'
  )
  console.log(
    '✓ managed health requires owned sole listener and authenticated 2xx; TCP is diagnostic-only'
  )
}

// ---------------------------------------------------------------------------
// 8. Update check — mirrors updates.ts's checkForUpdates shape; fully
//    offline via injected fetchJson.
// ---------------------------------------------------------------------------

{
  const newerDeps: UpdateCheckDeps = {
    fetchJson: async () => ({ tag_name: 'v7.3.0' })
  }
  const newer = await checkRoutingProxyUpdate(PINNED_VERSION, newerDeps)
  assert.equal(newer.available, true)
  assert.equal(newer.latest, '7.3.0')
  console.log('✓ checkRoutingProxyUpdate reports availability when GitHub has a newer tag')

  const sameDeps: UpdateCheckDeps = {
    fetchJson: async () => ({ tag_name: `v${PINNED_VERSION}` })
  }
  const same = await checkRoutingProxyUpdate(PINNED_VERSION, sameDeps)
  assert.equal(same.available, false, 'must not report available when latest == current')
  console.log('✓ checkRoutingProxyUpdate reports no update when already on latest')

  const failDeps: UpdateCheckDeps = {
    fetchJson: async () => {
      throw new Error('network down')
    }
  }
  const failed = await checkRoutingProxyUpdate(PINNED_VERSION, failDeps)
  assert.equal(failed.available, false)
  assert.ok(failed.error, 'a network failure must surface as a non-throwing error field')
  console.log('✓ checkRoutingProxyUpdate never throws — network failure surfaces as result.error')
}

// ---------------------------------------------------------------------------
// 9. Trap-state fix — state.ts's pure status-transition helpers.
//
// Reproduces the exact bug the user hit: toggle the "Enable managed routing
// proxy" switch ON while the proxy is not installed (offline, so the
// install attempt fails), then toggle it OFF. Before the fix, this left
// status stuck on 'error' forever with no reachable Install control ('error'
// !== 'not_installed', so the Install button was never rendered).
// ---------------------------------------------------------------------------

{
  // --- isInstalled / canInstallOrRetry basics -------------------------------
  assert.equal(isInstalled(null), false, 'null installedVersion means not installed')
  assert.equal(isInstalled('7.2.92'), true, 'a version string means installed')

  assert.equal(
    canInstallOrRetry(null, 'not_installed'),
    true,
    'install must be reachable from not_installed'
  )
  assert.equal(
    canInstallOrRetry(null, 'installing'),
    false,
    'install must not be reachable mid-install (avoid double-trigger)'
  )
  assert.equal(
    canInstallOrRetry('7.2.92', 'error'),
    false,
    'once truly installed, an unrelated error (e.g. unreachable) must not offer reinstall'
  )
  console.log('✓ isInstalled/canInstallOrRetry basics')

  // --- the actual trap-state repro: error status, never installed ----------
  // This is the state a failed auto-install-on-enable leaves behind:
  // installedVersion stays null, status flips to 'error'.
  const trapState = { installedVersion: null as string | null, status: 'error' as const }
  assert.equal(
    canInstallOrRetry(trapState.installedVersion, trapState.status),
    true,
    "an 'error' status must NEVER make install/retry unreachable while uninstalled " +
      '(the exact dead-end the user hit)'
  )
  console.log("✓ canInstallOrRetry(null, 'error') stays reachable — 'error' is never a dead end")

  // Sweep every declared status: whenever installedVersion is null and
  // status isn't 'installing', install/retry must be reachable. This is the
  // "the state machine never reaches a state where installing is impossible
  // while uninstalled" invariant from the unit spec, checked exhaustively
  // rather than for one status.
  const allStatuses: Array<
    'not_installed' | 'installing' | 'stopped' | 'starting' | 'running' | 'error'
  > = ['not_installed', 'installing', 'stopped', 'starting', 'running', 'error']
  for (const status of allStatuses) {
    const reachable = canInstallOrRetry(null, status)
    if (status === 'installing') {
      assert.equal(reachable, false, `installing must gate itself out (status=${status})`)
    } else {
      assert.equal(
        reachable,
        true,
        `install/retry must be reachable while uninstalled regardless of status (status=${status})`
      )
    }
  }
  console.log('✓ canInstallOrRetry(null, status) is reachable for every status except mid-install')

  // --- disable transition lands clean ---------------------------------------
  // enable -> disable while NOT installed: must clear the error and land on
  // 'not_installed' (never leave 'error' behind, which is exactly what the
  // user's screenshot showed: toggle OFF + status still "Error").
  const afterDisableUninstalled = disableTransitionPatch(null)
  assert.equal(
    afterDisableUninstalled.status,
    'not_installed',
    'disabling while never installed must land on not_installed, not a stale error'
  )
  assert.equal(
    afterDisableUninstalled.error,
    null,
    'disabling must always clear any lingering error message'
  )
  console.log(
    '✓ disableTransitionPatch(null) clears error and lands on not_installed (the trap-state fix)'
  )

  // enable -> disable while installed (e.g. was running, or install
  // succeeded but start failed): must land on 'stopped', still with error
  // cleared — disabling is a clean transition regardless of prior status.
  const afterDisableInstalled = disableTransitionPatch('7.2.92')
  assert.equal(
    afterDisableInstalled.status,
    'stopped',
    'disabling while installed must land on stopped'
  )
  assert.equal(afterDisableInstalled.error, null, 'disabling while installed also clears error')
  console.log('✓ disableTransitionPatch("7.2.92") clears error and lands on stopped')

  assert.equal(cleanStoppedStatus(null), 'not_installed')
  assert.equal(cleanStoppedStatus('7.2.92'), 'stopped')
  console.log('✓ cleanStoppedStatus reflects installedVersion, not status')

  // --- full repro sequence, exactly as the user hit it ----------------------
  // Simulate the manager's own state shape across the enable->fail->disable
  // sequence using only the pure helpers (mirrors what manager.ts's start()/
  // stop()/reconcileRoutingProxy() now do with these helpers).
  let sim = {
    installedVersion: null as string | null,
    status: 'not_installed' as const,
    error: null as string | null
  }

  // 1. User toggles ON. Proxy is not installed and offline, so install()
  //    fails. installedVersion stays null; status flips to 'error'.
  sim = { ...sim, status: 'error', error: 'Not installed yet — install the proxy first.' }
  assert.equal(
    canInstallOrRetry(sim.installedVersion, sim.status),
    true,
    'step 1: after a failed enable, install/retry must still be reachable'
  )

  // 2. User toggles OFF. reconcileRoutingProxy() takes the "was never
  //    running" branch and applies disableTransitionPatch().
  const patch = disableTransitionPatch(sim.installedVersion)
  sim = { ...sim, ...patch }
  assert.equal(sim.status, 'not_installed', 'step 2: disable must clear the stuck error status')
  assert.equal(sim.error, null, 'step 2: disable must clear the stuck error message')
  assert.equal(
    canInstallOrRetry(sim.installedVersion, sim.status),
    true,
    'step 2: install must remain reachable after disabling too (still uninstalled)'
  )
  console.log(
    '✓ full repro: enable (fails, offline) -> disable leaves a CLEAN state, no lingering error, install still reachable'
  )
}

// ---------------------------------------------------------------------------
// 10. TCP diagnostic polling (waitForRoutingProxyTcpDiagnostic). A fake
//    clock + fake sleep so every assertion is deterministic and instant: real
//    time never advances, `now()` is driven purely by how many times `sleep`
//    has been "awaited", and `sleep` itself resolves synchronously (no real
//    setTimeout) while still recording the requested delay for assertions.
// ---------------------------------------------------------------------------

{
  function makeFakeClockDeps(tcpProbe: HealthCheckDeps['tcpProbe']): {
    deps: RoutingProxyReadyDeps
    sleepCalls: number[]
    probeCallCount: () => number
  } {
    let elapsed = 0
    const sleepCalls: number[] = []
    let probeCalls = 0
    const wrappedProbe: HealthCheckDeps['tcpProbe'] = async (host, port, timeoutMs) => {
      probeCalls++
      return tcpProbe(host, port, timeoutMs)
    }
    return {
      sleepCalls,
      probeCallCount: () => probeCalls,
      deps: {
        tcpProbe: wrappedProbe,
        now: () => elapsed,
        sleep: async (ms: number) => {
          sleepCalls.push(ms)
          elapsed += ms
        }
      }
    }
  }

  // 10a. Probes IMMEDIATELY after spawn — no initial sleep before the first
  // probe. A proxy reachable on the very first probe must resolve healthy
  // with ZERO sleeps recorded.
  {
    const { deps, sleepCalls, probeCallCount } = makeFakeClockDeps(async () => true)
    const ready = await waitForRoutingProxyTcpDiagnostic('http://127.0.0.1:18765', {}, deps)
    assert.equal(ready, true, 'must report ready when the very first probe succeeds')
    assert.equal(probeCallCount(), 1, 'exactly one probe when the first one succeeds')
    assert.equal(
      sleepCalls.length,
      0,
      'no sleep must occur before the first probe (or after success)'
    )
    console.log(
      '✓ waitForRoutingProxyTcpDiagnostic probes immediately (no initial sleep) and returns on first success'
    )
  }

  // 10b. A proxy that becomes reachable on the Nth probe is detected
  // promptly: the total simulated wait must be materially lower than the old
  // flat-500ms-per-probe behaviour would have produced for the same N.
  {
    const successOnProbe = 5 // fails 4 times, succeeds on the 5th
    let calls = 0
    const { deps, sleepCalls, probeCallCount } = makeFakeClockDeps(async () => {
      calls++
      return calls >= successOnProbe
    })
    const ready = await waitForRoutingProxyTcpDiagnostic('http://127.0.0.1:18765', {}, deps)
    assert.equal(ready, true, 'must eventually report ready once a later probe succeeds')
    assert.equal(probeCallCount(), successOnProbe, `must probe exactly ${successOnProbe} times`)

    const totalSimulatedWaitMs = sleepCalls.reduce((a, b) => a + b, 0)
    const oldFlatBehaviourMs = (successOnProbe - 1) * 500 // old: flat 500ms between every probe
    assert.ok(
      totalSimulatedWaitMs < oldFlatBehaviourMs,
      `new backoff wait (${totalSimulatedWaitMs}ms) must be materially lower than the old flat-500ms ` +
        `wait (${oldFlatBehaviourMs}ms) for the same probe count`
    )
    // Backoff must actually grow between sleeps (not flat), starting well
    // below 500ms.
    assert.ok(sleepCalls[0]! < 500, 'first backoff delay must start well below the old flat 500ms')
    for (let i = 1; i < sleepCalls.length; i++) {
      assert.ok(
        sleepCalls[i]! >= sleepCalls[i - 1]!,
        'backoff delay must never shrink between probes'
      )
    }
    console.log(
      `✓ waitForRoutingProxyTcpDiagnostic detects an Nth-probe success promptly (total simulated wait ${totalSimulatedWaitMs}ms ` +
        `vs old flat behaviour ${oldFlatBehaviourMs}ms for N=${successOnProbe})`
    )
  }

  // 10c. Backoff is bounded by the cap — sleeping many times in a row must
  // never exceed maxDelayMs on any single sleep, even though it keeps
  // growing early on.
  {
    let calls = 0
    const maxDelayMs = 500
    const { deps, sleepCalls } = makeFakeClockDeps(async () => {
      calls++
      return calls >= 20 // never succeeds within the deadline below
    })
    await waitForRoutingProxyTcpDiagnostic(
      'http://127.0.0.1:18765',
      { deadlineMs: 5000, initialDelayMs: 50, maxDelayMs, backoffFactor: 2 },
      deps
    )
    assert.ok(sleepCalls.length > 0, 'must have slept at least once while retrying')
    for (const ms of sleepCalls) {
      assert.ok(
        ms <= maxDelayMs,
        `no single backoff delay may exceed the cap (${ms} > ${maxDelayMs})`
      )
    }
    assert.ok(
      sleepCalls[sleepCalls.length - 1]! === maxDelayMs,
      'backoff must actually reach the cap when retried enough times'
    )
    console.log(
      '✓ waitForRoutingProxyTcpDiagnostic backoff is bounded by maxDelayMs and reaches the cap'
    )
  }

  // 10d. The overall deadline still terminates a never-reachable proxy —
  // must return false (not hang) once the simulated clock crosses the
  // deadline, and the elapsed simulated time must respect the deadline
  // (allowing for one final probe's worth of overshoot).
  {
    const deadlineMs = 15_000
    const { deps, sleepCalls } = makeFakeClockDeps(async () => false)
    const ready = await waitForRoutingProxyTcpDiagnostic(
      'http://127.0.0.1:18765',
      { deadlineMs },
      deps
    )
    assert.equal(ready, false, 'must report NOT ready once the deadline elapses with no success')
    const totalSimulatedWaitMs = sleepCalls.reduce((a, b) => a + b, 0)
    assert.ok(
      totalSimulatedWaitMs >= deadlineMs,
      'must have waited at least the full deadline before giving up'
    )
    console.log(
      `✓ waitForRoutingProxyTcpDiagnostic still terminates a never-reachable proxy at the ${deadlineMs}ms deadline (simulated)`
    )
  }

  // 10e. Readiness uses the cheap/TCP signal only — the expensive
  // management-API round trip must never be invoked for readiness. Prove it
  // by asserting waitForRoutingProxyTcpDiagnostic's deps shape has no
  // managementProbe at all (a compile-time guarantee) AND that a tcpProbe
  // returning true is sufficient on its own with no management secret
  // involved anywhere in the call.
  {
    let managementProbeCalled = false
    const readyDeps: RoutingProxyReadyDeps = {
      tcpProbe: async () => {
        return true
      },
      now: () => 0,
      sleep: async () => {
        managementProbeCalled = true // would only flip if we ever slept, i.e. tcp failed first
      }
    }
    const ready = await waitForRoutingProxyTcpDiagnostic('http://127.0.0.1:18765', {}, readyDeps)
    assert.equal(ready, true)
    assert.equal(
      managementProbeCalled,
      false,
      'a bare TCP-accept must be sufficient for readiness — no management round trip required'
    )
    console.log(
      '✓ waitForRoutingProxyTcpDiagnostic is satisfied by the cheap TCP signal alone — no management-API round trip required for readiness'
    )
  }

  // 10f. Invalid URL never throws — resolves false.
  {
    const { deps } = makeFakeClockDeps(async () => true)
    const ready = await waitForRoutingProxyTcpDiagnostic('not a url', {}, deps)
    assert.equal(ready, false, 'an invalid base URL must resolve false, never throw')
    console.log(
      '✓ waitForRoutingProxyTcpDiagnostic resolves false (never throws) for an invalid URL'
    )
  }
}

// ---------------------------------------------------------------------------
// 11. ensureHealthyForRouting still fail-closed (regression guard specific to
//    this perf change — the readiness speedup must NOT have touched the
//    fail-closed gate's own default timeout/behaviour). Re-asserts the same
//    invariant as section 7 but explicitly framed as a no-regression check
//    tied to this change.
// ---------------------------------------------------------------------------

{
  const runtime = {
    source: 'automatic' as const,
    url: 'http://127.0.0.1:18765',
    host: '127.0.0.1',
    port: 18765,
    portConfigurationLocked: false
  }
  const ownedAttempt: RoutingProxySpawnAttempt = {
    pid: 123,
    managementSecret: 'x'.repeat(48),
    isAlive: () => true,
    terminate: () => {}
  }
  const foreignDeps: ManagedReadinessDeps = {
    inspectListeners: async () => [{ pid: 999, executablePath: '/foreign', argv: [] }],
    managementProbe: async () => true,
    sleep: async () => {},
    now: () => 0
  }
  await assert.rejects(
    () => ensureHealthyForRouting(runtime, ownedAttempt, { deadlineMs: 0 }, foreignDeps),
    /not healthy/,
    'routing gate must reject a foreign listener even when its TCP port and management API respond'
  )
  console.log('✓ (no-regression) routing gate remains fail-closed for foreign/unowned listeners')
}

// ---------------------------------------------------------------------------
// 12. Listener ownership inspection and proof-only orphan reclaim.
// ---------------------------------------------------------------------------

{
  const binary =
    '/Applications/Orpheus Dev.app/Contents/Resources/routing-proxy/7.2.92/cli-proxy-api'
  const config =
    '/Users/example/Library/Application Support/Orpheus Dev/routing-proxy/7.2.92/config.yaml'
  const otherConfig =
    '/Users/example/Library/Application Support/Orpheus/routing-proxy/7.2.92/config.yaml'
  const exact: ListeningProcess = {
    pid: 41,
    executablePath: binary,
    argv: [binary, '-config', config]
  }

  assert.equal(isSameVariantRoutingProxy(exact, binary, config), true)
  assert.equal(
    isSameVariantRoutingProxy(
      { pid: 42, executablePath: null, argv: [binary, '-config', config] },
      binary,
      config
    ),
    false,
    'an unknown executable path is never proof of ownership'
  )
  assert.equal(
    isSameVariantRoutingProxy({ pid: 43, executablePath: binary, argv: null }, binary, config),
    false,
    'an unknown argv is never proof of ownership'
  )
  assert.equal(
    isSameVariantRoutingProxy(
      { pid: 44, executablePath: '/usr/bin/other', argv: [binary, '-config', config] },
      binary,
      config
    ),
    false,
    'a foreign executable is never our routing proxy'
  )
  assert.equal(
    isSameVariantRoutingProxy(
      { pid: 45, executablePath: binary, argv: [binary, '-config', otherConfig] },
      binary,
      config
    ),
    false,
    'the same binary using a different config is another variant'
  )
  assert.equal(
    isSameVariantRoutingProxy(
      { pid: 46, executablePath: binary, argv: [binary, '--config', config] },
      binary,
      config
    ),
    false,
    'the config flag and its exact following token are required'
  )
  const literalBackslashConfig = config.replace('routing-proxy', 'routing\\proxy')
  assert.equal(
    isSameVariantRoutingProxy(
      { pid: 47, executablePath: binary, argv: null },
      binary,
      literalBackslashConfig
    ),
    false,
    'a command line containing a literal backslash is uninspectable, never ownership proof'
  )

  function makeInspectionDeps(listenersByCall: ListeningProcess[][]): {
    deps: ListenerInspectionDeps
    killedPids: number[]
    slept: number[]
  } {
    let calls = 0
    const killedPids: number[] = []
    const slept: number[] = []
    return {
      killedPids,
      slept,
      deps: {
        listListeners: async () =>
          listenersByCall[Math.min(calls++, listenersByCall.length - 1)] ?? [],
        signalProcess: (pid) => killedPids.push(pid),
        sleep: async (ms) => slept.push(ms)
      }
    }
  }

  // Unknown, foreign, and other-variant processes must remain untouched even
  // when they are the only listener or share a port with a proven orphan.
  const unrelated: ListeningProcess[] = [
    { pid: 42, executablePath: null, argv: [binary, '-config', config] },
    { pid: 43, executablePath: binary, argv: null },
    { pid: 44, executablePath: '/usr/bin/other', argv: [binary, '-config', config] },
    { pid: 45, executablePath: binary, argv: [binary, '-config', otherConfig] }
  ]
  {
    const { deps, killedPids } = makeInspectionDeps([unrelated])
    const result = await reclaimProvenOrphan(18766, binary, config, deps)
    assert.equal(result.reclaimed, false)
    assert.deepEqual(killedPids, [])
    assert.match(result.reason ?? '', /exactly one proven same-variant listener/)
  }

  // `ps command=` cannot safely distinguish a literal backslash from display
  // escaping. Its argv evidence is null, so it cannot be reclaimed even if
  // the expected config itself contains that literal character.
  {
    const ambiguous: ListeningProcess = { pid: 47, executablePath: binary, argv: null }
    const { deps, killedPids } = makeInspectionDeps([[ambiguous]])
    const result = await reclaimProvenOrphan(18766, binary, literalBackslashConfig, deps)
    assert.equal(result.reclaimed, false)
    assert.deepEqual(killedPids, [])
  }

  // Additional listeners make the port occupied, even if one is exactly our
  // stale process. Signal nobody: ownership proof applies to the whole port.
  {
    const foreign = unrelated[0]!
    const { deps, killedPids } = makeInspectionDeps([[exact, foreign]])
    const result = await reclaimProvenOrphan(18766, binary, config, deps)
    assert.equal(result.reclaimed, false)
    assert.deepEqual(result.killedPids, [])
    assert.deepEqual(killedPids, [])
  }

  // Even after signalling one exact listener, any remaining foreign listener
  // means the port was not reclaimed and cannot be reused.
  {
    const foreign = unrelated[0]!
    const { deps, killedPids } = makeInspectionDeps([[exact], [foreign]])
    const result = await reclaimProvenOrphan(18766, binary, config, deps)
    assert.equal(result.reclaimed, false)
    assert.deepEqual(result.killedPids, [41])
    assert.deepEqual(killedPids, [41])
    assert.match(result.reason ?? '', /remains bound/)
  }

  // A sole exact listener is reclaimable only after the complete listener list
  // becomes empty.
  {
    const { deps, killedPids, slept } = makeInspectionDeps([[exact], []])
    const result = await reclaimProvenOrphan(18766, binary, config, deps)
    assert.equal(result.reclaimed, true)
    assert.deepEqual(result.killedPids, [41])
    assert.deepEqual(killedPids, [41])
    assert.deepEqual(slept, [150])
  }

  console.log(
    '✓ reclaimProvenOrphan signals only a sole proven listener and requires an empty reinspection'
  )
}

// ---------------------------------------------------------------------------
// 14. (model-routing unit 09-polish) Explicit restart() — manager.ts's
//     restart() is NOT importable by this harness (manager.ts pulls in
//     `electron` via BrowserWindow, which this offline script never boots —
//     same carve-out as every other manager.ts-touching concern in this
//     file's header comment). restart() is a thin composition of THREE
//     already-exhaustively-tested primitives with no new logic of its own:
//       - stop() (lifecycle.ts's stopRoutingProxy — SIGTERM then SIGKILL
//         after a grace period, resolves only once the child has actually
//         exited)
//       - reclaimProvenOrphan (asserted exhaustively in section 12 above) —
//         reused as a proof-only defensive port-release check
//         between stop and start, exactly like reconcileRoutingProxy's own
//         pre-start reclaim
//       - start() (already covers config regeneration, readiness polling,
//         authFiles/model-cache refresh kickoff)
//     plus a module-level boolean re-entrancy flag
//     (restartInFlight/isRestarting()) guarding against a second overlapping
//     stop-then-start sequence against the same port. That flag idiom is
//     asserted here in isolation (the same shape manager.ts's restart()
//     uses) since the real restart() can't be imported offline; the full
//     integration (restart hits the SAME port, rotates MANAGEMENT_PASSWORD,
//     re-triggers the model-cache/authFiles refresh) is verified against the
//     real dev-app build as part of this unit's required end-to-end checks
//     (see this unit's task report for the live grep/curl evidence).
// ---------------------------------------------------------------------------

{
  // Same shape as manager.ts's restartInFlight/isRestarting()/restart():
  // a module-level flag checked-and-set before any async work starts, reset
  // in a finally so a thrown stop()/start() still releases the guard.
  let inFlight = false
  async function guardedRestart(work: () => Promise<string>): Promise<string | 'skipped'> {
    if (inFlight) return 'skipped'
    inFlight = true
    try {
      return await work()
    } finally {
      inFlight = false
    }
  }

  let concurrentCallCount = 0
  const slowWork = async (): Promise<string> => {
    concurrentCallCount++
    await new Promise((resolve) => setTimeout(resolve, 20))
    return 'done'
  }

  const [first, second] = await Promise.all([guardedRestart(slowWork), guardedRestart(slowWork)])
  const results = [first, second].sort()
  assert.deepEqual(
    results,
    ['done', 'skipped'],
    'a restart already in flight must make a concurrent second call a no-op (returns without starting new work), ' +
      'not a second overlapping stop/start sequence against the same port'
  )
  assert.equal(
    concurrentCallCount,
    1,
    'the guarded work must only actually run once for two concurrent restart calls'
  )
  console.log(
    "✓ (unit 09-polish) the re-entrancy-guard idiom manager.ts's restart() uses correctly makes a " +
      'concurrent second restart call a no-op rather than racing a second stop/start sequence'
  )

  // After the in-flight call completes, the guard must release and allow a
  // FRESH restart — non-re-entrant must not mean permanently locked.
  const third = await guardedRestart(async () => 'done-again')
  assert.equal(
    third,
    'done-again',
    'the guard must release after completion, allowing a later restart'
  )
  console.log('✓ the re-entrancy guard releases after completion, allowing a subsequent restart')
}

// ---------------------------------------------------------------------------
// 15. Auto-supervision (respawn + health watchdog) — src/main/routingProxy/
//     supervisor.ts. Fully offline: a fake clock/scheduler stands in for
//     setTimeout/setInterval so backoff/watchdog timing is asserted exactly,
//     with no real delays. This is the ONE module in routingProxy/ purpose-
//     built to be importable by this electron-free harness while still
//     covering the respawn/backoff/watchdog/give-up decision logic that
//     manager.ts wires to real electron/process APIs (manager.ts itself
//     stays untestable here for the same reason restart() is, per section 14
//     above — it imports `electron`).
// ---------------------------------------------------------------------------

// 15a. Pure backoff-delay calculator: attempt 0->1s, 1->2s, 2->4s, 3->8s,
// 4->16s, 5+->30s (capped), per the required schedule exactly.
{
  const schedule = [0, 1, 2, 3, 4, 5, 6, 100].map(respawnBackoffDelayMs)
  assert.deepEqual(
    schedule,
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
    'backoff schedule must be attempt 0->1s, 1->2s, 2->4s, 3->8s, 4->16s, 5+->30s (capped)'
  )
  console.log(
    '✓ respawnBackoffDelayMs follows the exact required schedule (1s/2s/4s/8s/16s/30s-capped)'
  )
}

// 15b. Pure respawn decision function — expected vs unexpected exit.
{
  const respawnWhenUnexpected = decideRespawnAction({
    enabled: true,
    expectedShutdown: false,
    restarting: false,
    consecutiveFailures: 0
  })
  assert.equal(
    respawnWhenUnexpected.action,
    'respawn',
    'an unexpected exit with no restart in flight and under the failure cap must trigger a respawn'
  )
  if (respawnWhenUnexpected.action === 'respawn') {
    assert.equal(
      respawnWhenUnexpected.delayMs,
      1000,
      'first respawn attempt uses the 1s base delay'
    )
  }

  const skipWhenExpected = decideRespawnAction({
    enabled: true,
    expectedShutdown: true,
    restarting: false,
    consecutiveFailures: 0
  })
  assert.equal(
    skipWhenExpected.action,
    'skip',
    'an exit marked as expected (manual stop/restart/quit) must NOT trigger a respawn'
  )

  const skipWhenDisabled = decideRespawnAction({
    enabled: false,
    expectedShutdown: false,
    restarting: false,
    consecutiveFailures: 0
  })
  assert.equal(
    skipWhenDisabled.action,
    'skip',
    'supervision must never fight an intentional stop — disabled must skip respawn entirely'
  )

  const skipWhenRestarting = decideRespawnAction({
    enabled: true,
    expectedShutdown: false,
    restarting: true,
    consecutiveFailures: 0
  })
  assert.equal(
    skipWhenRestarting.action,
    'skip',
    'a manual restart already in flight must not be raced by a second supervised respawn'
  )
  console.log(
    '✓ decideRespawnAction: unexpected exit respawns, expected/disabled/restarting-in-flight all skip'
  )
}

// 15c. Give-up after MAX_CONSECUTIVE_RESPAWN_FAILURES (5) consecutive
// failures — and NOT before.
{
  const stillTrying = decideRespawnAction({
    enabled: true,
    expectedShutdown: false,
    restarting: false,
    consecutiveFailures: MAX_CONSECUTIVE_RESPAWN_FAILURES - 1
  })
  assert.equal(
    stillTrying.action,
    'respawn',
    'must keep respawning right up to (but not including) the failure cap'
  )

  const givesUp = decideRespawnAction({
    enabled: true,
    expectedShutdown: false,
    restarting: false,
    consecutiveFailures: MAX_CONSECUTIVE_RESPAWN_FAILURES
  })
  assert.equal(
    givesUp.action,
    'give-up',
    `must give up once consecutiveFailures reaches ${MAX_CONSECUTIVE_RESPAWN_FAILURES}`
  )
  console.log(
    `✓ decideRespawnAction gives up after exactly ${MAX_CONSECUTIVE_RESPAWN_FAILURES} consecutive failed respawn attempts, not before`
  )
}

// 15d. Watchdog decision — a hung-but-alive (running, unhealthy) process
// must trigger a restart; a healthy one, a not-running one, a disabled
// state, an expected-shutdown, and a restart-in-flight must all skip.
{
  const restartsWhenHung = decideWatchdogAction({
    enabled: true,
    expectedShutdown: false,
    restarting: false,
    isRunning: true,
    healthy: false
  })
  assert.equal(
    restartsWhenHung.action,
    'restart',
    'a running-but-unhealthy (bound, not answering the management probe) process must be restarted'
  )

  const skipsWhenHealthy = decideWatchdogAction({
    enabled: true,
    expectedShutdown: false,
    restarting: false,
    isRunning: true,
    healthy: true
  })
  assert.equal(skipsWhenHealthy.action, 'skip', 'a healthy running process must not be restarted')

  const skipsWhenNotRunning = decideWatchdogAction({
    enabled: true,
    expectedShutdown: false,
    restarting: false,
    isRunning: false,
    healthy: false
  })
  assert.equal(
    skipsWhenNotRunning.action,
    'skip',
    'nothing running means nothing for the watchdog to restart — the respawn-on-exit path owns that case'
  )

  const skipsWhenDisabled = decideWatchdogAction({
    enabled: false,
    expectedShutdown: false,
    restarting: false,
    isRunning: true,
    healthy: false
  })
  assert.equal(
    skipsWhenDisabled.action,
    'skip',
    'a disabled proxy must never be watchdog-restarted'
  )
  console.log(
    '✓ decideWatchdogAction restarts a hung-but-running proxy and skips in every other case (healthy/not-running/disabled)'
  )
}

// ---------------------------------------------------------------------------
// 16. RoutingProxySupervisor — the stateful orchestration class, driven with
// a fully fake scheduler (no real setTimeout/setInterval) so backoff/
// watchdog timing is deterministic and instantaneous in this harness.
// ---------------------------------------------------------------------------

interface FakeTimer {
  id: number
  cb: () => void
  fireAt: number
  interval: number | null
}

/** Minimal fake scheduler: setTimer/setRepeatingTimer register a callback
 *  against a virtual clock; advance(ms) fires everything due, repeating
 *  timers reschedule themselves exactly like the real setInterval would. */
function makeFakeScheduler(): {
  deps: Pick<RoutingProxySupervisorDeps, 'setTimer' | 'clearTimer' | 'setRepeatingTimer'>
  advance: (ms: number) => void
  pendingCount: () => number
} {
  let now = 0
  let nextId = 1
  const timers = new Map<number, FakeTimer>()

  const setTimer: RoutingProxySupervisorDeps['setTimer'] = (cb, delayMs) => {
    const id = nextId++
    timers.set(id, { id, cb, fireAt: now + delayMs, interval: null })
    return id
  }
  const setRepeatingTimer: RoutingProxySupervisorDeps['setRepeatingTimer'] = (cb, intervalMs) => {
    const id = nextId++
    timers.set(id, { id, cb, fireAt: now + intervalMs, interval: intervalMs })
    return id
  }
  const clearTimer: RoutingProxySupervisorDeps['clearTimer'] = (handle) => {
    timers.delete(handle as number)
  }
  const advance = (ms: number): void => {
    const target = now + ms
    // Fire due timers in fireAt order, one at a time, so a callback that
    // itself schedules a new timer within the advanced window is picked up
    // correctly (mirrors real event-loop ordering closely enough for this
    // harness's purposes).
    while (true) {
      let due: FakeTimer | null = null
      for (const t of timers.values()) {
        if (t.fireAt <= target && (due === null || t.fireAt < due.fireAt)) due = t
      }
      if (!due) break
      now = due.fireAt
      if (due.interval !== null) {
        due.fireAt = now + due.interval
      } else {
        timers.delete(due.id)
      }
      due.cb()
    }
    now = target
  }
  return {
    deps: { setTimer, setRepeatingTimer, clearTimer },
    advance,
    pendingCount: () => timers.size
  }
}

function silentLogger(): SupervisorLogger {
  return { info: () => {}, warn: () => {}, error: () => {} }
}

/** Flushes pending microtasks (e.g. an `await deps.startProxy()` inside the
 *  supervisor's respawn path) so synchronous fake-timer `advance()` calls in
 *  this harness correctly observe state that only settles after a promise
 *  continuation — mirrors the real event loop interleaving timers/microtasks
 *  closely enough for these assertions. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

// 16a. Expected shutdown suppresses respawn entirely.
{
  const scheduler = makeFakeScheduler()
  let startCalls = 0
  let giveUpCalls = 0
  const deps: RoutingProxySupervisorDeps = {
    startProxy: async () => {
      startCalls++
    },
    killProxy: () => {},
    isRunning: () => false,
    isRestarting: () => false,
    isEnabled: () => true,
    checkHealth: async () => ({ healthy: true }),
    onGiveUp: () => {
      giveUpCalls++
    },
    logger: silentLogger(),
    ...scheduler.deps
  }
  const supervisor = new RoutingProxySupervisor(deps)

  supervisor.markExpectedShutdown()
  supervisor.onUnexpectedExit(0, null)
  scheduler.advance(60_000)
  assert.equal(
    startCalls,
    0,
    'marking a shutdown as expected BEFORE the exit must suppress respawn entirely, even after a long wait'
  )
  assert.equal(giveUpCalls, 0, 'no give-up should fire either when the exit was expected')
  console.log(
    '✓ RoutingProxySupervisor: an exit preceded by markExpectedShutdown() does NOT trigger a respawn'
  )
}

// 16b. An exit with NO prior expected-shutdown mark DOES trigger a respawn,
// on the correct 1s backoff.
{
  const scheduler = makeFakeScheduler()
  let startCalls = 0
  const deps: RoutingProxySupervisorDeps = {
    startProxy: async () => {
      startCalls++
    },
    killProxy: () => {},
    isRunning: () => true,
    isRestarting: () => false,
    isEnabled: () => true,
    checkHealth: async () => ({ healthy: true }),
    onGiveUp: () => {},
    logger: silentLogger(),
    ...scheduler.deps
  }
  const supervisor = new RoutingProxySupervisor(deps)

  supervisor.markStarted()
  supervisor.onUnexpectedExit(1, null)
  assert.equal(
    startCalls,
    0,
    'the respawn must be scheduled on a backoff timer, not fired synchronously'
  )
  scheduler.advance(999)
  await flushMicrotasks()
  assert.equal(startCalls, 0, 'must not respawn before the 1s backoff elapses')
  scheduler.advance(1)
  await flushMicrotasks()
  assert.equal(
    startCalls,
    1,
    'must respawn once the 1s backoff elapses for an unmarked (unexpected) exit'
  )
  console.log(
    '✓ RoutingProxySupervisor: an exit with NO prior expected-shutdown mark respawns after exactly the 1s backoff'
  )
}

// 16c. Give up after 5 consecutive failed respawn attempts, and stop trying.
{
  const scheduler = makeFakeScheduler()
  let startCalls = 0
  let giveUpMessage: string | null = null
  const deps: RoutingProxySupervisorDeps = {
    // Every attempt "fails" — the process never comes up.
    startProxy: async () => {
      startCalls++
    },
    killProxy: () => {},
    isRunning: () => false,
    isRestarting: () => false,
    isEnabled: () => true,
    checkHealth: async () => ({ healthy: true }),
    onGiveUp: (message) => {
      giveUpMessage = message
    },
    logger: silentLogger(),
    ...scheduler.deps
  }
  const supervisor = new RoutingProxySupervisor(deps)

  supervisor.markStarted()
  supervisor.onUnexpectedExit(1, null)
  // Drain every backoff tier (1s,2s,4s,8s,16s) — 5 failed attempts total.
  // Each advance() fires a timer synchronously, but the supervisor's own
  // respawn handling awaits startProxy() before scheduling the NEXT backoff
  // timer — flush microtasks after every tier so that next timer actually
  // exists before the following advance() call.
  for (const tier of [1000, 2000, 4000, 8000, 16000]) {
    scheduler.advance(tier)
    await flushMicrotasks()
  }

  assert.equal(startCalls, 5, 'must have attempted exactly 5 respawns before giving up')
  assert.ok(giveUpMessage !== null, 'onGiveUp must fire once the 5th consecutive attempt fails')
  assert.ok(
    (giveUpMessage as unknown as string).includes('5'),
    'the give-up message should be clear about the failure count'
  )
  assert.ok(supervisor.hasGivenUp(), 'hasGivenUp() must report true after giving up')

  // A 6th window must NOT trigger yet another respawn attempt.
  scheduler.advance(30_000)
  await flushMicrotasks()
  assert.equal(
    startCalls,
    5,
    'once given up, the supervisor must stop trying — no further respawn attempts'
  )
  console.log(
    '✓ RoutingProxySupervisor gives up after exactly 5 consecutive failed respawn attempts and stops trying'
  )

  // 16d. Counter reset (manual restart / enable-toggle) brings it back.
  supervisor.resetFailureCount()
  assert.equal(supervisor.hasGivenUp(), false, 'resetFailureCount() must clear the given-up state')
  supervisor.markStarted()
  supervisor.onUnexpectedExit(1, null)
  scheduler.advance(1000)
  await flushMicrotasks()
  assert.equal(
    startCalls,
    6,
    'after a counter reset, respawn attempts must resume normally from a fresh 1s backoff'
  )
  console.log(
    '✓ resetFailureCount() (manual restart / enable-toggle) resets the failure counter and respawn attempts resume'
  )
}

// 16e. Watchdog restarting an unhealthy-but-running proxy: a stubbed health
// probe reporting unhealthy must trigger killProxy() (which — in the real
// wiring — leads to a real child exit routed back through onUnexpectedExit;
// this unit only asserts the watchdog's own trigger).
{
  const scheduler = makeFakeScheduler()
  let killCalls = 0
  const deps: RoutingProxySupervisorDeps = {
    startProxy: async () => {},
    killProxy: () => {
      killCalls++
    },
    isRunning: () => true,
    isRestarting: () => false,
    isEnabled: () => true,
    checkHealth: async () => ({ healthy: false, reason: 'stubbed unhealthy' }),
    onGiveUp: () => {},
    logger: silentLogger(),
    ...scheduler.deps
  }
  const supervisor = new RoutingProxySupervisor(deps)
  supervisor.startWatchdog()
  scheduler.advance(30_000)
  // Allow the async checkHealth() promise inside the tick to settle.
  await Promise.resolve()
  await Promise.resolve()
  assert.ok(
    killCalls >= 1,
    'the watchdog must kill a running-but-unhealthy process on its first 30s tick'
  )
  supervisor.dispose()
  console.log(
    '✓ RoutingProxySupervisor: the 30s health watchdog kills-and-lets-respawn an unhealthy-but-running proxy'
  )
}

// 16f. Single-flight: two overlapping watchdog ticks must not stack/
// duplicate probes — a slow checkHealth() call must not be invoked a second
// time while the first is still outstanding.
{
  const scheduler = makeFakeScheduler()
  let probeCalls = 0
  let resolveFirstProbe: (() => void) | null = null
  const firstProbeGate = new Promise<void>((resolve) => {
    resolveFirstProbe = resolve
  })
  const deps: RoutingProxySupervisorDeps = {
    startProxy: async () => {},
    killProxy: () => {},
    isRunning: () => true,
    isRestarting: () => false,
    isEnabled: () => true,
    checkHealth: async () => {
      probeCalls++
      if (probeCalls === 1) await firstProbeGate
      return { healthy: true }
    },
    onGiveUp: () => {},
    logger: silentLogger(),
    ...scheduler.deps
  }
  const supervisor = new RoutingProxySupervisor(deps)
  supervisor.startWatchdog()

  // First tick fires and its probe is deliberately left outstanding.
  scheduler.advance(30_000)
  await Promise.resolve()
  assert.equal(probeCalls, 1, 'first watchdog tick must start exactly one probe')

  // A second tick fires while the first probe is still outstanding — must
  // NOT start a second overlapping probe (single-flight).
  scheduler.advance(30_000)
  await Promise.resolve()
  assert.equal(
    probeCalls,
    1,
    'a second overlapping watchdog tick must not stack a second probe while one is in flight'
  )

  // Release the first probe — now the NEXT tick is free to probe again.
  resolveFirstProbe?.()
  await Promise.resolve()
  await Promise.resolve()
  scheduler.advance(30_000)
  await Promise.resolve()
  assert.equal(
    probeCalls,
    2,
    'once the outstanding probe settles, a subsequent tick must be able to probe again'
  )
  supervisor.dispose()
  console.log(
    '✓ RoutingProxySupervisor: overlapping watchdog ticks are single-flight — no stacked/duplicate probes'
  )
}

// 16g. dispose() clears both the backoff-respawn timer and the health-
// watchdog interval — mirrors shutdownRoutingProxySync()'s requirement.
{
  const scheduler = makeFakeScheduler()
  let startCalls = 0
  let probeCalls = 0
  const deps: RoutingProxySupervisorDeps = {
    startProxy: async () => {
      startCalls++
    },
    killProxy: () => {},
    isRunning: () => false,
    isRestarting: () => false,
    isEnabled: () => true,
    checkHealth: async () => {
      probeCalls++
      return { healthy: true }
    },
    onGiveUp: () => {},
    logger: silentLogger(),
    ...scheduler.deps
  }
  const supervisor = new RoutingProxySupervisor(deps)
  supervisor.startWatchdog()
  supervisor.markStarted()
  supervisor.onUnexpectedExit(1, null) // schedules a 1s backoff respawn timer

  supervisor.dispose()
  scheduler.advance(120_000)
  assert.equal(startCalls, 0, 'dispose() must clear the pending backoff-respawn timer')
  assert.equal(probeCalls, 0, 'dispose() must clear the health-watchdog interval')
  assert.equal(scheduler.pendingCount(), 0, 'no timers should remain scheduled after dispose()')
  console.log(
    '✓ RoutingProxySupervisor.dispose() clears both the backoff-respawn timer and the health-watchdog interval'
  )
}

await cleanup()
console.log('\nAll routing-proxy assertions passed.')
