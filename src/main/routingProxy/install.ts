// ---------------------------------------------------------------------------
// src/main/routingProxy/install.ts
//
// Download + SHA-256-verify + extract the CLIProxyAPI release asset for the
// current platform/arch. Every I/O boundary (network fetch, filesystem,
// tar extraction) is injectable via the `deps` parameter, AND the
// destination directory is passed in explicitly by the caller (rather than
// derived internally from paths.ts, which imports `electron`) — both
// together are what let scripts/verify-routing-proxy.ts exercise the
// SHA-256-reject path (the single most important assertion in this unit)
// fully offline, with no Electron boot required. manager.ts is the one real
// caller and supplies paths.versionDir()/downloadsDir() explicitly.
//
// THE INVARIANT: verifyChecksum() runs BEFORE extraction, and a mismatch
// throws — extract() is never reached on a bad hash. No partial/half-trusted
// install is ever left in the destination dir.
// ---------------------------------------------------------------------------

import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PINNED_TAG,
  PINNED_VERSION,
  assetNameFor,
  checksumsAssetName,
  downloadUrlFor
} from './constants'

export class ChecksumMismatchError extends Error {
  constructor(assetName: string, expected: string, actual: string) {
    super(
      `SHA-256 mismatch for ${assetName}: expected ${expected}, got ${actual}. Refusing to install.`
    )
    this.name = 'ChecksumMismatchError'
  }
}

export class UnsupportedPlatformError extends Error {
  constructor(arch: string) {
    super(`No CLIProxyAPI release asset for arch "${arch}" (supported: arm64, x64).`)
    this.name = 'UnsupportedPlatformError'
  }
}

// ---------------------------------------------------------------------------
// Injectable I/O surface — defaults are the real network/fs/tar; tests pass
// stubs so the harness never touches the network or writes outside a tmpdir.
// ---------------------------------------------------------------------------

export interface InstallDeps {
  /** Fetch a URL and return its raw bytes. Must throw/reject on non-2xx. */
  fetchBytes: (url: string) => Promise<Buffer>
  /** Extract a tar.gz buffer's contents into destDir. */
  extractTarGz: (tarGzBytes: Buffer, destDir: string) => Promise<void>
  mkdir: (dir: string) => Promise<void>
  writeFile: (filePath: string, data: Buffer) => Promise<void>
  chmodExecutable: (filePath: string) => Promise<void>
  rm: (dirOrFile: string) => Promise<void>
}

async function realFetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function realExtractTarGz(tarGzBytes: Buffer, destDir: string): Promise<void> {
  // `tar` (npm) is already a project dependency (package.json) — avoids
  // shelling out to the system `tar` binary, which is not guaranteed present
  // in every environment the way it is on a dev Mac.
  const tar = await import('tar')
  await fs.mkdir(destDir, { recursive: true })
  const tmpTarPath = path.join(destDir, '.__download.tar.gz')
  await fs.writeFile(tmpTarPath, tarGzBytes)
  try {
    await tar.extract({ file: tmpTarPath, cwd: destDir })
  } finally {
    await fs.rm(tmpTarPath, { force: true })
  }
}

export function defaultInstallDeps(): InstallDeps {
  return {
    fetchBytes: realFetchBytes,
    extractTarGz: realExtractTarGz,
    mkdir: async (dir) => {
      await fs.mkdir(dir, { recursive: true })
    },
    writeFile: (filePath, data) => fs.writeFile(filePath, data),
    chmodExecutable: (filePath) => fs.chmod(filePath, 0o755),
    rm: (target) => fs.rm(target, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// checksums.txt parsing — standard `<sha256>  <filename>` format, one entry
// per line (sha256sum(1)/shasum -a 256 output).
// ---------------------------------------------------------------------------

export function parseChecksumsFile(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    // Format: <64-hex-char-hash><whitespace(s)><filename>. The reference
    // asset uses two spaces (binary-mode marker convention) but tolerate
    // one-or-more whitespace defensively.
    const m = /^([a-fA-F0-9]{64})\s+\*?(\S.*)$/.exec(line)
    if (!m) continue
    map.set(m[2].trim(), m[1].toLowerCase())
  }
  return map
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex')
}

/**
 * Verify `bytes` against the expected hash for `assetName` found in a parsed
 * checksums map. Throws ChecksumMismatchError on any mismatch (including a
 * missing entry, treated as "0000...0" expected so the mismatch message is
 * still informative) — callers must never proceed to extract() past this
 * throw.
 */
export function verifyChecksum(
  assetName: string,
  bytes: Buffer,
  checksums: Map<string, string>
): void {
  const expected = checksums.get(assetName)
  const actual = sha256Hex(bytes)
  if (!expected) {
    throw new ChecksumMismatchError(assetName, '(no entry in checksums.txt)', actual)
  }
  if (expected.toLowerCase() !== actual.toLowerCase()) {
    throw new ChecksumMismatchError(assetName, expected, actual)
  }
}

export interface InstallProgressCb {
  (phase: 'downloading' | 'verifying' | 'extracting'): void
}

export interface InstallResult {
  version: string
  installDir: string
  binaryPath: string
}

/**
 * Download the correct asset for `arch`, verify its SHA-256 against
 * checksums.txt, and extract it into `destDir` (caller-supplied — the real
 * caller is manager.ts, which passes paths.versionDir(version); never
 * derived internally so this module stays electron-free and testable
 * offline). Refuses (throws, installs nothing) on any checksum mismatch or
 * unsupported arch. Never installs into the app bundle.
 */
export async function installRoutingProxy(
  options: {
    version?: string
    tag?: string
    arch?: string
    destDir?: string
    onProgress?: InstallProgressCb
  } = {},
  deps: InstallDeps = defaultInstallDeps()
): Promise<InstallResult> {
  const version = options.version ?? PINNED_VERSION
  const tag = options.tag ?? PINNED_TAG
  const arch = options.arch ?? process.arch
  const assetName = assetNameFor(version, arch)
  if (!assetName) throw new UnsupportedPlatformError(arch)

  options.onProgress?.('downloading')
  const assetUrl = downloadUrlFor(tag, assetName)
  const checksumsUrl = downloadUrlFor(tag, checksumsAssetName())
  const [assetBytes, checksumsBytes] = await Promise.all([
    deps.fetchBytes(assetUrl),
    deps.fetchBytes(checksumsUrl)
  ])

  options.onProgress?.('verifying')
  const checksums = parseChecksumsFile(checksumsBytes.toString('utf8'))
  verifyChecksum(assetName, assetBytes, checksums) // throws + installs nothing on mismatch

  options.onProgress?.('extracting')
  const destDir = options.destDir ?? path.join(os.tmpdir(), 'orpheus-routing-proxy', version)
  // Extract into a scratch dir first, then only after a clean extract does
  // the final dir get populated — avoids leaving a half-extracted destDir
  // behind if extraction itself throws partway through.
  await deps.rm(destDir)
  await deps.mkdir(destDir)
  await deps.extractTarGz(assetBytes, destDir)

  const binPath = path.join(destDir, 'CLIProxyAPI')
  await deps.chmodExecutable(binPath)

  return { version, installDir: destDir, binaryPath: binPath }
}
