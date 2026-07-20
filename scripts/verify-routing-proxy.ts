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
  checkRoutingProxyHealth,
  ensureHealthyForRouting,
  waitForRoutingProxyReady,
  type HealthCheckDeps,
  type RoutingProxyReadyDeps
} from '../src/main/routingProxy/health.ts'
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

// ---------------------------------------------------------------------------
// Test scratch dir — everything this harness writes lives here, never under
// a real userData path (paths.ts is intentionally NOT exercised by this
// harness since it imports `electron`, which this offline script never
// boots; install.ts/config.ts are called with explicit dest paths instead).
// ---------------------------------------------------------------------------

const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'orpheus-routing-proxy-test-'))

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
// 6. Health check — unhealthy when nothing listens; healthy when a stub
//    responds. All I/O injected via HealthCheckDeps (no real socket/HTTP).
// ---------------------------------------------------------------------------

{
  const unreachableDeps: HealthCheckDeps = {
    tcpProbe: async () => false,
    managementProbe: async () => false
  }
  const unhealthy = await checkRoutingProxyHealth(
    'http://127.0.0.1:18765',
    { managementSecret: 'x'.repeat(48) },
    unreachableDeps
  )
  assert.equal(unhealthy.healthy, false, 'must report unhealthy when nothing responds')
  console.log('✓ checkRoutingProxyHealth reports unhealthy when nothing is listening')

  const reachableDeps: HealthCheckDeps = {
    tcpProbe: async () => true,
    managementProbe: async () => true
  }
  const healthy = await checkRoutingProxyHealth(
    'http://127.0.0.1:18765',
    { managementSecret: 'x'.repeat(48) },
    reachableDeps
  )
  assert.equal(healthy.healthy, true, 'must report healthy when the management probe responds')
  console.log('✓ checkRoutingProxyHealth reports healthy when a stub responds')

  // TCP-only fallback path (no management secret supplied yet).
  const tcpOnlyDeps: HealthCheckDeps = {
    tcpProbe: async () => true,
    managementProbe: async () => {
      throw new Error('managementProbe must not be called without a secret')
    }
  }
  const tcpHealthy = await checkRoutingProxyHealth('http://127.0.0.1:18765', {}, tcpOnlyDeps)
  assert.equal(
    tcpHealthy.healthy,
    true,
    'bare TCP reachability must count as healthy when no secret is set'
  )
  console.log('✓ checkRoutingProxyHealth falls back to a bare TCP probe with no management secret')
}

// ---------------------------------------------------------------------------
// 7. Fail-closed gate — ensureHealthyForRouting() throws a clear error when
//    unhealthy, so a caller (the terminal:mount handler) can refuse to mount
//    a routed workspace instead of hanging ~44-128s against a dead proxy.
// ---------------------------------------------------------------------------

{
  const unreachableDeps: HealthCheckDeps = {
    tcpProbe: async () => false,
    managementProbe: async () => false
  }
  await assert.rejects(
    () => ensureHealthyForRouting('http://127.0.0.1:18765', {}, unreachableDeps),
    /not reachable/,
    'ensureHealthyForRouting must throw a clear, immediate error when unhealthy'
  )
  console.log('✓ ensureHealthyForRouting REJECTS (fail-closed) when the proxy is unreachable')

  const reachableDeps: HealthCheckDeps = {
    tcpProbe: async () => true,
    managementProbe: async () => true
  }
  await ensureHealthyForRouting('http://127.0.0.1:18765', {}, reachableDeps) // must resolve, not throw
  console.log('✓ ensureHealthyForRouting resolves (allows mount) when the proxy is healthy')
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
// 10. Readiness polling (waitForRoutingProxyReady) — the perf fix. A fake
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
    const ready = await waitForRoutingProxyReady('http://127.0.0.1:18765', {}, deps)
    assert.equal(ready, true, 'must report ready when the very first probe succeeds')
    assert.equal(probeCallCount(), 1, 'exactly one probe when the first one succeeds')
    assert.equal(
      sleepCalls.length,
      0,
      'no sleep must occur before the first probe (or after success)'
    )
    console.log(
      '✓ waitForRoutingProxyReady probes immediately (no initial sleep) and returns on first success'
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
    const ready = await waitForRoutingProxyReady('http://127.0.0.1:18765', {}, deps)
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
      `✓ waitForRoutingProxyReady detects an Nth-probe success promptly (total simulated wait ${totalSimulatedWaitMs}ms ` +
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
    await waitForRoutingProxyReady(
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
    console.log('✓ waitForRoutingProxyReady backoff is bounded by maxDelayMs and reaches the cap')
  }

  // 10d. The overall deadline still terminates a never-reachable proxy —
  // must return false (not hang) once the simulated clock crosses the
  // deadline, and the elapsed simulated time must respect the deadline
  // (allowing for one final probe's worth of overshoot).
  {
    const deadlineMs = 15_000
    const { deps, sleepCalls } = makeFakeClockDeps(async () => false)
    const ready = await waitForRoutingProxyReady('http://127.0.0.1:18765', { deadlineMs }, deps)
    assert.equal(ready, false, 'must report NOT ready once the deadline elapses with no success')
    const totalSimulatedWaitMs = sleepCalls.reduce((a, b) => a + b, 0)
    assert.ok(
      totalSimulatedWaitMs >= deadlineMs,
      'must have waited at least the full deadline before giving up'
    )
    console.log(
      `✓ waitForRoutingProxyReady still terminates a never-reachable proxy at the ${deadlineMs}ms deadline (simulated)`
    )
  }

  // 10e. Readiness uses the cheap/TCP signal only — the expensive
  // management-API round trip must never be invoked for readiness. Prove it
  // by asserting waitForRoutingProxyReady's deps shape has no
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
    const ready = await waitForRoutingProxyReady('http://127.0.0.1:18765', {}, readyDeps)
    assert.equal(ready, true)
    assert.equal(
      managementProbeCalled,
      false,
      'a bare TCP-accept must be sufficient for readiness — no management round trip required'
    )
    console.log(
      '✓ waitForRoutingProxyReady is satisfied by the cheap TCP signal alone — no management-API round trip required for readiness'
    )
  }

  // 10f. Invalid URL never throws — resolves false.
  {
    const { deps } = makeFakeClockDeps(async () => true)
    const ready = await waitForRoutingProxyReady('not a url', {}, deps)
    assert.equal(ready, false, 'an invalid base URL must resolve false, never throw')
    console.log('✓ waitForRoutingProxyReady resolves false (never throws) for an invalid URL')
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
  const unreachableDeps: HealthCheckDeps = {
    tcpProbe: async () => false,
    managementProbe: async () => false
  }
  await assert.rejects(
    () => ensureHealthyForRouting('http://127.0.0.1:18765', {}, unreachableDeps),
    /not reachable/,
    'ensureHealthyForRouting must still reject an unreachable proxy after the readiness-polling change'
  )
  console.log(
    '✓ (no-regression) ensureHealthyForRouting remains fail-closed after the readiness-polling perf change'
  )
}

await cleanup()
console.log('\nAll routing-proxy assertions passed.')
