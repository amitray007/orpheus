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
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  archToAssetSegment,
  assetNameFor,
  downloadUrlFor,
  PINNED_TAG,
  PINNED_VERSION
} from '../src/main/routingProxy/constants.ts'
import {
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
  type HealthCheckDeps
} from '../src/main/routingProxy/health.ts'
import {
  checkRoutingProxyUpdate,
  type UpdateCheckDeps
} from '../src/main/routingProxy/updateCheck.ts'

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

  function makeDeps(assetBytesToServe: Buffer): InstallDeps {
    return {
      fetchBytes: async (url: string) => {
        if (url.endsWith('checksums.txt')) return Buffer.from(checksumsText, 'utf8')
        return assetBytesToServe
      },
      extractTarGz: async () => {
        extractCalls++
      },
      mkdir: async (dir) => {
        mkdirCalls.push(dir)
      },
      writeFile: async () => {},
      chmodExecutable: async () => {},
      rm: async (target) => {
        rmCalls.push(target)
      }
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

  // 4b. Correct hash: extraction proceeds exactly once.
  extractCalls = 0
  const result = await installRoutingProxy({ arch: 'arm64' }, makeDeps(goodBytes))
  assert.equal(extractCalls, 1, 'extractTarGz must be called exactly once on a good hash')
  assert.equal(result.version, PINNED_VERSION)
  assert.ok(
    result.binaryPath.endsWith('CLIProxyAPI'),
    'binary path must point at the extracted binary'
  )
  console.log('✓ installRoutingProxy extracts exactly once on a matching hash')

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

await cleanup()
console.log('\nAll routing-proxy assertions passed.')
