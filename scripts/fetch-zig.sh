#!/usr/bin/env bash
# Vendor a specific Zig toolchain into vendor/zig.
# We pin to Zig 0.15.2 to match Ghostty 1.3.1's build.zig.zon minimum_zig_version.
# Bump in lockstep with the Ghostty pin in scripts/fetch-ghostty.sh.
#
# Usage: bun run fetch:zig   (or: bash scripts/fetch-zig.sh)

set -euo pipefail

ZIG_VERSION="0.15.2"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor"
ZIG_DIR="$VENDOR_DIR/zig"

ARCH=$(uname -m)
OS=$(uname -s)

if [ "$OS" != "Darwin" ]; then
  echo "[fetch-zig] this script targets macOS only (Orpheus is mac-only for v0)" >&2
  exit 1
fi

case "$ARCH" in
  arm64) ZIG_ARCH="aarch64" ;;
  x86_64) ZIG_ARCH="x86_64" ;;
  *) echo "[fetch-zig] unsupported arch $ARCH" >&2; exit 1 ;;
esac

TARBALL="zig-${ZIG_ARCH}-macos-${ZIG_VERSION}.tar.xz"
URL="https://ziglang.org/download/${ZIG_VERSION}/${TARBALL}"
EXTRACTED="zig-${ZIG_ARCH}-macos-${ZIG_VERSION}"

mkdir -p "$VENDOR_DIR"

if [ -x "$ZIG_DIR/zig" ]; then
  CURRENT=$("$ZIG_DIR/zig" version 2>&1 || echo "broken")
  if [ "$CURRENT" = "$ZIG_VERSION" ]; then
    echo "[fetch-zig] zig $ZIG_VERSION already at $ZIG_DIR"
    exit 0
  fi
  echo "[fetch-zig] removing existing $ZIG_DIR (was $CURRENT, want $ZIG_VERSION)"
  rm -rf "$ZIG_DIR"
fi

cd "$VENDOR_DIR"
echo "[fetch-zig] downloading $URL"
curl -fL --progress-bar -o "$TARBALL" "$URL"

echo "[fetch-zig] extracting"
tar -xf "$TARBALL"
mv "$EXTRACTED" zig
rm "$TARBALL"

ACTUAL=$("$ZIG_DIR/zig" version)
if [ "$ACTUAL" != "$ZIG_VERSION" ]; then
  echo "[fetch-zig] version mismatch: got $ACTUAL, want $ZIG_VERSION" >&2
  exit 1
fi

echo "[fetch-zig] done. Zig $ZIG_VERSION at $ZIG_DIR/zig"
