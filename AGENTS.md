# AGENTS.md

This file provides guidance to AI coding agents working in this repository.

## What this is

Orpheus is an **open-source macOS Electron app** (MIT-licensed) that wraps **`claude`** — the [Claude Code CLI](https://claude.ai/code) — in a project/workspace UI. It is not associated with Codex or any other CLI tool. The terminal is rendered by a native NAPI addon embedding prebuilt **libghostty** (`vendor/GhosttyKit.xcframework`) as an `NSView` parented onto Electron's `BrowserWindow` native handle.

## Canonical references

Read these before doing any substantive work:

- **[CLAUDE.md](CLAUDE.md)** — the authoritative agent guide for this repo. Covers the orchestration model (top-level agent orchestrates; subagents do the coding), git workflow, the correct build/verify loop, architecture, IPC and settings wiring conventions, SQLite migration patterns, and the release pipeline.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — public-facing architecture overview (Electron three-process model, core domain model, native terminal addon lifecycle, workspace activity status pipeline).

## Dev build (the only local build that matters)

Local builds produce **Orpheus Dev** (`/Applications/Orpheus Dev.app`) — a separate bundle from any production install.

```bash
osascript -e 'tell application "Orpheus Dev" to quit' 2>/dev/null; sleep 1
pkill -x "Orpheus Dev" 2>/dev/null; true
bun run build:unpack         # → build:native → typecheck → vite build → electron-builder-dev.yml --dir → install Orpheus Dev.app
open "/Applications/Orpheus Dev.app"
```

Sanity-check after build: `pgrep -lf "Orpheus Dev.app/Contents/MacOS/Orpheus Dev" | head -1`

Never run `bun run dev` (electron-vite dev mode) or the production build (`bun run build:mac`). See CLAUDE.md for the rationale and full command reference.
