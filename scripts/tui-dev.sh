#!/usr/bin/env bash
# Run the TUI picker straight from TypeScript source against the running
# Orpheus Dev app — no build, no packaging, no codesign. Seconds instead of
# the several minutes `bun run build:unpack` takes.
#
# WHY THIS WORKS: the picker is pure Node + a Unix-socket client. It imports
# neither `electron` nor `better-sqlite3` (verified — those are why the
# packaged CLI needs the app's own Electron-as-Node runtime). It talks to the
# app over cmd.sock, so it does not need to live inside the bundle to work.
#
# WHEN YOU STILL NEED THE FULL BUILD: this exercises the TUI source only.
# Changes to resources/bin/orpheus (the shim), anything under src/main/ that
# changes the wire protocol, or the electron-builder configs are NOT covered
# here — those need `bun run build:unpack` and a relaunch.
#
# Usage:  bun run tui:dev          (or: ./scripts/tui-dev.sh)
# Requires: "Orpheus Dev.app" running (it owns the socket this connects to).

set -euo pipefail

DEV_DIR="$HOME/Library/Application Support/Orpheus Dev"
SOCK="$DEV_DIR/cmd.sock"
TOKEN_FILE="$DEV_DIR/cmd.token"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -S "$SOCK" ]; then
  echo "orpheus tui:dev — no command socket at:" >&2
  echo "  $SOCK" >&2
  echo "Start the dev app first:  open -g \"/Applications/Orpheus Dev.app\"" >&2
  exit 1
fi

if [ ! -f "$TOKEN_FILE" ]; then
  echo "orpheus tui:dev — no auth token at:" >&2
  echo "  $TOKEN_FILE" >&2
  echo "The dev app writes this on start; relaunch it." >&2
  exit 1
fi

# ORPHEUS_FORCE_CROSS_VARIANT: running from source there is no embedded
# variant marker, so paths.ts defaults to "prod" and would otherwise discard
# the Dev socket/token below as an untrusted cross-variant override (that
# guard exists to stop a Dev binary driving the PROD app, which has bitten us
# — see paths.ts's resolveEffectiveVariant). Here the mismatch is deliberate:
# source has no variant, and we are explicitly targeting Dev.
#
# ORPHEUS_CMD_TOKEN takes the token VALUE, not a path (ORPHEUS_CMD_TOKEN_FILE
# is the path form, but the value form skips a stat and is unambiguous).
exec env \
  ORPHEUS_FORCE_CROSS_VARIANT=1 \
  ORPHEUS_CMD_SOCK="$SOCK" \
  ORPHEUS_CMD_TOKEN="$(cat "$TOKEN_FILE")" \
  bun "$REPO_ROOT/packages/orpheus-cli/src/tui/dev-entry.ts" "$@"
