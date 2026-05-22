#!/usr/bin/env bash
# Fetch the prebuilt GhosttyKit.xcframework (from Lakr233/libghostty-spm) and
# clone/update the Ghostty source tree (for terminfo + shell-integration assets).
#
# Usage: bun run fetch:libghostty   (or directly: bash scripts/fetch-libghostty.sh)
#
# BUMPING: to pick up a new xcframework release, update GHOSTTYKIT_URL and
# GHOSTTYKIT_SHA256 together — the SHA-256 is the only tamper-detection we have
# for a binary artifact from a third-party repo. Also update GHOSTTYKIT_LABEL.
# For the Ghostty source pin, update GHOSTTY_PIN and GHOSTTY_TAG_LABEL as well.
#
# Xcframework layout (verified 2026-05-11):
#   macos-arm64_x86_64/{Headers/ghostty.h, Headers/module.modulemap, libghostty.a}
#   ios-arm64/{Headers/ghostty.h, Headers/module.modulemap, libghostty.a}
#   ios-arm64_x86_64-simulator/{Headers/ghostty.h, Headers/module.modulemap, libghostty.a}
#   ios-arm64_x86_64-maccatalyst/{Headers/ghostty.h, Headers/module.modulemap, libghostty.a}

set -euo pipefail

# ---------------------------------------------------------------------------
# Pinning constants
# ---------------------------------------------------------------------------

# Prebuilt xcframework — Lakr233/libghostty-spm (MIT, weekly auto-rebuilds)
GHOSTTYKIT_URL="https://github.com/Lakr233/libghostty-spm/releases/download/storage.1.1.4/GhosttyKit.xcframework.zip"
GHOSTTYKIT_SHA256="feab989335ed9be4ab0a01923b4d7f319c3bff63aabb4104474c686812cd3fd1"
GHOSTTYKIT_LABEL="storage.1.1.4 (Ghostty rolling)"

# Ghostty source clone — for terminfo/78/xterm-ghostty and shell-integration files
GHOSTTY_REPO="https://github.com/ghostty-org/ghostty.git"
GHOSTTY_PIN="332b2aefc6e72d363aa93ab6ecfc86eeeeb5ed28"  # v1.3.1
GHOSTTY_TAG_LABEL="v1.3.1"

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR_DIR="$ROOT_DIR/vendor"
XCFRAMEWORK_DIR="$VENDOR_DIR/GhosttyKit.xcframework"
GHOSTTY_DIR="$VENDOR_DIR/ghostty"

mkdir -p "$VENDOR_DIR"

# ---------------------------------------------------------------------------
# Step 1 — GhosttyKit.xcframework (prebuilt)
# ---------------------------------------------------------------------------

echo ""
echo "=== Step 1/2 — GhosttyKit.xcframework ($GHOSTTYKIT_LABEL) ==="

# Idempotency check: if Info.plist already exists we consider it present.
# A future bump will change the URL constant and the old dir will be replaced.
if [ -f "$XCFRAMEWORK_DIR/Info.plist" ]; then
  echo "[fetch-libghostty] xcframework already present at $XCFRAMEWORK_DIR — skipping download"
else
  TMPDIR_WORK="$(mktemp -d)"
  TMPFILE="$TMPDIR_WORK/GhosttyKit.xcframework.zip"

  cleanup() { rm -rf "$TMPDIR_WORK"; }
  trap cleanup EXIT

  echo "[fetch-libghostty] downloading $GHOSTTYKIT_URL"
  curl -fL --proto '=https' --tlsv1.2 --progress-bar -o "$TMPFILE" "$GHOSTTYKIT_URL"

  echo "[fetch-libghostty] verifying SHA-256..."
  ACTUAL_SHA=$(shasum -a 256 "$TMPFILE" | awk '{print $1}')
  if [ "$ACTUAL_SHA" != "$GHOSTTYKIT_SHA256" ]; then
    echo "[fetch-libghostty] SHA-256 MISMATCH" >&2
    echo "  expected: $GHOSTTYKIT_SHA256" >&2
    echo "  got:      $ACTUAL_SHA" >&2
    exit 1
  fi
  echo "[fetch-libghostty] SHA-256 OK"

  echo "[fetch-libghostty] extracting into $VENDOR_DIR/"
  rm -rf "$XCFRAMEWORK_DIR"
  unzip -q "$TMPFILE" -d "$VENDOR_DIR/"

  if [ ! -f "$XCFRAMEWORK_DIR/Info.plist" ]; then
    echo "[fetch-libghostty] extraction produced unexpected layout — Info.plist not found at $XCFRAMEWORK_DIR/Info.plist" >&2
    echo "[fetch-libghostty] contents of $VENDOR_DIR/:" >&2
    ls "$VENDOR_DIR/" >&2
    exit 1
  fi

  echo "[fetch-libghostty] xcframework ready at $XCFRAMEWORK_DIR"
fi

# ---------------------------------------------------------------------------
# Step 2 — Ghostty source clone (for terminfo + shell-integration assets)
# ---------------------------------------------------------------------------

echo ""
echo "=== Step 2/2 — Ghostty source ($GHOSTTY_TAG_LABEL) ==="

if [ ! -d "$GHOSTTY_DIR/.git" ]; then
  echo "[fetch-libghostty] cloning $GHOSTTY_REPO → $GHOSTTY_DIR"
  git clone --filter=blob:none "$GHOSTTY_REPO" "$GHOSTTY_DIR"
fi

cd "$GHOSTTY_DIR"

# Idempotency check: if HEAD is already at the pinned commit, skip network fetch.
CURRENT_PIN=$(git rev-parse HEAD 2>/dev/null || echo "none")
if [ "$CURRENT_PIN" = "$GHOSTTY_PIN" ]; then
  echo "[fetch-libghostty] Ghostty source already at $GHOSTTY_TAG_LABEL ($GHOSTTY_PIN) — skipping fetch"
else
  echo "[fetch-libghostty] fetching $GHOSTTY_TAG_LABEL ($GHOSTTY_PIN)"
  git fetch --tags origin
  git checkout -f "$GHOSTTY_PIN"

  ACTUAL_PIN=$(git rev-parse HEAD)
  if [ "$ACTUAL_PIN" != "$GHOSTTY_PIN" ]; then
    echo "[fetch-libghostty] HEAD ($ACTUAL_PIN) does not match pin ($GHOSTTY_PIN)" >&2
    exit 1
  fi
fi

echo "[fetch-libghostty] Ghostty source at $GHOSTTY_TAG_LABEL ($GHOSTTY_PIN) in $GHOSTTY_DIR"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "=== fetch-libghostty complete ==="
echo "  xcframework : $XCFRAMEWORK_DIR"
echo "  ghostty src : $GHOSTTY_DIR ($GHOSTTY_TAG_LABEL)"
