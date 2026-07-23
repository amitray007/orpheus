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
  BINARY_NAME,
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

/**
 * Thrown when the extracted archive doesn't contain a binary at the expected
 * path. Diagnosable-by-design: names exactly what was expected AND lists
 * what the archive actually produced, so a future upstream rename (the
 * archive's internal layout or binary name changing) surfaces as a clear,
 * actionable error instead of a raw ENOENT bubbling up from chmod().
 */
export class BinaryNotFoundError extends Error {
  constructor(expectedPath: string, actualEntries: string[]) {
    const listing = actualEntries.length > 0 ? actualEntries.join(', ') : '(directory is empty)'
    super(
      `Extracted routing-proxy archive but did not find the expected binary at ` +
        `"${expectedPath}". Archive contents were: ${listing}. The upstream release ` +
        `asset layout may have changed — check github.com/router-for-me/CLIProxyAPI ` +
        `releases and update BINARY_NAME in src/main/routingProxy/constants.ts.`
    )
    this.name = 'BinaryNotFoundError'
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
  /**
   * Ensure the exec bit on filePath. Best-effort: the release binary already
   * ships with mode -rwxr-xr-x, so a chmod failure here (e.g. already-correct
   * permissions on a filesystem that disallows the syscall) must NOT hard-fail
   * the install — pathExists() below is the real guard that catches an
   * actually-missing binary.
   */
  chmodExecutable: (filePath: string) => Promise<void>
  rm: (dirOrFile: string) => Promise<void>
  /** True if a file/dir exists at filePath. Used to verify the binary landed
   *  where expected after extraction — never let a missing binary surface as
   *  a raw ENOENT from chmod(). */
  pathExists: (filePath: string) => Promise<boolean>
  /** List entry names directly under dir (non-recursive). Used to build a
   *  helpful "here's what the archive actually contained" error message. */
  listDir: (dir: string) => Promise<string[]>
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
    chmodExecutable: async (filePath) => {
      // Best-effort: the binary already ships with the exec bit set, so a
      // chmod error on an already-correct file must not hard-fail the
      // install. BinaryNotFoundError (from the pathExists() check in
      // installRoutingProxy) is the real guard against a missing binary.
      try {
        await fs.chmod(filePath, 0o755)
      } catch {
        // intentionally swallowed — see comment above.
      }
    },
    rm: (target) => fs.rm(target, { recursive: true, force: true }),
    pathExists: async (filePath) => {
      try {
        await fs.access(filePath)
        return true
      } catch {
        return false
      }
    },
    listDir: async (dir) => {
      try {
        return await fs.readdir(dir)
      } catch {
        return []
      }
    }
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
 *
 * IDEMPOTENT: if destDir already contains a valid binary at the expected
 * path (e.g. a previous install already completed there — including a dir
 * left behind by an older, buggy version of this function that used the
 * wrong binary name and therefore never got this far), the network/extract
 * steps are skipped entirely and the existing install is reused. A
 * pre-existing destDir that is NOT valid (partial/corrupt — no binary at the
 * expected path) is cleanly wiped and reinstalled from scratch, so a stale
 * or broken directory can never permanently wedge future install attempts.
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

  const destDir = options.destDir ?? path.join(os.tmpdir(), 'orpheus-routing-proxy', version)
  const binPath = path.join(destDir, BINARY_NAME)

  // Reuse a pre-existing, already-valid install: don't re-download/re-extract
  // just because the version dir already exists (also makes this function
  // safe to call twice in a row, e.g. a retried enable-toggle).
  if (await deps.pathExists(binPath)) {
    return { version, installDir: destDir, binaryPath: binPath }
  }

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
  // Extract into a scratch dir first, then only after a clean extract does
  // the final dir get populated — avoids leaving a half-extracted destDir
  // behind if extraction itself throws partway through. This also clears out
  // any STALE/PARTIAL prior attempt (e.g. one that failed after extraction
  // but before this function returned) rather than ever getting permanently
  // wedged on a broken destDir.
  await deps.rm(destDir)
  await deps.mkdir(destDir)
  await deps.extractTarGz(assetBytes, destDir)

  // Resolve/verify the binary landed where expected. A future upstream
  // rename (archive layout or binary filename change) must surface here as
  // a clear, actionable error — never as a raw ENOENT from chmod().
  if (!(await deps.pathExists(binPath))) {
    const actualEntries = await deps.listDir(destDir)
    throw new BinaryNotFoundError(binPath, actualEntries)
  }

  await deps.chmodExecutable(binPath)

  return { version, installDir: destDir, binaryPath: binPath }
}
