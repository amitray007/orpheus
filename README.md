# Orpheus

A macOS app that wraps the Claude Code CLI in a project and workspace UI.

> [!WARNING]
> **Early preview — expect rough edges.** Orpheus is under active development.
> APIs, data formats, and UI flows may change between releases without notice.
> It is not yet feature-stable. Proceed accordingly.

## What is Orpheus?

Orpheus is a macOS GUI that gives the [Claude Code](https://claude.ai/code) CLI (`claude`) a persistent project/workspace shell. Instead of running `claude` in a plain terminal, Orpheus organizes your work into projects and workspaces, each backed by an isolated native terminal powered by [libghostty](https://github.com/ghostty-org/ghostty) — embedded directly into the Electron window as a native `NSView`. Each workspace maps to a single `claude` session and survives navigation; the session is resumed via `--resume` on return.

What the current implementation provides:

- Project and workspace management backed by SQLite
- Persistent native terminal (libghostty/Ghostty) — one surface per workspace, hidden rather than destroyed on navigation
- Live workspace activity status (`in_progress` / `attention` / `awaiting_input` / `idle`) sourced from Claude Code's on-disk session registry (`~/.claude/sessions/`)
- Layered settings: global → project → workspace, composed into `claude` CLI flags and `--settings` JSON at launch time
- In-app update check via Homebrew

**macOS only.** The terminal is a native NAPI addon that embeds libghostty as an `NSView` parented onto Electron's macOS window handle. There is no functional Windows or Linux build; vestigial build scripts for those platforms exist in the repository but do not produce a working app.

## Requirements

### To run the app

- macOS (Apple Silicon or Intel)
- The Claude Code CLI (`claude`) installed and authenticated — see the [Claude Code documentation](https://docs.anthropic.com/en/claude-code)

### To build from source

- macOS (Apple Silicon or Intel)
- [Bun](https://bun.sh) — the project's package manager (`bun.lock` is committed)
- Xcode Command Line Tools (`xcode-select --install`) — required by node-gyp to compile the native `.mm` NAPI addon (`packages/ghostty-native/addon.mm`)

No Apple Developer account is required. `bun install` triggers a `postinstall` hook that fetches a SHA-256-verified prebuilt `GhosttyKit.xcframework` from a public GitHub release.

## Build from source

Local builds always produce **Orpheus Dev** — a separate variant with its own bundle ID (`dev.orpheus.dev`), app name, icon, and data directory (`~/Library/Application Support/Orpheus Dev/`). It installs alongside any production build without interfering.

```bash
bun install
bun run build:unpack
open "/Applications/Orpheus Dev.app"
```

`build:unpack` chains: native addon rebuild → typecheck → Vite bundle → electron-builder (`electron-builder-dev.yml --dir`) → ad-hoc codesign → install to `/Applications/Orpheus Dev.app`.

> **Do not run `bun run dev`** (electron-vite dev mode). Bundle IDs, icons, and signing diverge from the installed variant — it is not a useful build target. Always use `build:unpack`.

> **Do not run `bun run build:mac`** — that is the production build path, guarded for CI and Homebrew release only.

### Other useful commands

| Command                    | What it does                                                                |
| -------------------------- | --------------------------------------------------------------------------- |
| `bun run typecheck`        | Type-check main process, preload, shared types, and renderer                |
| `bun run lint`             | ESLint over the workspace (flat config)                                     |
| `bun run format`           | Prettier — also enforced by `pre-commit` (lint-staged) and `pre-push` hooks |
| `bun run build:native`     | Rebuild only the native ghostty NAPI addon                                  |
| `bun run fetch:libghostty` | Re-fetch the pinned `GhosttyKit.xcframework` (also runs as `postinstall`)   |

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed walkthrough of:

- The three-process Electron model (main, preload, renderer)
- Core domain model (projects, workspaces, sessions)
- The Claude launch composition pipeline (`composeClaudeLaunch`)
- SQLite schema and migration conventions
- The native terminal addon (`packages/ghostty-native/addon.mm`)
- Workspace activity status sourced from Claude Code's session registry

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. Contributions are accepted at the owner's discretion under the project's terms — submitting a contribution does not grant you any rights to the project beyond what the [LICENSE](LICENSE) already permits.

All work lands on the **`staging` branch** — do not create per-feature branches unless explicitly discussed. Pull requests go `staging → main`; `main` is the release branch only.

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/): `feat(scope):`, `fix(scope):`, `chore(scope):`, `refactor(scope):`, etc. No emoji in commit subjects.

Before opening a PR, these must pass locally:

```bash
bun run typecheck
bun run lint
bun run format
```

**There are no automated tests.** CI runs typecheck and lint only. Manual verification against `Orpheus Dev.app` is the current quality gate — be honest in your PR description about what you tested.

## License

Orpheus is **source-available, not open-source** — © 2026 Amit Ray, all rights reserved. You may read the source for personal evaluation, but copying, modification, redistribution, and any use beyond evaluation require prior written permission (hey@amitray.dev). See [LICENSE](LICENSE) for the full terms. Third-party attributions in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
