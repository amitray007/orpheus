// ---------------------------------------------------------------------------
// src/main/routingProxy/constants.ts
//
// Everything pinned/constant about the managed CLIProxyAPI component.
// PINNED_VERSION is a deliberate, hand-bumped constant — this module never
// tracks `main` or auto-resolves "latest" for the install path; "latest" is
// only used by updateCheck.ts to REPORT whether a newer release exists, not
// to silently install it.
// ---------------------------------------------------------------------------

/** github.com/router-for-me/CLIProxyAPI release tag this build of Orpheus installs. */
export const PINNED_VERSION = '7.2.92'
export const PINNED_TAG = `v${PINNED_VERSION}`

export const GITHUB_REPO = 'router-for-me/CLIProxyAPI'
export const GITHUB_RELEASES_BASE = `https://github.com/${GITHUB_REPO}/releases`
export const GITHUB_API_LATEST_RELEASE = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

/**
 * Name of the executable inside the extracted release archive. VERIFIED
 * empirically against the real v7.2.92 darwin_aarch64 asset: entries extract
 * at the archive ROOT (no nested/version directory) as `cli-proxy-api`,
 * `LICENSE`, `README.md`, `README_CN.md`, `config.example.yaml` — lowercase,
 * hyphenated, NOT `CLIProxyAPI` (that was an unverified assumption in an
 * earlier version of this file that caused an ENOENT on chmod). The archive
 * FILENAME itself is still `CLIProxyAPI_<version>_darwin_<arch>.tar.gz` (see
 * assetNameFor below) — only the binary *inside* the archive differs.
 */
export const BINARY_NAME = 'cli-proxy-api'

/** Node's process.arch values this manager knows how to map to a CLIProxyAPI asset. */
export type SupportedArch = 'arm64' | 'x64'

/**
 * Map Node's `process.arch` to the asset-name architecture segment CLIProxyAPI
 * publishes: arm64 -> aarch64, x64 -> amd64. Returns null for anything else
 * (e.g. running under Rosetta reports 'x64' already, so no special-casing
 * needed there) — callers must treat null as "unsupported platform".
 */
export function archToAssetSegment(arch: string): 'aarch64' | 'amd64' | null {
  if (arch === 'arm64') return 'aarch64'
  if (arch === 'x64') return 'amd64'
  return null
}

/** Asset filename for a given version + Node arch, or null if unsupported. */
export function assetNameFor(version: string, arch: string): string | null {
  const seg = archToAssetSegment(arch)
  if (!seg) return null
  return `CLIProxyAPI_${version}_darwin_${seg}.tar.gz`
}

export function checksumsAssetName(): string {
  return 'checksums.txt'
}

export function downloadUrlFor(tag: string, assetName: string): string {
  return `${GITHUB_RELEASES_BASE}/download/${tag}/${assetName}`
}
