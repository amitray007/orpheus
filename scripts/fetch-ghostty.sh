#!/usr/bin/env bash
# Fetch Ghostty source into vendor/ghostty at a pinned commit.
# libghostty's API is unstable; pin to a known-good commit and bump deliberately.
#
# Usage: bun run fetch:ghostty   (or directly: bash scripts/fetch-ghostty.sh)

set -euo pipefail

# v1.3.1 — latest stable Ghostty release as of 2026-05-11.
# To bump: pick a newer tag/commit from https://github.com/ghostty-org/ghostty,
# update this constant, and re-run.
GHOSTTY_REPO="https://github.com/ghostty-org/ghostty.git"
GHOSTTY_PIN="332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28"  # v1.3.1
GHOSTTY_TAG_LABEL="v1.3.1"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor"
GHOSTTY_DIR="$VENDOR_DIR/ghostty"

mkdir -p "$VENDOR_DIR"

if [ ! -d "$GHOSTTY_DIR/.git" ]; then
  echo "[fetch-ghostty] cloning $GHOSTTY_REPO → $GHOSTTY_DIR"
  git clone --filter=blob:none "$GHOSTTY_REPO" "$GHOSTTY_DIR"
fi

cd "$GHOSTTY_DIR"
echo "[fetch-ghostty] fetching $GHOSTTY_TAG_LABEL ($GHOSTTY_PIN)"
git fetch --tags origin
git checkout -f "$GHOSTTY_PIN"

ACTUAL=$(git rev-parse HEAD)
if [ "$ACTUAL" != "$GHOSTTY_PIN" ]; then
  echo "[fetch-ghostty] HEAD ($ACTUAL) does not match pin ($GHOSTTY_PIN)" >&2
  exit 1
fi

echo "[fetch-ghostty] done. Ghostty at $GHOSTTY_TAG_LABEL ($GHOSTTY_PIN) in $GHOSTTY_DIR"
