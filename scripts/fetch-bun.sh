#!/usr/bin/env bash
# Fetch the pinned Bun runtime binary (from oven-sh/bun releases) into vendor/bun/.
#
# WHY WE VENDOR A SEPARATE BUN BINARY (rather than relying on node_modules/bun,
# a devDependency, or the host's installed `bun`)
# -----------------------------------------------------------------------------
# `@opentui/core`'s native dylib loads via `node:ffi`, which does not exist on
# Node 22 / Electron 39 (our Electron-as-Node CLI runtime) — it only works
# under Bun. The packaged app must therefore ship its OWN Bun binary to exec
# the OpenTUI-based TUI, independent of whatever (if anything) is on the end
# user's PATH. The `bun` npm package is NOT a self-contained binary — its
# postinstall downloads the platform build from GitHub at install time, which
# just moves the same fetch-and-verify problem into node_modules with less
# control over pinning/verification. Fetching directly here follows the exact
# convention already established by fetch-libghostty.sh: pin an exact
# version, download over HTTPS, verify SHA-256 against the upstream published
# checksum manifest, extract into vendor/ (gitignored — see .gitignore's
# `vendor/` rule), never commit the binary.
#
# Usage: bun run fetch:bun   (or directly: bash scripts/fetch-bun.sh)
#
# BUMPING: update BUN_VERSION and BUN_SHA256 together. BUN_SHA256 is copied
# from the release's own SHASUMS256.txt (not just the artifact we downloaded)
# so a compromised/mirrored artifact would have to also forge that manifest.
#
# macOS-only, arm64-only: Orpheus ships exclusively as a macOS Apple Silicon
# app (see install-mac.mjs / electron-builder*.yml — there is no Intel or
# Linux build), so only bun-darwin-aarch64 is fetched.

set -euo pipefail

# ---------------------------------------------------------------------------
# Pinning constants
# ---------------------------------------------------------------------------

BUN_VERSION="1.3.10" # matches package.json#packageManager
BUN_ASSET="bun-darwin-aarch64.zip"
BUN_URL="https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ASSET}"
# Copied from https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/SHASUMS256.txt
BUN_SHA256="82034e87c9d9b4398ea619aee2eed5d2a68c8157e9a6ae2d1052d84d533ccd8d"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor"
BUN_DIR="$VENDOR_DIR/bun"
BUN_BIN="$BUN_DIR/bun"

mkdir -p "$VENDOR_DIR"

echo ""
echo "=== Fetching Bun runtime (v$BUN_VERSION, darwin-aarch64) ==="

# Idempotency check: skip if the pinned binary is already present and reports
# the expected version.
if [ -x "$BUN_BIN" ] && "$BUN_BIN" --version 2>/dev/null | grep -qx "$BUN_VERSION"; then
  echo "[fetch-bun] bun $BUN_VERSION already present at $BUN_BIN — skipping download"
  exit 0
fi

TMPDIR_WORK="$(mktemp -d)"
TMPFILE="$TMPDIR_WORK/$BUN_ASSET"

cleanup() { rm -rf "$TMPDIR_WORK"; }
trap cleanup EXIT

echo "[fetch-bun] downloading $BUN_URL"
curl -fL --proto '=https' --tlsv1.2 --progress-bar -o "$TMPFILE" "$BUN_URL"

echo "[fetch-bun] verifying SHA-256..."
ACTUAL_SHA=$(shasum -a 256 "$TMPFILE" | awk '{print $1}')
if [ "$ACTUAL_SHA" != "$BUN_SHA256" ]; then
  echo "[fetch-bun] SHA-256 MISMATCH" >&2
  echo "  expected: $BUN_SHA256" >&2
  echo "  got:      $ACTUAL_SHA" >&2
  exit 1
fi
echo "[fetch-bun] SHA-256 OK"

echo "[fetch-bun] extracting into $BUN_DIR/"
rm -rf "$BUN_DIR"
mkdir -p "$BUN_DIR"
unzip -q "$TMPFILE" -d "$TMPDIR_WORK/extracted"

EXTRACTED_BIN="$TMPDIR_WORK/extracted/bun-darwin-aarch64/bun"
if [ ! -f "$EXTRACTED_BIN" ]; then
  echo "[fetch-bun] extraction produced unexpected layout — bun binary not found at $EXTRACTED_BIN" >&2
  echo "[fetch-bun] contents of $TMPDIR_WORK/extracted/:" >&2
  find "$TMPDIR_WORK/extracted" >&2
  exit 1
fi

cp "$EXTRACTED_BIN" "$BUN_BIN"
chmod +x "$BUN_BIN"

echo "[fetch-bun] bun $BUN_VERSION ready at $BUN_BIN"
